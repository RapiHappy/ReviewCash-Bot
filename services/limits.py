import os
import hashlib
from datetime import datetime, timezone, timedelta
import logging
import time
import asyncio

from config import (
    T_LIMITS, T_DEV, T_USERS, T_COMP,
    MAX_ACCOUNTS_PER_DEVICE, MAX_SUBMITS_10M, SUBMIT_WINDOW_SEC, SUBMIT_WINDOW_BLOCK_SEC,
    NEW_ACCOUNT_EXPENSIVE_LOCK_DAYS, MAIN_ADMIN_ID, TG_HOLD_PREFIX
)
from database import sb_select, sb_upsert, sb_delete, sb_update, sb_exec, sb

log = logging.getLogger("reviewcash")

# Simple async cache for feature flags and settings
GLOBAL_FF_CACHE = {} # {key: (value, expires_at)}

def _ff_get(key: str):
    now = time.time()
    if key in GLOBAL_FF_CACHE:
        val, exp = GLOBAL_FF_CACHE[key]
        if exp > now:
            return val
    return None

def _ff_set(key: str, val, ttl: int = 60):
    GLOBAL_FF_CACHE[key] = (val, time.time() + ttl)

def _ff_clear(key: str):
    if key in GLOBAL_FF_CACHE:
        del GLOBAL_FF_CACHE[key]

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

def sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()

# -------------------------
# Anti-Fraud core
# -------------------------
async def anti_fraud_check_and_touch(
    user_id: int,
    device_hash: str,
    ip: str,
    user_agent: str,
    device_id: str | None = None,
):
    if not device_hash:
        return True, None

    did = (device_id or "").strip() or device_hash
    ip_hash = sha256_hex(ip or "")
    ua_hash = sha256_hex(user_agent or "")

    try:
        await sb_upsert(
            T_DEV,
            {
                "tg_user_id": user_id,
                "device_id": did,
                "device_hash": device_hash,
                "last_seen_at": _now().isoformat(),
                "ip_hash": ip_hash,
                "user_agent_hash": ua_hash,
            },
            on_conflict="tg_user_id,device_hash",
        )
    except Exception as e:
        log.warning("user_devices upsert failed (anti-fraud bypassed): %s", e)
        return True, None

    try:
        def _f():
            return sb.table(T_DEV).select("tg_user_id").eq("device_hash", device_hash).execute()
        res = await sb_exec(_f)
        users = {row["tg_user_id"] for row in (res.data or []) if "tg_user_id" in row}
    except Exception as e:
        log.warning("user_devices select failed (anti-fraud bypassed): %s", e)
        return True, None

    if len(users) > MAX_ACCOUNTS_PER_DEVICE:
        await sb_update(T_USERS, {"user_id": user_id}, {"is_banned": True})
        return False, f"Слишком много аккаунтов на одном устройстве ({len(users)})."
    return True, None


