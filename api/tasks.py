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

def _task_created_at(task):
    cat = task.get("created_at")
    if not cat:
        return _now()
    try:
        return datetime.fromisoformat(str(cat).replace("Z", "+00:00"))
    except Exception:
        return _now()

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
        
        # ANTI-SPAM: Max 3 tasks per URL per advertiser
        existing_cnt = await sb_count(T_TASKS, {"owner_id": uid, "target_url": norm_u}, in_={"status": ["active", "review"]})
        if existing_cnt >= 3:
            return json_error(400, "У вас уже есть 3 активных задания с этой ссылкой. Дождитесь завершения или отмените старые.", code="URL_SPAM")

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

    # Call TaskEngine for centralized cancellation logic
    from services.task_engine import TaskEngine
    ok, err, refund_amount = await TaskEngine.cancel_task(uid, task_id_db)
    
    if not ok:
        return web.json_response({"ok": False, "error": err}, status=400)
    
    if refund_amount > 0:
        msg = f"✅ Задание отменено. Возврат средств: {refund_amount}₽"
        # We know if it's > 0 but less than full reward, there was a fee. 
        # But TaskEngine handles the logic, we just report the result.
        await notify_user(bot, uid, msg)

    return web.json_response({"ok": True, "refunded_rub": refund_amount})


# -------------------------
# API: submit task
# -------------------------

async def api_task_submit(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    body = await safe_json(req)

    # 1. Basic ban checks
    banned_until = await get_task_ban_until(uid)
    if banned_until:
        return web.json_response({"ok": False, "error": f"Доступ к заданиям ограничен до {banned_until.strftime('%d.%m %H:%M')}"}, status=403)

    task_id = str(body.get("task_id") or "").strip()
    proof_text = str(body.get("proof_text") or "").strip()
    proof_url = str(body.get("proof_url") or "").strip() or None

    if not task_id:
        raise web.HTTPBadRequest(text="Missing task_id")
    task_id_db = cast_id(task_id)

    # 2. Get task & click context
    t_res = await sb_select(T_TASKS, {"id": task_id_db}, limit=1)
    if not t_res.data:
        return web.json_response({"ok": False, "error": "Task not found"}, status=404)
    task = t_res.data[0]
    
    elapsed = await task_click_elapsed_sec(uid, task_id)
    
    # 3. Call CENTRALIZED TaskEngine
    from services.task_engine import TaskEngine
    res = await TaskEngine.submit_review(
        user_id=uid,
        task=task,
        proof_text=proof_text,
        proof_url=proof_url,
        time_since_click=elapsed,
        ip=req.remote,
        device_hash=body.get("device_hash")
    )

    if not res.get("ok"):
        return web.json_response(res, status=400)

    # 4. Notify admin for manual review if needed
    if res.get("status") == "review":
        await notify_admin(f"🧾 Новый отчет на проверку\nTask: {task.get('title')}\nUser: {uid}\nID: {task_id}")
    
    return web.json_response(res)

# -------------------------
# withdraw
# -------------------------

