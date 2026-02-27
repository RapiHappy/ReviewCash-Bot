# ======= main.py (patched full) =======
import os
import json
import re
import hmac
import hashlib
import asyncio
import logging
from datetime import datetime, timezone, date, timedelta
from urllib.parse import parse_qsl

from urllib.parse import urlparse

YA_ALLOWED_HOST = ("yandex.ru", "yandex.com", "yandex.kz", "yandex.by", "yandex.uz")
GM_ALLOWED_HOST = ("google.com", "google.ru", "google.kz", "google.by", "google.com.ua", "maps.app.goo.gl", "goo.gl")

def _norm_url(raw: str) -> str:
    s = (raw or "").strip()
    if not s:
        return ""
    if not s.lower().startswith(("http://", "https://")):
        s = "https://" + s
    return s

def _host_allowed(host: str, allowed: tuple[str, ...]) -> bool:
    h = (host or "").lower()
    return any(h == a or h.endswith("." + a) for a in allowed)

def validate_target_url(ttype: str, raw: str) -> tuple[bool, str, str]:
    """Return (ok, normalized_url, error_message)."""
    url = _norm_url(raw)
    if not url:
        return False, "", "Нужна ссылка"
    try:
        u = urlparse(url)
        if u.scheme not in ("http", "https") or not u.netloc:
            return False, "", "Некорректная ссылка"
        if any(ch.isspace() for ch in url):
            return False, "", "Ссылка не должна содержать пробелы"
        host = (u.hostname or "").lower()
        path = (u.path or "").lower()

        if ttype == "ya":
            if "yandex" not in host:
                return False, "", "Ссылка не похожа на Яндекс. Нужна ссылка на Яндекс Карты"
            if not _host_allowed(host, YA_ALLOWED_HOST):
                return False, "", "Разрешены только ссылки Яндекс (yandex.*)"
            if ("/maps" not in path) and ("/profile" not in path) and ("maps" not in host):
                return False, "", "Нужна ссылка именно на Яндекс Карты (место/организация)"
        elif ttype == "gm":
            if host in ("maps.app.goo.gl", "goo.gl"):
                return True, url, ""
            if "google" not in host:
                return False, "", "Ссылка не похожа на Google. Нужна ссылка на Google Maps"
            if not _host_allowed(host, GM_ALLOWED_HOST):
                return False, "", "Разрешены только ссылки Google Maps"
            if ("/maps" not in path) and (not host.startswith("maps.")):
                return False, "", "Нужна ссылка именно на Google Maps (место/организация)"
        return True, url, ""
    except Exception:
        return False, "", "Некорректная ссылка"

def cast_id(v):
    s = str(v or "").strip()
    if s.isdigit():
        try:
            return int(s)
        except Exception:
            return s
    return s

async def check_url_alive(url: str) -> tuple[bool, str]:
    """Best-effort check that URL responds (<400)."""
    try:
        import aiohttp
        timeout = aiohttp.ClientTimeout(total=8)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            try:
                async with session.head(url, allow_redirects=True) as r:
                    if r.status < 400:
                        return True, ""
                    return False, f"HTTP {r.status}"
            except Exception:
                async with session.get(url, allow_redirects=True) as r:
                    if r.status < 400:
                        return True, ""
                    return False, f"HTTP {r.status}"
    except Exception:
        return False, "не удалось открыть ссылку"

from pathlib import Path
from aiohttp import web

# -------------------------
# Build/version for cache-busting (Telegram WebView)
# -------------------------
APP_BUILD = os.getenv("APP_BUILD") or os.getenv("RENDER_GIT_COMMIT") or datetime.utcnow().strftime("rc_%Y%m%d_%H%M%S")

@web.middleware
async def no_cache_mw(request: web.Request, handler):
    resp = await handler(request)
    try:
        if request.path.startswith("/app/") or request.path == "/app":
            resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
            resp.headers["Pragma"] = "no-cache"
            resp.headers["Expires"] = "0"
        if request.path.startswith("/api/"):
            resp.headers["Cache-Control"] = "no-store, max-age=0"
            resp.headers["Pragma"] = "no-cache"
    except Exception:
        pass
    return resp

