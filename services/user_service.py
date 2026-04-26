import logging
import hashlib
import time
import json
from datetime import datetime, timezone, date, timedelta

from config import (
    T_USERS, T_BAL, T_REF, T_TASKS, T_COMP, T_STATS, T_LIMITS,
    REF_BONUS_RUB, REF_REVIEWS_REQUIRED, XP_PER_TASK_PAID,
    MAIN_ADMIN_ID, ADMIN_IDS
)
from database import sb, sb_select, sb_upsert, sb_insert, sb_update, sb_exec
from services.balances import add_rub, add_xp
from services.limits import get_limit_until, set_limit_until, tg_evt_touch

log = logging.getLogger("reviewcash")

def _now():
    return datetime.now(timezone.utc)

def _day():
    return date.today()

def cast_id(v):
    s = str(v or "").strip()
    if s.isdigit():
        try:
            return int(s)
        except Exception:
            return s
    return s

def _is_pgrst_missing_column(err: Exception, col: str) -> bool:
    try:
        s = str(err)
        if "PGRST204" in s and f"'{col}'" in s:
            return True
        if "Could not find" in s and f"'{col}'" in s:
            return True
    except Exception:
        pass
    return False

async def stats_add(field: str, amount: float):
    """Best-effort daily stats."""
    try:
        day_str = _day().isoformat()
        r = await sb_select(T_STATS, {"day": day_str}, limit=1)
        if r.data:
            cur = float(r.data[0].get(field) or 0)
            await sb_update(T_STATS, {"day": day_str}, {field: cur + float(amount)})
        else:
            row = {"day": day_str, "revenue_rub": 0, "payouts_rub": 0, "topups_rub": 0, "active_users": 0}
            row[field] = float(amount)
            await sb_insert(T_STATS, row)
    except Exception as e:
        log.warning("stats_add skipped (%s): %s", field, e)

async def referral_paid_reviews_count(uid: int) -> int:
    """Count paid completions for review tasks (Yandex/Google)."""
    try:
        rows = await sb_select(T_COMP, {"user_id": int(uid), "status": "paid"}, columns="task_id", order="created_at", desc=True, limit=5000)
        comp_rows = rows.data or []
        task_ids = []
        seen = set()
        for row in comp_rows:
            tid = cast_id(row.get("task_id"))
            key = str(tid)
            if not key or key in seen:
                continue
            seen.add(key)
            task_ids.append(tid)
        if not task_ids:
            return 0

        review_count = 0
        chunk_size = 100
        for i in range(0, len(task_ids), chunk_size):
            chunk = task_ids[i:i + chunk_size]
            ids_sql_parts = []
            for x in chunk:
                if isinstance(x, int):
                    ids_sql_parts.append(str(x))
                else:
                    ids_sql_parts.append('"' + str(x).replace('"', '') + '"')
            ids_sql = ",".join(ids_sql_parts)
            tasks = await sb_select(T_TASKS, filters={"id": f"in.({ids_sql})"}, columns="id,type", limit=len(chunk))
            for task in (tasks.data or []):
                if str(task.get("type") or "").lower() in ("ya", "gm"):
                    review_count += 1
        return int(review_count)
    except Exception as e:
        log.warning("referral_paid_reviews_count failed: %s", e)
        return 0

async def ensure_referral_event(referred_id: int, referrer_id: int):
    if referrer_id == referred_id:
        return
    try:
        exist = await sb_select(T_REF, {"referred_id": referred_id}, limit=1)
        if exist.data:
            return
        await sb_insert(T_REF, {
            "referred_id": referred_id,
            "referrer_id": referrer_id,
            "status": "pending",
            "bonus_rub": float(REF_BONUS_RUB),
        })
    except Exception as e:
        log.warning("ensure_referral_event failed: %s", e)

async def maybe_pay_referral_bonus(referred_id: int):
    try:
        r = await sb_select(T_REF, {"referred_id": referred_id}, limit=1)
        if not r.data:
            return
        ev = r.data[0]
        if (ev.get("status") or "") != "pending":
            return

        referrer_id = int(ev.get("referrer_id") or 0)
        if not referrer_id:
            return

        required_reviews = max(1, int(REF_REVIEWS_REQUIRED))
        paid_reviews = await referral_paid_reviews_count(referred_id)
        if paid_reviews < required_reviews:
            return

        u = await sb_select(T_USERS, {"user_id": referrer_id}, limit=1)
        if u.data and u.data[0].get("is_banned"):
            await sb_update(T_REF, {"referred_id": referred_id}, {"status": "cancelled"})
            return

        bonus = float(ev.get("bonus_rub") or REF_BONUS_RUB)
        await add_rub(referrer_id, bonus)
        await stats_add("payouts_rub", bonus)
        await add_xp(referrer_id, XP_PER_TASK_PAID)

        await sb_update(T_REF, {"referred_id": referred_id}, {
            "status": "paid",
            "paid_at": _now().isoformat()
        })

        from services.telegram_utils import notify_user
        await notify_user(referrer_id, f"🎉 Реферальный бонус: +{bonus:.2f}₽ (приглашённый выполнил {required_reviews} оплаченных отзыва)")
    except Exception as e:
        log.warning("maybe_pay_referral_bonus failed: %s", e)

async def referrals_summary(uid: int):
    try:
        c = await sb_select(T_REF, {"referrer_id": uid}, columns="referred_id,status,bonus_rub", limit=5000)
        rows = c.data or []
        count = len(rows)
        earned = sum(float(x.get("bonus_rub") or 0) for x in rows if (x.get("status") == "paid"))
        pending = sum(1 for x in rows if (x.get("status") == "pending"))
        return {"count": count, "earned_rub": earned, "pending": pending}
    except Exception:
        u = await sb_select(T_USERS, {"referrer_id": uid}, columns="user_id", limit=5000)
        return {"count": len(u.data or []), "earned_rub": 0.0, "pending": 0}

async def ensure_user(user: dict, referrer_id: int | None = None):
    uid = int(user.get("id") or user.get("user_id") or user.get("tg_user_id"))
    username = user.get("username")

    # Check if user is new (only if referrer provided)
    is_new = False
    if referrer_id and referrer_id != uid:
        existing = await sb_select(T_USERS, {"user_id": uid}, limit=1)
        is_new = not (existing.data or [])

    upd = {
        "user_id": uid,
        "username": username,
        "first_name": user.get("first_name"),
        "last_name": user.get("last_name"),
        "photo_url": user.get("photo_url"),
        "last_seen_at": _now().isoformat(),
    }

    if is_new:
        upd["referrer_id"] = referrer_id

    # Single upsert for user
    await sb_upsert(T_USERS, upd, on_conflict="user_id")
    
    # Background balance upsert
    asyncio.create_task(sb_upsert(T_BAL, {"user_id": uid}, on_conflict="user_id"))

    if is_new:
        await ensure_referral_event(uid, referrer_id)

    return upd

async def resolve_user_id(input_str: str) -> int | None:
    s = str(input_str or "").strip()
    if not s:
        return None
    if s.isdigit():
        return int(s)
    uname = s.lstrip("@").lower()
    if not uname:
        return None
    try:
        r = await sb.from_(T_USERS).select("user_id").ilike("username", uname).limit(1).execute()
        if r.data:
            return int(r.data[0].get("user_id"))
    except Exception as e:
        log.warning(f"resolve_user_id failed for '{s}': {e}")
    return None
