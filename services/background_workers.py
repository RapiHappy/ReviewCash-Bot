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
from services.balances import add_rub, add_xp, task_xp
from services.limits import *
from services.telegram_utils import tg_is_member, get_miniapp_url, notify_user
from services.user_service import maybe_pay_referral_bonus, cast_id, stats_add
from crypto_service import get_payout_status

log = logging.getLogger("reviewcash.workers")

def _now():
    return datetime.now(timezone.utc)

def _parse_dt(s):
    if not s: return None
    try:
        if isinstance(s, datetime): return s
        s = str(s).replace("Z", "+00:00")
        return datetime.fromisoformat(s)
    except Exception:
        return None

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
            except Exception as e:
                log.warning(f"Failed to process row in _iter_user_ids: {e}")
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
            except Exception as e:
                log.warning(f"Notification failed for {uid}: {e}")
            await asyncio.sleep(0.04) # 25 msgs/sec
    except Exception as e:
        log.warning('broadcast_new_task failed: %s', e)

async def notify_vips_about_fat_task(bot: Bot, task: dict):
    """Exclusive notification for VIP users about high-reward tasks."""
    try:
        title = str(task.get('title') or 'Жирное задание').strip()
        reward = float(task.get('reward_rub') or 0)
        
        text_msg = (
            f"<b>🔥 ЭКСКЛЮЗИВ ДЛЯ VIP!</b>\n\n"
            f"Появилось жирное задание: <b>{html.escape(title)}</b>\n"
            f"💰 Награда: <b>{reward:.0f} ₽</b>\n\n"
            f"Успей выполнить, пока есть места! 🚀"
        )
        kb = InlineKeyboardBuilder()
        kb.button(text='💎 Открыть задания', web_app=WebAppInfo(url=get_miniapp_url()))
        markup = kb.as_markup()
        
        vips = await get_all_vip_uids()
        for uid in vips:
            if await is_notify_muted(uid):
                continue
            try:
                await bot.send_message(uid, text_msg, parse_mode='HTML', reply_markup=markup, disable_web_page_preview=True)
            except Exception as e:
                log.warning(f"Notification failed for {uid}: {e}")
            await asyncio.sleep(0.05)
    except Exception as e:
        log.warning('notify_vips_about_fat_task failed: %s', e)

async def process_tg_holds_once(bot: Bot):
    due_rows = await tg_hold_list_due()
    for row in due_rows:
        user_id = row["user_id"]
        task_id = row["task_id"]
        task_id_db = cast_id(task_id)
        try:
            t = await sb_select(T_TASKS, {"id": task_id_db}, limit=1)
            task = (t.data or [None])[0]
            chat = task.get("tg_chat") or ""
            if not task or str(task.get("type") or "") != "tg" or not chat:
                await tg_hold_clear(task_id, user_id)
                continue

            reward = float(task.get("reward_rub") or 0)
            xp_added = task_xp(task)
            ok_member = await tg_is_member(chat, user_id)
            
            if ok_member:
                # ATOMIC FINALIZE
                await sb.rpc("finalize_tg_hold_atomic", {
                    "p_user_id": user_id,
                    "p_task_id": str(task_id_db),
                    "p_status": "paid",
                    "p_reward_rub": reward,
                    "p_xp_added": xp_added
                }).execute()
                
                await stats_add("payouts_rub", reward)
                await maybe_pay_referral_bonus(user_id)
                await notify_user(user_id, f"✅ Проверка срока удержания пройдена. Начислено +{reward:.2f}₽")
            else:
                # ATOMIC REJECT
                await sb.rpc("finalize_tg_hold_atomic", {
                    "p_user_id": user_id,
                    "p_task_id": str(task_id_db),
                    "p_status": "fake",
                    "p_reward_rub": 0,
                    "p_xp_added": 0
                }).execute()
                
                try:
                    until = await set_task_ban(user_id, days=3)
                    until_txt = until.strftime('%d.%m %H:%M') if until else 'на 3 дня'
                except Exception as e:
                    log.warning(f"Failed to set task ban in hold worker for {user_id}: {e}")
                    until_txt = 'на 3 дня'
                await notify_user(user_id, f"❌ Проверка срока удержания не пройдена: пользователь вышел из канала/группы раньше срока. Выплата отменена, применён штраф: доступ к заданиям ограничен {until_txt}.")
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
            vip_uids = await get_all_vip_uids()
            for uid in vip_uids:
                try:
                    v_dt = await get_vip_until(uid)
                    if not v_dt:
                        continue

                    diff = v_dt - now
                    hours_left = diff.total_seconds() / 3600

                    if 0 < hours_left <= 72:
                        reminded = await get_limit_until(uid, "vip_remind_3d")
                        if not reminded:
                            msg = (f"👑 <b>Ваш VIP-статус заканчивается через {int(hours_left/24) + 1} дн.</b>\n\n"
                                   f"Продлите его в профиле, чтобы сохранить бонус +10% к доходу и +50% к опыту! ✨")
                            await notify_user(uid, msg)
                            await set_limit_until(uid, "vip_remind_3d", 7 * 24 * 3600)

                    if 0 < hours_left <= 24:
                        reminded = await get_limit_until(uid, "vip_remind_1d")
                        if not reminded:
                            msg = (f"👑 <b>Внимание! Ваш VIP-статус закончится через 24 часа.</b>\n\n"
                                   f"Успейте выполнить все VIP-задания и продлить статус! 🚀")
                            await notify_user(uid, msg)
                            await set_limit_until(uid, "vip_remind_1d", 7 * 24 * 3600)

                    if -1 < hours_left <= 0:
                        reminded = await get_limit_until(uid, "vip_remind_expired")
                        if not reminded:
                            msg = (f"🚫 <b>Ваш VIP-статус закончился.</b>\n\n"
                                   f"Бонусы к доходу и опыту больше не действуют. Ждем вас снова! 👋")
                            await notify_user(uid, msg)
                            await set_limit_until(uid, "vip_remind_expired", 30 * 24 * 3600)
                except Exception as e:
                    log.warning("VIP worker uid=%s failed: %s", uid, e)
        except Exception as e:
            log.warning("VIP worker tick failed: %s", e)
        await asyncio.sleep(3600)