from aiogram import Bot, Dispatcher, F
from aiogram.types import (
    Message,
    CallbackQuery,
    WebAppInfo,
    PreCheckoutQuery,
    LabeledPrice,
)
from aiogram.enums import ParseMode
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

MAIN_ADMIN_ID = int(os.getenv("MAIN_ADMIN_ID", "0") or 0)
if not MAIN_ADMIN_ID and ADMIN_IDS:
    MAIN_ADMIN_ID = int(ADMIN_IDS[0])

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

# XP by difficulty (can be tuned via env)
XP_EASY = int(os.getenv("XP_EASY", "5").strip())
XP_MEDIUM = int(os.getenv("XP_MEDIUM", "12").strip())
XP_HARD = int(os.getenv("XP_HARD", "22").strip())
XP_MANUAL_BONUS = int(os.getenv("XP_MANUAL_BONUS", "3").strip())      # extra XP for manual (with proof)
XP_REVIEW_BONUS = int(os.getenv("XP_REVIEW_BONUS", "3").strip())      # extra XP for ya/gm reviews
XP_MAX_PER_TASK = int(os.getenv("XP_MAX_PER_TASK", "60").strip())

def _parse_task_xp_override(task: dict) -> tuple[int | None, str | None]:
    """Return (xp_override, diff_override) from task instructions if present."""
    ins = str((task or {}).get("instructions") or "")
    # XP: 15
    m = re.search(r"(?im)^\s*XP\s*:\s*(\d+)\s*$", ins)
    if m:
        try:
            return int(m.group(1)), None
        except Exception:
            pass
    # DIFF: easy|medium|hard
    m = re.search(r"(?im)^\s*(DIFF|DIFFICULTY)\s*:\s*(easy|medium|hard)\s*$", ins)
    if m:
        return None, str(m.group(2)).lower()
    # DIFF=hard (inline)
    m = re.search(r"(?i)\bDIFF\s*=\s*(easy|medium|hard)\b", ins)
    if m:
        return None, str(m.group(1)).lower()
    return None, None

def task_xp(task: dict) -> int:
    """Compute XP for a paid completion depending on task type/reward/difficulty."""
    if not task:
        return int(XP_PER_TASK_PAID)

    xp_override, diff_override = _parse_task_xp_override(task)
    if isinstance(xp_override, int) and xp_override > 0:
        return max(1, min(int(xp_override), int(XP_MAX_PER_TASK)))

    ttype = str(task.get("type") or "").strip().lower()
    check_type = str(task.get("check_type") or "").strip().lower()
    reward = float(task.get("reward_rub") or 0)

    # determine difficulty if not overridden
    diff = diff_override
    if not diff:
        if ttype in ("ya", "gm"):
            diff = "hard" if reward >= 80 else "medium"
        elif ttype == "tg":
            if reward <= 5:
                diff = "easy"
            elif reward <= 20:
                diff = "medium"
            else:
                diff = "hard"
        else:
            if reward <= 50:
                diff = "easy"
            elif reward <= 120:
                diff = "medium"
            else:
                diff = "hard"

    base = XP_EASY if diff == "easy" else (XP_HARD if diff == "hard" else XP_MEDIUM)

    # bonuses
    if check_type != "auto":
        base += int(XP_MANUAL_BONUS)
    if ttype in ("ya", "gm"):
        base += int(XP_REVIEW_BONUS)

    # small scaling by reward (keeps "harder = more")
    base += int(min(15, max(0, round(reward * 0.05))))  # +0..+15

    return max(1, min(int(base), int(XP_MAX_PER_TASK)))

