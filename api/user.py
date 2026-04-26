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
import logging
from aiohttp import web
import json
import base64
import asyncio

from api.task_helpers import *
# Removed from main import * to avoid circularity issues
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
    # Use global secret from config (imported via main)
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


# The main.py will later import these and inject missing dependencies
# or they will import from main/config/services properly.
async def api_user_gender_set(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    body = await safe_json(req)
    gender = normalize_task_gender(body.get("gender"))
    if gender not in (TASK_GENDER_MALE, TASK_GENDER_FEMALE):
        return web.json_response({"ok": False, "error": "Выбери Мужской или Женский"}, status=400)
    await tg_set_gender(uid, gender)
    return web.json_response({"ok": True, "gender": gender})

# -------------------------
# API: referrals summary (for MiniApp)
# -------------------------

async def api_referrals(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    s = await referrals_summary(uid)
    return web.json_response({"ok": True, **s})

# -------------------------
# API: sync
# -------------------------

async def api_sync(req: web.Request):
    _, user = await require_init_optional(req)
    if not user:
        return web.json_response({"ok": True, "auth": False, "user": None, "tasks": [], "balances": None})
    body = await safe_json(req)

    uid = int(user.get("id") or user.get("user_id") or 0)
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

    # MAINTENANCE CHECK
    if await is_maintenance_mode():
        is_adm = (uid in ADMIN_IDS) or (uid == MAIN_ADMIN_ID)
        if not is_adm:
            return web.json_response({
                "ok": False,
                "error": "Бот временно отключен на техническое обслуживание. Пожалуйста, попробуйте позже.",
                "code": "MAINTENANCE"
            }, status=503)

    if urow.get("is_banned"):
        return web.json_response({"ok": False, "error": "Аккаунт заблокирован"}, status=403)

    bal = await get_balance(uid)
    risk_score = await calc_user_risk_score(uid)
    trust_level = "high" if risk_score < 30 else ("medium" if risk_score < 60 else "low")
    expensive_ok, expensive_reason = await can_access_expensive_tasks(uid)

    banned_until = await get_task_ban_until(uid)
    
    is_vip = False
    vip_until = urow.get("vip_until")
    if vip_until:
        v_dt = _parse_dt(vip_until)
        if v_dt and v_dt > _now():
            is_vip = True

    tasks = []
    user_gender = normalize_task_gender(await tg_get_gender(uid))
    if not banned_until:
        tsel = await sb_select(T_TASKS, {"status": "active"}, order="created_at", desc=True, limit=200)
        raw = tsel.data or []

        pending_task_counts = {}
        try:
            psel = await sb_select(T_COMP, {"status": "pending"}, order="created_at", desc=True, limit=1000)
            for x in (psel.data or []):
                tid = x.get("task_id")
                if tid is None:
                    continue
                k = str(tid)
                pending_task_counts[k] = int(pending_task_counts.get(k, 0) or 0) + 1
        except Exception:
            pending_task_counts = {}

        completed_tg_stack_keys: set[str] = set()
        try:
            user_comp = await sb_select(T_COMP, {"user_id": uid}, order="created_at", desc=True, limit=300)
            done_statuses = {"pending", "pending_hold", "paid", "fake", "approved"}
            done_task_ids = list({
                cast_id(x.get("task_id"))
                for x in (user_comp.data or [])
                if str(x.get("status") or "").lower() in done_statuses and x.get("task_id") is not None
            })
            if done_task_ids:
                done_tasks = await sb_select_in(
                    T_TASKS,
                    "id",
                    done_task_ids,
                    columns="id,type,target_url,tg_chat,instructions",
                    limit=max(len(done_task_ids), 1),
                )
                for dt in (done_tasks.data or []):
                    if str(dt.get("type") or "") != "tg":
                        continue
                    stack_key = tg_task_identity(dt)
                    if stack_key:
                        completed_tg_stack_keys.add(stack_key)
        except Exception:
            completed_tg_stack_keys = set()

        tasks = [
            t for t in raw
            if (int(t.get("owner_id") or 0) == uid or int(t.get("qty_left") or 0) > 0)
            and (int(t.get("owner_id") or 0) == uid or t.get("type") != "tg" or t.get("check_type") == "auto")
            and not (
                int(t.get("owner_id") or 0) != uid
                and int(pending_task_counts.get(str(t.get("id")), 0) or 0) >= int(t.get("qty_left") or 0)
            )
            and (
                int(t.get("owner_id") or 0) == uid
                or expensive_ok
                or str(t.get("type") or "") in ("ya", "gm")
                or float(t.get("reward_rub") or 0) < EXPENSIVE_TASK_REWARD_RUB
            )
            and (
                int(t.get("owner_id") or 0) == uid
                or get_task_target_gender(t) == TASK_GENDER_ANY
                or get_task_target_gender(t) == user_gender
            )
            and not (
                int(t.get("owner_id") or 0) != uid
                and str(t.get("type") or "") == "tg"
                and tg_task_identity(t) in completed_tg_stack_keys
            )
        ]
        task_slot_map = {}
        try:
            comp_for_slots = await sb_select(T_COMP, {}, order="created_at", desc=False, limit=5000)
            for comp in (comp_for_slots.data or []):
                tid = str(comp.get("task_id") or "")
                if not tid:
                    continue
                st = str(comp.get("status") or "").lower()
                if st in {"pending", "pending_hold", "paid", "fake"} or is_rework_active(comp):
                    task_slot_map[tid] = int(task_slot_map.get(tid, 0) or 0) + 1
        except Exception:
            task_slot_map = {}

        for t in tasks:
            t["top_active_until"] = get_top_meta(t, "TOP_ACTIVE_UNTIL")
            t["top_bought_at"] = get_top_meta(t, "TOP_BOUGHT_AT")
            t["retention_days"] = get_retention_days(t)
            t["custom_review_mode"] = get_custom_review_mode(t)
            # Extract vip_only flag BEFORE stripping meta tags
            t["vip_only"] = "VIP_ONLY: 1" in str(t.get("instructions") or "")
            if int(t.get("owner_id") or 0) == uid:
                t["custom_review_texts"] = get_review_texts(t)
            else:
                slot_index = int(task_slot_map.get(str(t.get("id")), 0) or 0)
                assigned_text = pick_review_text_for_task(t, slot_index)
                t["custom_review_texts"] = [assigned_text] if assigned_text else []
                t["assigned_review_text"] = assigned_text
            # Strip internal meta tags from instructions before sending to frontend
            if t.get("instructions"):
                t["instructions"] = strip_meta_tags(t["instructions"])
    if is_vip:
        # VIP sorting: Top active first, then highest reward first
        tasks.sort(key=lambda x: (
            0 if is_top_active(x) else 1,
            -float(x.get("reward_rub") or 0),
            str(x.get("created_at") or "")
        ), reverse=False)
    else:
        # Default sorting
        tasks.sort(key=lambda x: (
            0 if is_top_active(x) else 1,
            -(top_bought_at(x).timestamp() if top_bought_at(x) else 0),
            str(x.get("created_at") or "")
        ), reverse=False)

    reopen_task_ids = []
    try:
        rr = await sb_select(T_COMP, {"user_id": uid}, order="moderated_at", desc=True, limit=300)
        if rr.data:
            active_ids = {str(t.get('id')) for t in tasks}
            reopen_statuses = {"rework", "rejected"}
            reopen_task_ids = [
                str(x.get('task_id'))
                for x in (rr.data or [])
                if str(x.get('status') or '').lower() in reopen_statuses and str(x.get('task_id')) in active_ids
            ]
            reopen_task_ids = list(dict.fromkeys(reopen_task_ids))
    except Exception:
        reopen_task_ids = []

    session_token = _make_session_token(uid)

    vip_until_dt = await get_vip_until(uid)
    is_vip = vip_until_dt is not None

    return web.json_response({
        "ok": True,
        "auth": True,
        "session_token": session_token,
        "user": {
            "user_id": uid,
            "username": urow.get("username") or (user.get("username") if user else None),
            "first_name": (user.get("first_name") if user else None),
            "last_name": (user.get("last_name") if user else None),
            "photo_url": (user.get("photo_url") if user else None),
            "gender": user_gender,
            "is_vip": is_vip,
            "vip_until": vip_until_dt.isoformat() if vip_until_dt else None,
            "is_admin": uid in ADMIN_IDS or uid == MAIN_ADMIN_ID,
            "is_main_admin": uid == MAIN_ADMIN_ID,
            "maintenance_mode": await is_maintenance_mode(),
        },
        "balance": bal,
        "tasks": tasks,
        "reopen_task_ids": reopen_task_ids,
        "task_ban_until": banned_until.isoformat() if banned_until else None,
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
        },
    })


# -------------------------
# API: admin toggle commission
# -------------------------

async def api_ops_list(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])

    pays = await sb_select(T_PAY, {"user_id": uid}, order="created_at", desc=True, limit=300)
    wds = await sb_select(T_WD, {"user_id": uid}, order="created_at", desc=True, limit=300)
    comps = await sb_select(T_COMP, {"user_id": uid, "status": "paid"}, order="moderated_at", desc=True, limit=300)
    refs = await sb_select(T_REF, {"referrer_id": uid, "status": "paid"}, order="paid_at", desc=True, limit=300)

    # preload tasks for completions
    task_ids = list({c.get("task_id") for c in (comps.data or []) if c.get("task_id") is not None})
    tasks_map: dict[str, dict] = {}
    if task_ids:
        tr = await sb_select_in(T_TASKS, "id", task_ids, columns="id,title,reward_rub,type,target_url", limit=500)
        for t in (tr.data or []):
            tasks_map[str(t.get("id"))] = t

    ops: list[dict] = []

    # Topups + admin credits live in payments table
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
            if provider == "admin_credit":
                admin_kind = admin_kind or "credit"
            elif not admin_kind:
                admin_kind = "fine" if amount < 0 else "credit"

            if admin_kind == "fine" or amount < 0:
                ops.append({
                    "kind": "fine",
                    "source": "admin",
                    "status": status or "paid",
                    "amount_rub": amount,
                    "title": str(meta.get("reason") or "Штраф от администратора"),
                    "created_at": p.get("created_at"),
                    "id": p.get("id"),
                })
            else:
                ops.append({
                    "kind": "earning",
                    "source": "admin",
                    "status": status,
                    "amount_rub": amount,
                    "title": str(meta.get("reason") or "Ручное начисление"),
                    "created_at": p.get("created_at"),
                    "id": p.get("id"),
                })
        else:
            # unknown payment provider -> treat as topup
            ops.append({
                "kind": "topup",
                "provider": provider or "payment",
                "status": status,
                "amount_rub": amount,
                "created_at": p.get("created_at"),
                "id": p.get("id"),
            })

    # Withdrawals
    for w in (wds.data or []):
        ops.append({
            "kind": "withdrawal",
            "status": w.get("status"),
            "amount_rub": float(w.get("amount_rub") or 0),
            "details": w.get("details"),
            "created_at": w.get("created_at"),
            "id": w.get("id"),
        })

    # Earnings from tasks (paid completions)
    for c in (comps.data or []):
        tid = str(c.get("task_id"))
        t = tasks_map.get(tid, {})
        reward = float(t.get("reward_rub") or 0)
        title = str(t.get("title") or "Выполнение задания")
        ops.append({
            "kind": "earning",
            "source": "task",
            "status": "paid",
            "amount_rub": reward,
            "title": title,
            "task_id": c.get("task_id"),
            "created_at": c.get("moderated_at") or c.get("created_at"),
            "id": c.get("id"),
        })

    # Referral bonuses
    for r in (refs.data or []):
        bonus = float(r.get("bonus_rub") or REF_BONUS_RUB)
        ops.append({
            "kind": "earning",
            "source": "referral",
            "status": "paid",
            "amount_rub": bonus,
            "title": "Реферальный бонус",
            "referred_id": r.get("referred_id"),
            "created_at": r.get("paid_at") or r.get("created_at"),
            "id": r.get("id"),
        })

    ops.sort(key=lambda x: _dt_key(x.get("created_at")), reverse=True)
    return web.json_response({"ok": True, "operations": ops})
