from datetime import datetime, timezone, timedelta
import math
import re
import json
import base64
import logging
import asyncio
from typing import Any
from aiohttp import web

from config import *
from database import *
from services.balances import *
from services.limits import *
from services.telegram_utils import *

# The main.py will later import these and inject missing dependencies
# or they will import from main/config/services properly.
from services.user_service import *
from services.web_utils import *
from api.task_helpers import *

def _now():
    return datetime.now(timezone.utc)

def _dt_after_task(dt, task) -> bool:
    if not dt:
        return False
    created = _task_created_at(task)
    return dt >= created


async def api_task_create(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    body = await safe_json(req)

    ttype = str(body.get("type") or "").strip()  # tg|ya|gm
    title = str(body.get("title") or "").strip()
    target_url = str(body.get("target_url") or "").strip()
    instructions = str(body.get("instructions") or "").strip()
    
    # NEW PRICING LOGIC
    price_per_unit = float(body.get("price_per_unit") or 100)
    if price_per_unit < 5:
        return json_error(400, "Минимальная цена за 1 шт. — 5 ₽", code="MIN_PRICE")
    
    qty_total = int(body.get("qty_total") or 1)
    if qty_total <= 0:
        return json_error(400, "Количество должно быть больше 0")

    # Minimum Quantity for Telegram
    if ttype == "tg" and qty_total < 10:
        return json_error(400, "Минимальное количество для Telegram — 10 штук", code="MIN_QTY")

    vip_for_all = bool(body.get("vip_for_all") or False)
    comm_enabled = await is_commission_enabled()
    
    base_total = price_per_unit * qty_total
    
    # Commission (20%) - round down on total
    comm_rate = 0.20 if comm_enabled else 0.0
    comm_total = math.floor(base_total * comm_rate)
    
    # VIP rate (10%) - use math.ceil on total
    vip_rate = 0.10 if vip_for_all else 0.0
    vip_total = math.ceil(base_total * vip_rate)
    
    total_cost_rub = base_total + comm_total + vip_total
    
    # Validation of TOTAL COST (Advertiser Price)
    if ttype == "ya" and price_per_unit < 100:
        return json_error(400, "Минимальная награда исполнителю (Яндекс) — 100 ₽", code="MIN_REWARD_YA")
    if ttype == "gm" and price_per_unit < 70:
        return json_error(400, "Минимальная награда исполнителю (Google) — 70 ₽", code="MIN_REWARD_GM")
    if ttype == "dg" and price_per_unit < 15:
        return json_error(400, "Минимальная награда исполнителю (2GIS) — 15 ₽", code="MIN_REWARD_DG")
    
    if ttype == "tg":
        sub_type = str(body.get("sub_type") or "").strip()
        extra_days = max(0, int(body.get("retention_extra_days") or 0))
        
        # Base reward mapping (matching main.js TG_TASK_TYPES)
        base_reward = 5
        base_min_cost = 6
        if sub_type in ("sub_24h", "join_group_24h"): 
             base_reward = 6
             base_min_cost = 8
        elif sub_type in ("sub_48h", "join_group_48h"): 
             base_reward = 8
             base_min_cost = 10
        elif sub_type in ("sub_72h", "join_group_72h"): 
             base_reward = 10
             base_min_cost = 15
        
        min_reward = base_reward + (extra_days * 2)
        min_tg_price_per_unit = base_min_cost + (extra_days * 5)
        
        if price_per_unit < min_reward:
             return json_error(400, f"Минимальная награда для этого типа (+{extra_days} дн. удержания) — {min_reward} ₽", code="MIN_REWARD_TG")
        if price_per_unit < min_tg_price_per_unit:
             return json_error(400, f"Минимальная стоимость задания (+{extra_days} дн. удержания) — {min_tg_price_per_unit} ₽", code="MIN_COST_TG")

    # Reward for performer is price_per_unit
    reward_rub = price_per_unit
    
    check_type = str(body.get("check_type") or "manual").strip()
    tg_chat = str(body.get("tg_chat") or "").strip() or None
    tg_kind = str(body.get("tg_kind") or "").strip() or None
    sub_type = str(body.get("sub_type") or "").strip() or None
    pay_currency = str(body.get("pay_currency") or "rub").strip().lower()
    want_top = bool(body.get("want_top") or False)
    top_price_rub = float(body.get("top_price_rub") or 250)
    target_gender = normalize_task_gender(body.get("target_gender"))
    retention_extra_days = max(0, int(body.get("retention_extra_days") or 0))
    custom_review_texts = body.get("custom_review_texts") or []
    custom_review_mode = str(body.get("custom_review_mode") or "none").strip().lower()
    
    if pay_currency in ("stars", "xtr"):
        pay_currency = "star"

    if ttype not in ("tg", "ya", "gm", "dg"):
        raise web.HTTPBadRequest(text="Bad type")
    if not title:
        raise web.HTTPBadRequest(text="Missing title")
    if ttype != "tg" and not target_url:
        raise web.HTTPBadRequest(text="Missing target_url")

    # Only links/@usernames allowed. For YA/GM: validate + ensure URL is reachable.
    if ttype in ("ya", "gm", "dg"):
        ok_u, norm_u, err = validate_target_url(ttype, target_url)
        if not ok_u:
            return json_error(400, err, code="BAD_LINK")
        ok_alive, why = await check_url_alive(norm_u)
        if not ok_alive:
            return json_error(400, f"Ссылка не открывается или не подходит: {why}", code="LINK_DEAD")
        target_url = norm_u

    if custom_review_mode not in ("none", "single", "per_item"):
        custom_review_mode = "none"
    if not isinstance(custom_review_texts, list):
        custom_review_texts = [custom_review_texts]
    custom_review_texts = [str(x).strip() for x in custom_review_texts if str(x).strip()]
    if ttype not in ("ya", "gm", "dg"):
        custom_review_mode = "none"
        custom_review_texts = []
    if custom_review_mode == "single" and custom_review_texts:
        custom_review_texts = [custom_review_texts[0]]
    if custom_review_mode == "per_item":
        if len(custom_review_texts) < qty_total:
            return json_error(400, f"Для режима с разным текстом нужно минимум {qty_total} строк текста", code="REVIEW_TEXTS_NOT_ENOUGH")
        custom_review_texts = custom_review_texts[:qty_total]

    # TG task:
    if ttype == "tg":
        sub_type = (sub_type or TG_SUB_CHANNEL_KEY).strip().lower()
        if sub_type not in (TG_MEMBER_SUBTYPES | TG_EVENT_SUBTYPES):
            return json_error(400, "Неизвестный TG подтип задания", code="TG_BAD_SUBTYPE")

        if sub_type in TG_MEMBER_SUBTYPES:
            raw_tg = (tg_chat or target_url or "").strip()
            raw_low = raw_tg.lower()

            if is_private_tg_target(raw_tg):
                return json_error(400, "Приватные Telegram-ссылки запрещены. Укажи публичный @username или https://t.me/username", code="TG_PRIVATE_FORBIDDEN")

            if not (raw_tg.startswith("@") or ("t.me/" in raw_low)):
                return json_error(400, "Для TG задания можно указывать только @юзернейм или ссылку t.me/...", code="TG_ONLY_AT_OR_LINK")

            tg_chat_n = normalize_tg_chat(raw_tg)
            if not tg_chat_n:
                return json_error(400, "Некорректный @юзернейм/ссылка TG. Пример: @MyChannel или https://t.me/MyChannel", code="TG_CHAT_REQUIRED")
            if tg_chat_n.lower().endswith('bot'):
                return json_error(400, "Бот-ссылки запрещены. Для TG заданий можно использовать только каналы и группы.", code="TG_BOT_FORBIDDEN")
            tg_chat = tg_chat_n

            try:
                actual_kind = await tg_get_chat_kind(tg_chat)
            except Exception:
                return json_error(
                    400,
                    "Не удалось открыть TG-цель. Проверь @/ссылку. Приватные каналы и группы не поддерживаются.",
                    code="TG_BAD_TARGET",
                )

            if sub_type in TG_CHANNEL_SUBTYPES and actual_kind != 'channel':
                return json_error(400, "Для этого типа задания нужна ссылка именно на Telegram-канал.", code="TG_NEED_CHANNEL")
            if sub_type in TG_GROUP_SUBTYPES and actual_kind not in ('group', 'supergroup'):
                return json_error(400, "Для этого типа задания нужна ссылка именно на Telegram-группу.", code="TG_NEED_GROUP")

            desired_check_type, desired_kind, reason = await tg_calc_check_type(tg_chat, target_url)
            tg_kind = actual_kind or desired_kind
            check_type = desired_check_type
            if check_type != "auto":
                return json_error(400, "TG задания доступны только с автоматической проверкой. Укажи канал/группу, где бот может проверить подписку.", code="TG_AUTO_ONLY", reason=reason)
        else:
            tg_kind = "bot"
            check_type = "auto"
            if not target_url:
                target_url = "https://t.me/ReviewCashOrg_Bot"

    if want_top:
        total_cost_rub += max(0.0, float(top_price_rub or 250))
    
    charged_amount = total_cost_rub
    charged_currency = "rub"

    if pay_currency == "star":
        if not await is_stars_payments_enabled():
            return web.json_response({"ok": False, "error": "Оплата Stars временно отключена"}, status=403)
        charged_currency = "star"
        # Since total_cost_rub is what the user would pay in RUB, we convert to stars
        charged_amount = max(1, int(round(total_cost_rub / max(STARS_RUB_RATE, 0.000001))))
        ok = await sub_stars(uid, charged_amount)
        if not ok:
            return web.json_response({"ok": False, "error": f"Недостаточно Stars. Нужно {int(charged_amount)}⭐"}, status=400)
    else:
        ok = await sub_rub(uid, total_cost_rub)
        if not ok:
            return web.json_response({"ok": False, "error": f"Недостаточно RUB. Нужно {total_cost_rub:.2f}"}, status=400)

    row = {
        "owner_id": uid,
        "type": ttype,
        "tg_chat": tg_chat,
        "tg_kind": tg_kind,
        "title": title,
        "target_url": target_url,
        "instructions": instructions,
        "reward_rub": reward_rub,
        "cost_rub": total_cost_rub,
        "qty_total": qty_total,
        "qty_left": qty_total,
        "check_type": check_type,
        "status": "active",
    }

    meta_lines = []
    if sub_type:
        meta_lines.append("TG_SUBTYPE: " + sub_type)
    if target_gender != TASK_GENDER_ANY:
        meta_lines.append("TARGET_GENDER: " + target_gender)
    if vip_for_all:
        meta_lines.append("VIP_ONLY: 1")
    if ttype == "tg":
        meta_lines.append(f"RETENTION_DAYS: {tg_required_retention_days(sub_type or TG_SUB_CHANNEL_KEY, retention_extra_days)}")
    if custom_review_mode != "none" and custom_review_texts:
        encoded_review_texts = base64.b64encode(json.dumps(custom_review_texts, ensure_ascii=False).encode("utf-8")).decode("utf-8")
        meta_lines.append("CUSTOM_REVIEW_MODE: " + custom_review_mode)
        meta_lines.append("CUSTOM_REVIEW_TEXTS: " + encoded_review_texts)
    if want_top:
        now = _now()
        until = now + timedelta(hours=24)
        meta_lines.append(f"TOP_BOUGHT_AT: {now.isoformat()}")
        meta_lines.append(f"TOP_ACTIVE_UNTIL: {until.isoformat()}")
        meta_lines.append(f"TOP_PRICE_RUB: {float(top_price_rub or 250)}")
    if meta_lines:
        row["instructions"] = (instructions + "\n\n" + "\n".join(meta_lines)).strip()

    ins = await sb_insert(T_TASKS, row)
    task = (ins.data or [row])[0]

    await stats_add("revenue_rub", total_cost_rub)
    pay_text = f"{int(charged_amount)}⭐" if charged_currency == "star" else f"{charged_amount:.2f}₽"
    await notify_admin(f"🆕 Новое задание\n• {title}\n• Награда исполнителю: {reward_rub}₽\n• Оплата заказчиком: {pay_text}")
    try:
        from services.background_workers import broadcast_new_task, notify_vips_about_fat_task
        asyncio.create_task(broadcast_new_task(bot, task))
        if reward_rub >= 50:
            asyncio.create_task(notify_vips_about_fat_task(bot, task))
    except Exception:
        pass

    return web.json_response({
        "ok": True,
        "task": task,
        "charged_amount": int(charged_amount) if charged_currency == "star" else charged_amount,
        "charged_currency": charged_currency,
        "cost_rub": total_cost_rub,
    })



# -------------------------
# API: task click (must open link before submitting proof)
# -------------------------

async def api_task_click(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    body = await safe_json(req)

    banned_until = await get_task_ban_until(uid)
    if banned_until:
        return web.json_response({"ok": False, "error": f"Доступ к заданиям временно ограничен до {banned_until.strftime('%d.%m %H:%M')}"}, status=403)

    task_id = str(body.get("task_id") or "").strip()
    if not task_id:
        raise web.HTTPBadRequest(text="Missing task_id")
    task_id_db = cast_id(task_id)

    t = await sb_select(T_TASKS, {"id": task_id_db}, limit=1)
    if not t.data:
        return web.json_response({"ok": False, "error": "Task not found"}, status=404)

    task = (t.data or [None])[0] or {}
    if int(task.get("owner_id") or 0) == uid:
        return web.json_response({"ok": False, "error": "Нельзя выполнять своё задание"}, status=403)

    is_vip_task = "VIP_ONLY: 1" in str(task.get("instructions") or "")
    if is_vip_task:
        if not await get_vip_until(uid):
            return web.json_response({"ok": False, "error": "Это задание доступно только для VIP-пользователей"}, status=403)

    await touch_task_click(uid, task_id)
    return web.json_response({"ok": True})


# -------------------------
# API: cancel task
# -------------------------

async def api_task_cancel(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    body = await safe_json(req)

    task_id = str(body.get("task_id") or "").strip()
    if not task_id:
        raise web.HTTPBadRequest(text="Missing task_id")
    task_id_db = cast_id(task_id)

    t = await sb_select(T_TASKS, {"id": task_id_db}, limit=1)
    if not t.data:
        return web.json_response({"ok": False, "error": "Task not found"}, status=404)
    task = t.data[0]

    if int(task.get("owner_id") or 0) != uid:
        return web.json_response({"ok": False, "error": "Нельзя отменить чужое задание"}, status=403)

    if task.get("status") != "active":
        return web.json_response({"ok": False, "error": "Задание уже неактивно"}, status=400)

    qty_left = int(task.get("qty_left") or 0)
    if qty_left <= 0:
        return web.json_response({"ok": False, "error": "Нет оставшихся выполнений для отмены"}, status=400)

    # Refund logic: (qty_left * reward) - cancellation_fee
    reward_per_unit = float(task.get("reward_rub") or 0)
    base_refund = qty_left * reward_per_unit
    
    # 5% cancellation fee if more than 0 completions already done
    qty_total = int(task.get("qty_total") or 1)
    completed = qty_total - qty_left
    cancel_fee_rate = 0.05 if completed > 0 else 0.0
    cancel_fee = round(base_refund * cancel_fee_rate, 2)
    
    refund_amount = round(base_refund - cancel_fee, 2)

    # Update task
    await sb_update(T_TASKS, {"id": task_id_db}, {"status": "cancelled", "qty_left": 0})
    
    # Refund to user balance
    if refund_amount > 0:
        await add_rub(uid, refund_amount)
        msg = f"✅ Задание отменено. Возврат средств: {refund_amount}₽"
        if cancel_fee > 0:
            msg += f" (удержана комиссия за отмену {cancel_fee}₽)"
        await notify_user(bot, uid, msg)

    return web.json_response({"ok": True, "refund_amount": refund_amount})


# -------------------------
# API: submit task
# -------------------------

async def api_task_submit(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    await rate_limit_enforce(uid, "task_submit", min_interval_sec=10, spam_strikes=12, block_sec=120)
    body = await safe_json(req)

    banned_until = await get_task_ban_until(uid)
    if banned_until:
        return web.json_response({"ok": False, "error": f"Доступ к заданиям временно ограничен до {banned_until.strftime('%d.%m %H:%M')}"}, status=403)

    blocked_until = await get_submit_block_until(uid)
    if blocked_until:
        return web.json_response({"ok": False, "error": f"Слишком много проверок. Повтори после {blocked_until.strftime('%d.%m %H:%M')} UTC"}, status=429)

    await mark_submit_attempt(uid, ok=False)

    task_id = str(body.get("task_id") or "").strip()
    proof_text = str(body.get("proof_text") or "").strip()
    proof_url = str(body.get("proof_url") or "").strip() or None

    if not task_id:
        raise web.HTTPBadRequest(text="Missing task_id")

    task_id_db = cast_id(task_id)

    t = await sb_select(T_TASKS, {"id": task_id_db}, limit=1)
    if not t.data:
        return web.json_response({"ok": False, "error": "Task not found"}, status=404)
    task = t.data[0]

    if int(task.get("owner_id") or 0) == uid:
        return web.json_response({"ok": False, "error": "Нельзя выполнять своё задание"}, status=403)

    if task.get("status") != "active" or int(task.get("qty_left") or 0) <= 0:
        return web.json_response({"ok": False, "error": "Task closed"}, status=400)

    is_vip_task = "VIP_ONLY: 1" in str(task.get("instructions") or "")
    if is_vip_task:
        if not await get_vip_until(uid):
            return web.json_response({"ok": False, "error": "Это задание доступно только для VIP-пользователей"}, status=403)

    # cooldown for reviews
    if task.get("type") == "ya":
        ok_lim, rem = await check_limit(uid, "ya_review", YA_COOLDOWN_SEC)
        if not ok_lim:
            return web.json_response({"ok": False, "error": f"Лимит: раз в 3 дня. Осталось ~{rem//3600}ч"}, status=400)
    if task.get("type") == "gm":
        ok_lim, rem = await check_limit(uid, "gm_review", GM_COOLDOWN_SEC)
        if not ok_lim:
            return web.json_response({"ok": False, "error": f"Лимит: раз в день. Осталось ~{rem//3600}ч"}, status=400)

    # duplicate check: block only active/paid/fake completions; allow resubmit after rejected/rework
    dup = await sb_select(T_COMP, {"task_id": task_id_db, "user_id": uid}, order="created_at", desc=True, limit=20)
    dup_rows = []
    for row in (dup.data or []):
        dup_rows.append(await expire_rework_if_needed(row))
    blocking_statuses = {"pending", "pending_24h", "pending_hold", "paid", "fake"}
    if any(str(x.get("status") or "").lower() in blocking_statuses or is_rework_active(x) for x in dup_rows):
        return web.json_response({"ok": False, "error": "Уже отправляли выполнение"}, status=400)

    is_auto = (task.get("check_type") == "auto") and (task.get("type") == "tg")

    if not is_auto:
        # reserve only available slots: allow parallel pending reports while free places remain
        pending_any = await sb_select(T_COMP, {"task_id": task_id_db}, order="created_at", desc=True, limit=1000)
        active_pending = []
        for row in (pending_any.data or []):
            row = await expire_rework_if_needed(row)
            st = str(row.get("status") or "").lower()
            if st in {"pending", "pending_hold"} or is_rework_active(row):
                active_pending.append(row)
        pending_count = len(active_pending)
        qty_left = int(task.get("qty_left") or 0)
        if pending_count >= qty_left:
            return web.json_response({"ok": False, "error": "Свободных мест сейчас нет: все места уже заняты отчётами на проверке. Дождись решения модератора."}, status=400)

    # require that user opened the task link (anti-fake) for manual checks
    if not is_auto:
        ok_clicked = await require_recent_task_click(uid, task_id)
        if not ok_clicked:
            return web.json_response({"ok": False, "error": "Сначала нажми «Перейти к выполнению» и открой ссылку, затем отправляй отчёт."}, status=400)
        elapsed = await task_click_elapsed_sec(uid, task_id)
        if elapsed is not None and elapsed < 60: # User said 60s for naturalness
            return web.json_response({"ok": False, "error": "Выполняете слишком быстро. Для качественного отзыва нужно хотя бы 1-2 минуты изучения объекта."}, status=400)
        
            # Layered Quality Check
            from services.task_engine import TaskEngine
            
            # 1. Basic Filters (Fast & Reliable)
            if proof_text:
                ok_q, err_q = await TaskEngine.basic_quality_filters(proof_text, task)
                if not ok_q:
                    return web.json_response({"ok": False, "error": err_q}, status=400)
                
                # Check for exact duplicate in this task (by anyone)
                existing = await sb_select(T_COMP, {"task_id": task_id_db, "proof_text": proof_text}, limit=1)
                if existing.data:
                    return web.json_response({"ok": False, "error": "Такой текст отзыва уже отправляли для этого задания. Напишите свой уникальный текст."}, status=400)

            # 2. Link Usage & Uniqueness Check (Atomic)
            url = task.get("target_url")
            if url:
                limit = TaskEngine.get_daily_limit(task)
                ok, err = await TaskEngine.try_reserve_link_usage(uid, task_id_db, url, limit)
                if not ok:
                    return web.json_response({"ok": False, "error": err}, status=400)

            # 3. AI Moderation (Optional / Second Layer)
            if proof_text:
                from services.ai_moderation import analyze_review_quality
                ai_res = await analyze_review_quality(proof_text, task.get("instructions", ""))
                if not ai_res["is_ok"] and ai_res["score"] < 0.4:
                    return web.json_response({"ok": False, "error": f"AI-фильтр: {ai_res['reason']}"}, status=400)
                # If score is between 0.4 and 0.6, we let it pass but could flag it

    if is_auto:
        async def _auto_pay(ok_code: str):
            reward = float(task.get("reward_rub") or 0)
            xp_added = task_xp(task)
            
            vip_until_dt = await get_vip_until(uid)
            if vip_until_dt:
                reward = round(reward * VIP_INCOME_MULT, 2)
                xp_added = int(round(xp_added * VIP_XP_MULT))

            await add_rub(uid, reward)
            await stats_add("payouts_rub", reward)
            await add_xp(uid, xp_added)
            await maybe_pay_referral_bonus(uid)
            try:
                left = int(task.get("qty_left") or 0)
                if left > 0:
                    new_left = max(0, left - 1)
                    upd = {"qty_left": new_left}
                    if new_left <= 0:
                        upd["status"] = "closed"
                    await sb_update(T_TASKS, {"id": task_id_db}, upd)
            except Exception:
                pass
            await sb_insert(T_COMP, {
                "task_id": task_id_db,
                "user_id": uid,
                "status": "paid",
                "proof_text": ok_code,
                "proof_url": None,
                "moderated_at": _now().isoformat(),
            })
            await mark_submit_attempt(uid, ok=True)
            return web.json_response({"ok": True, "status": "paid", "earned": reward, "xp_added": xp_added})

        task_subtype = get_tg_subtype(task) or TG_SUB_CHANNEL_KEY
        reward = float(task.get("reward_rub") or 0)
        chat = task.get("tg_chat") or ""
        task_created_at = _task_created_at(task)

        if task_subtype in TG_MEMBER_SUBTYPES:
            if not chat:
                return web.json_response({"ok": False, "error": "TG task misconfigured (no tg_chat)"}, status=400)

            retention_days = get_retention_days(task)
            hold_delay = tg_hold_delay_sec(task_subtype, max(0, retention_days - tg_required_retention_days(task_subtype, 0))) if retention_days else tg_hold_delay_sec(task_subtype)
            if hold_delay > 0:
                existing_hold = await tg_hold_get(task_id, uid)
                if existing_hold:
                    left_raw = int((existing_hold - _now()).total_seconds())
                    if left_raw <= 0:
                        await tg_hold_clear(task_id, uid)
                    else:
                        left = max(1, left_raw)
                        hours = max(1, int(round(left / 3600)))
                        return web.json_response({
                            "ok": False,
                            "error": f"Проверка уже запланирована. Осталось примерно {hours} ч.",
                            "code": "TG_HOLD_WAIT",
                            "retry_after": left,
                        }, status=400)

                ok_member = await tg_is_member(chat, uid)
                if not ok_member:
                    return web.json_response({"ok": False, "error": "Бот не видит подписку сейчас. Подпишись и отправь на проверку снова."}, status=400)

                due_at = _now() + timedelta(seconds=hold_delay)
                await tg_hold_set(task_id, uid, due_at)
                await sb_insert(T_COMP, {
                    "task_id": task_id_db,
                    "user_id": uid,
                    "status": "pending_hold",
                    "proof_text": f"AUTO_TG_WAIT_{tg_hold_delay_hours(task_subtype, max(0, retention_days - tg_required_retention_days(task_subtype, 0))) if retention_days else tg_hold_delay_hours(task_subtype)}H",
                    "proof_url": None,
                })

                due_msk = due_at.astimezone(timezone(timedelta(hours=3)))
                wait_hours = tg_hold_delay_hours(task_subtype, max(0, retention_days - tg_required_retention_days(task_subtype, 0))) if retention_days else tg_hold_delay_hours(task_subtype)
                await mark_submit_attempt(uid, ok=True)
                return web.json_response({
                    "ok": True,
                    "status": f"hold_{wait_hours}h",
                    "message": f"Подписка подтверждена. Выходить нельзя {max(1, wait_hours // 24)} дн. Бот автоматически перепроверит участие через {wait_hours} ч. ({due_msk.strftime('%d.%m %H:%M МСК')}). Если выйти раньше — задание отменится и включится штраф.",
                    "retry_after": max(1, int((due_at - _now()).total_seconds())),
                })

            ok_member = await tg_is_member(chat, uid)
            if not ok_member:
                return web.json_response({"ok": False, "error": "Бот не видит подписку/участие. Подпишись и попробуй снова."}, status=400)
            return await _auto_pay("AUTO_TG_OK")

        if task_subtype == TG_BOT_START_KEY:
            dt = await tg_evt_get(uid, "bot_start")
            if not _dt_after_task(dt, task):
                return web.json_response({"ok": False, "error": "Нажми /start у бота и попробуй снова."}, status=400)
            return await _auto_pay("AUTO_TG_BOT_START")

        if task_subtype == TG_BOT_CALLBACK_KEY:
            expected_cb = get_tg_meta(task, "TG_CALLBACK_DATA")
            dt = await tg_evt_get(uid, "callback_data", expected_cb) if expected_cb else await tg_evt_get(uid, "callback_any")
            if not _dt_after_task(dt, task):
                return web.json_response({"ok": False, "error": "Нажми нужную inline-кнопку в боте и попробуй снова."}, status=400)
            return await _auto_pay("AUTO_TG_CALLBACK")

        if task_subtype == TG_BOT_MESSAGE_KEY:
            expected_text = get_tg_meta(task, "TG_EXPECT_TEXT").lower()
            dt = await tg_evt_get(uid, "message_text", expected_text) if expected_text else await tg_evt_get(uid, "message_any")
            if not _dt_after_task(dt, task):
                err = "Отправь сообщение боту и попробуй снова."
                if expected_text:
                    err = f"Отправь боту текст: {expected_text}"
                return web.json_response({"ok": False, "error": err}, status=400)
            return await _auto_pay("AUTO_TG_MESSAGE")

        if task_subtype == TG_MINIAPP_OPEN_KEY:
            dt = await tg_evt_get(uid, "miniapp_open")
            if not _dt_after_task(dt, task):
                return web.json_response({"ok": False, "error": "Открой Mini App бота и попробуй снова."}, status=400)
            return await _auto_pay("AUTO_TG_MINIAPP")

        if task_subtype == TG_INVITE_FRIENDS_KEY:
            need_cnt_raw = get_tg_meta(task, "TG_REF_COUNT")
            try:
                need_cnt = max(1, int(need_cnt_raw or "1"))
            except Exception:
                need_cnt = 1
            paid_refs = await tg_referrals_paid_since(uid, task_created_at)
            if paid_refs < need_cnt:
                return web.json_response({"ok": False, "error": f"Нужно приглашений с выполнением: {need_cnt}. Сейчас: {paid_refs}."}, status=400)
            return await _auto_pay("AUTO_TG_REFERRAL")

        if task_subtype == TG_POLL_VOTE_KEY:
            poll_id = get_tg_meta(task, "TG_POLL_ID")
            ok_vote = await tg_poll_answer_seen_since(uid, task_created_at, poll_id=poll_id or None)
            if not ok_vote:
                return web.json_response({"ok": False, "error": "Голос не найден. Проголосуй в опросе от бота и попробуй снова."}, status=400)
            return await _auto_pay("AUTO_TG_POLL")

        return web.json_response({"ok": False, "error": "Неподдерживаемый TG подтип задания"}, status=400)

    # manual proof: обязательно нужен proof_url
    if not proof_url:
        return web.json_response({"ok": False, "error": "Нужен скриншот доказательства"}, status=400)

    await sb_insert(T_COMP, {
        "task_id": task_id_db,
        "user_id": uid,
        "status": "pending",
        "proof_text": proof_text,
        "proof_url": proof_url
    })

    await clear_task_click(uid, task_id)

    if task.get("type") == "ya":
        await touch_limit(uid, "ya_review")
    if task.get("type") == "gm":
        await touch_limit(uid, "gm_review")

    await notify_admin(f"🧾 Новый отчет на проверку\nTask: {task.get('title')}\nUser: {uid}\nTaskID: {task_id}")
    xp_expected = task_xp(task)
    if await get_vip_until(uid):
        xp_expected = int(round(xp_expected * VIP_XP_MULT))
    await mark_submit_attempt(uid, ok=True)
    return web.json_response({"ok": True, "status": "pending", "xp_expected": xp_expected})

# -------------------------
# withdraw
# -------------------------

