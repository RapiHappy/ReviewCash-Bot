import os
import json
import hmac
import hashlib
import asyncio
import logging
from datetime import datetime, timezone, date
from urllib.parse import parse_qsl
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from aiohttp import web

from aiogram import Bot, Dispatcher, F
from aiogram.types import (
    Message,
    CallbackQuery,
    WebAppInfo,
    PreCheckoutQuery,
    LabeledPrice,
)
from aiogram.filters import CommandStart
from aiogram.utils.keyboard import InlineKeyboardBuilder

from supabase import create_client, Client

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("reviewcash")

# =========================
# ENV
# =========================
BOT_TOKEN = os.getenv("BOT_TOKEN")  # required
SUPABASE_URL = os.getenv("SUPABASE_URL")  # required
SUPABASE_SERVICE_ROLE = os.getenv("SUPABASE_SERVICE_ROLE")  # required

ADMIN_IDS = [int(x) for x in os.getenv("ADMIN_IDS", "").split(",") if x.strip().isdigit()]

BASE_URL = os.getenv("BASE_URL", "").rstrip("/")  # e.g. https://reviewcash-bot.onrender.com
SERVER_BASE_URL = os.getenv("SERVER_BASE_URL", "").rstrip("/") or BASE_URL

PORT = int(os.getenv("PORT", "10000"))

USE_WEBHOOK = os.getenv("USE_WEBHOOK", "1") == "1"
WEBHOOK_PATH = os.getenv("WEBHOOK_PATH", "/tg/webhook")

MINIAPP_URL = os.getenv("MINIAPP_URL", "").strip()  # e.g. https://reviewcash-bot.onrender.com/app/

# CORS
CORS_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()]
if not CORS_ORIGINS:
    CORS_ORIGINS = ["*"]  # safe default for MiniApp

# anti-fraud
MAX_ACCOUNTS_PER_DEVICE = int(os.getenv("MAX_ACCOUNTS_PER_DEVICE", "2"))

# topup minimum
MIN_TOPUP_RUB = float(os.getenv("MIN_TOPUP_RUB", "300"))

# Stars rate: how many RUB per 1 star (simple default = 1 RUB per 1 Star)
STARS_RUB_RATE = float(os.getenv("STARS_RUB_RATE", "1.0"))

# =========================
# SANITY
# =========================
if not BOT_TOKEN:
    raise RuntimeError("BOT_TOKEN is missing")
if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE:
    raise RuntimeError("SUPABASE_URL / SUPABASE_SERVICE_ROLE is missing")

bot = Bot(BOT_TOKEN)
dp = Dispatcher()
sb: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE)

# =========================
# DB table names
# =========================
T_USERS = "users"
T_BAL = "balances"
T_TASKS = "tasks"
T_COMP = "task_completions"
T_DEV = "user_devices"
T_PAY = "payments"
T_WD = "withdrawals"
T_LIMITS = "user_limits"
T_STATS = "stats_daily"

# =========================
# helpers
# =========================
async def sb_exec(fn):
    return await asyncio.to_thread(fn)

def _now() -> datetime:
    return datetime.now(timezone.utc)

def _day() -> date:
    return date.today()

async def sb_upsert(table: str, row: dict, on_conflict: Optional[str] = None):
    def _f():
        return sb.table(table).upsert(row, on_conflict=on_conflict).execute()
    return await sb_exec(_f)

async def sb_insert(table: str, row: dict):
    def _f():
        return sb.table(table).insert(row).execute()
    return await sb_exec(_f)

async def sb_update(table: str, match: dict, updates: dict):
    def _f():
        q = sb.table(table).update(updates)
        for k, v in match.items():
            q = q.eq(k, v)
        return q.execute()
    return await sb_exec(_f)

async def sb_select(table: str, match: Optional[dict] = None, columns: str = "*",
                    limit: Optional[int] = None, order: Optional[str] = None, desc: bool = True):
    def _f():
        q = sb.table(table).select(columns)
        if match:
            for k, v in match.items():
                q = q.eq(k, v)
        if order:
            q = q.order(order, desc=desc)
        if limit:
            q = q.limit(limit)
        return q.execute()
    return await sb_exec(_f)