def strip_meta_tags(text: str) -> str:
    """Hide internal tags like XP:/DIFF: from user-facing instructions."""
    out = []
    for line in str(text or "").splitlines():
        if re.match(r"(?im)^\s*(XP\s*:|DIFF\s*:|DIFFICULTY\s*:|DIFF\s*=)", line):
            continue
        # old helper tag
        if re.match(r"(?im)^\s*TG_SUBTYPE\s*:", line):
            continue
        out.append(line)
    return "\n".join(out).strip()

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
# In-memory rate limiting (per process)
# -------------------------
RATE_LIMIT_STATE: dict[tuple[int, str], dict] = {}
TG_CHAT_CACHE: dict[str, tuple[float, bool, str]] = {}

async def sb_exec(fn):
    return await asyncio.to_thread(fn)

def _now():
    return datetime.now(timezone.utc)

def _day():
    return date.today()

def json_error(status: int, error: str, code: str | None = None, **extra):
    payload = {"ok": False, "error": error}
    if code:
        payload["code"] = code
    payload.update(extra)
    return web.json_response(payload, status=status)

def rate_limit_enforce(uid: int, action: str, min_interval_sec: int = 60, spam_strikes: int = 3, block_sec: int = 600):
    now = _now().timestamp()
    key = (int(uid), str(action))
    st = RATE_LIMIT_STATE.get(key, {"last_ok": 0.0, "strikes": 0, "blocked_until": 0.0})
    if st.get("blocked_until", 0.0) > now:
        left = int(st["blocked_until"] - now)
        raise web.HTTPTooManyRequests(text=json.dumps({"ok": False, "error": f"Слишком часто. Блок {max(1, left // 60)} мин.", "code": "SPAM_BLOCK", "retry_after": left}), content_type="application/json")
    last_ok = float(st.get("last_ok", 0.0))
    if last_ok and (now - last_ok) < min_interval_sec:
        st["strikes"] = int(st.get("strikes", 0)) + 1
        left = int(min_interval_sec - (now - last_ok))
        if st["strikes"] >= spam_strikes:
            st["blocked_until"] = now + block_sec
            st["strikes"] = 0
            RATE_LIMIT_STATE[key] = st
            raise web.HTTPTooManyRequests(text=json.dumps({"ok": False, "error": "Слишком часто. Блок 10 минут.", "code": "SPAM_BLOCK", "retry_after": block_sec}), content_type="application/json")
        RATE_LIMIT_STATE[key] = st
        raise web.HTTPTooManyRequests(text=json.dumps({"ok": False, "error": f"Лимит: раз в 1 минуту. Осталось ~{left}с", "code": "RATE_LIMIT", "retry_after": left}), content_type="application/json")
    st["last_ok"] = now
    st["strikes"] = 0
    RATE_LIMIT_STATE[key] = st

def normalize_tg_chat(s: str | None) -> str | None:
    if not s:
        return None
    t = str(s).strip()
    if not t:
        return None
    t = re.sub(r"^https?://t\.me/", "", t)
    t = t.split("?")[0].split("/")[0]
    if not t.startswith("@"):
        t = "@" + t
    t = "@" + re.sub(r"[^0-9A-Za-z_]", "", t[1:])
    return t if len(t) > 1 else None

def tg_detect_kind(tg_chat: str | None, target_url: str | None) -> str:
    u = (tg_chat or "").lower().lstrip("@")
    tu = (target_url or "").lower()
    if u.endswith("bot") or ("?start=" in tu) or ("&start=" in tu) or ("/start" in tu):
        return "bot"
    return "chat"

async def tg_calc_check_type(tg_chat: str, target_url: str) -> tuple[str, str, str]:
    kind = tg_detect_kind(tg_chat, target_url)
    if kind == "bot":
        return "manual", kind, "BOT_TASK"
    ok, msg = await ensure_bot_in_chat(tg_chat)
    if ok:
        return "auto", kind, ""
    return "manual", kind, (msg or "NO_ACCESS")

