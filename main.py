import os
import json
import re
import hmac
import hashlib
import base64
import time
import asyncio
import logging
from datetime import datetime, timezone, date, timedelta

# Build/version string used for cache-busting in Telegram WebView
APP_BUILD = (
    os.getenv("APP_BUILD")
    or os.getenv("RENDER_GIT_COMMIT")
    or os.getenv("GIT_COMMIT")
    or datetime.utcnow().strftime("rc_%Y%m%d_%H%M%S")
)
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
    """Best-effort check that URL responds.

    Notes:
    - Yandex/Google Maps sometimes return 403/429 to automated HEAD/GET requests.
      We still allow such links, because they are valid for humans in a browser.
    """
    try:
        import aiohttp
        timeout = aiohttp.ClientTimeout(total=10)
        headers = {
            "User-Agent": "Mozilla/5.0 (compatible; ReviewCashBot/1.0; +https://t.me/ReviewCashOrg_Bot)"
        }
        async with aiohttp.ClientSession(timeout=timeout, headers=headers) as session:
            def _ok_status(st: int) -> bool:
                # accept 2xx/3xx; also accept anti-bot responses
                return (st < 400) or (st in (401, 403, 429))

            try:
                async with session.head(url, allow_redirects=True) as r:
                    if _ok_status(r.status):
                        return True, ""
                    return False, f"HTTP {r.status}"
            except Exception:
                async with session.get(url, allow_redirects=True) as r:
                    if _ok_status(r.status):
                        return True, ""
                    return False, f"HTTP {r.status}"
    except Exception:
        return False, "не удалось открыть ссылку"

from pathlib import Path

from aiohttp import web


@web.middleware
async def no_cache_mw(request: web.Request, handler):
    resp = await handler(request)
    try:
        if request.path.startswith("/app/") or request.path == "/app":
            resp.headers["Cache-Control"] = "no-store, max-age=0"
            resp.headers["Pragma"] = "no-cache"
            resp.headers["Expires"] = "0"
        if request.path.startswith("/api/"):
            resp.headers["Cache-Control"] = "no-store, max-age=0"
            resp.headers["Pragma"] = "no-cache"
            resp.headers["Expires"] = "0"
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

    MenuButtonWebApp,

    InlineKeyboardMarkup,

    InlineKeyboardButton,
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

# WebApp session (for Telegram Desktop sometimes missing initData)
WEBAPP_SESSION_SECRET = os.getenv("WEBAPP_SESSION_SECRET", "").strip()  # set in Render env
WEBAPP_SESSION_TTL_SEC = int(os.getenv("WEBAPP_SESSION_TTL_SEC", "2592000"))  # default 30 days
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
# Stars topup minimum (in RUB)
MIN_STARS_TOPUP_RUB = float(os.getenv("MIN_STARS_TOPUP_RUB", "1").strip())

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


async def setup_menu_button(bot: Bot):
    """Force Telegram to open Mini App in real WebApp mode (stable initData)."""
    try:
        await bot.set_chat_menu_button(
            menu_button=MenuButtonWebApp(
                text="ReviewCash",
                web_app=WebAppInfo(url=MINIAPP_URL),
            )
        )
        log.info("[WEBAPP] MenuButton WebApp set.")
    except Exception as e:
        log.warning(f"[WEBAPP] MenuButton setup failed: {e}")


@dp.message(F.text == "/app")
async def open_app_cmd(m: Message):
    kb = InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text="🚀 Открыть ReviewCash", web_app=WebAppInfo(url=MINIAPP_URL))
    ]])
    await m.answer("Открывай Mini App только этой кнопкой (WebApp):", reply_markup=kb)

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
#   - 1 minute between actions
#   - if spamming, block for 10 minutes
# -------------------------
RATE_LIMIT_STATE: dict[tuple[int, str], dict] = {}
TG_CHAT_CACHE: dict[str, tuple[float, bool, str]] = {}


# -------------------------
# helpers: supabase safe exec in thread
# -------------------------
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
    # accept https://t.me/name or @name or name
    t = re.sub(r"^https?://t\.me/", "", t)
    t = t.split("?")[0].split("/")[0]
    if not t.startswith("@"):
        t = "@" + t
    # keep only @, letters, digits, underscore
    t = "@" + re.sub(r"[^0-9A-Za-z_]", "", t[1:])
    return t if len(t) > 1 else None