def sha256_hex(s: str) -> str:
    return hashlib.sha256((s or "").encode("utf-8")).hexdigest()

# =========================
# Telegram initData verify
# =========================
def verify_init_data(init_data: str, token: str) -> Optional[dict]:
    if not init_data:
        return None

    pairs = dict(parse_qsl(init_data, keep_blank_values=True))
    received_hash = pairs.pop("hash", None)
    if not received_hash:
        return None

    data_check_arr = [f"{k}={pairs[k]}" for k in sorted(pairs.keys())]
    data_check_string = "\n".join(data_check_arr)

    secret_key = hashlib.sha256(token.encode()).digest()
    calc_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()

    if not hmac.compare_digest(calc_hash, received_hash):
        return None

    if "user" in pairs:
        try:
            pairs["user"] = json.loads(pairs["user"])
        except Exception:
            pass

    return pairs

def get_ip(req: web.Request) -> str:
    xff = req.headers.get("X-Forwarded-For", "")
    if xff:
        return xff.split(",")[0].strip()
    return req.remote or ""

async def require_init(req: web.Request) -> Tuple[dict, dict]:
    init_data = req.headers.get("X-Tg-InitData", "")
    parsed = verify_init_data(init_data, BOT_TOKEN)
    if not parsed:
        raise web.HTTPUnauthorized(text="Bad initData (open Mini App via this bot button)")

    user = parsed.get("user") or {}
    if not user or "id" not in user:
        raise web.HTTPUnauthorized(text="No user in initData")
    return parsed, user

async def require_admin(req: web.Request) -> dict:
    _, user = await require_init(req)
    if int(user["id"]) not in ADMIN_IDS:
        raise web.HTTPForbidden(text="Not admin")
    return user

# =========================
# anti-fraud: device limits
# =========================
async def anti_fraud_check_and_touch(user_id: int, device_hash: str, ip: str, user_agent: str):
    if not device_hash:
        return True, None

    ip_hash = sha256_hex(ip)
    ua_hash = sha256_hex(user_agent)

    await sb_upsert(T_DEV, {
        "tg_user_id": user_id,
        "device_hash": device_hash,
        "last_seen_at": _now().isoformat(),
        "ip_hash": ip_hash,
        "user_agent_hash": ua_hash
    }, on_conflict="tg_user_id,device_hash")

    def _f():
        return sb.table(T_DEV).select("tg_user_id").eq("device_hash", device_hash).execute()
    res = await sb_exec(_f)
    users = {row["tg_user_id"] for row in (res.data or []) if "tg_user_id" in row}

    if len(users) > MAX_ACCOUNTS_PER_DEVICE:
        await sb_update(T_USERS, {"user_id": user_id}, {"is_banned": True})
        return False, f"Too many accounts on one device ({len(users)})."
    return True, None

# =========================
# users/balances
# =========================
async def ensure_user(user: dict, referrer_id: Optional[int] = None):
    uid = int(user["id"])
    upd = {
        "user_id": uid,
        "username": user.get("username"),
        "first_name": user.get("first_name"),
        "last_name": user.get("last_name"),
        "photo_url": user.get("photo_url"),
        "last_seen_at": _now().isoformat(),
    }
    if referrer_id and referrer_id != uid:
        upd["referrer_id"] = referrer_id

    await sb_upsert(T_USERS, upd, on_conflict="user_id")
    await sb_upsert(T_BAL, {"user_id": uid}, on_conflict="user_id")

    r = await sb_select(T_USERS, {"user_id": uid}, limit=1)
    return (r.data or [upd])[0]

async def get_balance(uid: int):
    r = await sb_select(T_BAL, {"user_id": uid}, limit=1)
    if r.data:
        return r.data[0]
    return {"user_id": uid, "rub_balance": 0, "stars_balance": 0, "xp": 0, "level": 1}

async def add_rub(uid: int, amount: float):
    bal = await get_balance(uid)
    new_val = float(bal.get("rub_balance") or 0) + float(amount)
    await sb_update(T_BAL, {"user_id": uid}, {"rub_balance": new_val, "updated_at": _now().isoformat()})
    return new_val