async def ensure_bot_in_chat(chat_username: str) -> tuple[bool, str]:
    key = str(chat_username).lower()
    now = _now().timestamp()
    if key in TG_CHAT_CACHE:
        ts, ok, msg = TG_CHAT_CACHE[key]
        if (now - ts) < 300:
            return ok, msg
    try:
        me = await bot.get_me()
        chat = await bot.get_chat(chat_username)
        member = await bot.get_chat_member(chat_username, me.id)
        status = getattr(member, "status", None)
        ctype = getattr(chat, "type", "")
        if status in ("left", "kicked"):
            TG_CHAT_CACHE[key] = (now, False, "Добавь бота в группу/канал, иначе TG-задание создать нельзя.")
            return TG_CHAT_CACHE[key][1], TG_CHAT_CACHE[key][2]
        if ctype == "channel" and status != "administrator":
            TG_CHAT_CACHE[key] = (now, False, "Для канала нужно добавить бота и сделать админом.")
            return TG_CHAT_CACHE[key][1], TG_CHAT_CACHE[key][2]
        TG_CHAT_CACHE[key] = (now, True, "")
        return True, ""
    except Exception:
        TG_CHAT_CACHE[key] = (now, False, "Не удалось проверить чат. Добавь бота в группу/канал (и для канала — админом), затем попробуй снова.")
        return False, TG_CHAT_CACHE[key][2]