async def can_access_expensive_tasks(uid: int) -> tuple[bool, str | None]:
    rows = await sb_select(T_USERS, {"user_id": int(uid)}, limit=1)
    if not rows.data:
        return True, None
    u = rows.data[0] or {}
    created = _parse_dt(u.get("created_at") or u.get("last_seen_at"))
    if not created:
        return True, None
    age_days = max(0, int((_now() - created).total_seconds() // 86400))
    if age_days < max(0, NEW_ACCOUNT_EXPENSIVE_LOCK_DAYS):
        return False, f"Дорогие задания доступны через {max(0, NEW_ACCOUNT_EXPENSIVE_LOCK_DAYS - age_days)} дн."
    return True, None

async def calc_user_risk_score(uid: int) -> int:
    score = 0
    rows = await sb_select(T_USERS, {"user_id": int(uid)}, limit=1)
    u = (rows.data or [None])[0] or {}
    created = _parse_dt(u.get("created_at") or u.get("last_seen_at"))
    if created:
        age_days = max(0, int((_now() - created).total_seconds() // 86400))
        if age_days <= 1:
            score += 20

    try:
        c = await sb_select(T_COMP, {"user_id": int(uid)}, order="created_at", desc=True, limit=20)
        rows = c.data or []
        failed = sum(1 for x in rows if str(x.get("status") or "").lower() in {"rejected", "fake", "fraud"})
        pending = sum(1 for x in rows if str(x.get("status") or "").lower() in {"pending", "pending_24h", "checking"})
        if failed >= 3:
            score += 15
        if pending >= 10:
            score += 10
    except Exception:
        pass

    try:
        d = await sb_select(T_DEV, {"tg_user_id": int(uid)}, limit=20)
        hashes = {str(x.get("device_hash") or "") for x in (d.data or []) if x.get("device_hash")}
        if hashes:
            cnt = set()
            for h in hashes:
                rr = await sb_exec(lambda h=h: sb.table(T_DEV).select("tg_user_id").eq("device_hash", h).execute())
                for r in (rr.data or []):
                    if r.get("tg_user_id") is not None:
                        cnt.add(int(r.get("tg_user_id")))
            if len(cnt) >= 3:
                score += 35
    except Exception:
        pass

    return min(100, max(0, int(score)))

# -------------------------
# Limits / Bans API
# -------------------------
async def get_limit_until(uid: int, key: str):
    """Return datetime until limit active, or None."""
    try:
        r = await sb_select(T_LIMITS, {"user_id": int(uid), "limit_key": str(key)}, limit=1)
        if not r.data:
            return None
        row = r.data[0] or {}
        until = _parse_dt(row.get("last_at"))
        if not until:
            return None
        if until <= _now():
            try:
                await sb_delete(T_LIMITS, {"user_id": int(uid), "limit_key": str(key)})
            except Exception:
                pass
            return None
        return until
    except Exception:
        return None

async def set_limit_until(uid: int, key: str, seconds: int):
    until = _now() + timedelta(seconds=int(max(0, seconds)))
    await sb_upsert(
        T_LIMITS,
        {"user_id": int(uid), "limit_key": str(key), "last_at": until.isoformat()},
        on_conflict="user_id,limit_key",
    )
    return until

async def clear_limit(uid: int, key: str):
    try:
        await sb_delete(T_LIMITS, {"user_id": int(uid), "limit_key": str(key)})
    except Exception:
        pass


async def check_limit(uid: int, key: str, cooldown_sec: int):
    r = await sb_select(T_LIMITS, {"user_id": uid, "limit_key": key}, limit=1)
    last_at = None
    if r.data:
        last_at = r.data[0].get("last_at")
    if not last_at:
        return True, 0
    try:
        dt = datetime.fromisoformat(str(last_at).replace("Z", "+00:00"))
    except Exception:
        return True, 0
    diff = (_now() - dt).total_seconds()
    if diff < cooldown_sec:
        return False, int(cooldown_sec - diff)
    return True, 0

async def touch_limit(uid: int, key: str):
    await sb_upsert(
        T_LIMITS,
        {"user_id": uid, "limit_key": key, "last_at": _now().isoformat()},
        on_conflict="user_id,limit_key"
    )

# -------------------------
# Task access / ban tracking
# -------------------------
TASK_BAN_KEY = "task_ban_until"
SUBMIT_WINDOW_KEY = "task_submit_window"
SUBMIT_BLOCK_KEY = "task_submit_block_until"
FIRST_WITHDRAW_DONE_KEY = "first_withdraw_done"
GLOBAL_BAN_KEY = "global_ban_until"
TBANK_BAN_KEY = "tbank_ban_until"
WITHDRAW_BAN_KEY = "withdraw_ban_until"
VIP_UNTIL_KEY = "vip_until"

TBANK_COOLDOWN_KEY = "tbank_topup_until"
TBANK_COOLDOWN_SEC = int(os.getenv("TBANK_COOLDOWN_SEC", str(24 * 3600)).strip())

CLICK_PREFIX = "clicked_task:"
CLICK_WINDOW_SEC = int(os.getenv("CLICK_WINDOW_SEC", str(6 * 3600)).strip())

CONSECUTIVE_FAKE_KEY = "consecutive_fake_strikes"

async def track_fake_report(uid: int):
    """Increment consecutive fake report counter and ban if reached 3."""
    r = await sb_select(T_LIMITS, {"user_id": int(uid), "limit_key": CONSECUTIVE_FAKE_KEY}, limit=1)
    strikes = 1
    if r.data:
        try:
            strikes = int(r.data[0].get("proof_text") or 0) + 1
        except Exception:
            strikes = 1
    
    await sb_upsert(
        T_LIMITS,
        {"user_id": int(uid), "limit_key": CONSECUTIVE_FAKE_KEY, "proof_text": str(strikes), "last_at": _now().isoformat()},
        on_conflict="user_id,limit_key"
    )
    
    if strikes >= 3:
        # Ban for 24 hours
        await set_task_ban(uid, days=1)
        # Reset strikes after ban so they can start over after ban expires
        await reset_fake_report_strikes(uid)
        return True # Banned
    return False

async def reset_fake_report_strikes(uid: int):
    try:
        await sb_delete(T_LIMITS, {"user_id": int(uid), "limit_key": CONSECUTIVE_FAKE_KEY})
    except Exception:
        pass

async def get_all_vip_uids() -> list[int]:
    """Fetch all users who currently have VIP status."""
    try:
        def _f():
            return sb.table(T_LIMITS).select("user_id").eq("limit_key", VIP_UNTIL_KEY).gt("last_at", _now().isoformat()).execute()
        res = await sb_exec(_f)
        return [int(r["user_id"]) for r in (res.data or []) if r.get("user_id")]
    except Exception:
        return []

async def get_task_ban_until(uid: int):
    return await get_limit_until(uid, TASK_BAN_KEY)

async def set_task_ban(uid: int, days: int = 3):
    until = _now() + timedelta(days=int(days))
    await sb_upsert(
        T_LIMITS,
        {"user_id": uid, "limit_key": TASK_BAN_KEY, "last_at": until.isoformat()},
        on_conflict="user_id,limit_key"
    )
    return until

async def get_submit_block_until(uid: int):
    return await get_limit_until(uid, SUBMIT_BLOCK_KEY)

async def mark_submit_attempt(uid: int, ok: bool = False):
    uid = int(uid)
    if ok:
        try:
            await clear_limit(uid, SUBMIT_WINDOW_KEY)
            await clear_limit(uid, SUBMIT_BLOCK_KEY)
        except Exception:
            pass
        return 0

    now = _now()
    row = await sb_select(T_LIMITS, {"user_id": uid, "limit_key": SUBMIT_WINDOW_KEY}, limit=1)
    count = 1
    started_at = now

    if row.data:
        prev = _parse_dt((row.data[0] or {}).get("last_at"))
        if prev and (now - prev).total_seconds() <= max(60, SUBMIT_WINDOW_SEC):
            count = max(1, MAX_SUBMITS_10M + 1)
            started_at = prev

    await sb_upsert(
        T_LIMITS,
        {
            "user_id": uid,
            "limit_key": SUBMIT_WINDOW_KEY,
            "last_at": started_at.isoformat(),
        },
        on_conflict="user_id,limit_key",
    )

    if count > max(1, MAX_SUBMITS_10M):
        await set_limit_until(uid, SUBMIT_BLOCK_KEY, max(60, SUBMIT_WINDOW_BLOCK_SEC))
    return count

async def get_vip_until(uid: int):
    return await get_limit_until(uid, VIP_UNTIL_KEY)

async def set_vip_until(uid: int, days: int = 30):
    until = _now() + timedelta(days=days)
    await sb_upsert(
        T_LIMITS,
        {"user_id": int(uid), "limit_key": VIP_UNTIL_KEY, "last_at": until.isoformat()},
        on_conflict="user_id,limit_key",
    )
    return until

async def get_global_ban_until(uid: int):
    return await get_limit_until(uid, GLOBAL_BAN_KEY)

async def get_tbank_ban_until(uid: int):
    return await get_limit_until(uid, TBANK_BAN_KEY)

async def get_withdraw_ban_until(uid: int):
    return await get_limit_until(uid, WITHDRAW_BAN_KEY)

async def get_tbank_cooldown_until(uid: int):
    try:
        r = await sb_select(T_LIMITS, {"user_id": uid, "limit_key": TBANK_COOLDOWN_KEY}, limit=1)
        if not r.data:
            return None
        until = _parse_dt(r.data[0].get("last_at"))
        if not until:
            return None
        if until <= _now():
            try:
                await sb_delete(T_LIMITS, {"user_id": uid, "limit_key": TBANK_COOLDOWN_KEY})
            except Exception:
                pass
            return None
        return until
    except Exception:
        return None

async def set_tbank_cooldown(uid: int, seconds: int = TBANK_COOLDOWN_SEC):
    until = _now() + timedelta(seconds=int(seconds))
    await sb_upsert(
        T_LIMITS,
        {"user_id": uid, "limit_key": TBANK_COOLDOWN_KEY, "last_at": until.isoformat()},
        on_conflict="user_id,limit_key"
    )
    return until


async def touch_task_click(uid: int, task_id: str):
    key = CLICK_PREFIX + str(task_id)
    await sb_upsert(
        T_LIMITS,
        {"user_id": uid, "limit_key": key, "last_at": _now().isoformat()},
        on_conflict="user_id,limit_key"
    )

async def task_click_elapsed_sec(uid: int, task_id: str) -> float | None:
    key = CLICK_PREFIX + str(task_id)
    try:
        r = await sb_select(T_LIMITS, {"user_id": uid, "limit_key": key}, limit=1)
        if not r.data:
            return None
        dt = _parse_dt(r.data[0].get("last_at"))
        if not dt:
            return None
        return float((_now() - dt).total_seconds())
    except Exception:
        return None

async def require_recent_task_click(uid: int, task_id: str) -> bool:
    elapsed = await task_click_elapsed_sec(uid, task_id)
    if elapsed is None:
        return False
    return elapsed <= CLICK_WINDOW_SEC

async def clear_task_click(uid: int, task_id: str):
    key = CLICK_PREFIX + str(task_id)
    try:
        await sb_delete(T_LIMITS, {"user_id": uid, "limit_key": key})
    except Exception:
        pass

async def clear_task_click_globally(task_id: int | str):
    """Delete clicked_task:<task_id> limit records for all users."""
    key = CLICK_PREFIX + str(task_id)
    try:
        await sb_delete(T_LIMITS, {"limit_key": key})
    except Exception as e:
        log.error(f"Failed to clear task clicks globally: {e}")


# -------------------------
# feature flags / notifications
# -------------------------
MUTE_NOTIFY_KEY = "mute_notify"
FEATURE_STARS_PAY_DISABLED_KEY = "feature_stars_pay_disabled"
COMMISSION_DISABLED_KEY = "feature_commission_disabled"
MAINTENANCE_MODE_KEY = "feature_maintenance_mode_on"

# Gender keys (user_limits)
USER_GENDER_MALE_KEY = "gender_m"
USER_GENDER_FEMALE_KEY = "gender_f"

TASK_GENDER_ANY = "any"
TASK_GENDER_MALE = "male"
TASK_GENDER_FEMALE = "female"

TG_EVT_PREFIX = "tge:"

def _feature_flags_user_id() -> int:
    try:
        return int(MAIN_ADMIN_ID or 0)
    except Exception:
        return 0

def _evt_hash(v: str) -> str:
    return hashlib.sha1(str(v or "").encode("utf-8")).hexdigest()[:20]

def tg_evt_key(event: str, value: str | None = None) -> str:
    base = f"{TG_EVT_PREFIX}{str(event or '').strip().lower()}"
    if value:
        return f"{base}:{_evt_hash(value)}"
    return base

async def tg_evt_touch(user_id: int, event: str, value: str | None = None):
    await sb_upsert(
        T_LIMITS,
        {"user_id": int(user_id), "limit_key": tg_evt_key(event, value), "last_at": _now().isoformat()},
        on_conflict="user_id,limit_key"
    )

async def tg_evt_get(user_id: int, event: str, value: str | None = None) -> datetime | None:
    r = await sb_select(T_LIMITS, {"user_id": int(user_id), "limit_key": tg_evt_key(event, value)}, limit=1)
    if not r.data:
        return None
    return _parse_dt(r.data[0].get("last_at"))

async def tg_set_gender(user_id: int, gender: str):
    g = str(gender or "").strip().lower()
    if g not in (TASK_GENDER_MALE, TASK_GENDER_FEMALE):
        return
    keep_key = USER_GENDER_MALE_KEY if g == TASK_GENDER_MALE else USER_GENDER_FEMALE_KEY
    drop_key = USER_GENDER_FEMALE_KEY if g == TASK_GENDER_MALE else USER_GENDER_MALE_KEY
    await sb_delete(T_LIMITS, {"user_id": int(user_id), "limit_key": drop_key})
    await sb_upsert(
        T_LIMITS,
        {"user_id": int(user_id), "limit_key": keep_key, "last_at": _now().isoformat()},
        on_conflict="user_id,limit_key"
    )

async def tg_get_gender(user_id: int) -> str | None:
    try:
        from database import sb_select_in
        res = await sb_select_in(T_LIMITS, "limit_key", [USER_GENDER_MALE_KEY, USER_GENDER_FEMALE_KEY], match={"user_id": int(user_id)})
        rows = res.data or []
        for r in rows:
            k = r.get("limit_key")
            if k == USER_GENDER_MALE_KEY: return TASK_GENDER_MALE
            if k == USER_GENDER_FEMALE_KEY: return TASK_GENDER_FEMALE
    except Exception:
        pass
    return None

def normalize_task_gender(value: str | None) -> str:
    v = str(value or "").strip().lower()
    if v in (TASK_GENDER_MALE, TASK_GENDER_FEMALE):
        return v
    return TASK_GENDER_ANY

async def is_maintenance_mode() -> bool:
    cached = _ff_get("maintenance_mode")
    if cached is not None: return cached
    
    ff_uid = _feature_flags_user_id()
    if ff_uid <= 0: return False
    try:
        r = await sb_select(T_LIMITS, {"user_id": ff_uid, "limit_key": MAINTENANCE_MODE_KEY}, limit=1)
        val = bool(r.data)
        _ff_set("maintenance_mode", val, ttl=30)
        return val
    except Exception:
        return False

async def set_maintenance_mode(on: bool) -> bool:
    ff_uid = _feature_flags_user_id()
    if ff_uid <= 0:
        return bool(on)
    try:
        await sb_upsert(T_USERS, {"user_id": ff_uid}, on_conflict="user_id")
    except Exception:
        pass
    if on:
        await sb_upsert(
            T_LIMITS,
            {
                "user_id": ff_uid,
                "limit_key": MAINTENANCE_MODE_KEY,
                "last_at": _now().isoformat(),
            },
            on_conflict="user_id,limit_key"
        )
    else:
        await sb_delete(T_LIMITS, {"user_id": ff_uid, "limit_key": MAINTENANCE_MODE_KEY})
    _ff_clear("maintenance_mode")
    return bool(on)

async def is_stars_payments_enabled() -> bool:
    cached = _ff_get("stars_payments")
    if cached is not None: return cached

    ff_uid = _feature_flags_user_id()
    if ff_uid <= 0: return True
    try:
        r = await sb_select(T_LIMITS, {"user_id": ff_uid, "limit_key": FEATURE_STARS_PAY_DISABLED_KEY}, limit=1)
        val = not bool(r.data)
        _ff_set("stars_payments", val, ttl=60)
        return val
    except Exception:
        return True

async def set_stars_payments_enabled(enabled: bool, admin_id: int | None = None) -> bool:
    ff_uid = _feature_flags_user_id()
    if ff_uid <= 0:
        return bool(enabled)
    try:
        await sb_upsert(T_USERS, {"user_id": ff_uid}, on_conflict="user_id")
    except Exception:
        pass

    if enabled:
        try:
            await sb_delete(T_LIMITS, {"user_id": ff_uid, "limit_key": FEATURE_STARS_PAY_DISABLED_KEY})
        except Exception:
            pass
        _ff_clear("stars_payments")
        return True

    await sb_upsert(
        T_LIMITS,
        {
            "user_id": ff_uid,
            "limit_key": FEATURE_STARS_PAY_DISABLED_KEY,
            "last_at": _now().isoformat(),
        },
        on_conflict="user_id,limit_key"
    )
    _ff_clear("stars_payments")
    return False

async def is_commission_enabled() -> bool:
    cached = _ff_get("commission_enabled")
    if cached is not None: return cached

    ff_uid = _feature_flags_user_id()
    if ff_uid <= 0: return True
    try:
        r = await sb_select(T_LIMITS, {"user_id": ff_uid, "limit_key": COMMISSION_DISABLED_KEY}, limit=1)
        val = not bool(r.data)
        _ff_set("commission_enabled", val, ttl=300)
        return val
    except Exception:
        return True

async def set_commission_enabled(enabled: bool) -> bool:
    ff_uid = _feature_flags_user_id()
    if ff_uid <= 0:
        return bool(enabled)
    try:
        await sb_upsert(T_USERS, {"user_id": ff_uid}, on_conflict="user_id")
    except Exception:
        pass
    if enabled:
        try:
            await sb_delete(T_LIMITS, {"user_id": ff_uid, "limit_key": COMMISSION_DISABLED_KEY})
        except Exception:
            pass
        _ff_clear("commission_enabled")
        return True
    await sb_upsert(
        T_LIMITS,
        {
            "user_id": ff_uid,
            "limit_key": COMMISSION_DISABLED_KEY,
            "last_at": _now().isoformat(),
        },
        on_conflict="user_id,limit_key"
    )
    _ff_clear("commission_enabled")
    return False

async def is_notify_muted(uid: int) -> bool:
    key = f"mute:{uid}"
    cached = _ff_get(key)
    if cached is not None: return cached
    try:
        r = await sb_select(T_LIMITS, {"user_id": uid, "limit_key": MUTE_NOTIFY_KEY}, limit=1)
        val = bool(r.data)
        _ff_set(key, val, ttl=300) # 5 min cache
        return val
    except Exception:
        return False

async def set_notify_muted(uid: int, muted: bool):
    key = f"mute:{uid}"
    _ff_set(key, bool(muted), ttl=300)
    if muted:
        await sb_upsert(
            T_LIMITS,
            {"user_id": uid, "limit_key": MUTE_NOTIFY_KEY, "last_at": _now().isoformat()},
            on_conflict="user_id,limit_key"
        )
    else:
        await sb_delete(T_LIMITS, {"user_id": uid, "limit_key": MUTE_NOTIFY_KEY})
async def rate_limit_get(uid: int, action: str) -> dict:
    """Get rate limit state from DB."""
    key = f"rl:{action}"
    r = await sb_select(T_LIMITS, {"user_id": int(uid), "limit_key": key}, limit=1)
    if not r.data:
        return {"last_ok": 0.0, "strikes": 0, "blocked_until": 0.0}
    
    row = r.data[0]
    # We store state as JSON in proof_text or just use multiple rows. 
    # Let's use a JSON string in a new meta field if possible, or just parse it.
    # Actually, we can just use the 'last_at' for last_ok and maybe another key for strikes.
    # To keep it simple, let's use a single row and encode strikes in a string or use a dedicated table.
    # Since we have T_LIMITS, let's use it.
    
    # We'll store: last_ok|strikes|blocked_until
    raw = str(row.get("proof_text") or "0.0|0|0.0")
    try:
        parts = raw.split("|")
        return {
            "last_ok": float(parts[0]),
            "strikes": int(parts[1]),
            "blocked_until": float(parts[2])
        }
    except Exception:
        return {"last_ok": 0.0, "strikes": 0, "blocked_until": 0.0}

async def rate_limit_set(uid: int, action: str, state: dict):
    """Save rate limit state to DB."""
    key = f"rl:{action}"
    raw = f"{state['last_ok']}|{state['strikes']}|{state['blocked_until']}"
    # last_at will be used as a TTL hint for cleanup
    await sb_upsert(
        T_LIMITS,
        {
            "user_id": int(uid),
            "limit_key": key,
            "proof_text": raw,
            "last_at": (_now() + timedelta(days=1)).isoformat()
        },
        on_conflict="user_id,limit_key"
    )

# -------------------------
# TG Hold logic
# -------------------------
async def tg_hold_get(task_id: str, user_id: int) -> datetime | None:
    key = f"{TG_HOLD_PREFIX}{task_id}"
    return await get_limit_until(user_id, key)

async def tg_hold_set(task_id: str, user_id: int, until: datetime):
    key = f"{TG_HOLD_PREFIX}{task_id}"
    await sb_upsert(
        T_LIMITS,
        {"user_id": int(user_id), "limit_key": key, "last_at": until.isoformat()},
        on_conflict="user_id,limit_key"
    )

async def tg_hold_clear(task_id: str, user_id: int):
    key = f"{TG_HOLD_PREFIX}{task_id}"
    await clear_limit(user_id, key)

async def tg_hold_list_due() -> list[dict]:
    """Returns list of {user_id, task_id} where hold is over."""
    try:
        def _f():
            return sb.table(T_LIMITS).select("*").like("limit_key", f"{TG_HOLD_PREFIX}%").lte("last_at", _now().isoformat()).execute()
        res = await sb_exec(_f)
        out = []
        for r in (res.data or []):
            key = r.get("limit_key")
            tid = tg_hold_parse_key(key)
            if tid:
                out.append({"user_id": int(r["user_id"]), "task_id": tid})
        return out
    except Exception:
        return []

def tg_hold_parse_key(key: str) -> str | None:
    if not key or not key.startswith(TG_HOLD_PREFIX): return None
    return key[len(TG_HOLD_PREFIX):]

def tg_required_retention_days(subtype: str, extra_days: int = 0) -> int:
    base = 1
    if "72h" in str(subtype): base = 3
    elif "48h" in str(subtype): base = 2
    return base + int(extra_days)

def tg_hold_delay_sec(subtype: str, extra_days: int = 0) -> int:
    return tg_required_retention_days(subtype, extra_days) * 24 * 3600

def tg_hold_delay_hours(subtype: str, extra_days: int = 0) -> int:
    return tg_required_retention_days(subtype, extra_days) * 24


async def tg_referrals_paid_since(uid: int, since: datetime) -> int:
    """Count paid referral completions for uid since a given datetime."""
    try:
        from config import T_REF
        r = await sb_select(T_REF, {"referrer_id": int(uid), "status": "paid"}, order="paid_at", desc=True, limit=1000)
        count = 0
        for row in (r.data or []):
            paid_at = _parse_dt(row.get("paid_at"))
            if paid_at and paid_at >= since:
                count += 1
        return count
    except Exception:
        return 0


async def tg_poll_answer_seen_since(uid: int, since: datetime, poll_id: str | None = None) -> bool:
    """Check if user voted in a poll since given datetime."""
    try:
        key = tg_evt_key("poll_answer", poll_id) if poll_id else tg_evt_key("poll_answer")
        dt = await tg_evt_get(uid, "poll_answer", poll_id) if poll_id else await tg_evt_get(uid, "poll_answer")
        if not dt:
            return False
        return dt >= since
    except Exception:
        return False

