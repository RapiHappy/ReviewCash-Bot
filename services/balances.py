from datetime import datetime, timezone
from config import (
    XP_PER_LEVEL, XP_LEVEL_STEP, T_BAL,
    XP_EASY, XP_MEDIUM, XP_HARD, XP_MANUAL_BONUS, XP_REVIEW_BONUS, XP_MAX_PER_TASK
)
from database import sb_update, sb_select, sb_upsert

def _now():
    return datetime.now(timezone.utc)

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

async def balances_update(uid: int, updates: dict) -> bool:
    """Update balances row. If some columns don't exist (level/updated_at), retry without them."""
    updates = dict(updates or {})
    if not updates:
        return True
    # try full
    try:
        await sb_update(T_BAL, {"user_id": int(uid)}, updates)
        return True
    except Exception as e:
        # drop 'level' if missing
        if "level" in updates and _is_pgrst_missing_column(e, "level"):
            updates.pop("level", None)
            try:
                await sb_update(T_BAL, {"user_id": int(uid)}, updates)
                return True
            except Exception:
                pass
        # drop updated_at if missing
        if "updated_at" in updates and _is_pgrst_missing_column(e, "updated_at"):
            updates.pop("updated_at", None)
            try:
                await sb_update(T_BAL, {"user_id": int(uid)}, updates)
                return True
            except Exception:
                pass
        # last resort: try only numeric balances/xp keys
        slim = {k: v for k, v in updates.items() if k in ("rub_balance", "stars_balance", "xp")}
        if slim and slim != updates:
            try:
                await sb_update(T_BAL, {"user_id": int(uid)}, slim)
                return True
            except Exception:
                pass
        return False

def xp_needed_for_levelup(level: int) -> int:
    level = max(1, min(int(level or 1), 60))  # Cap level growth calculation to avoid overflow
    base = max(1, int(XP_PER_LEVEL or 100))
    mult = max(1, int(XP_LEVEL_STEP or 2))
    # Cap result to something safe for INT4/BIGINT
    val = int(base * (mult ** (level - 1)))
    return min(val, 2000000000)  # Max ~2B (safe for INT4)

def calc_level_progress(xp: int) -> dict:
    x = max(0, int(xp or 0))
    lvl = 1
    spent = 0
    need = xp_needed_for_levelup(lvl)
    while x >= spent + need:
        spent += need
        lvl += 1
        need = xp_needed_for_levelup(lvl)
    current = max(0, x - spent)
    remaining = max(0, need - current)
    return {
        "level": lvl,
        "current_xp": current,
        "next_need": need,
        "remaining": remaining,
        "total_next_level": spent + need,
    }

def calc_level(xp: int) -> int:
    return int(calc_level_progress(xp).get("level") or 1)

async def get_balance(uid: int):
    r = await sb_select(T_BAL, {"user_id": uid}, limit=1)
    if r.data:
        row = r.data[0] or {}
        # normalize possible NULLs from DB
        xp = int(row.get("xp") or 0)
        lvl = row.get("level")
        try:
            lvl = int(lvl) if lvl is not None else None
        except Exception:
            lvl = None
        calc_lvl = calc_level(xp)
        if not lvl or lvl < 1:
            lvl = calc_lvl
        # if DB stored wrong level - fix silently
        if lvl != calc_lvl:
            lvl = calc_lvl
        progress = calc_level_progress(xp)
        row["xp"] = xp
        row["level"] = lvl
        row["xp_current_level"] = int(progress.get("current_xp") or 0)
        row["xp_next_level"] = int(progress.get("next_need") or 0)
        row["xp_remaining"] = int(progress.get("remaining") or 0)
        row["xp_total_next_level"] = int(progress.get("total_next_level") or 0)
        # best-effort persist fixes
        try:
            await balances_update(uid, {"xp": xp, "level": lvl, "updated_at": _now().isoformat()})
        except Exception:
            pass
        return row
    # ensure row exists
    try:
        await sb_upsert(T_BAL, {"user_id": uid, "xp": 0, "rub_balance": 0, "stars_balance": 0}, on_conflict="user_id")
    except Exception:
        pass
    return {"user_id": uid, "rub_balance": 0, "stars_balance": 0, "xp": 0, "level": 1, "xp_current_level": 0, "xp_next_level": xp_needed_for_levelup(1), "xp_remaining": xp_needed_for_levelup(1), "xp_total_next_level": xp_needed_for_levelup(1)}

async def set_xp_level(uid: int, xp: int):
    xp = int(max(0, xp))
    lvl = calc_level(xp)
    await balances_update(uid, {"xp": xp, "level": lvl, "updated_at": _now().isoformat()})
    return xp, lvl

async def add_xp(uid: int, amount: int):
    bal = await get_balance(uid)
    cur = int(bal.get("xp") or 0)
    return await set_xp_level(uid, cur + int(amount))

async def add_rub(uid: int, amount: float):
    bal = await get_balance(uid)
    new_val = float(bal.get("rub_balance") or 0) + float(amount)
    await balances_update(uid, {"rub_balance": new_val, "updated_at": _now().isoformat()})
    return new_val

async def add_stars(uid: int, amount: int | float):
    bal = await get_balance(uid)
    cur = int(float(bal.get("stars_balance") or 0))
    add = int(round(float(amount or 0)))
    new_val = max(0, cur + add)
    await balances_update(uid, {"stars_balance": new_val, "updated_at": _now().isoformat()})
    return new_val

async def sub_rub(uid: int, amount: float) -> bool:
    bal = await get_balance(uid)
    cur = float(bal.get("rub_balance") or 0)
    if cur < float(amount):
        return False
    await balances_update(uid, {"rub_balance": cur - float(amount), "updated_at": _now().isoformat()})
    return True

async def sub_stars(uid: int, amount: int | float) -> bool:
    bal = await get_balance(uid)
    cur = int(float(bal.get("stars_balance") or 0))
    sub = int(round(float(amount or 0)))
    if cur < sub:
        return False
    await balances_update(uid, {"stars_balance": cur - sub, "updated_at": _now().isoformat()})
    return True

def task_xp(task: dict) -> int:
    """Calculate base XP for a task based on its type and check method."""
    ttype = str(task.get("type") or "").lower()
    check_type = str(task.get("check_type") or "").lower()
    
    if ttype == "tg":
        base = XP_EASY
    elif ttype in ("ya", "gm", "dg"):
        base = XP_HARD
    else:
        base = XP_MEDIUM
        
    bonus = 0
    if check_type == "manual":
        bonus += XP_MANUAL_BONUS
    if ttype in ("ya", "gm", "dg"):
        bonus += XP_REVIEW_BONUS
        
    return min(int(base + bonus), XP_MAX_PER_TASK)
