import os
import json
import re
import hmac
import hashlib
import asyncio
import logging
from datetime import datetime, timezone, date
from urllib.parse import parse_qsl
from pathlib import Path

from aiohttp import web

from aiogram import Bot, Dispatcher, F
from aiogram.types import (
    Message,
    CallbackQuery,
    WebAppInfo,
    PreCheckoutQuery,
    LabeledPrice,
)
from aiogram.filters import CommandStart, Command
from aiogram.utils.keyboard import InlineKeyboardBuilder

from supabase import create_client, Client

# Optional CryptoBot (можно не включать)
try:
    from aiocryptopay import AioCryptoPay, Networks
except Exception:
    AioCryptoPay = None
    Networks = None

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("reviewcash")

# -------------------------
# ENV
# -------------------------
BOT_TOKEN = os.getenv("BOT_TOKEN", "").strip()  # required
SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip()  # required
SUPABASE_SERVICE_ROLE = os.getenv("SUPABASE_SERVICE_ROLE", "").strip()  # required

ADMIN_IDS = [int(x) for x in os.getenv("ADMIN_IDS", "").split(",") if x.strip().isdigit()]

MINIAPP_URL = os.getenv("MINIAPP_URL", "").strip()       # example: https://your-service.onrender.com/app/
SERVER_BASE_URL = os.getenv("SERVER_BASE_URL", "").strip()  # example: https://your-service.onrender.com
BASE_URL = os.getenv("BASE_URL", "").strip()             # fallback base
PORT = int(os.getenv("PORT", "10000").strip())
USE_WEBHOOK = os.getenv("USE_WEBHOOK", "1").strip() == "1"
WEBHOOK_PATH = os.getenv("WEBHOOK_PATH", "/tg/webhook").strip()

# CORS
CORS_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()]

# anti-fraud
MAX_ACCOUNTS_PER_DEVICE = int(os.getenv("MAX_ACCOUNTS_PER_DEVICE", "2").strip())

# limits
YA_COOLDOWN_SEC = int(os.getenv("YA_COOLDOWN_SEC", str(3 * 24 * 3600)).strip())
GM_COOLDOWN_SEC = int(os.getenv("GM_COOLDOWN_SEC", str(1 * 24 * 3600)).strip())

# topup minimum
MIN_TOPUP_RUB = float(os.getenv("MIN_TOPUP_RUB", "300").strip())

# Stars rate: сколько рублей даёт 1 Star
STARS_RUB_RATE = float(os.getenv("STARS_RUB_RATE", "1.0").strip())

# Debug bypass (НЕ включай в проде)
DISABLE_INITDATA = os.getenv("DISABLE_INITDATA", "0").strip() == "1"

# Proof upload (Supabase Storage)
PROOF_BUCKET = os.getenv("PROOF_BUCKET", "proofs").strip() or "proofs"
MAX_PROOF_MB = int(os.getenv("MAX_PROOF_MB", "8").strip())

# Levels / XP
XP_PER_LEVEL = int(os.getenv("XP_PER_LEVEL", "100").strip())          # 100 xp = +1 lvl
XP_PER_TASK_PAID = int(os.getenv("XP_PER_TASK_PAID", "10").strip())   # за оплаченный отзыв/задачу
XP_PER_TOPUP_100 = int(os.getenv("XP_PER_TOPUP_100", "2").strip())    # за каждые 100₽ пополнения

# Referral
REF_BONUS_RUB = float(os.getenv("REF_BONUS_RUB", "50").strip())       # бонус рефереру 1 раз

# CryptoBot (optional)
CRYPTO_PAY_TOKEN = os.getenv("CRYPTO_PAY_TOKEN", "").strip()
CRYPTO_PAY_NETWORK = os.getenv("CRYPTO_PAY_NETWORK", "MAIN_NET").strip()
CRYPTO_WEBHOOK_PATH = os.getenv("CRYPTO_WEBHOOK_PATH", "/cryptobot/webhook").strip()
CRYPTO_RUB_PER_USDT = float(os.getenv("CRYPTO_RUB_PER_USDT", "100").strip())

# -------------------------
# sanity
# -------------------------
if not BOT_TOKEN:
    raise RuntimeError("BOT_TOKEN is missing in env")
if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE:
    raise RuntimeError("SUPABASE_URL / SUPABASE_SERVICE_ROLE is missing in env")

bot = Bot(BOT_TOKEN)
dp = Dispatcher()
sb: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE)

crypto = None
if CRYPTO_PAY_TOKEN and AioCryptoPay:
    crypto = AioCryptoPay(
        token=CRYPTO_PAY_TOKEN,
        network=Networks.MAIN_NET if CRYPTO_PAY_NETWORK.upper().startswith("MAIN") else Networks.TEST_NET
    )

# -------------------------
# DB table names
# -------------------------
T_USERS = "users"
T_BAL = "balances"
T_TASKS = "tasks"
T_COMP = "task_completions"
T_DEV = "user_devices"
T_PAY = "payments"
T_WD = "withdrawals"
T_LIMITS = "user_limits"
T_STATS = "stats_daily"
T_REF = "referral_events"

