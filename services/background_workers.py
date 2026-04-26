import asyncio
import logging
import os
import html
from datetime import datetime, timezone, timedelta
from aiogram import Bot
from aiogram.types import WebAppInfo
from aiogram.utils.keyboard import InlineKeyboardBuilder

from config import *
from database import *
from services.balances import add_rub, add_xp
from services.limits import *
from services.telegram_utils import tg_is_member, get_miniapp_url, notify_user
from services.ui_handlers import task_xp, maybe_pay_referral_bonus

log = logging.getLogger("reviewcash.workers")

def _now():
    return datetime.now(timezone.utc)

async def _iter_user_ids(batch: int = 1000):
    start = 0
    while True:
        def _f():
            q = sb.table(T_USERS).select('user_id').order('user_id', desc=False)
            if hasattr(q, 'range'):
                q = q.range(start, start + batch - 1)
            else:
                q = q.limit(min(batch, 5000))
            return q.execute()
        r = await sb_exec(_f)
        rows = (r.data or [])
        if not rows:
            break
        for row in rows:
            try:
                yield int(row.get('user_id'))
            except Exception:
                continue
        if len(rows) < batch:
            break
        start += batch

async def broadcast_new_task(bot: Bot, task: dict):
    try:
        in_maintenance = await is_maintenance_mode()
        title = str(task.get('title') or task.get('platform') or 'Новое задание').strip()
        try:
            reward_i = int(float(task.get('reward_rub') or task.get('reward') or 0))
        except Exception:
            reward_i = 0
        kind_map = {'tg': 'Telegram', 'ya': 'Яндекс', 'gm': 'Google', 'dg': '2GIS'}
        kind = kind_map.get(str(task.get('type') or '').lower(), 'ReviewCash')
        text_msg = (
            f"🆕 <b>Новое задание</b>\n\n"
            f"<b>{html.escape(title)}</b>\n"
            f"💰 Награда: <b>{reward_i} ₽</b>\n"
            f"📍 Платформа: <b>{html.escape(kind)}</b>"
        )
        kb = InlineKeyboardBuilder()
        kb.button(text='🚀 Открыть ReviewCash', web_app=WebAppInfo(url=get_miniapp_url()))
        markup = kb.as_markup()
        async for uid in _iter_user_ids():
            if in_maintenance:
                if uid not in ADMIN_IDS and uid != MAIN_ADMIN_ID:
                    continue
            if await is_notify_muted(uid):
                continue
            try:
                await bot.send_message(uid, text_msg, parse_mode='HTML', reply_markup=markup, disable_web_page_preview=True)
            except Exception:
                pass
            await asyncio.sleep(0.03)
    except Exception as e:
        log.warning('broadcast_new_task failed: %s', e)