async def payout_reconciliation_worker(bot: Bot):
    """Periodically check pending payouts that might have missed webhooks or timed out."""
    while True:
        try:
            # 1. Reconcile Payouts
            threshold = _now() - timedelta(minutes=30)
            def _f():
                return sb.table(T_WD).select("*").eq("status", "pending").lte("created_at", threshold.isoformat()).execute()
            r = await sb_exec(_f)
            
            for wd in (r.data or []):
                wd_id = wd["id"]
                uid = wd["user_id"]
                log.info(f"Reconciling pending payout {wd_id} for user {uid}")
                
                status = await get_payout_status(wd_id)
                if status == "completed":
                    # ATOMIC: Use RPC to finalize
                    await sb.rpc("withdraw_decision_atomic", {
                        "p_admin_id": int(MAIN_ADMIN_ID or 0),
                        "p_withdraw_id": int(wd_id),
                        "p_approved": True,
                        "p_new_status": "paid"
                    }).execute()
                    await notify_user(uid, f"✅ Выплата №{wd_id} подтверждена (reconciliation).")
                elif status in ("failed", "rejected"):
                    # ATOMIC: Use RPC to return balance
                    await sb.rpc("withdraw_decision_atomic", {
                        "p_admin_id": int(MAIN_ADMIN_ID or 0),
                        "p_withdraw_id": int(wd_id),
                        "p_approved": False
                    }).execute()
                    await notify_user(uid, f"❌ Выплата №{wd_id} отклонена платёжной системой (reconciliation). Средства возвращены.")
                elif status == "not_found":
                    log.warning(f"Payout {wd_id} not found in CryptoBot after 30m. Marking as failed.")
                    await sb.rpc("withdraw_decision_atomic", {
                        "p_admin_id": int(MAIN_ADMIN_ID or 0),
                        "p_withdraw_id": int(wd_id),
                        "p_approved": False
                    }).execute()
            
            # 2. Cleanup Orphan Redis Locks in DB (if any)
            # handled in orphan_cleanup_worker
                    
        except Exception as e:
            log.warning(f"Reconciliation worker tick failed: {e}")
        await asyncio.sleep(600) # every 10 mins

async def orphan_cleanup_worker():
    """Cleanup stale states and zombie records."""
    while True:
        try:
            # 1. Cleanup expired Redis locks (fallback if TTL failed)
            # This is complex without scanning all keys, usually TTL is enough.
            # But we can cleanup old limits in DB
            threshold = _now() - timedelta(days=7)
            def _f():
                return sb.table(T_LIMITS).delete().lte("last_at", threshold.isoformat()).execute()
            await sb_exec(_f)
            log.info("Old limits cleanup completed.")
            
        except Exception as e:
            log.warning(f"Cleanup worker tick failed: {e}")
        await asyncio.sleep(86400) # once a day

def start_background_workers(bot: Bot) -> list[asyncio.Task]:
    tasks = [
        asyncio.create_task(tg_hold_worker(bot)),
        asyncio.create_task(vip_expiry_worker(bot)),
        asyncio.create_task(payout_reconciliation_worker(bot)),
        asyncio.create_task(orphan_cleanup_worker()),
    ]
    log.info("Background workers started (including Reconciliation and Cleanup).")
    return tasks