# =========================================================
# ADMIN API
# =========================================================

async def api_report_list(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])

    rows = await sb_select(T_COMP, {"user_id": uid}, order="created_at", desc=True, limit=300)
    comps = rows.data or []

    task_ids = list({c.get("task_id") for c in comps if c.get("task_id") is not None})
    tasks_map: dict[str, dict] = {}
    if task_ids:
        tr = await sb_select_in(T_TASKS, "id", task_ids, columns="id,title,reward_rub,type,target_url,instructions", limit=500)
        for t in (tr.data or []):
            tasks_map[str(t.get("id"))] = t

    type_labels = {
        "tg": "Telegram",
        "ya": "Яндекс",
        "gm": "Google",
    }

    reports: list[dict] = []
    for c in comps:
        task = tasks_map.get(str(c.get("task_id")), {})
        reports.append({
            "id": c.get("id"),
            "task_id": c.get("task_id"),
            "title": task.get("title") or "Задание",
            "type": task.get("type") or "tg",
            "type_label": type_labels.get(str(task.get("type") or "").lower(), str(task.get("type") or "Задание")),
            "reward_rub": float(task.get("reward_rub") or 0),
            "target_url": task.get("target_url"),
            "tg_subtype": get_tg_subtype(task),
            "status": c.get("status"),
            "proof_text": c.get("proof_text"),
            "proof_url": c.get("proof_url"),
            "created_at": c.get("created_at"),
            "updated_at": c.get("moderated_at") or c.get("updated_at") or c.get("created_at"),
            "moderated_at": c.get("moderated_at"),
        })

    return web.json_response({"ok": True, "reports": reports})