# -------------------------
# helpers: supabase safe exec in thread
# -------------------------
async def sb_exec(fn):
    return await asyncio.to_thread(fn)

def _now():
    return datetime.now(timezone.utc)

def _day():
    return date.today()

async def sb_upsert(table: str, row: dict, on_conflict: str | None = None):
    def _f():
        q = sb.table(table).upsert(row, on_conflict=on_conflict)
        return q.execute()
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

async def sb_delete(table: str, match: dict):
    def _f():
        q = sb.table(table).delete()
        for k, v in match.items():
            q = q.eq(k, v)
        return q.execute()
    return await sb_exec(_f)

async def sb_select(
    table: str,
    match: dict | None = None,
    columns: str = "*",
    limit: int | None = None,
    order: str | None = None,
    desc: bool = True
):
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

async def sb_select_in(
    table: str,
    col: str,
    values: list,
    columns: str = "*",
    order: str | None = None,
    desc: bool = True,
    limit: int | None = None
):
    def _f():
        q = sb.table(table).select(columns).in_(col, values)
        if order:
            q = q.order(order, desc=desc)
        if limit:
            q = q.limit(limit)
        return q.execute()
    return await sb_exec(_f)

# -------------------------
# Telegram initData verify (WebApp)
# -------------------------
def verify_init_data(init_data: str, token: str) -> dict | None:
    if not init_data:
        return None

    pairs = dict(parse_qsl(init_data, keep_blank_values=True))
    received_hash = pairs.pop("hash", None)
    if not received_hash:
        return None

    data_check_arr = [f"{k}={pairs[k]}" for k in sorted(pairs.keys())]
    data_check_string = "\n".join(data_check_arr)

    secret_key = hmac.new(b"WebAppData", token.encode("utf-8"), hashlib.sha256).digest()
    calc_hash = hmac.new(secret_key, data_check_string.encode("utf-8"), hashlib.sha256).hexdigest()

    if not hmac.compare_digest(calc_hash, received_hash):
        return None

    if "user" in pairs:
        try:
            pairs["user"] = json.loads(pairs["user"])
        except Exception:
            pass

    return pairs

# -------------------------
# anti-fraud: device limits
# -------------------------
def sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()

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