async def api_tg_check_chat(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    rate_limit_enforce(uid, "tg_check", min_interval_sec=2, spam_strikes=8, block_sec=60)

    body = await safe_json(req)
    target = str(body.get("target") or body.get("chat") or body.get("target_url") or "").strip()

    chat = normalize_tg_chat(target)
    if not chat:
        return web.json_response({
            "ok": True,
            "valid": False,
            "code": "TG_CHAT_REQUIRED",
            "message": "Укажи @канал или @группу (например @MyChannel).",
        })

    ok_chat, msg = await ensure_bot_in_chat(chat)
    if not ok_chat:
        return web.json_response({
            "ok": True,
            "valid": False,
            "code": "TG_BOT_NOT_IN_CHAT",
            "chat": chat,
            "message": msg,
        })

    title = chat
    ctype = ""
    try:
        ch = await bot.get_chat(chat)
        ctype = getattr(ch, "type", "") or ""
        title = getattr(ch, "title", "") or getattr(ch, "username", "") or chat
    except Exception:
        pass

    return web.json_response({
        "ok": True,
        "valid": True,
        "chat": chat,
        "type": ctype,
        "title": title,
    })

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

def calc_level(xp: int) -> int:
    if XP_PER_LEVEL <= 0:
        return 1
    return max(1, (int(xp) // int(XP_PER_LEVEL)) + 1)

async def get_balance(uid: int):
    r = await sb_select(T_BAL, {"user_id": uid}, limit=1)
    if r.data:
        row = r.data[0] or {}
        xp = int(row.get("xp") or 0)
        lvl = row.get("level")
        try:
            lvl = int(lvl) if lvl is not None else None
        except Exception:
            lvl = None
        calc_lvl = calc_level(xp)
        if not lvl or lvl < 1:
            lvl = calc_lvl
        if lvl != calc_lvl:
            lvl = calc_lvl
        row["xp"] = xp
        row["level"] = lvl
        try:
            await sb_update(T_BAL, {"user_id": uid}, {"xp": xp, "level": lvl, "updated_at": _now().isoformat()})
        except Exception:
            pass
        return row
    try:
        await sb_upsert(T_BAL, {"user_id": uid, "xp": 0, "level": 1, "rub_balance": 0, "stars_balance": 0}, on_conflict="user_id")
    except Exception:
        pass
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

async def stats_add(field: str, amount: float):
    try:
        day = _day().isoformat()
        r = await sb_select(T_STATS, {"day": day}, limit=1)
        if r.data:
            cur = float(r.data[0].get(field) or 0)
            await sb_update(T_STATS, {"day": day}, {field: cur + float(amount)})
        else:
            row = {"day": day, "revenue_rub": 0, "payouts_rub": 0, "topups_rub": 0, "active_users": 0}
            row[field] = float(amount)
            await sb_insert(T_STATS, row)
    except Exception as e:
        log.warning("stats_add skipped (%s): %s", field, e)

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

        await notify_user(referrer_id, f"🎉 Реферальный бонус: +{bonus:.2f}₽ (приглашённый выполнил первое задание)")
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
    uid = int(user["id"])
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

    if is_new and referrer_id and referrer_id != uid:
        upd["referrer_id"] = referrer_id

    await sb_upsert(T_USERS, upd, on_conflict="user_id")
    await sb_upsert(T_BAL, {"user_id": uid}, on_conflict="user_id")

    if is_new and referrer_id and referrer_id != uid:
        await ensure_referral_event(uid, referrer_id)

    u = await sb_select(T_USERS, {"user_id": uid}, limit=1)
    return (u.data or [upd])[0]

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

MUTE_NOTIFY_KEY = "mute_notify"

async def is_notify_muted(uid: int) -> bool:
    try:
        r = await sb_select(T_LIMITS, {"user_id": uid, "limit_key": MUTE_NOTIFY_KEY}, limit=1)
        return bool(r.data)
    except Exception:
        return False

async def set_notify_muted(uid: int, muted: bool):
    if muted:
        await sb_upsert(
            T_LIMITS,
            {"user_id": uid, "limit_key": MUTE_NOTIFY_KEY, "last_at": _now().isoformat()},
            on_conflict="user_id,limit_key"
        )
    else:
        await sb_delete(T_LIMITS, {"user_id": uid, "limit_key": MUTE_NOTIFY_KEY})

TASK_BAN_KEY = "task_ban_until"
CLICK_PREFIX = "clicked_task:"
CLICK_WINDOW_SEC = int(os.getenv("CLICK_WINDOW_SEC", str(6 * 3600)).strip())

def _parse_dt(v):
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except Exception:
        return None

async def get_task_ban_until(uid: int):
    try:
        r = await sb_select(T_LIMITS, {"user_id": uid, "limit_key": TASK_BAN_KEY}, limit=1)
        if not r.data:
            return None
        until = _parse_dt(r.data[0].get("last_at"))
        if not until:
            return None
        if until <= _now():
            try:
                await sb_delete(T_LIMITS, {"user_id": uid, "limit_key": TASK_BAN_KEY})
            except Exception:
                pass
            return None
        return until
    except Exception:
        return None

async def set_task_ban(uid: int, days: int = 3):
    until = _now() + timedelta(days=int(days))
    await sb_upsert(
        T_LIMITS,
        {"user_id": uid, "limit_key": TASK_BAN_KEY, "last_at": until.isoformat()},
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

async def require_recent_task_click(uid: int, task_id: str) -> bool:
    key = CLICK_PREFIX + str(task_id)
    try:
        r = await sb_select(T_LIMITS, {"user_id": uid, "limit_key": key}, limit=1)
        if not r.data:
            return False
        dt = _parse_dt(r.data[0].get("last_at"))
        if not dt:
            return False
        return (_now() - dt).total_seconds() <= CLICK_WINDOW_SEC
    except Exception:
        return False

async def clear_task_click(uid: int, task_id: str):
    key = CLICK_PREFIX + str(task_id)
    try:
        await sb_delete(T_LIMITS, {"user_id": uid, "limit_key": key})
    except Exception:
        pass

async def tg_is_member(chat: str, user_id: int) -> bool:
    try:
        cm = await bot.get_chat_member(chat_id=chat, user_id=user_id)
        status = getattr(cm, "status", None)
        return status in ("member", "administrator", "creator")
    except Exception as e:
        log.warning("get_chat_member failed: %s", e)
        return False

async def notify_admin(text: str):
    for aid in ADMIN_IDS:
        try:
            await bot.send_message(aid, text)
        except Exception:
            pass

async def notify_user(uid: int, text: str, force: bool = False):
    if not force:
        try:
            if await is_notify_muted(uid):
                return
        except Exception:
            pass
    try:
        await bot.send_message(uid, text)
    except Exception:
        pass

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

async def require_main_admin(req: web.Request) -> dict:
    _, user = await require_init(req)
    if int(user["id"]) != int(MAIN_ADMIN_ID or 0):
        raise web.HTTPForbidden(text="Not main admin")
    return user

async def api_referrals(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    s = await referrals_summary(uid)
    return web.json_response({"ok": True, **s})

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
    banned_until = await get_task_ban_until(uid)
    tasks = []
    if not banned_until:
        tsel = await sb_select(T_TASKS, {"status": "active"}, order="created_at", desc=True, limit=200)
        raw = tsel.data or []
        tasks = [t for t in raw if int(t.get("qty_left") or 0) > 0]

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
        "tasks": tasks,
        "task_ban_until": banned_until.isoformat() if banned_until else None,
    })

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

    if ttype in ("ya", "gm"):
        ok_u, norm_u, err = validate_target_url(ttype, target_url)
        if not ok_u:
            return json_error(400, err, code="BAD_LINK")
        ok_alive, why = await check_url_alive(norm_u)
        if not ok_alive:
            return json_error(400, f"Ссылка не открывается или не подходит: {why}", code="LINK_DEAD")
        target_url = norm_u

    if reward_rub <= 0 or qty_total <= 0:
        raise web.HTTPBadRequest(text="Bad reward/qty")

    if ttype == "tg":
        raw_tg = (tg_chat or target_url or "").strip()
        raw_low = raw_tg.lower()

        if not (raw_tg.startswith("@") or ("t.me/" in raw_low)):
            return json_error(400, "Для TG задания можно указывать только @юзернейм или ссылку t.me/...", code="TG_ONLY_AT_OR_LINK")

        tg_chat_n = normalize_tg_chat(raw_tg)
        if not tg_chat_n:
            return json_error(400, "Некорректный @юзернейм/ссылка TG. Пример: @MyChannel или https://t.me/MyChannel", code="TG_CHAT_REQUIRED")
        tg_chat = tg_chat_n

        try:
            await bot.get_chat(tg_chat)
        except Exception:
            return json_error(400, "Не удалось открыть TG-цель. Проверь @/ссылку. Если это приватный чат/канал — добавь бота.", code="TG_BAD_TARGET")

        desired_check_type, desired_kind, reason = await tg_calc_check_type(tg_chat, target_url)
        tg_kind = desired_kind
        check_type = desired_check_type

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
    await notify_admin(f"🆕 Новое задание\n• {title}\n• Награда: {reward_rub}₽ × {qty_total}")

    return web.json_response({"ok": True, "task": task})

# -------------------------
# API: task click
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

    t = await sb_select(T_TASKS, {"id": cast_id(task_id)}, limit=1)
    if not t.data:
        return web.json_response({"ok": False, "error": "Task not found"}, status=404)

    task = (t.data or [None])[0] or {}
    if int(task.get("owner_id") or 0) == uid:
        return web.json_response({"ok": False, "error": "Нельзя выполнять своё задание"}, status=403)

    await touch_task_click(uid, task_id)
    return web.json_response({"ok": True})

# -------------------------
# API: submit task
# -------------------------
async def api_task_submit(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    rate_limit_enforce(uid, "task_submit", min_interval_sec=60, spam_strikes=10, block_sec=600)
    body = await safe_json(req)

    banned_until = await get_task_ban_until(uid)
    if banned_until:
        return web.json_response({"ok": False, "error": f"Доступ к заданиям временно ограничен до {banned_until.strftime('%d.%m %H:%M')}"}, status=403)

    task_id = str(body.get("task_id") or "").strip()
    proof_text = str(body.get("proof_text") or "").strip()
    proof_url = str(body.get("proof_url") or "").strip() or None

    if not task_id:
        raise web.HTTPBadRequest(text="Missing task_id")

    t = await sb_select(T_TASKS, {"id": cast_id(task_id)}, limit=1)
    if not t.data:
        return web.json_response({"ok": False, "error": "Task not found"}, status=404)
    task = t.data[0]

    if int(task.get("owner_id") or 0) == uid:
        return web.json_response({"ok": False, "error": "Нельзя выполнять своё задание"}, status=403)

    if task.get("status") != "active" or int(task.get("qty_left") or 0) <= 0:
        return web.json_response({"ok": False, "error": "Task closed"}, status=400)

    if task.get("type") == "ya":
        ok_lim, rem = await check_limit(uid, "ya_review", YA_COOLDOWN_SEC)
        if not ok_lim:
            return web.json_response({"ok": False, "error": f"Лимит: раз в 3 дня. Осталось ~{rem//3600}ч"}, status=400)
    if task.get("type") == "gm":
        ok_lim, rem = await check_limit(uid, "gm_review", GM_COOLDOWN_SEC)
        if not ok_lim:
            return web.json_response({"ok": False, "error": f"Лимит: раз в день. Осталось ~{rem//3600}ч"}, status=400)

    dup = await sb_select(T_COMP, {"task_id": task_id, "user_id": uid}, limit=1)
    if dup.data:
        return web.json_response({"ok": False, "error": "Уже отправляли выполнение"}, status=400)

    is_auto = (task.get("check_type") == "auto") and (task.get("type") == "tg")

    if not is_auto:
        ok_clicked = await require_recent_task_click(uid, task_id)
        if not ok_clicked:
            return web.json_response({"ok": False, "error": "Сначала нажми «Перейти к выполнению» и открой ссылку, затем отправляй отчёт."}, status=400)

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

        xp_added = task_xp(task)
        await add_xp(uid, xp_added)
        await maybe_pay_referral_bonus(uid)

        try:
            left = int(task.get("qty_left") or 0)
            if left > 0:
                new_left = max(0, left - 1)
                upd = {"qty_left": new_left}
                if new_left <= 0:
                    upd["status"] = "closed"
                await sb_update(T_TASKS, {"id": cast_id(task_id)}, upd)
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

        return web.json_response({"ok": True, "status": "paid", "earned": reward, "xp_added": xp_added})

    if not proof_url:
        return web.json_response({"ok": False, "error": "Нужен скриншот доказательства"}, status=400)

    await sb_insert(T_COMP, {
        "task_id": task_id,
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
    return web.json_response({"ok": True, "status": "pending", "xp_expected": xp_expected})

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
# T-Bank claim
# -------------------------
async def api_tbank_claim(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    rate_limit_enforce(uid, "topup", min_interval_sec=60, spam_strikes=3, block_sec=600)
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
# Telegram Stars
# -------------------------
async def api_stars_link(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    rate_limit_enforce(uid, "topup", min_interval_sec=60, spam_strikes=3, block_sec=600)
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
# CryptoBot
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

            xp_add = int((amount // 100) * XP_PER_TOPUP_100)
            if xp_add > 0:
                await add_xp(uid, xp_add)

            await notify_user(uid, f"✅ Пополнение успешно: +{amount:.2f}₽")

        return web.Response(text="ok", status=200)
    except Exception as e:
        log.exception("cryptobot webhook error: %s", e)
        return web.Response(text="ok", status=200)

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
# ADMIN
# =========================================================
async def api_admin_summary(req: web.Request):
    user = await require_admin(req)

    proofs = await sb_select(T_COMP, {"status": "pending"}, limit=1000)
    wds = await sb_select(T_WD, {"status": "pending"}, limit=1000)

    def _f():
        return sb.table(T_PAY).select("id").eq("provider", "tbank").eq("status", "pending").execute()
    tp = await sb_exec(_f)

    tasks = await sb_select(T_TASKS, {"status": "active"}, limit=2000)
    tasks_active = [t for t in (tasks.data or []) if int(t.get("qty_left") or 0) > 0]

    return web.json_response({
        "ok": True,
        "is_main_admin": int(MAIN_ADMIN_ID or 0) == int(user["id"]),
        "counts": {
            "proofs": len(proofs.data or []),
            "withdrawals": len(wds.data or []),
            "tbank": len(tp.data or []),
            "tasks": len(tasks_active),
        }
    })

# (остальной admin-код у тебя уже был — я его не менял логически)

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

    # ✅ FIX: никаких fix_20260219 — всегда текущий билд
    miniapp_url = MINIAPP_URL
    if not miniapp_url:
        base = SERVER_BASE_URL or BASE_URL
        if base:
            miniapp_url = base.rstrip("/") + f"/app/?v={APP_BUILD}"

    if miniapp_url:
        kb.button(text="🚀 Открыть приложение", web_app=WebAppInfo(url=miniapp_url))

    muted = await is_notify_muted(uid)
    kb.button(text=("🔕 Уведомления: ВЫКЛ" if muted else "🔔 Уведомления: ВКЛ"), callback_data="toggle_notify")
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
    kb.adjust(1)
    await message.answer(text, reply_markup=kb.as_markup())

# ... (дальше твои хендлеры без изменений по логике)

# =========================================================
# aiohttp app + webhook + static Mini App
# =========================================================
async def health(req: web.Request):
    return web.Response(text="OK")

async def tg_webhook(req: web.Request):
    update = await safe_json(req)
    try:
        asyncio.create_task(dp.feed_webhook_update(bot, update))
    except Exception:
        await dp.feed_webhook_update(bot, update)
    return web.Response(text="OK")

def make_app():
    app = web.Application(middlewares=[cors_middleware, no_cache_mw], client_max_size=10 * 1024 * 1024)
    app.router.add_get("/", health)

    base_dir = Path(__file__).resolve().parent
    static_dir = base_dir / "public"

    if static_dir.exists():
        async def app_redirect(req: web.Request):
            # ✅ FIX: всегда новый URL -> Telegram не держит старый кеш
            raise web.HTTPFound(f"/app/?v={APP_BUILD}")

        async def app_index(req: web.Request):
            html_path = static_dir / "index.html"
            try:
                html = html_path.read_text(encoding="utf-8")
            except Exception:
                return web.FileResponse(html_path)
            html = html.replace("__APP_BUILD__", APP_BUILD)
            return web.Response(
                text=html,
                content_type="text/html",
                headers={
                    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
                    "Pragma": "no-cache",
                    "Expires": "0",
                },
            )

        app.router.add_get("/app", app_redirect)
        app.router.add_get("/app/", app_index)
        app.router.add_static("/app/", path=str(static_dir), show_index=False)
    else:
        log.warning("Static dir not found: %s", static_dir)

    app.router.add_post(WEBHOOK_PATH, tg_webhook)

    # API routes (как у тебя)
    app.router.add_post("/api/sync", api_sync)
    app.router.add_post("/api/tg/check_chat", api_tg_check_chat)
    app.router.add_post("/api/task/create", api_task_create)
    app.router.add_post("/api/task/click", api_task_click)
    app.router.add_post("/api/task/submit", api_task_submit)
    app.router.add_post("/api/proof/upload", api_proof_upload)
    app.router.add_post("/api/referrals", api_referrals)
    app.router.add_post("/api/withdraw/create", api_withdraw_create)
    app.router.add_post("/api/withdraw/list", api_withdraw_list)
    app.router.add_post("/api/tbank/claim", api_tbank_claim)
    app.router.add_post("/api/pay/stars/link", api_stars_link)
    app.router.add_post("/api/ops/list", api_ops_list)
    app.router.add_post("/api/pay/cryptobot/create", api_cryptobot_create)
    app.router.add_post(CRYPTO_WEBHOOK_PATH, cryptobot_webhook)

    # admin routes (как у тебя)
    app.router.add_post("/api/admin/summary", api_admin_summary)
    # ... остальные admin routes ...
    # ✅ FIX: tg_audit должен быть ВНУТРИ make_app()
    app.router.add_post("/api/admin/task/tg_audit", api_admin_tg_audit)

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

# Gunicorn entrypoint
app = make_app()
app.on_startup.append(on_startup)
app.on_cleanup.append(on_cleanup)

if __name__ == "__main__":
    web.run_app(app, host="0.0.0.0", port=PORT)