def tg_detect_kind(tg_chat: str | None, target_url: str | None) -> str:
    u = (tg_chat or "").lower().lstrip("@")
    tu = (target_url or "").lower()
    # bots are not auto-checkable (cannot know if user pressed Start in someone else's bot)
    if u.endswith("bot") or ("?start=" in tu) or ("&start=" in tu) or ("/start" in tu):
        return "bot"
    return "chat"

async def tg_calc_check_type(tg_chat: str, target_url: str) -> tuple[str, str, str]:
    """Return (check_type, tg_kind, reason)."""
    kind = tg_detect_kind(tg_chat, target_url)
    if kind == "bot":
        return "manual", kind, "BOT_TASK"
    ok, msg = await ensure_bot_in_chat(tg_chat)
    if ok:
        return "auto", kind, ""
    return "manual", kind, (msg or "NO_ACCESS")


async def ensure_bot_in_chat(chat_username: str) -> tuple[bool, str]:
    # cache for 5 minutes
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

# -------------------------
# API: TG chat check (for UI animation)
# -------------------------
async def api_tg_check_chat(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    # Light rate limit: ~1 request per 2 seconds; spam -> 1 minute block
    rate_limit_enforce(uid, "tg_check", min_interval_sec=2, spam_strikes=8, block_sec=60)

    body = await safe_json(req)
    target = str(body.get("target") or body.get("chat") or body.get("target_url") or "").strip()

    chat = normalize_tg_chat(target)
    if not chat:
        # hide internal tags from instructions (XP:/DIFF:/TG_SUBTYPE)
        try:
            for _t in (tasks or []):
                if isinstance(_t, dict) and _t.get("instructions"):
                    _t["instructions"] = strip_meta_tags(_t.get("instructions") or "")
        except Exception:
            pass

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

# -------------------------
# Telegram initData verify (WebApp)
# -------------------------
def verify_init_data(init_data: str, token: str) -> dict | None:
    """
    Telegram Mini App (WebApp) initData verification.
    IMPORTANT: For WebApp initData, secret key is HMAC_SHA256("WebAppData", bot_token).
    """
    if not init_data:
        return None
    token = (token or "").strip()
    if not token:
        return None

    try:
        pairs = dict(parse_qsl(init_data, keep_blank_values=True))
    except Exception:
        return None

    received_hash = pairs.pop("hash", None)
    if not received_hash:
        return None

    data_check_string = "\n".join(f"{k}={pairs[k]}" for k in sorted(pairs.keys()))

    # ✅ Correct WebApp algorithm
    secret_key = hmac.new(b"WebAppData", token.encode("utf-8"), hashlib.sha256).digest()
    calculated_hash = hmac.new(secret_key, data_check_string.encode("utf-8"), hashlib.sha256).hexdigest()

    if not hmac.compare_digest(calculated_hash, received_hash):
        try:
            log.warning(f"[AUTH] hash mismatch recv={received_hash[:12]} calc={calculated_hash[:12]} keys={list(pairs.keys())}")
        except Exception:
            pass
        return None

    if "user" in pairs:
        try:
            pairs["user"] = json.loads(pairs["user"])
        except Exception:
            pass

    return pairs


# -------------------------
# WebApp session token (fallback for Telegram Desktop, where initData can be missing)
# -------------------------
def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode("utf-8").rstrip("=")

def _b64url_decode(s: str) -> bytes:
    s = s.strip()
    pad = "=" * ((4 - len(s) % 4) % 4)
    return base64.urlsafe_b64decode((s + pad).encode("utf-8"))

def _make_session_token(user_id: int) -> str | None:
    secret = (WEBAPP_SESSION_SECRET or "").strip()
    if not secret:
        return None
    ts = int(time.time())
    payload = f"{user_id}:{ts}".encode("utf-8")
    sig = hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).digest()
    return _b64url(payload) + "." + _b64url(sig)

def _verify_session_token(token: str) -> int | None:
    secret = (WEBAPP_SESSION_SECRET or "").strip()
    if not secret:
        return None
    try:
        parts = token.strip().split(".")
        if len(parts) != 2:
            return None
        payload = _b64url_decode(parts[0])
        sig = _b64url_decode(parts[1])
        calc = hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).digest()
        if not hmac.compare_digest(calc, sig):
            return None
        txt = payload.decode("utf-8", errors="strict")
        uid_s, ts_s = txt.split(":", 1)
        uid = int(uid_s)
        ts = int(ts_s)
        if WEBAPP_SESSION_TTL_SEC > 0 and int(time.time()) - ts > WEBAPP_SESSION_TTL_SEC:
            return None
        return uid
    except Exception:
        return None