# -------------------------
# levels / balances
# -------------------------
def calc_level(xp: int) -> int:
    if XP_PER_LEVEL <= 0:
        return 1
    return max(1, (int(xp) // int(XP_PER_LEVEL)) + 1)

async def get_balance(uid: int):
    r = await sb_select(T_BAL, {"user_id": uid}, limit=1)
    if r.data:
        return r.data[0]
    return {"user_id": uid, "rub_balance": 0, "stars_balance": 0, "xp": 0, "level": 1}

async def set_xp_level(uid: int, xp: int):
    xp = int(max(0, xp))
    lvl = calc_level(xp)
    await sb_update(T_BAL, {"user_id": uid}, {"xp": xp, "level": lvl, "updated_at": _now().isoformat()})
    return xp, lvl

async def add_xp(uid: int, amount: int):
    bal = await get_balance(uid)
    cur = int(bal.get("xp") or 0)
    return await set_xp_level(uid, cur + int(amount))

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

# -------------------------
# stats
# -------------------------
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

# -------------------------
# referral system (bonus 1 time after first paid task)
# -------------------------
async def ensure_referral_event(referred_id: int, referrer_id: int):
    if referrer_id == referred_id:
        return
    # если уже есть — не трогаем
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

        # проверим что реферер не забанен
        u = await sb_select(T_USERS, {"user_id": referrer_id}, limit=1)
        if u.data and u.data[0].get("is_banned"):
            await sb_update(T_REF, {"referred_id": referred_id}, {"status": "cancelled"})
            return

        bonus = float(ev.get("bonus_rub") or REF_BONUS_RUB)

        await add_rub(referrer_id, bonus)
        await stats_add("payouts_rub", bonus)

        await add_xp(referrer_id, XP_PER_TASK_PAID)  # небольшой бонус XP рефереру

        await sb_update(T_REF, {"referred_id": referred_id}, {
            "status": "paid",
            "paid_at": _now().isoformat()
        })

        await notify_user(referrer_id, f"🎉 Реферальный бонус: +{bonus:.2f}₽ (приглашённый выполнил первое задание)")
    except Exception as e:
        log.warning("maybe_pay_referral_bonus failed: %s", e)

async def referrals_summary(uid: int):
    # count
    try:
        c = await sb_select(T_REF, {"referrer_id": uid}, columns="referred_id,status,bonus_rub", limit=5000)
        rows = c.data or []
        count = len(rows)
        earned = sum(float(x.get("bonus_rub") or 0) for x in rows if (x.get("status") == "paid"))
        pending = sum(1 for x in rows if (x.get("status") == "pending"))
        return {"count": count, "earned_rub": earned, "pending": pending}
    except Exception:
        # fallback via users.referrer_id
        u = await sb_select(T_USERS, {"referrer_id": uid}, columns="user_id", limit=5000)
        return {"count": len(u.data or []), "earned_rub": 0.0, "pending": 0}

# -------------------------
# users
# -------------------------
async def ensure_user(user: dict, referrer_id: int | None = None):
    uid = int(user["id"])

    # узнаём новый ли пользователь
    existing = await sb_select(T_USERS, {"user_id": uid}, limit=1)
    is_new = not (existing.data or [])

    upd = {
        "user_id": uid,
        "username": user.get("username"),
        "first_name": user.get("first_name"),
        "last_name": user.get("last_name"),
        "photo_url": user.get("photo_url"),
        "last_seen_at": _now().isoformat(),
    }

    # referrer записываем только при первом входе и если ещё не установлен
    if is_new and referrer_id and referrer_id != uid:
        upd["referrer_id"] = referrer_id

    await sb_upsert(T_USERS, upd, on_conflict="user_id")
    await sb_upsert(T_BAL, {"user_id": uid}, on_conflict="user_id")

    # создаём referral_event (pending) только если новый и referrer есть
    if is_new and referrer_id and referrer_id != uid:
        await ensure_referral_event(uid, referrer_id)

    u = await sb_select(T_USERS, {"user_id": uid}, limit=1)
    return (u.data or [upd])[0]

# -------------------------
# limits (ya/gm cooldown)
# -------------------------
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
# Telegram auto-check: member status
# -------------------------
async def tg_is_member(chat: str, user_id: int) -> bool:
    try:
        cm = await bot.get_chat_member(chat_id=chat, user_id=user_id)
        status = getattr(cm, "status", None)
        return status in ("member", "administrator", "creator")
    except Exception as e:
        log.warning("get_chat_member failed: %s", e)
        return False

# -------------------------
# notify helpers
# -------------------------
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
def get_ip(req: web.Request) -> str:
    xff = req.headers.get("X-Forwarded-For", "")
    if xff:
        return xff.split(",")[0].strip()
    return req.remote or ""

async def safe_json(req: web.Request) -> dict:
    try:
        return await req.json()
    except Exception:
        return {}

def parse_amount_rub(v) -> float | None:
    if v is None:
        return None
    if isinstance(v, (int, float)):
        try:
            return float(v)
        except Exception:
            return None

    s = str(v).strip()
    if not s:
        return None

    s = s.replace("₽", "")
    s = s.replace("RUB", "").replace("rub", "")
    s = s.replace("\u00a0", "").replace("\xa0", "")
    s = s.replace(" ", "")
    s = s.replace(",", ".")
    s = re.sub(r"[^0-9.]", "", s)

    if s.count(".") > 1:
        parts = s.split(".")
        s = "".join(parts[:-1]) + "." + parts[-1]

    try:
        return float(s)
    except Exception:
        return None

async def require_init(req: web.Request) -> tuple[dict, dict]:
    if DISABLE_INITDATA:
        mock_user = {"id": 123456, "username": "dev", "first_name": "Dev", "last_name": "Mode", "photo_url": None}
        return {"user": mock_user, "auth_date": str(int(_now().timestamp()))}, mock_user

    init_data = req.headers.get("X-Tg-InitData", "")
    parsed = verify_init_data(init_data, BOT_TOKEN)
    if not parsed:
        raise web.HTTPUnauthorized(
            text="Bad initData signature (hash mismatch). Проверь BOT_TOKEN и что MiniApp открыт внутри Telegram."
        )

    user = parsed.get("user") or {}
    if not user or "id" not in user:
        raise web.HTTPUnauthorized(text="No user in initData")
    return parsed, user

async def require_admin(req: web.Request) -> dict:
    _, user = await require_init(req)
    if int(user["id"]) not in ADMIN_IDS:
        raise web.HTTPForbidden(text="Not admin")
    return user

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
    _, user = await require_init(req)
    body = await safe_json(req)

    uid = int(user["id"])
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

    if urow.get("is_banned"):
        return web.json_response({"ok": False, "error": "Аккаунт заблокирован"}, status=403)

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

# -------------------------
# Proof upload (Supabase Storage)
# -------------------------
def safe_filename(name: str) -> str:
    name = (name or "proof").strip()
    name = re.sub(r"[^a-zA-Z0-9._-]+", "_", name)
    return name[:80] or "proof.png"

async def sb_storage_upload(bucket: str, path: str, data: bytes, content_type: str):
    def _f():
        return sb.storage.from_(bucket).upload(
            path=path,
            file=data,
            file_options={"content-type": content_type, "upsert": "true"},
        )
    return await sb_exec(_f)

async def sb_storage_public_url(bucket: str, path: str) -> str:
    def _f():
        return sb.storage.from_(bucket).get_public_url(path)
    return await sb_exec(_f)

async def api_proof_upload(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])

    reader = await req.multipart()
    file_field = None
    while True:
        part = await reader.next()
        if part is None:
            break
        if part.name == "file":
            file_field = part
            break

    if not file_field:
        return web.json_response({"ok": False, "error": "Нет файла (field=file)"}, status=400)

    filename = safe_filename(file_field.filename or "proof.png")
    content_type = file_field.headers.get("Content-Type", "application/octet-stream")

    limit = MAX_PROOF_MB * 1024 * 1024
    buf = bytearray()
    while True:
        chunk = await file_field.read_chunk(size=256 * 1024)
        if not chunk:
            break
        buf.extend(chunk)
        if len(buf) > limit:
            return web.json_response({"ok": False, "error": f"Файл слишком большой (>{MAX_PROOF_MB}MB)"}, status=413)

    ts = int(_now().timestamp())
    path = f"{uid}/{ts}_{filename}"

    try:
        await sb_storage_upload(PROOF_BUCKET, path, bytes(buf), content_type)
        url = await sb_storage_public_url(PROOF_BUCKET, path)
    except Exception as e:
        log.exception("proof upload failed: %s", e)
        return web.json_response({"ok": False, "error": "Не удалось загрузить доказательство"}, status=500)

    return web.json_response({"ok": True, "url": url, "path": path})

# -------------------------
# API: create task
# -------------------------
async def api_task_create(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    body = await safe_json(req)

    ttype = str(body.get("type") or "").strip()  # tg|ya|gm
    title = str(body.get("title") or "").strip()
    target_url = str(body.get("target_url") or "").strip()
    instructions = str(body.get("instructions") or "").strip()
    reward_rub = float(body.get("reward_rub") or 0)
    cost_rub = float(body.get("cost_rub") or 0)
    qty_total = int(body.get("qty_total") or 1)
    check_type = str(body.get("check_type") or "manual").strip()
    tg_chat = str(body.get("tg_chat") or "").strip() or None
    tg_kind = str(body.get("tg_kind") or "").strip() or None
    sub_type = str(body.get("sub_type") or "").strip() or None

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
        return web.json_response({"ok": False, "error": f"Недостаточно RUB. Нужно {total_cost:.2f}"}, status=400)

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

    if sub_type:
        row["instructions"] = (instructions + "\n\nTG_SUBTYPE: " + sub_type).strip()

    ins = await sb_insert(T_TASKS, row)
    task = (ins.data or [row])[0]

    await stats_add("revenue_rub", total_cost)
    await notify_admin(f"🆕 Новое задание: {title}\nТип: {ttype}\nНаграда: {reward_rub}₽ x{qty_total}\nOwner: {uid}")

    return web.json_response({"ok": True, "task": task})

# -------------------------
# API: submit task
# -------------------------
async def api_task_submit(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    body = await safe_json(req)

    task_id = str(body.get("task_id") or "").strip()
    proof_text = str(body.get("proof_text") or "").strip()
    proof_url = str(body.get("proof_url") or "").strip() or None

    if not task_id:
        raise web.HTTPBadRequest(text="Missing task_id")

    t = await sb_select(T_TASKS, {"id": task_id}, limit=1)
    if not t.data:
        return web.json_response({"ok": False, "error": "Task not found"}, status=404)
    task = t.data[0]

    if task.get("status") != "active" or int(task.get("qty_left") or 0) <= 0:
        return web.json_response({"ok": False, "error": "Task closed"}, status=400)

    # cooldown for reviews
    if task.get("type") == "ya":
        ok_lim, rem = await check_limit(uid, "ya_review", YA_COOLDOWN_SEC)
        if not ok_lim:
            return web.json_response({"ok": False, "error": f"Лимит: раз в 3 дня. Осталось ~{rem//3600}ч"}, status=400)
    if task.get("type") == "gm":
        ok_lim, rem = await check_limit(uid, "gm_review", GM_COOLDOWN_SEC)
        if not ok_lim:
            return web.json_response({"ok": False, "error": f"Лимит: раз в день. Осталось ~{rem//3600}ч"}, status=400)

    # duplicate check
    dup = await sb_select(T_COMP, {"task_id": task_id, "user_id": uid}, limit=1)
    if dup.data:
        return web.json_response({"ok": False, "error": "Уже отправляли выполнение"}, status=400)

    is_auto = (task.get("check_type") == "auto") and (task.get("type") == "tg")
    if is_auto:
        chat = task.get("tg_chat") or ""
        if not chat:
            return web.json_response({"ok": False, "error": "TG task misconfigured (no tg_chat)"}, status=400)

        ok_member = await tg_is_member(chat, uid)
        if not ok_member:
            return web.json_response({"ok": False, "error": "Бот не видит подписку/участие. Подпишись и попробуй снова."}, status=400)

        reward = float(task.get("reward_rub") or 0)
        await add_rub(uid, reward)
        await stats_add("payouts_rub", reward)

        # XP + maybe referral payout
        await add_xp(uid, XP_PER_TASK_PAID)
        await maybe_pay_referral_bonus(uid)

        try:
            left = int(task.get("qty_left") or 0)
            if left > 0:
                await sb_update(T_TASKS, {"id": task_id}, {"qty_left": left - 1})
        except Exception:
            pass

        await sb_insert(T_COMP, {
            "task_id": task_id,
            "user_id": uid,
            "status": "paid",
            "proof_text": "AUTO_TG_OK",
            "proof_url": None,
            "moderated_at": _now().isoformat(),
        })

        return web.json_response({"ok": True, "status": "paid", "earned": reward})

    # manual proof: обязательно нужен proof_url
    if not proof_url:
        return web.json_response({"ok": False, "error": "Нужен скриншот доказательства"}, status=400)

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

    await notify_admin(f"🧾 Новый отчет на проверку\nTask: {task.get('title')}\nUser: {uid}\nTaskID: {task_id}")
    return web.json_response({"ok": True, "status": "pending"})

# -------------------------
# withdraw
# -------------------------
async def api_withdraw_create(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    body = await safe_json(req)

    amount = parse_amount_rub(body.get("amount_rub") or body.get("amount") or body.get("sum") or body.get("value") or body.get("rub"))
    if amount is None:
        return web.json_response({"ok": False, "error": "Некорректная сумма"}, status=400)

    details = str(body.get("details") or body.get("requisites") or body.get("requisites_text") or body.get("card") or body.get("wallet") or "").strip()

    if amount < 300:
        return web.json_response({"ok": False, "error": "Минимум 300₽"}, status=400)
    if not details:
        return web.json_response({"ok": False, "error": "Укажи реквизиты"}, status=400)

    ok = await sub_rub(uid, amount)
    if not ok:
        return web.json_response({"ok": False, "error": "Недостаточно средств"}, status=400)

    wd = await sb_insert(T_WD, {
        "user_id": uid,
        "amount_rub": amount,
        "details": details,
        "status": "pending",
    })

    wd_row = (wd.data or [None])[0]
    await notify_admin(f"🏦 Заявка на вывод: {amount}₽\nUser: {uid}\nID: {wd_row.get('id') if wd_row else 'n/a'}")
    return web.json_response({"ok": True, "withdrawal": wd_row})

async def api_withdraw_list(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    r = await sb_select(T_WD, {"user_id": uid}, order="created_at", desc=True, limit=100)
    return web.json_response({"ok": True, "withdrawals": r.data or []})

# -------------------------
# T-Bank claim (Mini App -> API)
# -------------------------
async def api_tbank_claim(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    body = await safe_json(req)

    amount = parse_amount_rub(body.get("amount_rub") or body.get("amount") or body.get("sum") or body.get("value") or body.get("rub"))
    if amount is None:
        return web.json_response({"ok": False, "error": "Некорректная сумма"}, status=400)

    sender = str(body.get("sender") or body.get("name") or body.get("from") or body.get("payer") or "").strip()
    code = str(body.get("code") or body.get("comment") or body.get("payment_code") or body.get("provider_ref") or body.get("reference") or "").strip()

    if amount < MIN_TOPUP_RUB:
        return web.json_response({"ok": False, "error": f"Минимум {MIN_TOPUP_RUB:.0f}₽"}, status=400)
    if not sender:
        return web.json_response({"ok": False, "error": "Укажи имя отправителя"}, status=400)
    if not code:
        return web.json_response({"ok": False, "error": "Нет кода платежа"}, status=400)

    await sb_insert(T_PAY, {
        "user_id": uid,
        "provider": "tbank",
        "status": "pending",
        "amount_rub": amount,
        "provider_ref": code,
        "meta": {"sender": sender}
    })

    await notify_admin(f"💳 T-Bank заявка\nСумма: {amount}₽\nUser: {uid}\nCode: {code}\nSender: {sender}")
    return web.json_response({"ok": True})

# -------------------------
# Telegram Stars (Mini App -> API): create invoice link
# -------------------------
async def api_stars_link(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    body = await safe_json(req)

    amount = parse_amount_rub(body.get("amount_rub") or body.get("amount") or body.get("sum") or body.get("value") or body.get("rub"))
    if amount is None:
        return web.json_response({"ok": False, "error": "Некорректная сумма"}, status=400)
    if amount < MIN_TOPUP_RUB:
        return web.json_response({"ok": False, "error": f"Минимум {MIN_TOPUP_RUB:.0f}₽"}, status=400)

    stars = int(round(float(amount) / STARS_RUB_RATE))
    if stars <= 0:
        stars = 1

    payload_ref = f"stars_topup:{uid}:{float(amount):.2f}:{int(_now().timestamp())}"

    try:
        await sb_insert(T_PAY, {
            "user_id": uid,
            "provider": "stars",
            "status": "pending",
            "amount_rub": float(amount),
            "provider_ref": payload_ref,
            "meta": {"stars": stars, "stars_rub_rate": STARS_RUB_RATE}
        })
    except Exception as e:
        log.exception("DB insert payment(stars) failed: %s", e)
        return web.json_response({"ok": False, "error": "Ошибка записи платежа"}, status=500)

    prices = [LabeledPrice(label=f"Пополнение {float(amount):.0f} ₽", amount=stars)]

    try:
        invoice_link = None
        if hasattr(bot, "create_invoice_link"):
            invoice_link = await bot.create_invoice_link(
                title="Пополнение баланса",
                description=f"Пополнение баланса на {float(amount):.0f} ₽ (Telegram Stars)",
                payload=payload_ref,
                provider_token="",
                currency="XTR",
                prices=prices,
            )
        else:
            await bot.send_invoice(
                chat_id=uid,
                title="Пополнение баланса",
                description=f"Пополнение баланса на {float(amount):.0f} ₽ (Telegram Stars)",
                payload=payload_ref,
                provider_token="",
                currency="XTR",
                prices=prices,
            )

        return web.json_response({
            "ok": True,
            "amount_rub": float(amount),
            "stars": stars,
            "payload": payload_ref,
            "invoice_link": invoice_link,
        })
    except Exception as e:
        log.exception("create_invoice_link/send_invoice(XTR) failed: %s", e)
        try:
            await sb_update(T_PAY, {"provider": "stars", "provider_ref": payload_ref}, {"status": "failed"})
        except Exception:
            pass
        return web.json_response({"ok": False, "error": "Не удалось создать инвойс Stars"}, status=500)

# -------------------------
# CryptoBot create invoice (optional)
# -------------------------
async def api_cryptobot_create(req: web.Request):
    if not crypto:
        return web.json_response({"ok": False, "error": "CryptoBot not configured"}, status=500)

    _, user = await require_init(req)
    uid = int(user["id"])
    body = await safe_json(req)

    amount = float(body.get("amount_rub") or 0)
    if amount < MIN_TOPUP_RUB:
        return web.json_response({"ok": False, "error": f"Минимум {MIN_TOPUP_RUB:.0f}₽"}, status=400)

    usdt = round(amount / CRYPTO_RUB_PER_USDT, 2)
    inv = await crypto.create_invoice(asset="USDT", amount=usdt, description=f"Topup {amount} RUB for {uid}")

    await sb_insert(T_PAY, {
        "user_id": uid,
        "provider": "cryptobot",
        "status": "pending",
        "amount_rub": amount,
        "provider_ref": str(inv.invoice_id),
        "meta": {"asset": "USDT", "amount_asset": usdt}
    })

    return web.json_response({"ok": True, "pay_url": inv.pay_url, "invoice_id": inv.invoice_id})

async def cryptobot_webhook(req: web.Request):
    if not crypto:
        return web.Response(text="no cryptobot", status=200)

    data = await safe_json(req)
    try:
        update = data.get("update", {})
        inv = update.get("payload", {}) or update.get("invoice", {}) or update
        invoice_id = str(inv.get("invoice_id") or inv.get("id") or "")
        status = str(inv.get("status") or "").lower()

        if not invoice_id:
            return web.Response(text="ok", status=200)

        pay = await sb_select(T_PAY, {"provider": "cryptobot", "provider_ref": invoice_id}, limit=1)
        if not pay.data:
            return web.Response(text="ok", status=200)

        prow = pay.data[0]
        if prow.get("status") == "paid":
            return web.Response(text="ok", status=200)

        if status in ("paid", "completed"):
            uid = int(prow["user_id"])
            amount = float(prow.get("amount_rub") or 0)
            await sb_update(T_PAY, {"id": prow["id"]}, {"status": "paid"})
            await add_rub(uid, amount)
            await stats_add("topups_rub", amount)

            # XP за пополнение
            xp_add = int((amount // 100) * XP_PER_TOPUP_100)
            if xp_add > 0:
                await add_xp(uid, xp_add)

            await notify_user(uid, f"✅ Пополнение успешно: +{amount:.2f}₽")

        return web.Response(text="ok", status=200)
    except Exception as e:
        log.exception("cryptobot webhook error: %s", e)
        return web.Response(text="ok", status=200)

# -------------------------
# ops list
# -------------------------
def _dt_key(v: str):
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
# ADMIN API
# =========================================================
async def api_admin_summary(req: web.Request):
    await require_admin(req)

    proofs = await sb_select(T_COMP, {"status": "pending"}, limit=1000)
    wds = await sb_select(T_WD, {"status": "pending"}, limit=1000)

    def _f():
        return sb.table(T_PAY).select("id").eq("provider", "tbank").eq("status", "pending").execute()
    tp = await sb_exec(_f)

    return web.json_response({
        "ok": True,
        "counts": {
            "proofs": len(proofs.data or []),
            "withdrawals": len(wds.data or []),
            "tbank": len(tp.data or []),
        }
    })

async def api_admin_proof_list(req: web.Request):
    await require_admin(req)
    r = await sb_select(T_COMP, {"status": "pending"}, order="created_at", desc=True, limit=200)
    comps = r.data or []

    task_ids = list({c.get("task_id") for c in comps if c.get("task_id")})
    tasks_map = {}
    if task_ids:
        tr = await sb_select_in(T_TASKS, "id", task_ids, columns="id,title,reward_rub,target_url,type,owner_id", limit=500)
        for t in (tr.data or []):
            tasks_map[str(t["id"])] = t

    out = []
    for c in comps:
        tid = str(c.get("task_id"))
        t = tasks_map.get(tid)
        out.append({
            "id": c.get("id"),
            "task_id": c.get("task_id"),
            "user_id": c.get("user_id"),
            "proof_text": c.get("proof_text"),
            "proof_url": c.get("proof_url"),
            "created_at": c.get("created_at"),
            "task": t
        })

    return web.json_response({"ok": True, "proofs": out})

async def api_admin_proof_decision(req: web.Request):
    admin = await require_admin(req)
    body = await safe_json(req)

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

        # XP + referral bonus (after first paid task)
        await add_xp(user_id, XP_PER_TASK_PAID)
        await maybe_pay_referral_bonus(user_id)

        await sb_update(T_COMP, {"id": proof_id}, {
            "status": "paid",
            "moderated_by": int(admin["id"]),
            "moderated_at": _now().isoformat(),
        })

        try:
            left = int(task.get("qty_left") or 0)
            if left > 0:
                await sb_update(T_TASKS, {"id": task_id}, {"qty_left": left - 1})
        except Exception:
            pass

        await notify_user(user_id, f"✅ Отчёт принят. Начислено +{reward:.2f}₽")
    else:
        await sb_update(T_COMP, {"id": proof_id}, {
            "status": "rejected",
            "moderated_by": int(admin["id"]),
            "moderated_at": _now().isoformat(),
        })
        await notify_user(user_id, "❌ Отчёт отклонён модератором.")

    return web.json_response({"ok": True})

async def api_admin_withdraw_list(req: web.Request):
    await require_admin(req)
    r = await sb_select(T_WD, {}, order="created_at", desc=True, limit=200)
    return web.json_response({"ok": True, "withdrawals": r.data or []})

async def api_admin_withdraw_decision(req: web.Request):
    await require_admin(req)
    body = await safe_json(req)

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
        await notify_user(uid, "✅ Заявка на вывод подтверждена. Ожидай перевод.")
    else:
        await add_rub(uid, amount)
        await sb_update(T_WD, {"id": withdraw_id}, {"status": "rejected"})
        await notify_user(uid, "❌ Заявка на вывод отклонена. Средства возвращены на баланс.")

    return web.json_response({"ok": True})

async def api_admin_tbank_list(req: web.Request):
    await require_admin(req)

    def _f():
        return sb.table(T_PAY).select("*").eq("provider", "tbank").eq("status", "pending").order("created_at", desc=True).limit(200).execute()
    r = await sb_exec(_f)
    return web.json_response({"ok": True, "tbank": r.data or []})

async def api_admin_tbank_decision(req: web.Request):
    await require_admin(req)
    body = await safe_json(req)

    payment_id = body.get("payment_id")
    approved = bool(body.get("approved"))

    if payment_id is None:
        raise web.HTTPBadRequest(text="Missing payment_id")

    r = await sb_select(T_PAY, {"id": payment_id}, limit=1)
    if not r.data:
        return web.json_response({"ok": False, "error": "Payment not found"}, status=404)
    pay = r.data[0]

    if pay.get("provider") != "tbank":
        return web.json_response({"ok": False, "error": "Not tbank payment"}, status=400)
    if pay.get("status") != "pending":
        return web.json_response({"ok": True, "status": pay.get("status")})

    uid = int(pay.get("user_id") or 0)
    amount = float(pay.get("amount_rub") or 0)

    if approved:
        await sb_update(T_PAY, {"id": payment_id}, {"status": "paid"})
        await add_rub(uid, amount)
        await stats_add("topups_rub", amount)

        xp_add = int((amount // 100) * XP_PER_TOPUP_100)
        if xp_add > 0:
            await add_xp(uid, xp_add)

        await notify_user(uid, f"✅ T-Bank пополнение подтверждено: +{amount:.2f}₽")
    else:
        await sb_update(T_PAY, {"id": payment_id}, {"status": "rejected"})
        await notify_user(uid, "❌ T-Bank пополнение отклонено администратором.")

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

    miniapp_url = MINIAPP_URL
    if not miniapp_url:
        base = SERVER_BASE_URL or BASE_URL
        if base:
            miniapp_url = base.rstrip("/") + "/app/"

    if miniapp_url:
        kb.button(text="🚀 Открыть приложение", web_app=WebAppInfo(url=miniapp_url))

    kb.button(text="📌 Инструкция новичку", callback_data="help_newbie")

    text = (
        "👋 Добро пожаловать в ReviewCash!\n\n"
        "Как это работает:\n"
        "1) Открываешь Mini App\n"
        "2) Выбираешь задание и выполняешь\n"
        "3) Отправляешь отчет (или авто-проверка TG)\n"
        "4) Получаешь ₽ на баланс\n"
        "5) Оформляешь вывод\n\n"
        f"🎁 Рефералка: бонус {REF_BONUS_RUB:.0f}₽ за друга, когда он выполнит первое задание.\n"
        "⚡ TG задания проверяются автоматически, если бот добавлен в чат и может проверять участников.\n"
    )
    await message.answer(text, reply_markup=kb.as_markup())

@dp.callback_query(F.data == "help_newbie")
async def cb_help(cq: CallbackQuery):
    await cq.answer()
    await cq.message.answer(
        "📌 Инструкция:\n\n"
        "• Открой «Задания» и нажми «Выполнить»\n"
        "• TG — подпишись/вступи и нажми «Проверить»\n"
        "• Отзывы — прикрепи скрин и отправь на модерацию\n"
        "• В профиле можно пополнить и вывести\n"
    )

@dp.message(Command("me"))
async def cmd_me(message: Message):
    uid = message.from_user.id
    bal = await get_balance(uid)
    ref = await referrals_summary(uid)
    await message.answer(
        "👤 Профиль\n"
        f"Баланс: {float(bal.get('rub_balance') or 0):.0f} ₽\n"
        f"XP: {int(bal.get('xp') or 0)} | LVL: {int(bal.get('level') or 1)}\n\n"
        "👥 Рефералы\n"
        f"Друзей: {ref['count']}\n"
        f"Заработано: {ref['earned_rub']:.0f} ₽\n"
        f"Ожидают бонуса: {ref.get('pending', 0)}"
    )

# Stars платежи: Telegram требует PreCheckout ok=True
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
            await message.answer("✅ Платеж получен, но запись не найдена. Напишите в поддержку.")
            return

        prow = pay.data[0]
        if prow.get("status") == "paid":
            return

        amount_rub = float(prow.get("amount_rub") or 0)
        await sb_update(T_PAY, {"id": prow["id"]}, {"status": "paid"})
        await add_rub(uid, amount_rub)
        await stats_add("topups_rub", amount_rub)

        xp_add = int((amount_rub // 100) * XP_PER_TOPUP_100)
        if xp_add > 0:
            await add_xp(uid, xp_add)

        await message.answer(f"✅ Пополнение Stars успешно: +{amount_rub:.2f}₽")
    except Exception as e:
        log.exception("successful_payment handle error: %s", e)

# -------------------------
# CORS middleware
# -------------------------
def _apply_cors_headers(req: web.Request, resp: web.StreamResponse):
    origin = req.headers.get("Origin")
    if not origin:
        return

    if not CORS_ORIGINS:
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
    update = await safe_json(req)
    await dp.feed_webhook_update(bot, update)
    return web.Response(text="OK")

def make_app():
    # client_max_size важен для загрузки скриншотов (по умолчанию ~1MB)
    app = web.Application(middlewares=[cors_middleware], client_max_size=10 * 1024 * 1024)

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

    # API
    app.router.add_post("/api/sync", api_sync)
    app.router.add_post("/api/task/create", api_task_create)
    app.router.add_post("/api/task/submit", api_task_submit)

    # proof upload
    app.router.add_post("/api/proof/upload", api_proof_upload)

    # referrals
    app.router.add_post("/api/referrals", api_referrals)

    app.router.add_post("/api/withdraw/create", api_withdraw_create)
    app.router.add_post("/api/withdraw/list", api_withdraw_list)

    app.router.add_post("/api/tbank/claim", api_tbank_claim)
    app.router.add_post("/api/pay/stars/link", api_stars_link)
    app.router.add_post("/api/ops/list", api_ops_list)

    # optional crypto
    app.router.add_post("/api/pay/cryptobot/create", api_cryptobot_create)
    app.router.add_post(CRYPTO_WEBHOOK_PATH, cryptobot_webhook)

    # admin
    app.router.add_post("/api/admin/summary", api_admin_summary)
    app.router.add_post("/api/admin/proof/list", api_admin_proof_list)
    app.router.add_post("/api/admin/proof/decision", api_admin_proof_decision)
    app.router.add_post("/api/admin/withdraw/list", api_admin_withdraw_list)
    app.router.add_post("/api/admin/withdraw/decision", api_admin_withdraw_decision)
    app.router.add_post("/api/admin/tbank/list", api_admin_tbank_list)
    app.router.add_post("/api/admin/tbank/decision", api_admin_tbank_decision)

    return app

async def on_startup(app: web.Application):
    hook_base = SERVER_BASE_URL or BASE_URL
    if USE_WEBHOOK and hook_base:
        wh_url = hook_base.rstrip("/") + WEBHOOK_PATH
        await bot.set_webhook(wh_url)
        log.info("Webhook set to %s", wh_url)
    else:
        asyncio.create_task(dp.start_polling(bot))
        log.info("Polling started")

async def on_cleanup(app: web.Application):
    if crypto:
        try:
            await crypto.close()
        except Exception:
            pass
    await bot.session.close()

def main():
    app = make_app()
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    web.run_app(app, host="0.0.0.0", port=PORT)

if __name__ == "__main__":
    main()