async def api_report_clear(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    await sb_delete(T_COMP, {"user_id": uid})
    return web.json_response({"ok": True})


# =========================================================
# GAMIFICATION
# =========================================================

async def api_bonus_claim(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    
    try:
        # Check limit (24 hours = 86400 seconds)
        ok, wait_sec = await check_limit(uid, "daily_bonus", 24 * 3600)
        if not ok:
            hours = wait_sec // 3600
            mins = (wait_sec % 3600) // 60
            return web.json_response({"ok": False, "error": f"Бонус уже получен. Приходи через {hours}ч {mins}м"})
        
        # Claim bonus
        bonus_rub = DAILY_BONUS_RUB
        await add_rub(uid, bonus_rub)
        await touch_limit(uid, "daily_bonus")
        
        return web.json_response({"ok": True, "bonus_rub": bonus_rub})
    except Exception as e:
        _log = logging.getLogger("reviewcash")
        _log.exception("api_bonus_claim failed uid=%s: %s", uid, e)
        return web.json_response({"ok": False, "error": f"Ошибка бонуса: {type(e).__name__}: {e}"}, status=500)

async def api_leaderboard_top(req: web.Request):
    _, user = await require_init_optional(req)
    
    # 1. Top by Ruble Balance
    top_rub = []
    try:
        r = await sb_select(T_BAL, columns="user_id, rub_balance", order="rub_balance", desc=True, limit=50)
        u_ids = [x.get("user_id") for x in (r.data or [])]
        if u_ids:
            names_r = await sb_select_in(T_USERS, "user_id", u_ids, columns="user_id, username, first_name")
            names_map = {x["user_id"]: x for x in (names_r.data or [])}
            
            for i, row in enumerate(r.data or []):
                uid = row.get("user_id")
                u_info = names_map.get(uid) or {}
                top_rub.append({
                    "rank": i + 1,
                    "user_id": uid,
                    "username": u_info.get("username"),
                    "first_name": u_info.get("first_name"),
                    "score": float(row.get("rub_balance") or 0)
                })
    except Exception as e:
        log.error(f"top_rub err: {e}")

    # 2. Top by Level (XP)
    top_level = []
    try:
        r = await sb_select(T_BAL, columns="user_id, level, xp", order="xp", desc=True, limit=50)
        u_ids = [x.get("user_id") for x in (r.data or [])]
        if u_ids:
            names_r = await sb_select_in(T_USERS, "user_id", u_ids, columns="user_id, username, first_name")
            names_map = {x["user_id"]: x for x in (names_r.data or [])}
            
            for i, row in enumerate(r.data or []):
                uid = row.get("user_id")
                u_info = names_map.get(uid) or {}
                top_level.append({
                    "rank": i + 1,
                    "user_id": uid,
                    "username": u_info.get("username"),
                    "first_name": u_info.get("first_name"),
                    "score": int(row.get("level") or 1),
                    "xp": int(row.get("xp") or 0)
                })
    except Exception as e:
        log.error(f"top_level err: {e}")

    # 3. Top by Referrals
    top_refs = []
    try:
        def _f():
            return sb.table(T_USERS).select("referrer_id").not_.is_null("referrer_id").execute()
        r = await sb_exec(_f)
        refs_count = {}
        for row in (r.data or []):
            ref_id = row.get("referrer_id")
            if ref_id:
                refs_count[ref_id] = refs_count.get(ref_id, 0) + 1
        
        sorted_refs = sorted(refs_count.items(), key=lambda x: x[1], reverse=True)[:50]
        if sorted_refs:
            ref_ids = [k for k, v in sorted_refs]
            users_r = await sb_select_in(T_USERS, "user_id", ref_ids, columns="user_id, username, first_name")
            u_map = {x.get("user_id"): x for x in (users_r.data or [])}
            
            for i, (u_id, count) in enumerate(sorted_refs):
                u_info = u_map.get(u_id) or {}
                top_refs.append({
                    "rank": i + 1,
                    "user_id": u_id,
                    "username": u_info.get("username"),
                    "first_name": u_info.get("first_name"),
                    "score": count
                })
    except Exception as e:
        log.error(f"top_refs err: {e}")

    return web.json_response({
        "ok": True,
        "top_rub": top_rub,
        "top_level": top_level,
        "top_refs": top_refs
    })