async def process_tg_holds_once(bot: Bot):
    now_dt = _now()
    due_rows = await tg_hold_list_due(now_dt)
    for row in due_rows:
        parsed = tg_hold_parse_key(row.get("limit_key"))
        if not parsed:
            continue
        task_id, user_id = parsed
        task_id_db = cast_id(task_id)
        try:
            t = await sb_select(T_TASKS, {"id": task_id_db}, limit=1)
            task = (t.data or [None])[0]
            if not task or str(task.get("type") or "") != "tg":
                await tg_hold_clear(task_id, user_id)
                continue

            chat = str(task.get("tg_chat") or "").strip()
            if not chat:
                await tg_hold_clear(task_id, user_id)
                continue

            reward = float(task.get("reward_rub") or 0)
            ok_member = await tg_is_member(chat, user_id)
            if ok_member:
                await add_rub(user_id, reward)
                await stats_add("payouts_rub", reward)
                xp_added = task_xp(task)
                await add_xp(user_id, xp_added)
                await maybe_pay_referral_bonus(user_id)

                try:
                    left = int(task.get("qty_left") or 0)
                    if left > 0:
                        upd = {"qty_left": max(0, left - 1)}
                        if int(upd["qty_left"]) <= 0:
                            upd["status"] = "closed"
                        await sb_update(T_TASKS, {"id": task_id_db}, upd)
                except Exception:
                    pass

                c = await sb_select(T_COMP, {"task_id": task_id_db, "user_id": int(user_id), "status": "pending_hold"}, order="created_at", desc=True, limit=1)
                if c.data:
                    await sb_update(T_COMP, {"id": cast_id(c.data[0].get("id"))}, {
                        "status": "paid",
                        "proof_text": "AUTO_TG_HOLD_OK",
                        "moderated_at": _now().isoformat(),
                    })
                else:
                    await sb_insert(T_COMP, {
                        "task_id": task_id_db,
                        "user_id": int(user_id),
                        "status": "paid",
                        "proof_text": "AUTO_TG_HOLD_OK",
                        "proof_url": None,
                        "moderated_at": _now().isoformat(),
                    })
                await notify_user(bot, user_id, f"✅ Проверка срока удержания пройдена. Начислено +{reward:.2f}₽")
            else:
                c = await sb_select(T_COMP, {"task_id": task_id_db, "user_id": int(user_id), "status": "pending_hold"}, order="created_at", desc=True, limit=1)
                if c.data:
                    await sb_update(T_COMP, {"id": cast_id(c.data[0].get("id"))}, {
                        "status": "fake",
                        "proof_text": "AUTO_TG_HOLD_FAIL",
                        "moderated_at": _now().isoformat(),
                    })
                try:
                    until = await set_task_ban(user_id, days=3)
                    until_txt = until.strftime('%d.%m %H:%M') if until else 'на 3 дня'
                except Exception:
                    until_txt = 'на 3 дня'
                await notify_user(bot, user_id, f"❌ Проверка срока удержания не пройдена: пользователь вышел из канала/группы раньше срока. Выплата отменена, применён штраф: доступ к заданиям ограничен {until_txt}.")
        except Exception as e:
            log.warning("tg hold process failed task=%s user=%s err=%s", task_id, user_id, e)
        finally:
            await tg_hold_clear(task_id, user_id)

async def tg_hold_worker(bot: Bot):
    scan_interval = int(os.getenv("TG_HOLD_SCAN_INTERVAL_SEC", "60").strip())
    while True:
        try:
            await process_tg_holds_once(bot)
        except Exception as e:
            log.warning("tg hold worker tick failed: %s", e)
        await asyncio.sleep(max(10, scan_interval))

async def vip_expiry_worker(bot: Bot):
    while True:
        try:
            now = _now()
            users_res = await sb_exec(lambda: sb.table(T_USERS).select("*").not_.is_("vip_until", "null").execute())
            for u in (users_res.data or []):
                uid = int(u.get("user_id") or 0)
                if not uid: continue
                
                v_str = u.get("vip_until")
                if not v_str: continue
                v_dt = _parse_dt(v_str)
                if not v_dt: continue
                
                diff = v_dt - now
                hours_left = diff.total_seconds() / 3600
                
                if 0 < hours_left <= 72:
                    reminded = await get_limit_until(uid, "vip_remind_3d")
                    if not reminded:
                        msg = (f"👑 <b>Ваш VIP-статус заканчивается через {int(hours_left/24) + 1} дн.</b>\n\n"
                               f"Продлите его в профиле, чтобы сохранить бонус +10% к доходу и +50% к опыту! ✨")
                        await notify_user(bot, uid, msg)
                        await set_limit_until(uid, "vip_remind_3d", 7 * 24 * 3600)
                
                if 0 < hours_left <= 24:
                    reminded = await get_limit_until(uid, "vip_remind_1d")
                    if not reminded:
                        msg = (f"👑 <b>Внимание! Ваш VIP-статус закончится через 24 часа.</b>\n\n"
                               f"Успейте выполнить все VIP-задания и продлить статус! 🚀")
                        await notify_user(bot, uid, msg)
                        await set_limit_until(uid, "vip_remind_1d", 7 * 24 * 3600)
                
                if -1 < hours_left <= 0:
                    reminded = await get_limit_until(uid, "vip_remind_expired")
                    if not reminded:
                        msg = (f"🚫 <b>Ваш VIP-статус закончился.</b>\n\n"
                               f"Бонусы к доходу и опыту больше не действуют. Ждем вас снова! 👋")
                        await notify_user(bot, uid, msg)
                        await set_limit_until(uid, "vip_remind_expired", 30 * 24 * 3600)
        except Exception as e:
            log.warning("VIP worker tick failed: %s", e)
        await asyncio.sleep(3600)

def start_background_workers(bot: Bot):
    asyncio.create_task(tg_hold_worker(bot))
    asyncio.create_task(vip_expiry_worker(bot))
    log.info("Background workers started.")