def _extract_session_token(req: web.Request) -> str | None:
    # Prefer explicit header; also support Authorization: Bearer <token>
    t = (req.headers.get("X-Session-Token") or "").strip()
    if t:
        return t
    auth = (req.headers.get("Authorization") or "").strip()
    if auth.lower().startswith("bearer "):
        return auth.split(" ", 1)[1].strip()
    return None


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
        row["xp"] = xp
        row["level"] = lvl
        # best-effort persist fixes
        try:
            await sb_update(T_BAL, {"user_id": uid}, {"xp": xp, "level": lvl, "updated_at": _now().isoformat()})
        except Exception:
            pass
        return row
    # ensure row exists
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

# -------------------------
# stats
# -------------------------
async def stats_add(field: str, amount: float):
    """Best-effort daily stats.
    Never blocks payouts/flows if stats table is missing or schema differs.
    """
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
    uid = int(user.get("id") or user.get("user_id") or user.get("tg_user_id"))

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
    row = (u.data or [upd])[0] or {}
    # normalize to tg-style keys
    if "id" not in row:
        row["id"] = uid
    if "user_id" not in row:
        row["user_id"] = uid
    return row

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
# user notifications (mute/unmute) via user_limits
# -------------------------
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


# -------------------------
# Task access bans + "must click link" tracking
# -------------------------
TASK_BAN_KEY = "task_ban_until"
CLICK_PREFIX = "clicked_task:"
CLICK_WINDOW_SEC = int(os.getenv("CLICK_WINDOW_SEC", str(6 * 3600)).strip())  # must click within 6h

def _parse_dt(v):
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except Exception:
        return None

async def get_task_ban_until(uid: int):
    """Returns datetime until user is blocked from submitting tasks, or None."""
    try:
        r = await sb_select(T_LIMITS, {"user_id": uid, "limit_key": TASK_BAN_KEY}, limit=1)
        if not r.data:
            return None
        until = _parse_dt(r.data[0].get("last_at"))
        if not until:
            return None
        # expired -> cleanup
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
    """Returns True if user clicked task link recently."""
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

async def require_init(req: web.Request):
    # 1) Try Telegram WebApp initData
    init_data = (
        (req.headers.get("X-Tg-Init-Data") or "")
        or (req.headers.get("X-Tg-InitData") or "")
        or (req.headers.get("X-Telegram-Init-Data") or "")
        or (req.headers.get("X-Tg-Initdata") or "")
        or (req.headers.get("X-Init-Data") or "")
        or (req.headers.get("X-Initdata") or "")
        or (req.headers.get("X-Telegram-WebApp-Init-Data") or "")
        or (req.query.get("initData") or "")
    ).strip()

    if init_data:
        parsed = verify_init_data(init_data, BOT_TOKEN or "")
        if parsed and isinstance(parsed.get("user"), dict):
            tg_user = parsed["user"]
            user = await ensure_user(tg_user)
            # merge TG fields (ensure_user returns DB row)
            merged = {**user}
            merged.setdefault("id", int(tg_user.get("id")))
            merged.setdefault("user_id", int(tg_user.get("id")))
            merged.setdefault("username", tg_user.get("username"))
            merged.setdefault("first_name", tg_user.get("first_name"))
            merged.setdefault("last_name", tg_user.get("last_name"))
            merged.setdefault("photo_url", tg_user.get("photo_url"))
            return parsed, merged

    # 2) Fallback: session token (for Telegram Desktop, where initData can be missing)
    token = _extract_session_token(req)
    uid = _verify_session_token(token) if token else None
    if uid:
        # Make sure minimal rows exist
        await sb_upsert(T_USERS, {"user_id": uid}, on_conflict="user_id")
        await sb_upsert(T_BAL, {"user_id": uid}, on_conflict="user_id")

        rows = await sb_select(T_USERS, {"user_id": uid}, limit=1)
        u = (rows.data[0] if getattr(rows, "data", None) else None) or {"user_id": uid}
        # normalize: downstream expects tg-style user dict with key 'id' == telegram user_id
        user = {**u, "id": int(u.get("user_id") or uid), "user_id": int(u.get("user_id") or uid)}
        parsed = {"user": {"id": int(u.get("user_id") or uid)}}
        return parsed, user

    raise web.HTTPUnauthorized(text="No initData/session")



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


