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

def _dt_key(v: str):
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0

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

async def api_user_gender_set(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    body = await safe_json(req)
    gender = normalize_task_gender(body.get("gender"))
    if gender not in (TASK_GENDER_MALE, TASK_GENDER_FEMALE):
        return web.json_response({"ok": False, "error": "Выбери Мужской или Женский"}, status=400)
    await tg_set_gender(uid, gender)
    return web.json_response({"ok": True, "gender": gender})

async def api_referrals(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    s = await referrals_summary(uid)
    return web.json_response({"ok": True, **s})

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
        ok_take, _ = await TaskEngine.can_user_take_task(uid, t, user_rep=user_rep, is_vip=is_vip, user_gender=user_gender)
        if not ok_take:
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
            "stars_payments_enabled": await is_stars_payments_enabled(),
            "commission_enabled": await is_commission_enabled(),
        }
    })

async def api_ops_list(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])

    pays = await sb_select(T_PAY, {"user_id": uid}, order="created_at", desc=True, limit=300)
    wds = await sb_select(T_WD, {"user_id": uid}, order="created_at", desc=True, limit=300)
    comps = await sb_select(T_COMP, {"user_id": uid, "status": "paid"}, order="moderated_at", desc=True, limit=300)
    refs = await sb_select(T_REF, {"referrer_id": uid, "status": "paid"}, order="paid_at", desc=True, limit=300)

    task_ids = list({c.get("task_id") for c in (comps.data or []) if c.get("task_id") is not None})
    tasks_map: dict[str, dict] = {}
    if task_ids:
        tr = await sb_select_in(T_TASKS, "id", task_ids, columns="id,title,reward_rub,type,target_url", limit=500)
        for t in (tr.data or []):
            tasks_map[str(t.get("id"))] = t

    ops: list[dict] = []
    for p in (pays.data or []):
        provider = str(p.get("provider") or "")
        status = str(p.get("status") or "")
        amount = float(p.get("amount_rub") or 0)
        meta = p.get("meta") or {}
        if provider in ("tbank", "stars", "cryptobot"):
            if status == "paid":
                ops.append({
                    "kind": "topup",
                    "provider": provider,
                    "status": status,
                    "amount_rub": amount,
                    "created_at": p.get("created_at"),
                    "id": p.get("id"),
                })
        elif provider in ("admin_credit", "admin"):
            admin_kind = str(meta.get("kind") or "").lower()
            if admin_kind == "fine" or amount < 0:
                ops.append({
                    "kind": "fine", "source": "admin", "status": "paid", "amount_rub": amount,
                    "title": str(meta.get("reason") or "Штраф от администратора"), "created_at": p.get("created_at"), "id": p.get("id"),
                })
            else:
                ops.append({
                    "kind": "earning", "source": "admin", "status": status, "amount_rub": amount,
                    "title": str(meta.get("reason") or "Ручное начисление"), "created_at": p.get("created_at"), "id": p.get("id"),
                })

    for w in (wds.data or []):
        ops.append({
            "kind": "withdrawal", "status": w.get("status"), "amount_rub": float(w.get("amount_rub") or 0),
            "details": w.get("details"), "created_at": w.get("created_at"), "id": w.get("id"),
        })

    for c in (comps.data or []):
        tid = str(c.get("task_id"))
        t = tasks_map.get(tid, {})
        ops.append({
            "kind": "earning", "source": "task", "status": "paid", "amount_rub": float(t.get("reward_rub") or 0),
            "title": str(t.get("title") or "Задание"), "created_at": c.get("moderated_at"), "id": c.get("id"),
        })

    for r in (refs.data or []):
        ops.append({
            "kind": "earning", "source": "referral", "status": "paid", "amount_rub": float(r.get("bonus_rub") or 0),
            "title": "Реферальный бонус", "created_at": r.get("paid_at"), "id": r.get("id"),
        })

    ops.sort(key=lambda x: _dt_key(x.get("created_at")), reverse=True)
    return web.json_response({"ok": True, "operations": ops})

async def api_report_list(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    rows = await sb_select(T_COMP, {"user_id": uid}, order="created_at", desc=True, limit=300)
    comps = rows.data or []
    task_ids = list({c.get("task_id") for c in comps if c.get("task_id") is not None})
    tasks_map = {}
    if task_ids:
        tr = await sb_select_in(T_TASKS, "id", task_ids, columns="id,title,reward_rub,type,target_url", limit=500)
        for t in (tr.data or []): tasks_map[str(t.get("id"))] = t

    type_labels = {"tg": "Telegram", "ya": "Яндекс", "gm": "Google"}
    reports = []
    for c in comps:
        task = tasks_map.get(str(c.get("task_id")), {})
        reports.append({
            "id": c.get("id"), "task_id": c.get("task_id"), "title": task.get("title") or "Задание",
            "type": task.get("type") or "tg", "reward_rub": float(task.get("reward_rub") or 0),
            "status": c.get("status"), "created_at": c.get("created_at"),
        })
    return web.json_response({"ok": True, "reports": reports})

async def api_report_clear(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    await sb_delete(T_COMP, {"user_id": uid})
    return web.json_response({"ok": True})

async def api_bonus_claim(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    ok, wait_sec = await check_limit(uid, "daily_bonus", 24 * 3600)
    if not ok:
        hours = wait_sec // 3600
        mins = (wait_sec % 3600) // 60
        return web.json_response({"ok": False, "error": f"Бонус уже получен. Приходи через {hours}ч {mins}м"})
    await add_rub(uid, DAILY_BONUS_RUB)
    await touch_limit(uid, "daily_bonus")
    return web.json_response({"ok": True, "bonus_rub": DAILY_BONUS_RUB})

async def api_leaderboard_top(req: web.Request):
    top_rub = []
    r = await sb_select(T_BAL, columns="user_id, rub_balance", order="rub_balance", desc=True, limit=50)
    u_ids = [x.get("user_id") for x in (r.data or [])]
    if u_ids:
        names_r = await sb_select_in(T_USERS, "user_id", u_ids, columns="user_id, username, first_name")
        names_map = {x["user_id"]: x for x in (names_r.data or [])}
        for i, row in enumerate(r.data or []):
            uid = row.get("user_id"); u_info = names_map.get(uid) or {}
            top_rub.append({"rank": i + 1, "user_id": uid, "username": u_info.get("username"), "first_name": u_info.get("first_name"), "score": float(row.get("rub_balance") or 0)})
    return web.json_response({"ok": True, "top_rub": top_rub})