async def sub_rub(uid: int, amount: float) -> bool:
    bal = await get_balance(uid)
    cur = float(bal.get("rub_balance") or 0)
    if cur < float(amount):
        return False
    await sb_update(T_BAL, {"user_id": uid}, {"rub_balance": cur - float(amount), "updated_at": _now().isoformat()})
    return True

# =========================
# stats
# =========================
async def stats_add(field: str, amount: float):
    day = _day().isoformat()
    r = await sb_select(T_STATS, {"day": day}, limit=1)
    if r.data:
        cur = float(r.data[0].get(field) or 0)
        await sb_update(T_STATS, {"day": day}, {field: cur + float(amount)})
    else:
        row = {"day": day, "revenue_rub": 0, "payouts_rub": 0, "topups_rub": 0, "active_users": 0}
        row[field] = float(amount)
        await sb_insert(T_STATS, row)

# =========================
# limits (cooldown)
# =========================
YA_COOLDOWN_SEC = int(os.getenv("YA_COOLDOWN_SEC", str(3 * 24 * 3600)))
GM_COOLDOWN_SEC = int(os.getenv("GM_COOLDOWN_SEC", str(1 * 24 * 3600)))

async def check_limit(uid: int, key: str, cooldown_sec: int):
    r = await sb_select(T_LIMITS, {"user_id": uid, "limit_key": key}, limit=1)
    last_at = r.data[0].get("last_at") if r.data else None
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

# =========================
# Telegram auto-check: member status
# =========================
async def tg_is_member(chat: str, user_id: int) -> bool:
    try:
        cm = await bot.get_chat_member(chat_id=chat, user_id=user_id)
        status = getattr(cm, "status", None)
        return status in ("member", "administrator", "creator")
    except Exception as e:
        log.warning("get_chat_member failed: %s", e)
        return False

# =========================
# notify
# =========================
async def notify_admin(text: str):
    for aid in ADMIN_IDS:
        try:
            await bot.send_message(aid, text)
        except Exception:
            pass

async def notify_user(uid: int, text: str):
    try:
        await bot.send_message(uid, text)
    except Exception:
        pass