async def require_init_optional(req: web.Request):
    """Like require_init(), but returns (None, None) instead of raising if there is no initData/session."""
    try:
        return await require_init(req)
    except web.HTTPUnauthorized:
        return None, None

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

    if urow.get("is_banned"):
        return web.json_response({"ok": False, "error": "Аккаунт заблокирован"}, status=403)

    bal = await get_balance(uid)
    banned_until = await get_task_ban_until(uid)
    tasks = []
    if not banned_until:
        tsel = await sb_select(T_TASKS, {"status": "active"}, order="created_at", desc=True, limit=200)
        raw = tsel.data or []
        tasks = [t for t in raw if int(t.get("qty_left") or 0) > 0 and (t.get("type") != "tg" or t.get("check_type") == "auto")]

    
    session_token = _make_session_token(uid)
    return web.json_response({
        "ok": True,
        "auth": True,
        "session_token": session_token,
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

    # Only links/@usernames allowed. For YA/GM: validate + ensure URL is reachable.
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

    # TG task:
    # - принимаем только @юзернейм или ссылку t.me/...
    # - авто-проверка возможна только если это НЕ бот и наш бот добавлен в чат/канал (для канала — админ)
    if ttype == "tg":
        raw_tg = (tg_chat or target_url or "").strip()
        raw_low = raw_tg.lower()

        if not (raw_tg.startswith("@") or ("t.me/" in raw_low)):
            return json_error(400, "Для TG задания можно указывать только @юзернейм или ссылку t.me/...", code="TG_ONLY_AT_OR_LINK")

        tg_chat_n = normalize_tg_chat(raw_tg)
        if not tg_chat_n:
            return json_error(400, "Некорректный @юзернейм/ссылка TG. Пример: @MyChannel или https://t.me/MyChannel", code="TG_CHAT_REQUIRED")
        tg_chat = tg_chat_n

        # Определяем тип TG-цели.
        # Для bot задач (например /start) Telegram Bot API часто НЕ даёт getChat,
        # поэтому не блокируем создание, а делаем ручную проверку.
        kind_guess = tg_detect_kind(tg_chat, target_url)
        if kind_guess == "chat":
            # Проверим что цель существует (best-effort). Для приватных чатов это может не работать — тогда нужно добавить бота.
            try:
                await bot.get_chat(tg_chat)
            except Exception:
                return json_error(
                    400,
                    "Не удалось открыть TG-цель. Проверь @/ссылку. Если это приватный чат/канал — добавь бота.",
                    code="TG_BAD_TARGET",
                )

        desired_check_type, desired_kind, reason = await tg_calc_check_type(tg_chat, target_url)
        tg_kind = desired_kind
        check_type = desired_check_type

        # Telegram tasks: only automatic checks are allowed
        if check_type != "auto":
            return json_error(400, "TG задания доступны только с автоматической проверкой. Укажи канал/группу, где бот может проверить подписку.", code="TG_AUTO_ONLY", reason=reason)


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
    task_id_db = cast_id(task_id)

    t = await sb_select(T_TASKS, {"id": task_id_db}, limit=1)
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

    t = await sb_select(T_TASKS, {"id": task_id_db}, limit=1)
    if not t.data:
        return web.json_response({"ok": False, "error": "Task not found"}, status=404)
    task = t.data[0]

    if int(task.get("owner_id") or 0) == uid:
        return web.json_response({"ok": False, "error": "Нельзя выполнять своё задание"}, status=403)

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
    dup = await sb_select(T_COMP, {"task_id": task_id_db, "user_id": uid}, limit=1)
    if dup.data:
        return web.json_response({"ok": False, "error": "Уже отправляли выполнение"}, status=400)

    is_auto = (task.get("check_type") == "auto") and (task.get("type") == "tg")

    # require that user opened the task link (anti-fake) for manual checks
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

        # XP + maybe referral payout
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
                await sb_update(T_TASKS, {"id": task_id_db}, upd)
        except Exception:
            pass

        await sb_insert(T_COMP, {
            "task_id": task_id_db,
            "user_id": uid,
            "status": "paid",
            "proof_text": "AUTO_TG_OK",
            "proof_url": None,
            "moderated_at": _now().isoformat(),
        })

        return web.json_response({"ok": True, "status": "paid", "earned": reward, "xp_added": xp_added})

    # manual proof: обязательно нужен proof_url
    if not proof_url:
        return web.json_response({"ok": False, "error": "Нужен скриншот доказательства"}, status=400)

    await sb_insert(T_COMP, {
        "task_id": task_id_db,
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
    # Withdrawals only on Saturday/Sunday (Moscow time). Admins can bypass.
    try:
        if int(uid) not in ADMIN_IDS:
            msk = timezone(timedelta(hours=3))
            wd = datetime.now(msk).weekday()  # Mon=0 ... Sun=6
            if wd not in (5, 6):
                return web.json_response({"ok": False, "error": "Заявки на вывод принимаются только в субботу и воскресенье."}, status=400)
    except Exception:
        pass

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
# Telegram Stars (Mini App -> API): create invoice link
# -------------------------
async def api_stars_link(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    rate_limit_enforce(uid, "topup", min_interval_sec=60, spam_strikes=3, block_sec=600)
    body = await safe_json(req)

    amount = parse_amount_rub(body.get("amount_rub") or body.get("amount") or body.get("sum") or body.get("value") or body.get("rub"))
    if amount is None:
        return web.json_response({"ok": False, "error": "Некорректная сумма"}, status=400)
    if amount < MIN_STARS_TOPUP_RUB:
        return web.json_response({"ok": False, "error": f"Минимум {MIN_STARS_TOPUP_RUB:.0f}₽"}, status=400)

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
    if amount < MIN_STARS_TOPUP_RUB:
        return web.json_response({"ok": False, "error": f"Минимум {MIN_STARS_TOPUP_RUB:.0f}₽"}, status=400)

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
            ops.append({
                "kind": "topup",
                "provider": provider,
                "status": status,
                "amount_rub": amount,
                "created_at": p.get("created_at"),
                "id": p.get("id"),
            })
        elif provider == "admin_credit":
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

async def api_admin_balance_credit(req: web.Request):
    admin = await require_admin(req)
    # only MAIN admin can credit balances
    if int(MAIN_ADMIN_ID or 0) and int(admin["id"]) != int(MAIN_ADMIN_ID or 0):
        raise web.HTTPForbidden(text="Only main admin")

    body = await safe_json(req)
    user_id = int(body.get("user_id") or body.get("uid") or 0)

    amount = parse_amount_rub(body.get("amount_rub") or body.get("amount") or body.get("sum") or body.get("value") or body.get("rub"))
    if amount is None or amount <= 0:
        return web.json_response({"ok": False, "error": "Некорректная сумма"}, status=400)
    reason = str(body.get("reason") or body.get("comment") or "Начисление админом").strip()

    if user_id <= 0:
        return web.json_response({"ok": False, "error": "Некорректный user_id"}, status=400)

    await add_rub(user_id, float(amount))
    try:
        await sb_insert(T_PAY, {
            "user_id": user_id,
            "provider": "admin_credit",
            "status": "paid",
            "amount_rub": float(amount),
            "provider_ref": f"admin_credit:{int(admin['id'])}:{int(_now().timestamp())}",
            "meta": {"reason": reason, "admin_id": int(admin["id"])}
        })
    except Exception:
        pass

    try:
        await notify_user(user_id, f"💸 Начисление: +{float(amount):.2f}₽\nПричина: {reason}")
    except Exception:
        pass

    return web.json_response({"ok": True})

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

    visible_after_ya = _now() - timedelta(days=3)

    out = []
    for c in comps:
        tid = str(c.get("task_id"))
        t = tasks_map.get(tid)

        # Delay Yandex review proofs: show to admins only after 3 days
        if t and t.get("type") == "ya":
            ca = c.get("created_at")
            dt = None
            try:
                if isinstance(ca, str) and ca:
                    s = ca.replace("Z", "+00:00")
                    dt = datetime.fromisoformat(s)
            except Exception:
                dt = None
            if dt and dt > visible_after_ya:
                continue

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
    approved_raw = body.get("approved")
    if isinstance(approved_raw, bool):
        approved = approved_raw
    elif isinstance(approved_raw, (int, float)):
        approved = bool(approved_raw)
    else:
        approved = str(approved_raw).strip().lower() in ("1","true","yes","y","on")

    fake = bool(body.get("fake"))

    if proof_id is None:
        raise web.HTTPBadRequest(text="Missing proof_id")

    r = await sb_select(T_COMP, {"id": cast_id(proof_id)}, limit=1)
    if not r.data:
        return web.json_response({"ok": False, "error": "Proof not found"}, status=404)
    proof = r.data[0]

    if proof.get("status") != "pending":
        return web.json_response({"ok": True, "status": proof.get("status")})

    task_id = proof.get("task_id")
    user_id = int(proof.get("user_id") or 0)

    t = await sb_select(T_TASKS, {"id": task_id_db}, limit=1)
    task = (t.data or [{}])[0]
    reward = float(task.get("reward_rub") or 0)


    if approved:
        # 1) начисление — обязательное, иначе не принимаем
        try:
            await add_rub(user_id, reward)
        except Exception as e:
            log.exception("approve proof failed: add_rub uid=%s reward=%s err=%s", user_id, reward, e)
            return web.json_response({
                "ok": False,
                "code": "PAYOUT_FAILED",
                "message": "Не удалось принять отчёт: ошибка начисления. Проверь таблицу balances (rub_balance) и права Supabase."
            }, status=200)

        # 2) статистика/XP/рефералка — best effort (не блокируем модерацию)
        await stats_add("payouts_rub", reward)
        try:
            xp_added = task_xp(task)
            await add_xp(user_id, xp_added)
        except Exception as e:
            log.warning("add_xp skipped: %s", e)

        await maybe_pay_referral_bonus(user_id)

        await sb_update(T_COMP, {"id": cast_id(proof_id)}, {
            "status": "paid",
            "moderated_by": int(admin["id"]),
            "moderated_at": _now().isoformat(),
        })

        try:
            left = int(task.get("qty_left") or 0)
            if left > 0:
                new_left = max(0, left - 1)
                upd = {"qty_left": new_left}
                if new_left <= 0:
                    upd["status"] = "closed"
                await sb_update(T_TASKS, {"id": task_id_db}, upd)
        except Exception:
            pass

        try:
            xp_txt = f" +{int(xp_added)} XP" if "xp_added" in locals() and int(xp_added) > 0 else ""
        except Exception:
            xp_txt = ""
        await notify_user(user_id, f"✅ Отчёт принят. Начислено +{reward:.2f}₽{xp_txt}")
    else:
        # rejected / fake
        new_status = "fake" if fake else "rejected"
        await sb_update(T_COMP, {"id": cast_id(proof_id)}, {
            "status": new_status,
            "moderated_by": int(admin["id"]),
            "moderated_at": _now().isoformat(),
        })
        if fake:
            try:
                until = await set_task_ban(user_id, days=3)
            except Exception:
                until = None
            txt = "🚫 Отчёт отмечен как фейк. Доступ к заданиям ограничен на 3 дня.\n\n⚠️ Предупреждение: за фейки применяются штрафы — блокировки, заморозка выплат и возможное снятие бонусов."
            if until:
                txt += f"\n\nБлокировка до: {until.strftime('%d.%m %H:%M')}"
            await notify_user(user_id, txt)
        else:
            await notify_user(user_id, "❌ Отчёт отклонён модератором.")

    try:
        resp_extra = {"xp_added": int(xp_added)} if "xp_added" in locals() else {}
    except Exception:
        resp_extra = {}
    return web.json_response({"ok": True, **resp_extra})

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
            miniapp_url = base.rstrip("/") + "/app/?v=fix_20260219"

    if miniapp_url and "v=" not in miniapp_url:
        miniapp_url = miniapp_url + ("&" if "?" in miniapp_url else "?") + "v=fix_20260219"

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

@dp.callback_query(F.data == "help_newbie")
async def cb_help(cq: CallbackQuery):
    await cq.answer()
    await cq.message.answer(
        '📌 *Инструкция новичку — ReviewCash*\n\n🚀 *Как зарабатывать:*\n1️⃣ Нажми «🚀 Открыть приложение»\n2️⃣ Выбери задание\n3️⃣ Обязательно нажми «Перейти к выполнению»\n4️⃣ Выполни задание\n5️⃣ Вернись и нажми «Отправить отчёт»\n6️⃣ Дождись проверки — получи ₽ на баланс\n\n💰 *Начисление денег*\n— Деньги приходят после проверки администратором  \n— TG-задания могут проверяться автоматически\n\n🏆 *Уровни (LVL)*\n— За одобренные задания начисляется XP  \n— Кол-во XP зависит от сложности задания  \n— 100 XP = +1 уровень  \nЧем выше уровень — тем выше доверие\n\n🎁 *Рефералка*\n— 50₽ за каждого друга  \n— Бонус начисляется, когда друг выполнит первое задание\n\n⏳ *Лимиты*\nНекоторые задания можно выполнять:\n— 1 раз\n— или с интервалом (1–3 дня)\nЕсли задание не видно — лимит ещё не прошёл\n\n⚡ *Режимы приложения*\nВ профиле есть переключатель «⚡ Режим»:\n— *Слабое устройство* — меньше эффектов и реже авто-обновление\n— *Нормальное* — плавнее анимации и обновление чаще\n\n🚫 *Важно!*\nЗапрещено:\n— фейковые скриншоты\n— отзывы не со своего аккаунта\n— поддельные доказательства\n\nЕсли админ нажмёт «Фейк»:\n— блокировка на 3 дня по этому заданию\n— возможны штрафы (заморозка выплат/снятие бонусов) при повторных нарушениях\n\n❓ *Проблемы?*\nЕсли не отправляется отчёт —\nты не нажал «Перейти к выполнению».\n\nРаботай честно — и выплаты будут без проблем 💎',
        parse_mode=ParseMode.MARKDOWN,
    )

@dp.callback_query(F.data == "toggle_notify")
async def cb_toggle_notify(cq: CallbackQuery):
    uid = cq.from_user.id
    muted = await is_notify_muted(uid)
    new_muted = not muted
    await set_notify_muted(uid, new_muted)

    try:
        kb = InlineKeyboardBuilder()

        miniapp_url = MINIAPP_URL
        if not miniapp_url:
            base = SERVER_BASE_URL or BASE_URL
            if base:
                miniapp_url = base.rstrip("/") + "/app/?v=fix_20260219"

        if miniapp_url:
            kb.button(text="🚀 Открыть приложение", web_app=WebAppInfo(url=miniapp_url))
        kb.button(text=("🔕 Уведомления: ВЫКЛ" if new_muted else "🔔 Уведомления: ВКЛ"), callback_data="toggle_notify")
        kb.button(text="📌 Инструкция новичку", callback_data="help_newbie")
        kb.adjust(1)

        await cq.message.edit_reply_markup(reply_markup=kb.as_markup())
    except Exception:
        pass

    await cq.answer("Уведомления выключены 🔕" if new_muted else "Уведомления включены 🔔", show_alert=False)

    # Confirm in chat (force=true so it always arrives)
    await notify_user(uid, ("🔕 Уведомления отключены. Чтобы включить — нажми кнопку ещё раз." if new_muted
                            else "🔔 Уведомления включены."), force=True)

@dp.message(Command("notify"))
async def cmd_notify(message: Message):
    uid = message.from_user.id
    muted = await is_notify_muted(uid)
    new_muted = not muted
    await set_notify_muted(uid, new_muted)
    await message.answer("🔕 Уведомления отключены." if new_muted else "🔔 Уведомления включены.")


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
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type, X-Tg-InitData, X-Tg-Init-Data, X-Telegram-Init-Data, X-Session-Token, Authorization"
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
    # Быстрый ответ Telegram: обработку делаем в фоне, чтобы webhook не таймаутился
    try:
        asyncio.create_task(dp.feed_webhook_update(bot, update))
    except Exception:
        await dp.feed_webhook_update(bot, update)
    return web.Response(text="OK")

def make_app():
    # client_max_size важен для загрузки скриншотов (по умолчанию ~1MB)
    app = web.Application(middlewares=[cors_middleware], client_max_size=10 * 1024 * 1024)

    app.router.add_get("/", health)
    app.router.add_get("/api/health", health)
    # static miniapp at /app/
    base_dir = Path(__file__).resolve().parent

    # ВСЕГДА раздаём Mini App только из папки ./public (без подхвата файлов из корня)
    static_dir = base_dir / "public"
    if static_dir.exists():
        async def app_redirect(req: web.Request):
            raise web.HTTPFound(f"/app/?v={APP_BUILD}")

        async def app_index(req: web.Request):
            # Serve index.html with build placeholder replaced to bust Telegram WebView cache.
            try:
                html = (static_dir / "index.html").read_text(encoding="utf-8")
            except Exception:
                return web.FileResponse(static_dir / "index.html")
            html = html.replace("__APP_BUILD__", APP_BUILD)
            resp = web.Response(text=html, content_type="text/html")
            resp.headers["Cache-Control"] = "no-store, max-age=0"
            resp.headers["Pragma"] = "no-cache"
            resp.headers["Expires"] = "0"
            return resp

        app.router.add_get("/app", app_redirect)
        app.router.add_get("/app/", app_index)
        app.router.add_static("/app/", path=str(static_dir), show_index=False)
    else:
        log.warning("Static dir not found: %s", static_dir)
    # tg webhook
    app.router.add_post(WEBHOOK_PATH, tg_webhook)

    # API
    app.router.add_post("/api/sync", api_sync)
    app.router.add_post("/api/tg/check_chat", api_tg_check_chat)
    app.router.add_post("/api/task/create", api_task_create)
    app.router.add_post("/api/task/click", api_task_click)
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
    app.router.add_post("/api/admin/balance/credit", api_admin_balance_credit)
    app.router.add_post("/api/admin/proof/list", api_admin_proof_list)
    app.router.add_post("/api/admin/proof/decision", api_admin_proof_decision)
    app.router.add_post("/api/admin/withdraw/list", api_admin_withdraw_list)
    app.router.add_post("/api/admin/withdraw/decision", api_admin_withdraw_decision)
    app.router.add_post("/api/admin/tbank/list", api_admin_tbank_list)
    app.router.add_post("/api/admin/tbank/decision", api_admin_tbank_decision)
    app.router.add_post("/api/admin/task/list", api_admin_task_list)
    app.router.add_post("/api/admin/task/delete", api_admin_task_delete)
    app.router.add_post("/api/admin/task/tg_audit", api_admin_tg_audit)

    return app

async def on_startup(app: web.Application):
    await setup_menu_button(bot)
    # diagnostics: confirm which bot token is running
    try:
        me = await bot.get_me()
        log.warning(f"[SYNC_DIAG] Bot identity: @{me.username} id={me.id}")
    except Exception as e:
        log.error(f"[SYNC_DIAG] Bot identity check failed: {e}")
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




# -------------------------
# ADMIN: tasks list + delete (delete only by main admin)
# -------------------------
async def api_admin_task_list(req: web.Request):
    await require_admin(req)
    user = await require_admin(req)

    sel = await sb_select(T_TASKS, match={"status": "active"}, order="created_at", desc=True, limit=200)
    raw = sel.data or []
    tasks = [t for t in raw if int(t.get("qty_left") or 0) > 0]
    return web.json_response({"ok": True, "tasks": tasks, "is_main_admin": int(MAIN_ADMIN_ID or 0) == int(user["id"])})

async def api_admin_task_delete(req: web.Request):
    await require_main_admin(req)
    body = await safe_json(req)
    task_id = str(body.get("task_id") or "").strip()
    if not task_id:
        return json_error(400, "task_id required", code="BAD_TASK_ID")
    # delete task and related proofs (best effort)
    await sb_delete(T_TASKS, {"id": cast_id(task_id)})
    try:
        await sb_delete(T_COMP, {"task_id": cast_id(task_id)})
    except Exception:
        pass
    return web.json_response({"ok": True})
# =========================================================

async def api_admin_tg_audit(req: web.Request):
    # This action modifies tasks, so only main admin.
    await require_main_admin(req)

    # fetch active tasks (up to 500), filter tg here
    sel = await sb_select(T_TASKS, match={"status": "active"}, order="created_at", desc=True, limit=500)
    raw = sel.data or []
    tg_tasks = [t for t in raw if t.get("type") == "tg" and int(t.get("qty_left") or 0) > 0]

    changed = 0
    set_auto = 0
    set_manual = 0
    problems = 0

    for t in tg_tasks:
        task_id = t.get("id")
        tg_chat = (t.get("tg_chat") or "").strip()
        target_url = str(t.get("target_url") or "")
        if not tg_chat:
            continue

        try:
            desired_check_type, desired_kind, reason = await tg_calc_check_type(tg_chat, target_url)
        except Exception:
            problems += 1
            continue

        upd = {}
        if (t.get("check_type") or "manual") != desired_check_type:
            upd["check_type"] = desired_check_type
        if (t.get("tg_kind") or "") != desired_kind:
            upd["tg_kind"] = desired_kind

        if upd:
            try:
                await sb_update(T_TASKS, {"id": task_id_db}, upd)
                changed += 1
                if desired_check_type == "auto":
                    set_auto += 1
                else:
                    set_manual += 1
            except Exception:
                problems += 1

    return web.json_response({
        "ok": True,
        "total_tg": len(tg_tasks),
        "changed": changed,
        "set_auto": set_auto,
        "set_manual": set_manual,
        "problems": problems,
    })

# Gunicorn entrypoint: expose 'app'
# =========================================================
app = make_app()
app.on_startup.append(on_startup)
app.on_cleanup.append(on_cleanup)

if __name__ == "__main__":
    web.run_app(app, host="0.0.0.0", port=PORT)
WEBAPP_SESSION_SECRET = os.getenv("WEBAPP_SESSION_SECRET", "change-me-session-secret")
