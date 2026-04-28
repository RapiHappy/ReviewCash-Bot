import hashlib
import random
import re
import json
import base64
import logging
import asyncio
from datetime import datetime, timezone, timedelta
from typing import Any
from aiohttp import web

from config import *
from database import *
from services.balances import *
from services.limits import *
from services.telegram_utils import *

from api.task_helpers import *
from services.user_service import ensure_user, referrals_summary
from services.web_utils import *

def _now():
    return datetime.now(timezone.utc)

def _parse_dt(v):
    try:
        if isinstance(v, datetime):
            return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
        if isinstance(v, str) and v.strip():
            return datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except Exception:
        pass
    return None

def _make_session_token(user_id: int) -> str | None:
    from config import WEBAPP_SESSION_SECRET
    if not WEBAPP_SESSION_SECRET:
        return None
    try:
        import hmac, hashlib, base64, time
        ts = int(time.time())
        data = f"{user_id}:{ts}"
        sig = hmac.new(WEBAPP_SESSION_SECRET.encode(), data.encode(), hashlib.sha256).hexdigest()
        token = base64.b64encode(f"{data}:{sig}".encode()).decode()
        return token
    except Exception:
        return None

async def api_sync(req: web.Request):
    """
    Основной эндпоинт синхронизации MiniApp.
    Централизованная логика через TaskEngine.
    """
    _, user = await require_init_optional(req)
    if not user:
        return web.json_response({"ok": True, "auth": False, "user": None, "tasks": [], "balances": None})

    body = await safe_json(req)
    uid = int(user.get("id") or user.get("user_id") or 0)

    # Анти-фрод + регистрация
    device_hash = str(body.get("device_hash") or "").strip()
    device_id = str(body.get("device_id") or "").strip()
    ua = req.headers.get("User-Agent", "")
    ip = get_ip(req)

    ref = None
    try:
        if body.get("referrer_id") is not None:
            ref = int(body.get("referrer_id"))
    except Exception:
        ref = None

    urow = await ensure_user(user, referrer_id=ref)

    ok, reason = await anti_fraud_check_and_touch(uid, device_hash, ip, ua, device_id=device_id)
    if not ok:
        return web.json_response({"ok": False, "error": reason}, status=403)

    if await is_maintenance_mode():
        is_adm = (uid in ADMIN_IDS) or (uid == MAIN_ADMIN_ID)
        if not is_adm:
            return web.json_response({"ok": False, "error": "Бот временно отключен на тех. обслуживание.", "code": "MAINTENANCE"}, status=503)

    if urow.get("is_banned"):
        return web.json_response({"ok": False, "error": "Аккаунт заблокирован"}, status=403)

    bal = await get_balance(uid)
    risk_score = await calc_user_risk_score(uid)
    trust_level = "high" if risk_score < 30 else ("medium" if risk_score < 60 else "low")
    expensive_ok, expensive_reason = await can_access_expensive_tasks(uid)

    banned_until = await get_task_ban_until(uid)
    if banned_until:
        return web.json_response({
            "ok": True, "auth": True, "user": {"user_id": uid},
            "banned_until": banned_until.isoformat(), "tasks": []
        })

    # Данные пользователя
    user_gender = normalize_task_gender(await tg_get_gender(uid))
    vip_until_dt = await get_vip_until(uid)
    is_vip = vip_until_dt is not None

    # === ЗАГРУЗКА ЗАДАНИЙ ===
    from services.task_engine import TaskEngine
    tsel = await sb_select(T_TASKS, {"status": "active"}, order="created_at", desc=True, limit=250)
    raw_tasks = tsel.data or []

    # Предварительный расчет репутации
    user_rep = await TaskEngine.calculate_user_rep(uid)

    # Получение маппинга слотов для текстов
    active_ids = [str(t["id"]) for t in raw_tasks]
    task_slot_map = {}
    if active_ids:
        try:
            csel = await sb_select_in(T_COMP, "task_id", active_ids, columns="task_id,status", limit=3000)
            for c in (csel.data or []):
                st = str(c.get("status") or "").lower()
                if st in {"pending", "pending_hold", "paid", "fake", "rework"}:
                    tid = str(c.get("task_id") or "")
                    task_slot_map[tid] = task_slot_map.get(tid, 0) + 1
        except Exception: pass

    filtered = []
    for t in raw_tasks:
        tid_s = str(t.get("id"))
        is_owner = int(t.get("owner_id") or 0) == uid
        
        if is_owner:
            filtered.append(t)
            continue

        # Единая проверка доступности
        ok_take, _ = await TaskEngine.can_user_take_task(uid, t, user_rep=user_rep)
        if not ok_take:
            continue

        # Гендерный таргетинг
        target_g = get_task_target_gender(t)
        if target_g != TASK_GENDER_ANY and target_g != user_gender:
            continue

        filtered.append(t)

    # Ранжирование и доп. поля
    for t in filtered:
        t["_rank"] = TaskEngine.calculate_task_rank(t)
        if is_top_active(t):
            t["_rank"] += 100.0
            
        # Обогащение данными для фронтенда
        t["reputation_score"] = user_rep
        t["vip_only"] = "VIP_ONLY: 1" in str(t.get("instructions") or "")
        
        if int(t.get("owner_id") or 0) == uid:
            t["custom_review_texts"] = get_review_texts(t)
        else:
            slot_index = int(task_slot_map.get(str(t.get("id")), 0) or 0)
            assigned_text = pick_review_text_for_task(t, slot_index)
            t["custom_review_texts"] = [assigned_text] if assigned_text else []
            t["assigned_review_text"] = assigned_text
        
        if t.get("instructions"):
            t["instructions"] = strip_meta_tags(t["instructions"])

    filtered.sort(key=lambda x: x.get("_rank", 0), reverse=True)

    # Reopen tasks
    reopen_task_ids = []
    try:
        rr = await sb_select(T_COMP, {"user_id": uid}, order="moderated_at", desc=True, limit=100)
        active_filtered_ids = {str(t.get('id')) for t in filtered}
        reopen_task_ids = list(dict.fromkeys([
            str(x.get('task_id')) for x in (rr.data or [])
            if str(x.get('status') or '').lower() in {"rework", "rejected"} 
            and str(x.get('task_id')) in active_filtered_ids
        ]))
    except Exception: pass

    session_token = _make_session_token(uid)

    return web.json_response({
        "ok": True,
        "auth": True,
        "session_token": session_token,
        "user": {
            "user_id": uid,
            "username": urow.get("username") or user.get("username"),
            "first_name": user.get("first_name"),
            "is_vip": is_vip,
            "vip_until": vip_until_dt.isoformat() if vip_until_dt else None,
            "is_admin": uid in ADMIN_IDS or uid == MAIN_ADMIN_ID,
        },
        "balance": bal,
        "tasks": filtered,
        "reopen_task_ids": reopen_task_ids,
        "risk": {
            "score": risk_score,
            "trust_level": trust_level,
            "expensive_tasks_locked": (not expensive_ok),
            "expensive_tasks_reason": expensive_reason,
        },
        "config": {
            "stars_rub_rate": STARS_RUB_RATE,
        }
    })

async def api_user_gender_set(req: web.Request):
    _, user = await require_init(req)
    uid = int(user.get("id") or user.get("user_id") or 0)
    body = await safe_json(req)
    gender = body.get("gender")
    if gender not in ["male", "female", "other"]:
        return web.json_response({"ok": False, "error": "Invalid gender"}, status=400)
    await tg_set_gender(uid, gender)
    return web.json_response({"ok": True})