# =========================================================
# WEB API (Mini App -> backend)
# =========================================================
async def api_sync(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    body = await req.json()
    device_hash = (body.get("device_hash") or "").strip()
    ua = req.headers.get("User-Agent", "")
    ip = get_ip(req)

    ref = body.get("referrer_id")
    ref_id = int(ref) if isinstance(ref, int) else None

    urow = await ensure_user(user, referrer_id=ref_id)

    ok, reason = await anti_fraud_check_and_touch(uid, device_hash, ip, ua)
    if not ok:
        return web.json_response({"ok": False, "error": reason}, status=403)

    if urow.get("is_banned"):
        return web.json_response({"ok": False, "error": "Account banned"}, status=403)

    bal = await get_balance(uid)
    tasks = await sb_select(T_TASKS, {"status": "active"}, order="created_at", desc=True, limit=200)

    return web.json_response({
        "ok": True,
        "user": {
            "user_id": uid,
            "username": user.get("username"),
            "first_name": user.get("first_name"),
            "last_name": user.get("last_name"),
            "photo_url": user.get("photo_url"),
        },
        "balance": bal,
        "tasks": tasks.data or [],
    })

async def api_task_create(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    body = await req.json()

    ttype = (body.get("type") or "").strip()  # tg|ya|gm
    title = (body.get("title") or "").strip()
    target_url = (body.get("target_url") or "").strip()
    instructions = (body.get("instructions") or "").strip()

    reward_rub = float(body.get("reward_rub") or 0)
    cost_rub = float(body.get("cost_rub") or 0)
    qty_total = int(body.get("qty_total") or 1)

    check_type = (body.get("check_type") or "manual").strip()
    tg_chat = (body.get("tg_chat") or "").strip() or None
    tg_kind = (body.get("tg_kind") or "").strip() or None

    if ttype not in ("tg", "ya", "gm"):
        raise web.HTTPBadRequest(text="Bad type")
    if not title or not target_url:
        raise web.HTTPBadRequest(text="Missing title/target_url")
    if reward_rub <= 0 or qty_total <= 0:
        raise web.HTTPBadRequest(text="Bad reward/qty")

    if cost_rub <= 0:
        cost_rub = reward_rub * qty_total * 2.0

    total_cost = cost_rub
    ok = await sub_rub(uid, total_cost)
    if not ok:
        return web.json_response({"ok": False, "error": f"Not enough RUB. Need {total_cost:.2f}"}, status=400)

    row = {
        "owner_id": uid,
        "type": ttype,
        "tg_chat": tg_chat,
        "tg_kind": tg_kind,
        "title": title,
        "target_url": target_url,
        "instructions": instructions,
        "reward_rub": reward_rub,
        "cost_rub": cost_rub,
        "qty_total": qty_total,
        "qty_left": qty_total,
        "check_type": check_type,
        "status": "active",
    }
    ins = await sb_insert(T_TASKS, row)
    task = (ins.data or [row])[0]

    await stats_add("revenue_rub", total_cost)
    await notify_admin(f"🆕 New task: {title}\nType: {ttype}\nReward: {reward_rub}₽ x{qty_total}\nOwner: {uid}")

    return web.json_response({"ok": True, "task": task})

async def api_task_submit(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    body = await req.json()

    task_id = (body.get("task_id") or "").strip()
    proof_text = (body.get("proof_text") or "").strip()
    proof_url = (body.get("proof_url") or "").strip() or None

    if not task_id:
        raise web.HTTPBadRequest(text="Missing task_id")

    t = await sb_select(T_TASKS, {"id": task_id}, limit=1)
    if not t.data:
        return web.json_response({"ok": False, "error": "Task not found"}, status=404)
    task = t.data[0]

    if task.get("status") != "active" or int(task.get("qty_left") or 0) <= 0:
        return web.json_response({"ok": False, "error": "Task closed"}, status=400)

    # cooldown for review tasks
    if task.get("type") == "ya":
        ok_lim, rem = await check_limit(uid, "ya_review", YA_COOLDOWN_SEC)
        if not ok_lim:
            return web.json_response({"ok": False, "error": f"Limit: once per 3 days. ~{rem//3600}h left"}, status=400)
    if task.get("type") == "gm":
        ok_lim, rem = await check_limit(uid, "gm_review", GM_COOLDOWN_SEC)
        if not ok_lim:
            return web.json_response({"ok": False, "error": f"Limit: once per day. ~{rem//3600}h left"}, status=400)

    # duplicate
    dup = await sb_select(T_COMP, {"task_id": task_id, "user_id": uid}, limit=1)
    if dup.data:
        return web.json_response({"ok": False, "error": "Already submitted"}, status=400)

    is_auto = (task.get("check_type") == "auto") and (task.get("type") == "tg")
    if is_auto:
        chat = task.get("tg_chat") or ""
        if not chat:
            return web.json_response({"ok": False, "error": "TG task misconfigured (no tg_chat)"}, status=400)

        ok_member = await tg_is_member(chat, uid)
        if not ok_member:
            return web.json_response({"ok": False, "error": "Bot can't see your subscription yet. Subscribe and try again."}, status=400)

        reward = float(task.get("reward_rub") or 0)
        await add_rub(uid, reward)
        await stats_add("payouts_rub", reward)
        await sb_update(T_TASKS, {"id": task_id}, {"qty_left": int(task["qty_left"]) - 1})

        await sb_insert(T_COMP, {
            "task_id": task_id,
            "user_id": uid,
            "status": "paid",
            "proof_text": "AUTO_TG_OK",
            "proof_url": None
        })

        return web.json_response({"ok": True, "status": "paid", "earned": reward})

    # manual proof
    await sb_insert(T_COMP, {
        "task_id": task_id,
        "user_id": uid,
        "status": "pending",
        "proof_text": proof_text,
        "proof_url": proof_url
    })

    if task.get("type") == "ya":
        await touch_limit(uid, "ya_review")
    if task.get("type") == "gm":
        await touch_limit(uid, "gm_review")

    await notify_admin(f"🧾 New proof pending\nTask: {task.get('title')}\nUser: {uid}\nTaskID: {task_id}")
    return web.json_response({"ok": True, "status": "pending"})

# =========================
# T-Bank claim (manual confirm later)
# =========================
async def api_tbank_claim(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    body = await req.json()

    amount = float(body.get("amount_rub") or 0)
    sender = (body.get("sender") or "").strip()
    code = (body.get("code") or "").strip()

    if amount < MIN_TOPUP_RUB:
        return web.json_response({"ok": False, "error": f"Minimum {MIN_TOPUP_RUB:.0f}₽"}, status=400)
    if not sender or not code:
        return web.json_response({"ok": False, "error": "Missing sender/code"}, status=400)

    # prevent duplicates by provider_ref
    existing = await sb_select(T_PAY, {"provider": "tbank", "provider_ref": code}, limit=1)
    if existing.data:
        return web.json_response({"ok": True, "status": existing.data[0].get("status", "pending")})

    await sb_insert(T_PAY, {
        "user_id": uid,
        "provider": "tbank",
        "status": "pending",
        "amount_rub": amount,
        "provider_ref": code,
        "meta": {"sender": sender}
    })

    await notify_admin(f"💳 T-Bank claim\nAmount: {amount:.0f}₽\nUser: {uid}\nCode: {code}\nSender: {sender}")
    return web.json_response({"ok": True})

# =========================
# withdrawals
# =========================
async def api_withdraw_create(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    body = await req.json()

    amount = float(body.get("amount_rub") or 0)
    details = (body.get("details") or "").strip()
    if amount < 300:
        return web.json_response({"ok": False, "error": "Minimum 300₽"}, status=400)
    if not details:
        return web.json_response({"ok": False, "error": "Missing details"}, status=400)

    ok = await sub_rub(uid, amount)
    if not ok:
        return web.json_response({"ok": False, "error": "Not enough balance"}, status=400)

    wd = await sb_insert(T_WD, {
        "user_id": uid,
        "amount_rub": amount,
        "details": details,
        "status": "pending",
    })
    await notify_admin(f"🏦 Withdraw request: {amount:.0f}₽\nUser: {uid}\nID: {(wd.data or [{}])[0].get('id')}")
    return web.json_response({"ok": True, "withdrawal": (wd.data or [])[0] if wd.data else None})

async def api_withdraw_list(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    r = await sb_select(T_WD, {"user_id": uid}, order="created_at", desc=True, limit=100)
    return web.json_response({"ok": True, "withdrawals": r.data or []})

# =========================
# ops list (history)
# =========================
def _dt_key(v: Any) -> float:
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0

async def api_ops_list(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])

    pays = await sb_select(T_PAY, {"user_id": uid}, order="created_at", desc=True, limit=200)
    wds = await sb_select(T_WD, {"user_id": uid}, order="created_at", desc=True, limit=200)

    ops = []
    for p in (pays.data or []):
        ops.append({
            "kind": "payment",
            "provider": p.get("provider"),
            "status": p.get("status"),
            "amount_rub": float(p.get("amount_rub") or 0),
            "created_at": p.get("created_at"),
            "id": p.get("id"),
        })

    for w in (wds.data or []):
        ops.append({
            "kind": "withdrawal",
            "status": w.get("status"),
            "amount_rub": float(w.get("amount_rub") or 0),
            "details": w.get("details"),
            "created_at": w.get("created_at"),
            "id": w.get("id"),
        })

    ops.sort(key=lambda x: _dt_key(x.get("created_at")), reverse=True)
    return web.json_response({"ok": True, "operations": ops})

# =========================================================
# ADMIN API (proofs / withdrawals / tbank)
# =========================================================
async def api_admin_proof_list(req: web.Request):
    await require_admin(req)
    r = await sb_select(T_COMP, {"status": "pending"}, order="created_at", desc=True, limit=200)
    return web.json_response({"ok": True, "proofs": r.data or []})

async def api_admin_proof_decision(req: web.Request):
    admin = await require_admin(req)
    body = await req.json()
    proof_id = body.get("proof_id")
    approved = bool(body.get("approved"))

    if proof_id is None:
        raise web.HTTPBadRequest(text="Missing proof_id")

    r = await sb_select(T_COMP, {"id": proof_id}, limit=1)
    if not r.data:
        return web.json_response({"ok": False, "error": "Proof not found"}, status=404)
    proof = r.data[0]

    if proof.get("status") != "pending":
        return web.json_response({"ok": True, "status": proof.get("status")})

    task_id = proof.get("task_id")
    user_id = int(proof.get("user_id") or 0)

    t = await sb_select(T_TASKS, {"id": task_id}, limit=1)
    task = (t.data or [{}])[0]
    reward = float(task.get("reward_rub") or 0)

    if approved:
        await add_rub(user_id, reward)
        await stats_add("payouts_rub", reward)
        await sb_update(T_COMP, {"id": proof_id}, {"status": "paid", "moderated_by": int(admin["id"])})
        try:
            if task and int(task.get("qty_left") or 0) > 0:
                await sb_update(T_TASKS, {"id": task_id}, {"qty_left": int(task["qty_left"]) - 1})
        except Exception:
            pass
        await notify_user(user_id, f"✅ Proof approved. +{reward:.2f}₽")
    else:
        await sb_update(T_COMP, {"id": proof_id}, {"status": "rejected", "moderated_by": int(admin["id"])})
        await notify_user(user_id, "❌ Proof rejected.")

    return web.json_response({"ok": True})

async def api_admin_withdraw_list(req: web.Request):
    await require_admin(req)
    r = await sb_select(T_WD, {}, order="created_at", desc=True, limit=200)
    return web.json_response({"ok": True, "withdrawals": r.data or []})

async def api_admin_withdraw_decision(req: web.Request):
    await require_admin(req)
    body = await req.json()
    withdraw_id = body.get("withdraw_id")
    approved = bool(body.get("approved"))

    if withdraw_id is None:
        raise web.HTTPBadRequest(text="Missing withdraw_id")

    r = await sb_select(T_WD, {"id": withdraw_id}, limit=1)
    if not r.data:
        return web.json_response({"ok": False, "error": "Withdrawal not found"}, status=404)
    wd = r.data[0]
    if wd.get("status") != "pending":
        return web.json_response({"ok": True, "status": wd.get("status")})

    uid = int(wd.get("user_id") or 0)
    amount = float(wd.get("amount_rub") or 0)

    if approved:
        await sb_update(T_WD, {"id": withdraw_id}, {"status": "paid"})
        await stats_add("payouts_rub", amount)
        await notify_user(uid, "✅ Withdrawal approved. Wait for transfer.")
    else:
        await add_rub(uid, amount)
        await sb_update(T_WD, {"id": withdraw_id}, {"status": "rejected"})
        await notify_user(uid, "❌ Withdrawal rejected. Money returned.")

    return web.json_response({"ok": True})

async def api_admin_tbank_list(req: web.Request):
    await require_admin(req)
    r = await sb_select(T_PAY, {"provider": "tbank", "status": "pending"}, order="created_at", desc=True, limit=200)
    return web.json_response({"ok": True, "claims": r.data or []})

async def api_admin_tbank_decision(req: web.Request):
    await require_admin(req)
    body = await req.json()
    payment_id = body.get("payment_id")
    approved = bool(body.get("approved"))

    if payment_id is None:
        raise web.HTTPBadRequest(text="Missing payment_id")

    r = await sb_select(T_PAY, {"id": payment_id}, limit=1)
    if not r.data:
        return web.json_response({"ok": False, "error": "Payment not found"}, status=404)
    pay = r.data[0]
    if pay.get("status") != "pending":
        return web.json_response({"ok": True, "status": pay.get("status")})

    uid = int(pay.get("user_id") or 0)
    amount = float(pay.get("amount_rub") or 0)

    if approved:
        await sb_update(T_PAY, {"id": payment_id}, {"status": "paid"})
        await add_rub(uid, amount)
        await stats_add("topups_rub", amount)
        await notify_user(uid, f"✅ T-Bank topup approved: +{amount:.2f}₽")
    else:
        await sb_update(T_PAY, {"id": payment_id}, {"status": "rejected"})
        await notify_user(uid, "❌ T-Bank topup rejected.")

    return web.json_response({"ok": True})

# =========================================================
# Telegram handlers
# =========================================================
@dp.message(CommandStart())
async def cmd_start(message: Message):
    uid = message.from_user.id
    args = (message.text or "").split(maxsplit=1)
    ref = None
    if len(args) == 2 and args[1].isdigit():
        ref = int(args[1])

    await ensure_user(message.from_user.model_dump(), referrer_id=ref)

    kb = InlineKeyboardBuilder()
    miniapp_url = MINIAPP_URL or (BASE_URL + "/app/") if BASE_URL else MINIAPP_URL
    if miniapp_url:
        kb.button(text="🚀 Открыть приложение", web_app=WebAppInfo(url=miniapp_url))
    kb.button(text="📌 Инструкция", callback_data="help_newbie")

    text = (
        "👋 ReviewCash\n\n"
        "1) Открой Mini App\n"
        "2) Выполняй задания\n"
        "3) Получай ₽\n"
        "4) Выводи деньги\n\n"
        "⭐ Пополнение Stars — автоматически.\n"
        "💳 T-Bank — заявка, подтверждает админ.\n"
    )
    await message.answer(text, reply_markup=kb.as_markup())

@dp.callback_query(F.data == "help_newbie")
async def cb_help(cq: CallbackQuery):
    await cq.answer()
    await cq.message.answer(
        "📌 Как пользоваться:\n\n"
        "• Открой приложение кнопкой\n"
        "• Выбери задание и выполни\n"
        "• TG задания — нажми «Проверить»\n"
        "• Отзывы — отправь отчёт, ждёшь модерацию\n"
        "• В профиле — пополнение/вывод\n"
    )

@dp.pre_checkout_query()
async def on_pre_checkout_query(pre_checkout: PreCheckoutQuery):
    try:
        await bot.answer_pre_checkout_query(pre_checkout.id, ok=True)
    except Exception as e:
        log.warning("pre_checkout error: %s", e)

@dp.message(F.successful_payment)
async def on_successful_payment(message: Message):
    sp = message.successful_payment
    payload = sp.invoice_payload or ""
    uid = message.from_user.id

    if not payload.startswith("stars_topup:"):
        return

    try:
        pay = await sb_select(T_PAY, {"provider": "stars", "provider_ref": payload}, limit=1)
        if not pay.data:
            await message.answer("✅ Payment received, but record not found. Contact support.")
            return

        prow = pay.data[0]
        if prow.get("status") == "paid":
            return

        amount_rub = float(prow.get("amount_rub") or 0)
        await sb_update(T_PAY, {"id": prow["id"]}, {"status": "paid"})
        await add_rub(uid, amount_rub)
        await stats_add("topups_rub", amount_rub)
        await message.answer(f"✅ Stars topup success: +{amount_rub:.2f}₽")
    except Exception as e:
        log.exception("successful_payment handle error: %s", e)

@dp.message(F.web_app_data)
async def on_webapp_data(message: Message):
    uid = message.from_user.id
    try:
        payload = json.loads(message.web_app_data.data)
    except Exception:
        return await message.answer("Bad data from Mini App.")

    action = payload.get("action")

    # Stars topup
    if action == "pay_stars":
        amount = float(payload.get("amount") or 0)
        if amount < MIN_TOPUP_RUB:
            return await message.answer(f"❌ Minimum topup: {MIN_TOPUP_RUB:.0f} ₽")

        stars = int(round(amount / STARS_RUB_RATE))
        if stars <= 0:
            stars = 1

        payload_ref = f"stars_topup:{uid}:{amount:.2f}:{int(_now().timestamp())}"

        try:
            await sb_insert(T_PAY, {
                "user_id": uid,
                "provider": "stars",
                "status": "pending",
                "amount_rub": amount,
                "provider_ref": payload_ref,
                "meta": {"stars": stars, "stars_rub_rate": STARS_RUB_RATE}
            })
        except Exception as e:
            log.exception("DB insert payment(stars) failed: %s", e)
            return await message.answer("❌ DB error. Contact support.")

        prices = [LabeledPrice(label=f"Topup {amount:.0f} ₽", amount=stars)]
        try:
            await bot.send_invoice(
                chat_id=uid,
                title="Пополнение баланса",
                description=f"Пополнение на {amount:.0f} ₽ (Telegram Stars)",
                payload=payload_ref,
                provider_token="",
                currency="XTR",
                prices=prices,
            )
            return await message.answer("⭐ Инвойс отправлен. Оплати сообщение-инвойс выше.")
        except Exception as e:
            log.exception("send_invoice(XTR) failed: %s", e)
            try:
                await sb_update(T_PAY, {"provider": "stars", "provider_ref": payload_ref}, {"status": "failed"})
            except Exception:
                pass
            return await message.answer("❌ Не удалось создать инвойс. Проверь Stars в BotFather.")

    return await message.answer("✅ OK")

# =========================================================
# CORS middleware
# =========================================================
def _apply_cors_headers(req: web.Request, resp: web.StreamResponse):
    origin = req.headers.get("Origin")
    if not origin:
        return

    if "*" in CORS_ORIGINS:
        resp.headers["Access-Control-Allow-Origin"] = "*"
    elif origin in CORS_ORIGINS:
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Vary"] = "Origin"
    else:
        return

    resp.headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type, X-Tg-InitData"
    resp.headers["Access-Control-Max-Age"] = "86400"

@web.middleware
async def cors_middleware(req: web.Request, handler):
    if req.method == "OPTIONS":
        resp = web.Response(status=204)
        _apply_cors_headers(req, resp)
        return resp
    resp = await handler(req)
    _apply_cors_headers(req, resp)
    return resp

# =========================================================
# aiohttp app + webhook + static Mini App
# =========================================================
async def health(req: web.Request):
    return web.Response(text="OK")

async def tg_webhook(req: web.Request):
    update = await req.json()
    await dp.feed_webhook_update(bot, update)
    return web.Response(text="OK")

def make_app():
    app = web.Application(middlewares=[cors_middleware])

    app.router.add_get("/", health)

    # static miniapp at /app/
    base_dir = Path(__file__).resolve().parent
    static_dir = base_dir / "public"
    if static_dir.exists():
        async def app_index(req: web.Request):
            return web.FileResponse(static_dir / "index.html")

        app.router.add_get("/app", lambda req: web.HTTPFound("/app/"))
        app.router.add_get("/app/", app_index)
        app.router.add_static("/app/", path=str(static_dir), show_index=False)
    else:
        log.warning("Static dir not found: %s", static_dir)

    # tg webhook
    app.router.add_post(WEBHOOK_PATH, tg_webhook)

    # public api
    app.router.add_post("/api/sync", api_sync)
    app.router.add_post("/api/task/create", api_task_create)
    app.router.add_post("/api/task/submit", api_task_submit)

    app.router.add_post("/api/tbank/claim", api_tbank_claim)

    app.router.add_post("/api/withdraw/create", api_withdraw_create)
    app.router.add_post("/api/withdraw/list", api_withdraw_list)

    app.router.add_post("/api/ops/list", api_ops_list)

    # admin api
    app.router.add_post("/api/admin/proof/list", api_admin_proof_list)
    app.router.add_post("/api/admin/proof/decision", api_admin_proof_decision)
    app.router.add_post("/api/admin/withdraw/list", api_admin_withdraw_list)
    app.router.add_post("/api/admin/withdraw/decision", api_admin_withdraw_decision)
    app.router.add_post("/api/admin/tbank/list", api_admin_tbank_list)
    app.router.add_post("/api/admin/tbank/decision", api_admin_tbank_decision)

    return app

async def on_startup(app: web.Application):
    if USE_WEBHOOK and SERVER_BASE_URL:
        wh_url = SERVER_BASE_URL.rstrip("/") + WEBHOOK_PATH
        await bot.set_webhook(wh_url)
        log.info("Webhook set to %s", wh_url)
    else:
        asyncio.create_task(dp.start_polling(bot))
        log.info("Polling started")

async def on_cleanup(app: web.Application):
    await bot.session.close()

def main():
    app = make_app()
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    web.run_app(app, host="0.0.0.0", port=PORT)

if __name__ == "__main__":
    main()
