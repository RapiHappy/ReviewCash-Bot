import os
import json
import re
import hmac
import hashlib
import base64
import time
import asyncio
import logging
import html
from datetime import datetime, timezone, date, timedelta, time as dt_time
from typing import Any

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
    ReplyKeyboardMarkup,
    KeyboardButton,
    ReplyKeyboardRemove,
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

# Build tag for diagnostics (to ensure Render runs the expected version)
BUILD_TAG = 'rc_backend_release5_lvldouble'
try:
    log.warning('[BUILD] %s', BUILD_TAG)
except Exception:
    pass


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
MANDATORY_SUB_CHANNEL = os.getenv("MANDATORY_SUB_CHANNEL", "").strip()  # example: @yourchannel

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
MAX_SUBMITS_10M = int(os.getenv("MAX_SUBMITS_10M", "10").strip())
SUBMIT_WINDOW_SEC = int(os.getenv("SUBMIT_WINDOW_SEC", "600").strip())
SUBMIT_WINDOW_BLOCK_SEC = int(os.getenv("SUBMIT_WINDOW_BLOCK_SEC", "1800").strip())
MIN_TASK_SUBMIT_SEC = int(os.getenv("MIN_TASK_SUBMIT_SEC", "8").strip())
EXPENSIVE_TASK_REWARD_RUB = float(os.getenv("EXPENSIVE_TASK_REWARD_RUB", "25").strip())
NEW_ACCOUNT_EXPENSIVE_LOCK_DAYS = int(os.getenv("NEW_ACCOUNT_EXPENSIVE_LOCK_DAYS", "3").strip())
FIRST_WITHDRAW_MIN_PAID_TASKS = int(os.getenv("FIRST_WITHDRAW_MIN_PAID_TASKS", "3").strip())

# limits
YA_COOLDOWN_SEC = int(os.getenv("YA_COOLDOWN_SEC", str(3 * 24 * 3600)).strip())
GM_COOLDOWN_SEC = int(os.getenv("GM_COOLDOWN_SEC", str(1 * 24 * 3600)).strip())

# topup minimum
MIN_TOPUP_RUB = float(os.getenv("MIN_TOPUP_RUB", "120").strip())
# Stars topup minimum (in RUB)
MIN_STARS_TOPUP_RUB = float(os.getenv("MIN_STARS_TOPUP_RUB", "120").strip())

# Stars rate: сколько рублей даёт 1 Star
STARS_RUB_RATE = float(os.getenv("STARS_RUB_RATE", "1.0").strip())

# Debug bypass (НЕ включай в проде)
DISABLE_INITDATA = os.getenv("DISABLE_INITDATA", "0").strip() == "1"

# Proof upload (Supabase Storage)
PROOF_BUCKET = os.getenv("PROOF_BUCKET", "proofs").strip() or "proofs"
MAX_PROOF_MB = int(os.getenv("MAX_PROOF_MB", "8").strip())

# Levels / XP
XP_PER_LEVEL = int(os.getenv("XP_PER_LEVEL", "100").strip())          # базовый XP для LVL 1 -> 2
XP_LEVEL_STEP = int(os.getenv("XP_LEVEL_STEP", "2").strip())     # множитель роста XP на каждый следующий уровень
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
        if re.match(r"(?im)^\s*TG_EXPECT_TEXT\s*:", line):
            continue
        if re.match(r"(?im)^\s*TG_CALLBACK_DATA\s*:", line):
            continue
        if re.match(r"(?im)^\s*TG_REF_COUNT\s*:", line):
            continue
        if re.match(r"(?im)^\s*TG_POLL_ID\s*:", line):
            continue
        if re.match(r"(?im)^\s*TOP_(ACTIVE_UNTIL|BOUGHT_AT|PRICE_RUB)\s*:", line):
            continue
        if re.match(r"(?im)^\s*(RETENTION_DAYS|CUSTOM_REVIEW_MODE|CUSTOM_REVIEW_TEXTS)\s*:", line):
            continue
        out.append(line)
    return "\n".join(out).strip()



def get_meta_value(task: dict | None, key: str) -> str:
    ins = str((task or {}).get("instructions") or "")
    m = re.search(rf"(?im)^\s*{re.escape(key)}\s*:\s*(.+?)\s*$", ins)
    return str(m.group(1)).strip() if m else ""


def get_review_texts(task: dict | None) -> list[str]:
    raw = get_meta_value(task, "CUSTOM_REVIEW_TEXTS")
    if not raw:
        return []
    try:
        data = json.loads(base64.b64decode(raw.encode("utf-8")).decode("utf-8"))
        if isinstance(data, list):
            return [str(x).strip() for x in data if str(x).strip()]
    except Exception:
        return []
    return []


def get_custom_review_mode(task: dict | None) -> str:
    return (get_meta_value(task, "CUSTOM_REVIEW_MODE") or "none").strip().lower()


REWORK_GRACE_DAYS = 3
ACTIVE_REWORK_STATUSES = {"rework"}


def _parse_dt(raw: Any) -> datetime | None:
    try:
        if isinstance(raw, datetime):
            return raw if raw.tzinfo else raw.replace(tzinfo=timezone.utc)
        if isinstance(raw, str) and raw.strip():
            return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except Exception:
        return None
    return None


def rework_deadline_dt(comp: dict | None) -> datetime | None:
    dt = _parse_dt((comp or {}).get("moderated_at"))
    if not dt:
        return None
    return dt + timedelta(days=REWORK_GRACE_DAYS)


def is_rework_active(comp: dict | None, now: datetime | None = None) -> bool:
    status = str((comp or {}).get("status") or "").lower()
    if status not in ACTIVE_REWORK_STATUSES:
        return False
    deadline = rework_deadline_dt(comp)
    if not deadline:
        return False
    return deadline > (now or _now())


async def expire_rework_if_needed(comp: dict | None) -> dict | None:
    if not comp or str(comp.get("status") or "").lower() != "rework":
        return comp
    if is_rework_active(comp):
        return comp
    try:
        await sb_update(T_COMP, {"id": cast_id(comp.get("id"))}, {
            "status": "rework_expired",
            "moderated_at": _now().isoformat(),
        })
        comp = dict(comp)
        comp["status"] = "rework_expired"
    except Exception:
        pass
    return comp


def pick_review_text_for_task(task: dict | None, slot_index: int) -> str:
    texts = get_review_texts(task)
    if not texts:
        return ""
    mode = get_custom_review_mode(task)
    if mode == "single":
        return texts[0]
    if mode == "per_item":
        idx = max(0, min(int(slot_index), len(texts) - 1))
        return texts[idx]
    return ""


def get_retention_days(task: dict | None) -> int:
    try:
        return max(0, int(get_meta_value(task, "RETENTION_DAYS") or 0))
    except Exception:
        return 0

def get_tg_subtype(task: dict | None) -> str:
    ins = str((task or {}).get("instructions") or "")
    m = re.search(r"(?im)^\s*TG_SUBTYPE\s*:\s*([a-z0-9_\-]+)\s*$", ins)
    return str(m.group(1)).strip().lower() if m else ""

def tg_subtype(task: dict | None) -> str:
    return get_tg_subtype(task)

def tg_stack_key(task: dict | None) -> str:
    """One canonical TG target key for stacking all member tasks by the same link/chat.
    If user already did any TG member task on this target, hide all other TG member tasks
    for the same public @username regardless of subtype (+24h/+48h/+72h etc.).
    """
    task = task or {}
    subtype = get_tg_subtype(task)
    if subtype and subtype not in TG_MEMBER_SUBTYPES:
        return ""
    return tg_task_identity(task)


def tg_display_dedupe_key(task: dict | None) -> str:
    """Hide duplicate TG cards with the same target and the same subtype.

    Example: two active TG tasks both asking to subscribe to the same @channel should be
    shown to executors as a single card. For different TG subtypes on the same target we keep
    separate cards until the user completes one of them; after completion tg_stack_key() hides
    all member-task variants for that target.
    """
    task = task or {}
    if str(task.get("type") or "") != "tg":
        return ""
    ident = tg_task_identity(task)
    if not ident:
        return ""
    subtype = get_tg_subtype(task) or "tg"
    return f"{subtype}|{ident}"



def get_task_target_gender(task: dict | None) -> str:
    t = task or {}
    raw = t.get("target_gender")
    g = normalize_task_gender(raw)
    if g != TASK_GENDER_ANY:
        return g
    ins = str(t.get("instructions") or "")
    m = re.search(r"(?im)^\s*TARGET_GENDER\s*:\s*(male|female|any)\s*$", ins)
    if m:
        return normalize_task_gender(m.group(1))
    return TASK_GENDER_ANY


def get_top_meta(task: dict | None, key: str) -> str:
    ins = str((task or {}).get("instructions") or "")
    m = re.search(rf"(?im)^\s*{re.escape(key)}\s*:\s*(.+?)\s*$", ins)
    return str(m.group(1)).strip() if m else ""

def parse_dt_safe(value: str | None):
    s = str(value or "").strip()
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None

def is_top_active(task: dict | None) -> bool:
    until = parse_dt_safe(get_top_meta(task, "TOP_ACTIVE_UNTIL"))
    return bool(until and until > _now())

def top_bought_at(task: dict | None):
    return parse_dt_safe(get_top_meta(task, "TOP_BOUGHT_AT")) or datetime.fromtimestamp(0, tz=timezone.utc)

def get_tg_meta(task: dict | None, key: str) -> str:
    ins = str((task or {}).get("instructions") or "")
    m = re.search(rf"(?im)^\s*{re.escape(key)}\s*:\s*(.+?)\s*$", ins)
    return str(m.group(1)).strip() if m else ""

# Referral
REF_BONUS_RUB = float(os.getenv("REF_BONUS_RUB", "50").strip())       # бонус рефереру 1 раз
REF_REVIEWS_REQUIRED = int(os.getenv("REF_REVIEWS_REQUIRED", "2").strip())  # сколько оплаченных отзывов должен сделать приглашённый

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
TG_HOLD_WORKER_TASK: asyncio.Task | None = None


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


def get_required_sub_channel() -> str | None:
    return normalize_tg_chat(MANDATORY_SUB_CHANNEL)


async def tg_check_required_subscription(user_id: int) -> tuple[bool, str | None, str]:
    chat = get_required_sub_channel()
    if not chat:
        return True, None, ""
    try:
        member = await bot.get_chat_member(chat_id=chat, user_id=int(user_id))
        status = str(getattr(member, "status", "") or "").lower()
        if status in ("member", "administrator", "creator", "restricted"):
            return True, chat, ""
        return False, chat, "Подпишись на канал, чтобы пользоваться ботом."
    except Exception:
        return False, chat, "Подпишись на канал, затем нажми «Проверить подписку». Убедись, что бот добавлен в канал админом."


def required_subscribe_kb() -> InlineKeyboardMarkup | None:
    chat = get_required_sub_channel()
    if not chat:
        return None
    url = f"https://t.me/{chat.lstrip('@')}"
    return InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text="📢 Подписаться", url=url),
    ], [
        InlineKeyboardButton(text="✅ Проверить подписку", callback_data="check_required_sub"),
    ]])
def tg_task_identity(task: dict | None) -> str:
    """Stable identity for TG task target to suppress duplicates by same link/chat."""
    task = task or {}
    tg_chat = normalize_tg_chat((task.get("tg_chat") or task.get("target_url") or ""))
    if tg_chat:
        return tg_chat.lower()
    raw = str(task.get("target_url") or "").strip().lower()
    raw = re.sub(r"^https?://", "", raw)
    raw = raw.split("?")[0].rstrip("/")
    return raw

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
        if ctype == "channel" and status not in ("administrator", "creator"):
            TG_CHAT_CACHE[key] = (now, False, "Для канала бот должен быть админом перед созданием задания.")
            return TG_CHAT_CACHE[key][1], TG_CHAT_CACHE[key][2]
        TG_CHAT_CACHE[key] = (now, True, "")
        return True, ""
    except Exception:
        TG_CHAT_CACHE[key] = (now, False, "Не удалось проверить чат. Добавь бота в группу/канал (и для канала — админом), затем попробуй снова.")
        return False, TG_CHAT_CACHE[key][2]



def is_private_tg_target(raw: str | None) -> bool:
    s = str(raw or '').strip().lower()
    return ('t.me/+' in s) or ('t.me/joinchat/' in s) or ('telegram.me/+' in s) or ('joinchat/' in s)

async def tg_get_chat_kind(chat_username: str) -> str:
    chat = await bot.get_chat(chat_username)
    return str(getattr(chat, 'type', '') or '').strip().lower()

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

async def sb_count(
    table: str,
    match: dict | None = None,
    neq: dict | None = None,
    gt: dict | None = None,
    gte: dict | None = None,
    lt: dict | None = None,
    lte: dict | None = None,
):
    def _f():
        q = sb.table(table).select("*", count="exact", head=True)
        if match:
            for k, v in match.items():
                q = q.eq(k, v)
        if neq:
            for k, v in neq.items():
                q = q.neq(k, v)
        if gt:
            for k, v in gt.items():
                q = q.gt(k, v)
        if gte:
            for k, v in gte.items():
                q = q.gte(k, v)
        if lt:
            for k, v in lt.items():
                q = q.lt(k, v)
        if lte:
            for k, v in lte.items():
                q = q.lte(k, v)
        res = q.execute()
        return int(getattr(res, "count", 0) or 0)
    try:
        return await sb_exec(_f)
    except Exception as e:
        log.warning("sb_count failed table=%s: %s", table, e)
        return 0

async def sb_distinct_count(
    table: str,
    column: str,
    match: dict | None = None,
    batch: int = 1000,
    max_rows: int = 100000,
):
    def _f():
        seen = set()
        start = 0
        while True:
            q = sb.table(table).select(column)
            if match:
                for k, v in match.items():
                    q = q.eq(k, v)
            q = q.order(column, desc=False).range(start, start + batch - 1)
            res = q.execute()
            rows = res.data or []
            if not rows:
                break
            for row in rows:
                val = row.get(column)
                if val is not None and val != "":
                    seen.add(val)
            start += len(rows)
            if len(rows) < batch or start >= max_rows:
                break
        return len(seen)
    try:
        return await sb_exec(_f)
    except Exception as e:
        log.warning("sb_distinct_count failed table=%s column=%s: %s", table, column, e)
        return 0
# -------------------------
# helpers: tolerate schema differences (e.g., balances table without 'level' column)
# -------------------------
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
def xp_needed_for_levelup(level: int) -> int:
    level = max(1, int(level or 1))
    base = max(1, int(XP_PER_LEVEL))
    mult = max(1, int(XP_LEVEL_STEP or 2))
    return int(base * (mult ** (level - 1)))

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
# referral system (bonus 1 time after invited user completes required number of paid reviews)
# -------------------------
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

        required_reviews = max(1, int(REF_REVIEWS_REQUIRED))
        paid_reviews = await referral_paid_reviews_count(referred_id)
        if paid_reviews < required_reviews:
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

        await notify_user(referrer_id, f"🎉 Реферальный бонус: +{bonus:.2f}₽ (приглашённый выполнил {required_reviews} оплаченных отзыва)")
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
FEATURE_STARS_PAY_DISABLED_KEY = "feature_stars_pay_disabled"


def _feature_flags_user_id() -> int:
    try:
        return int(MAIN_ADMIN_ID or 0)
    except Exception:
        return 0


async def is_stars_payments_enabled() -> bool:
    ff_uid = _feature_flags_user_id()
    if ff_uid <= 0:
        return True
    try:
        r = await sb_select(T_LIMITS, {"user_id": ff_uid, "limit_key": FEATURE_STARS_PAY_DISABLED_KEY}, limit=1)
        return not bool(r.data)
    except Exception:
        return True


async def set_stars_payments_enabled(enabled: bool, admin_id: int | None = None) -> bool:
    ff_uid = _feature_flags_user_id()
    if ff_uid <= 0:
        return bool(enabled)

    # user_limits.user_id -> users.user_id FK: before writing a feature flag,
    # make sure the owner row exists.
    try:
        await sb_upsert(T_USERS, {"user_id": ff_uid}, on_conflict="user_id")
    except Exception:
        pass

    if enabled:
        try:
            await sb_delete(T_LIMITS, {"user_id": ff_uid, "limit_key": FEATURE_STARS_PAY_DISABLED_KEY})
        except Exception:
            pass
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
    return False


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
SUBMIT_WINDOW_KEY = "task_submit_window"
SUBMIT_BLOCK_KEY = "task_submit_block_until"
FIRST_WITHDRAW_DONE_KEY = "first_withdraw_done"
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

async def get_submit_block_until(uid: int):
    return await get_limit_until(uid, SUBMIT_BLOCK_KEY)

async def mark_submit_attempt(uid: int, ok: bool = False):
    """Track submit attempts using only timestamp rows in user_limits.

    user_limits.last_at is a timestamptz column, so we cannot store JSON there.
    We use one rolling timestamp for the submit window and one block-until timestamp.
    """
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

# Global / feature bans (admin)
GLOBAL_BAN_KEY = "global_ban_until"      # blocks any paid actions
TBANK_BAN_KEY = "tbank_ban_until"        # blocks T-Bank topups
WITHDRAW_BAN_KEY = "withdraw_ban_until"  # blocks withdrawals (in addition to weekend rule)

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
            # cleanup expired
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

async def get_global_ban_until(uid: int):
    return await get_limit_until(uid, GLOBAL_BAN_KEY)

async def get_tbank_ban_until(uid: int):
    return await get_limit_until(uid, TBANK_BAN_KEY)

async def get_withdraw_ban_until(uid: int):
    return await get_limit_until(uid, WITHDRAW_BAN_KEY)

# -------------------------
# T-Bank topup cooldown (once per 24h after successful topup)
# -------------------------
TBANK_COOLDOWN_KEY = "tbank_topup_until"
TBANK_COOLDOWN_SEC = int(os.getenv("TBANK_COOLDOWN_SEC", str(24 * 3600)).strip())

async def get_tbank_cooldown_until(uid: int):
    """Returns datetime until user is blocked from creating new T-Bank topup requests, or None."""
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
    """Returns True if user clicked task link recently."""
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

# -------------------------
# Telegram auto-check: member status
# -------------------------
def _normalize_chat(chat: str) -> str:
    if not chat:
        return chat
    chat = chat.strip()
    chat = chat.replace("https://t.me/", "").replace("http://t.me/", "")
    if not chat.startswith("@") and not chat.startswith("-100"):
        chat = "@" + chat
    return chat

async def tg_is_member(chat: str, user_id: int) -> bool:
    try:
        chat = _normalize_chat(chat)
        cm = await bot.get_chat_member(chat_id=chat, user_id=user_id)
        status = str(getattr(cm, "status", "")).lower()
        return status in ("member","administrator","creator","restricted")
    except Exception as e:
        log.warning("subscription check error: %s", e)
        return False

TG_HOLD_PREFIX = "tg_hold:"
TG_SUB_CHANNEL_KEY = "sub_channel"
TG_JOIN_GROUP_KEY = "join_group"
TG_SUB_24H_KEY = "sub_24h"
TG_SUB_48H_KEY = "sub_48h"
TG_SUB_72H_KEY = "sub_72h"
TG_JOIN_GROUP_24H_KEY = "join_group_24h"
TG_JOIN_GROUP_48H_KEY = "join_group_48h"
TG_JOIN_GROUP_72H_KEY = "join_group_72h"
TG_BOT_START_KEY = "bot_start"
TG_BOT_CALLBACK_KEY = "bot_callback"
TG_BOT_MESSAGE_KEY = "bot_message"
TG_MINIAPP_OPEN_KEY = "miniapp_open"

USER_GENDER_MALE_KEY = "gender:male"
USER_GENDER_FEMALE_KEY = "gender:female"
TASK_GENDER_ANY = "any"
TASK_GENDER_MALE = "male"
TASK_GENDER_FEMALE = "female"
TG_INVITE_FRIENDS_KEY = "invite_friends"
TG_POLL_VOTE_KEY = "poll_vote"

TG_CHANNEL_SUBTYPES = {TG_SUB_CHANNEL_KEY, TG_SUB_24H_KEY, TG_SUB_48H_KEY, TG_SUB_72H_KEY}
TG_GROUP_SUBTYPES = {TG_JOIN_GROUP_KEY, TG_JOIN_GROUP_24H_KEY, TG_JOIN_GROUP_48H_KEY, TG_JOIN_GROUP_72H_KEY}
TG_HOLD_SUBTYPES = {TG_SUB_24H_KEY, TG_SUB_48H_KEY, TG_SUB_72H_KEY, TG_JOIN_GROUP_24H_KEY, TG_JOIN_GROUP_48H_KEY, TG_JOIN_GROUP_72H_KEY}
TG_MEMBER_SUBTYPES = TG_CHANNEL_SUBTYPES | TG_GROUP_SUBTYPES
TG_EVENT_SUBTYPES = {TG_BOT_START_KEY, TG_BOT_CALLBACK_KEY, TG_BOT_MESSAGE_KEY, TG_MINIAPP_OPEN_KEY, TG_INVITE_FRIENDS_KEY, TG_POLL_VOTE_KEY}

TG_EVT_PREFIX = "tg_evt:"

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
    rm = await sb_select(T_LIMITS, {"user_id": int(user_id), "limit_key": USER_GENDER_MALE_KEY}, limit=1)
    if rm.data:
        return TASK_GENDER_MALE
    rf = await sb_select(T_LIMITS, {"user_id": int(user_id), "limit_key": USER_GENDER_FEMALE_KEY}, limit=1)
    if rf.data:
        return TASK_GENDER_FEMALE
    return None


def normalize_task_gender(value: str | None) -> str:
    v = str(value or "").strip().lower()
    if v in (TASK_GENDER_MALE, TASK_GENDER_FEMALE):
        return v
    return TASK_GENDER_ANY


def _task_created_at(task: dict | None) -> datetime:
    return _parse_dt((task or {}).get("created_at")) or datetime(1970, 1, 1, tzinfo=timezone.utc)

def _dt_after_task(event_dt: datetime | None, task: dict | None) -> bool:
    if not event_dt:
        return False
    return event_dt >= _task_created_at(task)

async def tg_referrals_paid_since(uid: int, since_dt: datetime) -> int:
    r = await sb_select(T_REF, {"referrer_id": int(uid), "status": "paid"}, columns="id,created_at", limit=5000)
    cnt = 0
    for row in (r.data or []):
        dt = _parse_dt(row.get("created_at"))
        if dt and dt >= since_dt:
            cnt += 1
    return cnt

async def tg_poll_answer_seen_since(uid: int, since_dt: datetime, poll_id: str | None = None) -> bool:
    if poll_id:
        dt = await tg_evt_get(uid, "poll_answer", poll_id)
        return bool(dt and dt >= since_dt)
    dt = await tg_evt_get(uid, "poll_answer")
    return bool(dt and dt >= since_dt)

TG_BASE_RETENTION_DAYS = 2
TG_SUB_24H_DELAY_SEC = 24 * 3600
TG_SUB_48H_DELAY_SEC = 48 * 3600
TG_SUB_72H_DELAY_SEC = 72 * 3600

def tg_subtype_extra_days(subtype: str) -> int:
    subtype = str(subtype or '').strip().lower()
    if subtype in (TG_SUB_24H_KEY, TG_JOIN_GROUP_24H_KEY):
        return 1
    if subtype in (TG_SUB_48H_KEY, TG_JOIN_GROUP_48H_KEY):
        return 2
    if subtype in (TG_SUB_72H_KEY, TG_JOIN_GROUP_72H_KEY):
        return 3
    return 0

def tg_required_retention_days(subtype: str, extra_days: int = 0) -> int:
    return max(TG_BASE_RETENTION_DAYS, TG_BASE_RETENTION_DAYS + tg_subtype_extra_days(subtype) + max(0, int(extra_days or 0)))

def tg_hold_delay_sec(subtype: str, extra_days: int = 0) -> int:
    return tg_required_retention_days(subtype, extra_days) * 24 * 3600

def tg_hold_delay_hours(subtype: str, extra_days: int = 0) -> int:
    sec = tg_hold_delay_sec(subtype, extra_days)
    return max(0, sec // 3600)

TG_HOLD_SCAN_INTERVAL_SEC = int(os.getenv("TG_HOLD_SCAN_INTERVAL_SEC", "60").strip())


def tg_hold_key(task_id: str, user_id: int) -> str:
    return f"{TG_HOLD_PREFIX}{task_id}:{int(user_id)}"


def tg_hold_parse_key(limit_key: str) -> tuple[str, int] | None:
    try:
        s = str(limit_key or "")
        if not s.startswith(TG_HOLD_PREFIX):
            return None
        rest = s[len(TG_HOLD_PREFIX):]
        task_id, user_id_s = rest.split(":", 1)
        return str(task_id), int(user_id_s)
    except Exception:
        return None


async def tg_hold_get(task_id: str, user_id: int) -> datetime | None:
    key = tg_hold_key(task_id, user_id)
    r = await sb_select(T_LIMITS, {"user_id": int(user_id), "limit_key": key}, limit=1)
    if not r.data:
        return None
    return _parse_dt(r.data[0].get("last_at"))


async def tg_hold_set(task_id: str, user_id: int, due_at: datetime):
    key = tg_hold_key(task_id, user_id)
    await sb_upsert(
        T_LIMITS,
        {"user_id": int(user_id), "limit_key": key, "last_at": due_at.isoformat()},
        on_conflict="user_id,limit_key"
    )


async def tg_hold_clear(task_id: str, user_id: int):
    try:
        await sb_delete(T_LIMITS, {"user_id": int(user_id), "limit_key": tg_hold_key(task_id, user_id)})
    except Exception:
        pass


async def tg_hold_list_due(now_dt: datetime, limit: int = 500) -> list[dict]:
    def _f():
        return (
            sb.table(T_LIMITS)
            .select("user_id,limit_key,last_at")
            .like("limit_key", f"{TG_HOLD_PREFIX}%")
            .limit(int(limit))
            .execute()
        )
    r = await sb_exec(_f)
    out = []
    for row in (r.data or []):
        due_at = _parse_dt(row.get("last_at"))
        if due_at and due_at <= now_dt:
            out.append(row)
    return out


async def process_tg_holds_once():
    now_dt = _now()
    due_rows = await tg_hold_list_due(now_dt)
    for row in due_rows:
        parsed = tg_hold_parse_key(row.get("limit_key"))
        if not parsed:
            continue
        task_id, user_id = parsed
        task_id_db = cast_id(task_id)
        try:
            t = await sb_select(T_TASKS, {"id": task_id_db}, limit=1)
            task = (t.data or [None])[0]
            if not task or str(task.get("type") or "") != "tg":
                await tg_hold_clear(task_id, user_id)
                continue

            chat = str(task.get("tg_chat") or "").strip()
            if not chat:
                await tg_hold_clear(task_id, user_id)
                continue

            reward = float(task.get("reward_rub") or 0)
            ok_member = await tg_is_member(chat, user_id)
            if ok_member:
                await add_rub(user_id, reward)
                await stats_add("payouts_rub", reward)
                xp_added = task_xp(task)
                await add_xp(user_id, xp_added)
                await maybe_pay_referral_bonus(user_id)

                try:
                    left = int(task.get("qty_left") or 0)
                    if left > 0:
                        upd = {"qty_left": max(0, left - 1)}
                        if int(upd["qty_left"]) <= 0:
                            upd["status"] = "closed"
                        await sb_update(T_TASKS, {"id": task_id_db}, upd)
                except Exception:
                    pass

                c = await sb_select(T_COMP, {"task_id": task_id_db, "user_id": int(user_id), "status": "pending_hold"}, order="created_at", desc=True, limit=1)
                if c.data:
                    await sb_update(T_COMP, {"id": cast_id(c.data[0].get("id"))}, {
                        "status": "paid",
                        "proof_text": "AUTO_TG_HOLD_OK",
                        "moderated_at": _now().isoformat(),
                    })
                else:
                    await sb_insert(T_COMP, {
                        "task_id": task_id_db,
                        "user_id": int(user_id),
                        "status": "paid",
                        "proof_text": "AUTO_TG_HOLD_OK",
                        "proof_url": None,
                        "moderated_at": _now().isoformat(),
                    })
                await notify_user(user_id, f"✅ Проверка срока удержания пройдена. Начислено +{reward:.2f}₽")
            else:
                c = await sb_select(T_COMP, {"task_id": task_id_db, "user_id": int(user_id), "status": "pending_hold"}, order="created_at", desc=True, limit=1)
                if c.data:
                    await sb_update(T_COMP, {"id": cast_id(c.data[0].get("id"))}, {
                        "status": "fake",
                        "proof_text": "AUTO_TG_HOLD_FAIL",
                        "moderated_at": _now().isoformat(),
                    })
                try:
                    until = await set_task_ban(user_id, days=3)
                    until_txt = until.strftime('%d.%m %H:%M') if until else 'на 3 дня'
                except Exception:
                    until_txt = 'на 3 дня'
                await notify_user(user_id, f"❌ Проверка срока удержания не пройдена: пользователь вышел из канала/группы раньше срока. Выплата отменена, применён штраф: доступ к заданиям ограничен {until_txt}.")
        except Exception as e:
            log.warning("tg hold process failed task=%s user=%s err=%s", task_id, user_id, e)
        finally:
            await tg_hold_clear(task_id, user_id)


async def tg_hold_worker():
    while True:
        try:
            await process_tg_holds_once()
        except Exception as e:
            log.warning("tg hold worker tick failed: %s", e)
        await asyncio.sleep(max(10, int(TG_HOLD_SCAN_INTERVAL_SEC)))

# -------------------------
# notify helpers
# -------------------------
async def notify_admin(text: str):
    seen = set()
    for aid in ADMIN_IDS:
        try:
            aid_int = int(aid)
        except Exception:
            continue
        if aid_int in seen:
            continue
        seen.add(aid_int)
        try:
            await bot.send_message(aid_int, text)
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


# -------------------------
# Telegram Stars admin helpers
# -------------------------
async def tg_bot_api_call(method: str, data: dict | None = None) -> dict:
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/{method}"
    payload = data or {}
    import aiohttp
    timeout = aiohttp.ClientTimeout(total=20)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(url, json=payload) as resp:
            try:
                res = await resp.json(content_type=None)
            except Exception:
                body = await resp.text()
                raise RuntimeError(f"Telegram API {method} bad response: HTTP {resp.status} {body[:300]}")
            if not isinstance(res, dict) or not res.get("ok"):
                desc = (res or {}).get("description") if isinstance(res, dict) else None
                raise RuntimeError(f"Telegram API {method} failed: {desc or ('HTTP ' + str(resp.status))}")
            return res.get("result") or {}


def _format_star_amount_obj(obj: dict | None) -> str:
    obj = obj or {}
    amount = int(obj.get("amount") or 0)
    nano = int(obj.get("nanostar_amount") or 0)
    if nano:
        frac = f"{nano:09d}".rstrip("0")
        return f"{amount}.{frac}⭐"
    return f"{amount}⭐"


def _format_unix_ts(ts) -> str:
    try:
        dt = datetime.fromtimestamp(int(ts), tz=timezone.utc) + timedelta(hours=3)
        return dt.strftime("%d.%m %H:%M")
    except Exception:
        return "?"


def _star_partner_text(partner: dict | None) -> str:
    partner = partner or {}
    ptype = str(partner.get("type") or "other")
    if ptype == "user":
        uname = partner.get("username")
        if uname:
            return f"@{uname}"
        name = " ".join(x for x in [partner.get("first_name"), partner.get("last_name")] if x)
        if name.strip():
            return name.strip()
        return f"user {partner.get('id') or '?'}"
    if ptype == "fragment":
        ws = partner.get("withdrawal_state")
        if isinstance(ws, dict):
            st = str(ws.get("type") or "fragment")
            return f"Fragment ({st})"
        return "Fragment"
    if ptype == "telegram_ads":
        return "Telegram Ads"
    if ptype == "telegram_api":
        return "Telegram API"
    if ptype == "bot":
        uname = partner.get("username")
        return f"bot @{uname}" if uname else "bot"
    if ptype == "chat":
        title = partner.get("title")
        return title or "chat"
    if ptype == "affiliate_program":
        return "affiliate"
    return ptype or "other"


async def get_bot_stars_balance() -> dict:
    return await tg_bot_api_call("getMyStarBalance")


async def get_bot_star_transactions(limit: int = 10, offset: int = 0) -> list[dict]:
    limit = max(1, min(int(limit or 10), 100))
    res = await tg_bot_api_call("getStarTransactions", {"limit": limit, "offset": int(offset or 0)})
    txs = res.get("transactions") or []
    return txs if isinstance(txs, list) else []

# -------------------------
# MiniApp URL helper + broadcast about new tasks
# -------------------------
def get_miniapp_url() -> str:
    url = (MINIAPP_URL or '').strip()
    if not url:
        base = (SERVER_BASE_URL or BASE_URL or '').strip()
        if base:
            url = base.rstrip('/') + f'/app/?v={APP_BUILD}'
    if url and 'v=' not in url:
        url = url + ('&' if '?' in url else '?') + f'v={APP_BUILD}'
    return url or '/app/'

async def _iter_user_ids(batch: int = 1000):
    start = 0
    while True:
        def _f():
            q = sb.table(T_USERS).select('user_id').order('user_id', desc=False)
            if hasattr(q, 'range'):
                q = q.range(start, start + batch - 1)
            else:
                q = q.limit(min(batch, 5000))
            return q.execute()
        r = await sb_exec(_f)
        rows = (r.data or [])
        if not rows:
            break
        for row in rows:
            try:
                yield int(row.get('user_id'))
            except Exception:
                continue
        if len(rows) < batch:
            break
        start += batch

async def broadcast_new_task(task: dict):
    try:
        title = str(task.get('title') or task.get('platform') or 'Новое задание').strip()
        try:
            reward_i = int(float(task.get('reward_rub') or task.get('reward') or 0))
        except Exception:
            reward_i = 0
        kind_map = {'tg': 'Telegram', 'ya': 'Яндекс', 'gm': 'Google'}
        kind = kind_map.get(str(task.get('type') or '').lower(), 'ReviewCash')
        text_msg = (
            f"🆕 <b>Новое задание</b>\n\n"
            f"<b>{html.escape(title)}</b>\n"
            f"💰 Награда: <b>{reward_i} ₽</b>\n"
            f"📍 Платформа: <b>{html.escape(kind)}</b>"
        )
        kb = InlineKeyboardBuilder()
        kb.button(text='🚀 Открыть ReviewCash', web_app=WebAppInfo(url=get_miniapp_url()))
        markup = kb.as_markup()
        async for uid in _iter_user_ids():
            if await is_notify_muted(uid):
                continue
            try:
                await bot.send_message(uid, text_msg, parse_mode='HTML', reply_markup=markup, disable_web_page_preview=True)
            except Exception:
                pass
            await asyncio.sleep(0.03)
    except Exception as e:
        log.warning('broadcast_new_task failed: %s', e)

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

            # global ban checks
            uid = int(merged.get("id") or merged.get("user_id") or 0)
            if merged.get("is_banned"):
                raise web.HTTPForbidden(text=json.dumps({"ok": False, "error": "Аккаунт заблокирован"}), content_type="application/json")
            gban = await get_global_ban_until(uid)
            if gban:
                raise web.HTTPForbidden(text=json.dumps({"ok": False, "error": f"Временная блокировка до {gban.strftime('%Y-%m-%d %H:%M')} UTC"}), content_type="application/json")

            sub_ok, sub_chat, sub_msg = await tg_check_required_subscription(uid)
            if not sub_ok:
                raise web.HTTPForbidden(
                    text=json.dumps({
                        "ok": False,
                        "error": sub_msg or "Нужна подписка на канал",
                        "code": "REQUIRED_SUBSCRIPTION",
                        "channel": sub_chat,
                    }, ensure_ascii=False),
                    content_type="application/json",
                )

            try:
                await tg_evt_touch(uid, "miniapp_open")
            except Exception:
                pass
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

        # global ban checks
        if user.get("is_banned"):
            raise web.HTTPForbidden(text=json.dumps({"ok": False, "error": "Аккаунт заблокирован"}), content_type="application/json")
        gban = await get_global_ban_until(int(user.get("id") or uid))
        if gban:
            raise web.HTTPForbidden(text=json.dumps({"ok": False, "error": f"Временная блокировка до {gban.strftime('%Y-%m-%d %H:%M')} UTC"}), content_type="application/json")

        sub_uid = int(user.get("id") or uid)
        sub_ok, sub_chat, sub_msg = await tg_check_required_subscription(sub_uid)
        if not sub_ok:
            raise web.HTTPForbidden(
                text=json.dumps({
                    "ok": False,
                    "error": sub_msg or "Нужна подписка на канал",
                    "code": "REQUIRED_SUBSCRIPTION",
                    "channel": sub_chat,
                }, ensure_ascii=False),
                content_type="application/json",
            )

        try:
            await tg_evt_touch(sub_uid, "miniapp_open")
        except Exception:
            pass
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
    risk_score = await calc_user_risk_score(uid)
    trust_level = "high" if risk_score < 30 else ("medium" if risk_score < 60 else "low")
    expensive_ok, expensive_reason = await can_access_expensive_tasks(uid)

    banned_until = await get_task_ban_until(uid)
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
                    stack_key = tg_stack_key(dt)
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
                and tg_stack_key(t) in completed_tg_stack_keys
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
            if int(t.get("owner_id") or 0) == uid:
                t["custom_review_texts"] = get_review_texts(t)
            else:
                slot_index = int(task_slot_map.get(str(t.get("id")), 0) or 0)
                assigned_text = pick_review_text_for_task(t, slot_index)
                t["custom_review_texts"] = [assigned_text] if assigned_text else []
                t["assigned_review_text"] = assigned_text
        tasks.sort(key=lambda x: (0 if is_top_active(x) else 1, -(top_bought_at(x).timestamp() if top_bought_at(x) else 0), str(x.get("created_at") or "")), reverse=False)

        deduped_tasks = []
        seen_tg_display_keys: set[str] = set()
        for t in tasks:
            if int(t.get("owner_id") or 0) == uid:
                deduped_tasks.append(t)
                continue
            tg_key = tg_display_dedupe_key(t)
            if tg_key:
                if tg_key in seen_tg_display_keys:
                    continue
                seen_tg_display_keys.add(tg_key)
            deduped_tasks.append(t)
        tasks = deduped_tasks

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
            "gender": user_gender,
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
        },
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
    pay_currency = str(body.get("pay_currency") or "rub").strip().lower()
    want_top = bool(body.get("want_top") or False)
    top_price_rub = float(body.get("top_price_rub") or 250)
    target_gender = normalize_task_gender(body.get("target_gender"))
    retention_extra_days = max(0, int(body.get("retention_extra_days") or 0))
    custom_review_texts = body.get("custom_review_texts") or []
    custom_review_mode = str(body.get("custom_review_mode") or "none").strip().lower()
    if pay_currency in ("stars", "xtr"):
        pay_currency = "star"

    if ttype not in ("tg", "ya", "gm"):
        raise web.HTTPBadRequest(text="Bad type")
    if not title:
        raise web.HTTPBadRequest(text="Missing title")
    if ttype != "tg" and not target_url:
        raise web.HTTPBadRequest(text="Missing target_url")

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
    if custom_review_mode not in ("none", "single", "per_item"):
        custom_review_mode = "none"
    if not isinstance(custom_review_texts, list):
        custom_review_texts = [custom_review_texts]
    custom_review_texts = [str(x).strip() for x in custom_review_texts if str(x).strip()]
    if ttype not in ("ya", "gm"):
        custom_review_mode = "none"
        custom_review_texts = []
    if custom_review_mode == "single" and custom_review_texts:
        custom_review_texts = [custom_review_texts[0]]
    if custom_review_mode == "per_item":
        if len(custom_review_texts) < qty_total:
            return json_error(400, f"Для режима с разным текстом нужно минимум {qty_total} строк текста", code="REVIEW_TEXTS_NOT_ENOUGH")
        custom_review_texts = custom_review_texts[:qty_total]

    # TG task:
    # - принимаем только @юзернейм или ссылку t.me/...
    # - авто-проверка возможна только если это НЕ бот и наш бот добавлен в чат/канал (для канала — админ)
    if ttype == "tg":
        sub_type = (sub_type or TG_SUB_CHANNEL_KEY).strip().lower()
        if sub_type not in (TG_MEMBER_SUBTYPES | TG_EVENT_SUBTYPES):
            return json_error(400, "Неизвестный TG подтип задания", code="TG_BAD_SUBTYPE")

        if sub_type in TG_MEMBER_SUBTYPES:
            raw_tg = (tg_chat or target_url or "").strip()
            raw_low = raw_tg.lower()

            if is_private_tg_target(raw_tg):
                return json_error(400, "Приватные Telegram-ссылки запрещены. Укажи публичный @username или https://t.me/username", code="TG_PRIVATE_FORBIDDEN")

            if not (raw_tg.startswith("@") or ("t.me/" in raw_low)):
                return json_error(400, "Для TG задания можно указывать только @юзернейм или ссылку t.me/...", code="TG_ONLY_AT_OR_LINK")

            tg_chat_n = normalize_tg_chat(raw_tg)
            if not tg_chat_n:
                return json_error(400, "Некорректный @юзернейм/ссылка TG. Пример: @MyChannel или https://t.me/MyChannel", code="TG_CHAT_REQUIRED")
            if tg_chat_n.lower().endswith('bot'):
                return json_error(400, "Бот-ссылки запрещены. Для TG заданий можно использовать только каналы и группы.", code="TG_BOT_FORBIDDEN")
            tg_chat = tg_chat_n

            try:
                actual_kind = await tg_get_chat_kind(tg_chat)
            except Exception:
                return json_error(
                    400,
                    "Не удалось открыть TG-цель. Проверь @/ссылку. Приватные каналы и группы не поддерживаются.",
                    code="TG_BAD_TARGET",
                )

            if sub_type in TG_CHANNEL_SUBTYPES and actual_kind != 'channel':
                return json_error(400, "Для этого типа задания нужна ссылка именно на Telegram-канал.", code="TG_NEED_CHANNEL")
            if sub_type in TG_GROUP_SUBTYPES and actual_kind not in ('group', 'supergroup'):
                return json_error(400, "Для этого типа задания нужна ссылка именно на Telegram-группу.", code="TG_NEED_GROUP")

            desired_check_type, desired_kind, reason = await tg_calc_check_type(tg_chat, target_url)
            tg_kind = actual_kind or desired_kind
            check_type = desired_check_type
            if check_type != "auto":
                return json_error(400, "TG задания доступны только с автоматической проверкой. Укажи канал/группу, где бот может проверить подписку.", code="TG_AUTO_ONLY", reason=reason)
        else:
            tg_kind = "bot"
            check_type = "auto"
            if not target_url:
                target_url = "https://t.me/ReviewCashOrg_Bot"


    if cost_rub <= 0:
        cost_rub = reward_rub * qty_total * 2.0
    if float(cost_rub) < 50:
        return json_error(400, "Минимальный бюджет задания — 50 ₽", code="MIN_BUDGET")

    total_cost = float(cost_rub)
    if want_top:
        total_cost += max(0.0, float(top_price_rub or 250))
    charged_amount = total_cost
    charged_currency = "rub"

    if pay_currency == "star":
        if not await is_stars_payments_enabled():
            return web.json_response({"ok": False, "error": "Оплата Stars временно отключена администратором"}, status=403)
        charged_currency = "star"
        charged_amount = max(1, int(round(total_cost / max(STARS_RUB_RATE, 0.000001))))
        ok = await sub_stars(uid, charged_amount)
        if not ok:
            return web.json_response({"ok": False, "error": f"Недостаточно Stars. Нужно {int(charged_amount)}⭐"}, status=400)
    else:
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

    meta_lines = []
    if sub_type:
        meta_lines.append("TG_SUBTYPE: " + sub_type)
    if target_gender != TASK_GENDER_ANY:
        meta_lines.append("TARGET_GENDER: " + target_gender)
    if ttype == "tg":
        meta_lines.append(f"RETENTION_DAYS: {tg_required_retention_days(sub_type or TG_SUB_CHANNEL_KEY, retention_extra_days)}")
    if custom_review_mode != "none" and custom_review_texts:
        encoded_review_texts = base64.b64encode(json.dumps(custom_review_texts, ensure_ascii=False).encode("utf-8")).decode("utf-8")
        meta_lines.append("CUSTOM_REVIEW_MODE: " + custom_review_mode)
        meta_lines.append("CUSTOM_REVIEW_TEXTS: " + encoded_review_texts)
    if meta_lines:
        row["instructions"] = (instructions + "\n\n" + "\n".join(meta_lines)).strip()

    ins = await sb_insert(T_TASKS, row)
    task = (ins.data or [row])[0]

    await stats_add("revenue_rub", total_cost)
    pay_text = f"{int(charged_amount)}⭐" if charged_currency == "star" else f"{charged_amount:.2f}₽"
    await notify_admin(f"🆕 Новое задание\n• {title}\n• Награда: {reward_rub}₽ × {qty_total}\n• Оплата: {pay_text}")
    try:
        asyncio.create_task(broadcast_new_task(task))
    except Exception:
        pass

    return web.json_response({
        "ok": True,
        "task": task,
        "charged_amount": int(charged_amount) if charged_currency == "star" else charged_amount,
        "charged_currency": charged_currency,
        "cost_rub": total_cost,
    })


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
    rate_limit_enforce(uid, "task_submit", min_interval_sec=10, spam_strikes=12, block_sec=120)
    body = await safe_json(req)

    banned_until = await get_task_ban_until(uid)
    if banned_until:
        return web.json_response({"ok": False, "error": f"Доступ к заданиям временно ограничен до {banned_until.strftime('%d.%m %H:%M')}"}, status=403)

    blocked_until = await get_submit_block_until(uid)
    if blocked_until:
        return web.json_response({"ok": False, "error": f"Слишком много проверок. Повтори после {blocked_until.strftime('%d.%m %H:%M')} UTC"}, status=429)

    await mark_submit_attempt(uid, ok=False)

    task_id = str(body.get("task_id") or "").strip()
    proof_text = str(body.get("proof_text") or "").strip()
    proof_url = str(body.get("proof_url") or "").strip() or None

    if not task_id:
        raise web.HTTPBadRequest(text="Missing task_id")

    task_id_db = cast_id(task_id)

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

    # duplicate check: block only active/paid/fake completions; allow resubmit after rejected/rework
    dup = await sb_select(T_COMP, {"task_id": task_id_db, "user_id": uid}, order="created_at", desc=True, limit=20)
    dup_rows = []
    for row in (dup.data or []):
        dup_rows.append(await expire_rework_if_needed(row))
    blocking_statuses = {"pending", "pending_24h", "pending_hold", "paid", "fake"}
    if any(str(x.get("status") or "").lower() in blocking_statuses or is_rework_active(x) for x in dup_rows):
        return web.json_response({"ok": False, "error": "Уже отправляли выполнение"}, status=400)

    is_auto = (task.get("check_type") == "auto") and (task.get("type") == "tg")

    if not is_auto:
        # reserve only available slots: allow parallel pending reports while free places remain
        pending_any = await sb_select(T_COMP, {"task_id": task_id_db}, order="created_at", desc=True, limit=1000)
        active_pending = []
        for row in (pending_any.data or []):
            row = await expire_rework_if_needed(row)
            st = str(row.get("status") or "").lower()
            if st in {"pending", "pending_hold"} or is_rework_active(row):
                active_pending.append(row)
        pending_count = len(active_pending)
        qty_left = int(task.get("qty_left") or 0)
        if pending_count >= qty_left:
            return web.json_response({"ok": False, "error": "Свободных мест сейчас нет: все места уже заняты отчётами на проверке. Дождись решения модератора."}, status=400)

    # require that user opened the task link (anti-fake) for manual checks
    if not is_auto:
        ok_clicked = await require_recent_task_click(uid, task_id)
        if not ok_clicked:
            return web.json_response({"ok": False, "error": "Сначала нажми «Перейти к выполнению» и открой ссылку, затем отправляй отчёт."}, status=400)
        elapsed = await task_click_elapsed_sec(uid, task_id)
        if elapsed is not None and elapsed < max(1, MIN_TASK_SUBMIT_SEC):
            return web.json_response({"ok": False, "error": "Слишком быстрое выполнение. Подожди немного и отправь снова."}, status=400)
    if is_auto:
        async def _auto_pay(ok_code: str):
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
                    await sb_update(T_TASKS, {"id": task_id_db}, upd)
            except Exception:
                pass
            await sb_insert(T_COMP, {
                "task_id": task_id_db,
                "user_id": uid,
                "status": "paid",
                "proof_text": ok_code,
                "proof_url": None,
                "moderated_at": _now().isoformat(),
            })
            await mark_submit_attempt(uid, ok=True)
            return web.json_response({"ok": True, "status": "paid", "earned": reward, "xp_added": xp_added})

        task_subtype = get_tg_subtype(task) or TG_SUB_CHANNEL_KEY
        reward = float(task.get("reward_rub") or 0)
        chat = task.get("tg_chat") or ""
        task_created_at = _task_created_at(task)

        if task_subtype in TG_MEMBER_SUBTYPES:
            if not chat:
                return web.json_response({"ok": False, "error": "TG task misconfigured (no tg_chat)"}, status=400)

            retention_days = get_retention_days(task)
            hold_delay = tg_hold_delay_sec(task_subtype, max(0, retention_days - tg_required_retention_days(task_subtype, 0))) if retention_days else tg_hold_delay_sec(task_subtype)
            if hold_delay > 0:
                existing_hold = await tg_hold_get(task_id, uid)
                if existing_hold:
                    left_raw = int((existing_hold - _now()).total_seconds())
                    if left_raw <= 0:
                        await tg_hold_clear(task_id, uid)
                    else:
                        left = max(1, left_raw)
                        hours = max(1, int(round(left / 3600)))
                        return web.json_response({
                            "ok": False,
                            "error": f"Проверка уже запланирована. Осталось примерно {hours} ч.",
                            "code": "TG_HOLD_WAIT",
                            "retry_after": left,
                        }, status=400)

                ok_member = await tg_is_member(chat, uid)
                if not ok_member:
                    return web.json_response({"ok": False, "error": "Бот не видит подписку сейчас. Подпишись и отправь на проверку снова."}, status=400)

                due_at = _now() + timedelta(seconds=hold_delay)
                await tg_hold_set(task_id, uid, due_at)
                await sb_insert(T_COMP, {
                    "task_id": task_id_db,
                    "user_id": uid,
                    "status": "pending_hold",
                    "proof_text": f"AUTO_TG_WAIT_{tg_hold_delay_hours(task_subtype, max(0, retention_days - tg_required_retention_days(task_subtype, 0))) if retention_days else tg_hold_delay_hours(task_subtype)}H",
                    "proof_url": None,
                })

                due_msk = due_at.astimezone(timezone(timedelta(hours=3)))
                wait_hours = tg_hold_delay_hours(task_subtype, max(0, retention_days - tg_required_retention_days(task_subtype, 0))) if retention_days else tg_hold_delay_hours(task_subtype)
                await mark_submit_attempt(uid, ok=True)
                return web.json_response({
                    "ok": True,
                    "status": f"hold_{wait_hours}h",
                    "message": f"Подписка подтверждена. Выходить нельзя {max(1, wait_hours // 24)} дн. Бот автоматически перепроверит участие через {wait_hours} ч. ({due_msk.strftime('%d.%m %H:%M МСК')}). Если выйти раньше — задание отменится и включится штраф.",
                    "retry_after": max(1, int((due_at - _now()).total_seconds())),
                })

            ok_member = await tg_is_member(chat, uid)
            if not ok_member:
                return web.json_response({"ok": False, "error": "Бот не видит подписку/участие. Подпишись и попробуй снова."}, status=400)
            return await _auto_pay("AUTO_TG_OK")

        if task_subtype == TG_BOT_START_KEY:
            dt = await tg_evt_get(uid, "bot_start")
            if not _dt_after_task(dt, task):
                return web.json_response({"ok": False, "error": "Нажми /start у бота и попробуй снова."}, status=400)
            return await _auto_pay("AUTO_TG_BOT_START")

        if task_subtype == TG_BOT_CALLBACK_KEY:
            expected_cb = get_tg_meta(task, "TG_CALLBACK_DATA")
            dt = await tg_evt_get(uid, "callback_data", expected_cb) if expected_cb else await tg_evt_get(uid, "callback_any")
            if not _dt_after_task(dt, task):
                return web.json_response({"ok": False, "error": "Нажми нужную inline-кнопку в боте и попробуй снова."}, status=400)
            return await _auto_pay("AUTO_TG_CALLBACK")

        if task_subtype == TG_BOT_MESSAGE_KEY:
            expected_text = get_tg_meta(task, "TG_EXPECT_TEXT").lower()
            dt = await tg_evt_get(uid, "message_text", expected_text) if expected_text else await tg_evt_get(uid, "message_any")
            if not _dt_after_task(dt, task):
                err = "Отправь сообщение боту и попробуй снова."
                if expected_text:
                    err = f"Отправь боту текст: {expected_text}"
                return web.json_response({"ok": False, "error": err}, status=400)
            return await _auto_pay("AUTO_TG_MESSAGE")

        if task_subtype == TG_MINIAPP_OPEN_KEY:
            dt = await tg_evt_get(uid, "miniapp_open")
            if not _dt_after_task(dt, task):
                return web.json_response({"ok": False, "error": "Открой Mini App бота и попробуй снова."}, status=400)
            return await _auto_pay("AUTO_TG_MINIAPP")

        if task_subtype == TG_INVITE_FRIENDS_KEY:
            need_cnt_raw = get_tg_meta(task, "TG_REF_COUNT")
            try:
                need_cnt = max(1, int(need_cnt_raw or "1"))
            except Exception:
                need_cnt = 1
            paid_refs = await tg_referrals_paid_since(uid, task_created_at)
            if paid_refs < need_cnt:
                return web.json_response({"ok": False, "error": f"Нужно приглашений с выполнением: {need_cnt}. Сейчас: {paid_refs}."}, status=400)
            return await _auto_pay("AUTO_TG_REFERRAL")

        if task_subtype == TG_POLL_VOTE_KEY:
            poll_id = get_tg_meta(task, "TG_POLL_ID")
            ok_vote = await tg_poll_answer_seen_since(uid, task_created_at, poll_id=poll_id or None)
            if not ok_vote:
                return web.json_response({"ok": False, "error": "Голос не найден. Проголосуй в опросе от бота и попробуй снова."}, status=400)
            return await _auto_pay("AUTO_TG_POLL")

        return web.json_response({"ok": False, "error": "Неподдерживаемый TG подтип задания"}, status=400)

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
    await mark_submit_attempt(uid, ok=True)
    return web.json_response({"ok": True, "status": "pending", "xp_expected": xp_expected})

# -------------------------
# withdraw
# -------------------------
async def api_withdraw_create(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])

    # Ban from withdrawals (admin)
    wb = await get_withdraw_ban_until(uid)
    if wb:
        return web.json_response({"ok": False, "error": f"Выводы временно заблокированы до {wb.strftime('%Y-%m-%d %H:%M')} UTC"}, status=403)

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

    full_name = str(body.get("full_name") or body.get("fio") or body.get("name") or "").strip()
    payout_value = str(body.get("payout_value") or body.get("phone") or body.get("card") or body.get("wallet") or body.get("requisites") or body.get("requisites_text") or body.get("details") or "").strip()
    payout_method = str(body.get("payout_method") or "").strip().lower()

    if amount < 300:
        return web.json_response({"ok": False, "error": f"Минимум {MIN_TOPUP_RUB:.0f}₽"}, status=400)
    if not full_name or len(full_name) < 5 or " " not in full_name:
        return web.json_response({"ok": False, "error": "Укажи имя и фамилию"}, status=400)
    if not payout_value:
        return web.json_response({"ok": False, "error": "Укажи номер телефона или карты"}, status=400)

    normalized = "".join(ch for ch in payout_value if ch.isdigit())
    if payout_method == "phone":
        if len(normalized) < 10:
            return web.json_response({"ok": False, "error": "Некорректный номер телефона"}, status=400)
    elif payout_method == "card":
        if len(normalized) < 16:
            return web.json_response({"ok": False, "error": "Некорректный номер карты"}, status=400)
    else:
        if len(normalized) < 10:
            return web.json_response({"ok": False, "error": "Укажи корректный номер телефона или карты"}, status=400)
        payout_method = "card" if len(normalized) >= 16 else "phone"

    details = f"{full_name} | {payout_method} | {payout_value}"

    first_withdraw_done = await get_limit_until(uid, FIRST_WITHDRAW_DONE_KEY)
    if not first_withdraw_done:
        paid = await sb_select(T_COMP, {"user_id": uid, "status": "paid"}, limit=FIRST_WITHDRAW_MIN_PAID_TASKS)
        paid_count = len(paid.data or [])
        if paid_count < max(1, FIRST_WITHDRAW_MIN_PAID_TASKS):
            return web.json_response({"ok": False, "error": f"Первый вывод доступен после {FIRST_WITHDRAW_MIN_PAID_TASKS} выполненных и оплаченных заданий."}, status=400)

    bal = await get_balance(uid)
    cur = float(bal.get("rub_balance") or 0)
    if cur < float(amount):
        return web.json_response({"ok": False, "error": "Недостаточно средств"}, status=400)

    wd_row = None
    debited = False
    try:
        await balances_update(uid, {"rub_balance": cur - float(amount), "updated_at": _now().isoformat()})
        debited = True

        wd = await sb_insert(T_WD, {
            "user_id": uid,
            "amount_rub": amount,
            "details": details,
            "status": "pending",
        })
        wd_row = (wd.data or [None])[0]

        try:
            await notify_admin(
                f"🏦 Заявка на вывод: {amount}₽\n"
                f"User: {uid}\n"
                f"ФИО: {full_name}\n"
                f"Способ: {payout_method}\n"
                f"Реквизиты: {payout_value}\n"
                f"ID: {wd_row.get('id') if wd_row else 'n/a'}"
            )
        except Exception:
            pass

        return web.json_response({"ok": True, "withdrawal": wd_row})
    except Exception:
        log.exception("withdraw create failed uid=%s amount=%s", uid, amount)
        if debited:
            try:
                await add_rub(uid, amount)
            except Exception:
                log.exception("withdraw rollback failed uid=%s amount=%s", uid, amount)
        return web.json_response({"ok": False, "error": "Ошибка сервера при создании заявки. Баланс восстановлен."}, status=500)

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

    # Ban from T-Bank topups (admin)
    b = await get_tbank_ban_until(uid)
    if b:
        return web.json_response({"ok": False, "error": f"Пополнение T-Bank временно заблокировано до {b.strftime('%Y-%m-%d %H:%M')} UTC"}, status=403)

    cool = await get_tbank_cooldown_until(uid)
    if cool and int(uid) not in ADMIN_IDS:
        left = int((cool - _now()).total_seconds())
        h = left // 3600
        m = (left % 3600) // 60
        return web.json_response({"ok": False, "error": f"Пополнение через Т-Банк доступно раз в сутки. Повтори через {h}ч {m}м."}, status=429)
    rate_limit_enforce(uid, "topup", min_interval_sec=60, spam_strikes=3, block_sec=600)
    body = await safe_json(req)

    amount = parse_amount_rub(body.get("amount_rub") or body.get("amount") or body.get("sum") or body.get("value") or body.get("rub"))
    if amount is None:
        return web.json_response({"ok": False, "error": "Некорректная сумма"}, status=400)

    sender = str(body.get("sender") or body.get("name") or body.get("from") or body.get("payer") or "").strip()
    code = str(body.get("code") or body.get("comment") or body.get("payment_code") or body.get("provider_ref") or body.get("reference") or "").strip()
    phone_raw = str(body.get("phone") or body.get("sender_phone") or body.get("payer_phone") or "").strip()
    proof_url = str(body.get("proof_url") or body.get("screenshot_url") or body.get("receipt_url") or "").strip()

    phone_digits = "".join(ch for ch in phone_raw if ch.isdigit())
    if len(phone_digits) == 10:
        phone_digits = "7" + phone_digits
    elif len(phone_digits) == 11 and phone_digits.startswith("8"):
        phone_digits = "7" + phone_digits[1:]

    if amount < MIN_TOPUP_RUB:
        return web.json_response({"ok": False, "error": f"Минимум {MIN_TOPUP_RUB:.0f}₽"}, status=400)
    if not sender:
        return web.json_response({"ok": False, "error": "Укажи имя отправителя"}, status=400)
    if not code:
        return web.json_response({"ok": False, "error": "Нет кода платежа"}, status=400)
    if len(phone_digits) != 11 or not phone_digits.startswith("7"):
        return web.json_response({"ok": False, "error": "Укажи корректный номер телефона"}, status=400)
    if not proof_url:
        return web.json_response({"ok": False, "error": "Прикрепи скрин оплаты"}, status=400)

    await sb_insert(T_PAY, {
        "user_id": uid,
        "provider": "tbank",
        "status": "pending",
        "amount_rub": amount,
        "provider_ref": code,
        "meta": {"sender": sender, "phone": phone_digits, "proof_url": proof_url}
    })

    await notify_admin(
        f"💳 T-Bank заявка\nСумма: {amount}₽\nUser: {uid}\nCode: {code}\nSender: {sender}\nPhone: +{phone_digits}\nСкрин: {proof_url}"
    )
    return web.json_response({"ok": True})

# -------------------------
# Telegram Stars (Mini App -> API): create invoice link
# -------------------------
async def api_stars_link(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    if not await is_stars_payments_enabled():
        return web.json_response({"ok": False, "error": "Оплата Stars временно отключена администратором"}, status=403)
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



async def api_report_list(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])

    rows = await sb_select(T_COMP, {"user_id": uid}, order="created_at", desc=True, limit=300)
    comps = rows.data or []

    task_ids = list({c.get("task_id") for c in comps if c.get("task_id") is not None})
    tasks_map: dict[str, dict] = {}
    if task_ids:
        tr = await sb_select_in(T_TASKS, "id", task_ids, columns="id,title,reward_rub,type,target_url,tg_subtype", limit=500)
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
            "tg_subtype": task.get("tg_subtype"),
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
        "features": {
            "stars_payments_enabled": await is_stars_payments_enabled(),
        },
        "counts": {
            "proofs": len(proofs.data or []),
            "withdrawals": len(wds.data or []),
            "tbank": len(tp.data or []),
            "tasks": len(tasks_active),
        }
    })

async def api_admin_stars_pay_set(req: web.Request):
    admin = await require_main_admin(req)
    body = await safe_json(req)

    raw_enabled = body.get("enabled")
    if isinstance(raw_enabled, bool):
        enabled = raw_enabled
    elif isinstance(raw_enabled, (int, float)):
        enabled = bool(raw_enabled)
    else:
        enabled = str(raw_enabled).strip().lower() in ("1", "true", "yes", "y", "on", "enable", "enabled")

    enabled = await set_stars_payments_enabled(enabled, int(admin["id"]))
    status_text = "включена" if enabled else "выключена"
    try:
        await notify_admin(f"⭐ Оплата Stars {status_text} главным админом {int(admin['id'])}")
    except Exception:
        pass

    return web.json_response({"ok": True, "enabled": enabled})


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


async def api_admin_user_punish(req: web.Request):
    """
    Admin sanctions:
      - temporary ban (global/tasks/tbank/withdraw)
      - permanent ban via users.is_banned
      - fine / manual balance adjustment (rub only)
    Body:
      { user_id, action: "ban"|"unban"|"permaban"|"unpermaban"|"fine",
        kind: "global"|"tasks"|"tbank"|"withdraw",
        days, hours, seconds,
        amount_rub, reason }
    """
    admin = await require_admin(req)
    body = await safe_json(req)

    try:
        uid = int(body.get("user_id") or body.get("uid") or 0)
    except Exception:
        uid = 0
    if uid <= 0:
        return web.json_response({"ok": False, "error": "Некорректный user_id"}, status=400)

    action = str(body.get("action") or "").strip().lower()
    if not action:
        # backward-compat: if "ban_days" provided assume ban
        action = "ban" if body.get("days") or body.get("ban_days") else "fine"

    kind = str(body.get("kind") or "global").strip().lower()
    if kind not in ("global", "tasks", "tbank", "withdraw"):
        kind = "global"

    reason = str(body.get("reason") or "").strip()
    admin_id = int(admin.get("id") or 0)

    # Permanent ban/unban (only main admin)
    if action in ("permaban", "ban_perm", "perma"):
        if int(MAIN_ADMIN_ID or 0) and admin_id != int(MAIN_ADMIN_ID or 0):
            return web.json_response({"ok": False, "error": "Только главный админ"}, status=403)
        try:
            await sb_update(T_USERS, {"user_id": uid}, {"is_banned": True})
        except Exception:
            # row might not exist yet
            await sb_upsert(T_USERS, {"user_id": uid, "is_banned": True}, on_conflict="user_id")
        await notify_user(uid, f"🚫 Аккаунт заблокирован администратором.\n{('Причина: ' + reason) if reason else ''}".strip())
        return web.json_response({"ok": True, "action": "permaban", "user_id": uid})

    if action in ("unpermaban", "unban_perm", "unperma"):
        if int(MAIN_ADMIN_ID or 0) and admin_id != int(MAIN_ADMIN_ID or 0):
            return web.json_response({"ok": False, "error": "Только главный админ"}, status=403)
        try:
            await sb_update(T_USERS, {"user_id": uid}, {"is_banned": False})
        except Exception:
            await sb_upsert(T_USERS, {"user_id": uid, "is_banned": False}, on_conflict="user_id")
        await notify_user(uid, "✅ Блокировка аккаунта снята администратором.")
        return web.json_response({"ok": True, "action": "unpermaban", "user_id": uid})

    # Temporary bans
    if action in ("ban", "tempban"):
        # only main admin can set GLOBAL ban longer than 30 days
        days = body.get("days") if body.get("days") is not None else body.get("ban_days")
        hours = body.get("hours")
        seconds = body.get("seconds")

        try:
            days = int(days or 0)
        except Exception:
            days = 0
        try:
            hours = int(hours or 0)
        except Exception:
            hours = 0
        try:
            seconds = int(seconds or 0)
        except Exception:
            seconds = 0

        total_sec = max(0, seconds + hours * 3600 + days * 86400)
        if total_sec <= 0:
            total_sec = 86400  # default 1 day

        if kind == "global":
            if days >= 30 and int(MAIN_ADMIN_ID or 0) and admin_id != int(MAIN_ADMIN_ID or 0):
                return web.json_response({"ok": False, "error": "Длительный глобальный бан — только главный админ"}, status=403)
            until = await set_limit_until(uid, GLOBAL_BAN_KEY, total_sec)
        elif kind == "tasks":
            until = await set_task_ban(uid, max(1, int(total_sec // 86400) or 1))
        elif kind == "tbank":
            until = await set_limit_until(uid, TBANK_BAN_KEY, total_sec)
        else:  # withdraw
            until = await set_limit_until(uid, WITHDRAW_BAN_KEY, total_sec)

        await notify_user(uid, f"⛔ Временная блокировка ({kind}) до {until.strftime('%Y-%m-%d %H:%M')} UTC.\n{('Причина: ' + reason) if reason else ''}".strip())
        return web.json_response({"ok": True, "action": "ban", "kind": kind, "user_id": uid, "until": until.isoformat()})

    if action in ("unban", "clearban"):
        if kind == "tasks":
            await clear_limit(uid, TASK_BAN_KEY)
        elif kind == "tbank":
            await clear_limit(uid, TBANK_BAN_KEY)
        elif kind == "withdraw":
            await clear_limit(uid, WITHDRAW_BAN_KEY)
        else:
            await clear_limit(uid, GLOBAL_BAN_KEY)

        await notify_user(uid, f"✅ Бан ({kind}) снят администратором.")
        return web.json_response({"ok": True, "action": "unban", "kind": kind, "user_id": uid})

    # Fine / manual adjustment (rub only)
    if action in ("fine", "adjust", "balance"):
        try:
            amount = float(body.get("amount_rub") if body.get("amount_rub") is not None else body.get("rub") or body.get("amount") or 0)
        except Exception:
            amount = 0.0
        if amount == 0:
            return web.json_response({"ok": False, "error": "Укажи сумму (amount_rub)"}, status=400)

        # amount can be negative (fine) or positive (manual credit)
        new_rub = await add_rub(uid, float(amount))

        # record in payments so it appears in history
        try:
            await sb_insert(T_PAY, {
                "user_id": uid,
                "provider": "admin",
                "status": "paid",
                "amount_rub": float(amount),
                "provider_ref": f"admin:{admin_id}:{int(_now().timestamp())}",
                "meta": {"reason": reason, "by": admin_id, "kind": "fine" if amount < 0 else "credit"}
            })
        except Exception:
            pass

        txt = "💸 Штраф" if amount < 0 else "➕ Начисление"
        await notify_user(uid, f"{txt}: {amount:+.0f} ₽\nБаланс: {new_rub:.0f} ₽\n{('Причина: ' + reason) if reason else ''}".strip())

        return web.json_response({"ok": True, "action": "fine", "user_id": uid, "amount_rub": float(amount), "rub_balance": new_rub})

    return web.json_response({"ok": False, "error": "Неизвестное действие"}, status=400)

async def api_admin_proof_list(req: web.Request):
    await require_admin(req)
    r = await sb_select(T_COMP, {"status": "pending"}, order="created_at", desc=True, limit=300)
    comps = r.data or []

    task_ids = list({c.get("task_id") for c in comps if c.get("task_id")})
    tasks_map = {}
    if task_ids:
        tr = await sb_select_in(T_TASKS, "id", task_ids, columns="id,title,reward_rub,target_url,type,owner_id,instructions", limit=500)
        for t in (tr.data or []):
            tasks_map[str(t["id"])] = t

    visible_after_ya = _now() - timedelta(days=3)

    out = []
    seen = set()
    for c in comps:
        tid = str(c.get("task_id"))
        t = tasks_map.get(tid)
        if not t:
            continue

        # Hide Yandex review reports for 3 days
        if t.get("type") == "ya":
            dt = None
            try:
                ca = c.get("created_at")
                if isinstance(ca, str) and ca:
                    dt = datetime.fromisoformat(ca.replace("Z", "+00:00"))
            except Exception:
                dt = None
            if dt and dt > visible_after_ya:
                continue

        # Prevent the same pending proof from appearing twice in admin UI
        sig = (
            str(c.get("user_id") or ""),
            tid,
            str(c.get("proof_url") or ""),
            str(c.get("proof_text") or ""),
        )
        if sig in seen:
            continue
        seen.add(sig)

        out.append({
            "id": c.get("id"),
            "task_id": c.get("task_id"),
            "user_id": c.get("user_id"),
            "proof_text": c.get("proof_text"),
            "proof_url": c.get("proof_url"),
            "created_at": c.get("created_at"),
            "task": t,
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
        approved = str(approved_raw).strip().lower() in ("1", "true", "yes", "y", "on")

    fake = bool(body.get("fake"))
    rework = bool(body.get("rework"))
    comment = str(body.get("comment") or body.get("rework_comment") or "").strip()

    if proof_id is None:
        raise web.HTTPBadRequest(text="Missing proof_id")

    r = await sb_select(T_COMP, {"id": cast_id(proof_id)}, limit=1)
    if not r.data:
        return web.json_response({"ok": False, "error": "Proof not found"}, status=404)
    proof = r.data[0]

    if proof.get("status") != "pending":
        return web.json_response({"ok": True, "status": proof.get("status")})

    task_id = proof.get("task_id")
    task_id_db = cast_id(task_id)
    user_id = int(proof.get("user_id") or 0)

    t = await sb_select(T_TASKS, {"id": task_id_db}, limit=1)
    task = (t.data or [{}])[0]
    reward = float(task.get("reward_rub") or 0)
    task_type = str(task.get("type") or "").lower()

    if rework:
        if task_type not in ("ya", "gm"):
            return web.json_response({"ok": False, "error": "Доработка доступна только для Яндекс/Google отзывов"}, status=400)
        moderated_at = _now()
        await sb_update(T_COMP, {"id": cast_id(proof_id)}, {
            "status": "rework",
            "moderated_by": int(admin["id"]),
            "moderated_at": moderated_at.isoformat(),
        })
        deadline = moderated_at + timedelta(days=REWORK_GRACE_DAYS)
        msg = "🛠 Отчёт отправлен на доработку."
        if comment:
            msg += f"\n\nКомментарий: {comment}"
        msg += f"\n\nНа исправление есть {REWORK_GRACE_DAYS} дня — до {deadline.strftime('%d.%m %H:%M UTC')}."
        msg += "\nПосле этого отчёт обнулится, и задание снова станет доступно другим исполнителям. Исправь отзыв/скрин и отправь отчёт заново."
        await notify_user(user_id, msg)
        return web.json_response({"ok": True, "status": "rework"})

    if approved:
        try:
            await add_rub(user_id, reward)
        except Exception as e:
            log.exception("approve proof failed: add_rub uid=%s reward=%s err=%s", user_id, reward, e)
            return web.json_response({
                "ok": False,
                "code": "PAYOUT_FAILED",
                "message": "Не удалось принять отчёт: ошибка начисления. Проверь таблицу balances (rub_balance) и права Supabase."
            }, status=200)

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
            msg = "❌ Отчёт отклонён модератором."
            if comment:
                msg += f"\n\nКомментарий: {comment}"
            if task_type in ("ya", "gm"):
                msg += "\n\n🗑 Удали свой отзыв как можно скорее. Если отклонённый отзыв не удалить, аккаунт могут забанить и применить штраф."
            await notify_user(user_id, msg)

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
        try:
            until = await set_tbank_cooldown(uid)
            # optional notify about cooldown
            await notify_user(uid, "⏳ Следующее пополнение через Т-Банк будет доступно через 24 часа.")
        except Exception:
            pass
    else:
        await sb_update(T_PAY, {"id": payment_id}, {"status": "rejected"})
        await notify_user(uid, "❌ T-Bank пополнение отклонено администратором.")

    return web.json_response({"ok": True})

# =========================================================
# Telegram handlers
# =========================================================
async def send_main_welcome(message: Message, uid: int):
    kb = InlineKeyboardBuilder()

    miniapp_url = MINIAPP_URL
    if not miniapp_url:
        base = SERVER_BASE_URL or BASE_URL
        if base:
            miniapp_url = base.rstrip("/") + f"/app/?v={APP_BUILD}"

    if miniapp_url and "v=" not in miniapp_url:
        miniapp_url = miniapp_url + ("&" if "?" in miniapp_url else "?") + f"v={APP_BUILD}"

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


@dp.message(CommandStart())
async def cmd_start(message: Message):
    uid = message.from_user.id
    args = (message.text or "").split(maxsplit=1)
    ref = None
    start_arg = ""
    if len(args) == 2:
        start_arg = str(args[1] or "").strip()
    if start_arg.isdigit():
        ref = int(start_arg)
    else:
        m_ref = re.match(r"(?i)^ref[_:\-]?(\d+)$", start_arg)
        if m_ref:
            ref = int(m_ref.group(1))

    await ensure_user(message.from_user.model_dump(), referrer_id=ref)

    sub_ok, sub_chat, sub_msg = await tg_check_required_subscription(uid)
    if not sub_ok:
        await message.answer(
            f"🔒 Для использования бота нужно подписаться на {sub_chat or 'канал'}\n\n{sub_msg}",
            reply_markup=required_subscribe_kb(),
        )
        return

    try:
        await tg_evt_touch(uid, "bot_start")
    except Exception:
        pass

    user_gender = await tg_get_gender(uid)
    if not user_gender:
        gender_kb = ReplyKeyboardMarkup(
            keyboard=[[KeyboardButton(text="👨 Мужской"), KeyboardButton(text="👩 Женский")]],
            resize_keyboard=True,
            one_time_keyboard=True,
            selective=True,
        )
        await message.answer("Перед началом выбери пол:", reply_markup=gender_kb)
        return

    await send_main_welcome(message, uid)


@dp.message(F.text.in_(["👨 Мужской", "👩 Женский"]))
async def handle_gender_pick(message: Message):
    uid = int(message.from_user.id)

    sub_ok, sub_chat, sub_msg = await tg_check_required_subscription(uid)
    if not sub_ok:
        await message.answer(
            f"🔒 Сначала подпишись на {sub_chat or 'канал'}\n\n{sub_msg}",
            reply_markup=required_subscribe_kb(),
        )
        return

    if str(message.text or "").strip() == "👨 Мужской":
        await tg_set_gender(uid, TASK_GENDER_MALE)
    else:
        await tg_set_gender(uid, TASK_GENDER_FEMALE)

    await message.answer("Пол сохранён ✅", reply_markup=ReplyKeyboardRemove())
    await send_main_welcome(message, uid)

@dp.callback_query(F.data == "check_required_sub")
async def cb_check_required_sub(cq: CallbackQuery):
    uid = int(cq.from_user.id)
    sub_ok, sub_chat, sub_msg = await tg_check_required_subscription(uid)
    if not sub_ok:
        await cq.answer("Подписка ещё не найдена", show_alert=True)
        try:
            await cq.message.answer(
                f"🔒 Сначала подпишись на {sub_chat or 'канал'}, потом нажми кнопку проверки ещё раз.\n\n{sub_msg}",
                reply_markup=required_subscribe_kb(),
            )
        except Exception:
            pass
        return
    await cq.answer("Подписка подтверждена ✅")
    try:
        await cq.message.delete()
    except Exception:
        pass
    await send_main_welcome(cq.message, uid)


@dp.callback_query(F.data == "help_newbie")
async def cb_help(cq: CallbackQuery):
    await cq.answer()
    await cq.message.answer(
        """✨ *ReviewCash — инструкция*

🚀 *Как выполнить задание*
1️⃣ Открой приложение
2️⃣ Выбери задание
3️⃣ Нажми *«Перейти к выполнению»*
4️⃣ Выполни задание
5️⃣ Отправь отчёт
6️⃣ Получи оплату после проверки

📝 *Яндекс / Google отзывы*
Перед отзывом обязательно:
— лайкни *5 положительных отзывов*
— лайкни *5 фото*, если они есть
— зайди на *сайт*, если он указан

Только после этого пиши отзыв ✨

💸 *Оплата*
— деньги приходят после проверки
— TG-задания иногда проверяются автоматически

🎁 *Рефералка*
— *50₽* за друга
— бонус придёт после его *первого выполненного задания*

⏳ *Почему задания не видно*
— не прошёл лимит
— задание уже выполнено
— для новых аккаунтов часть заданий может появляться не сразу

🚫 *Запрещено*
— фейковые скриншоты
— отзывы не со своего аккаунта
— поддельные доказательства

За обман возможны *блокировка и штраф*.

❗ *Важно*
Если отчёт не отправляется, значит ты не нажал *«Перейти к выполнению»*.

Работай честно — и выплаты будут стабильными 💎""",
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
                miniapp_url = base.rstrip("/") + f"/app/?v={APP_BUILD}"

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
        f"Stars: {int(float(bal.get('stars_balance') or 0))} ⭐\n"
        f"XP: {int(bal.get('xp') or 0)} | LVL: {int(bal.get('level') or 1)}\n"
        f"До следующего уровня: {int(bal.get('xp_remaining') or 0)} XP\n\n"
        "👥 Рефералы\n"
        f"Друзей: {ref['count']}\n"
        f"Заработано: {ref['earned_rub']:.0f} ₽\n"
        f"Ожидают бонуса: {ref.get('pending', 0)}"
    )

def _stars_pay_toggle_kb(enabled: bool):
    kb = InlineKeyboardBuilder()
    if enabled:
        kb.button(text="🔴 Выключить Stars", callback_data="starspay:off")
    else:
        kb.button(text="🟢 Включить Stars", callback_data="starspay:on")
    kb.button(text="🔄 Обновить", callback_data="starspay:status")
    kb.adjust(1)
    return kb.as_markup()


@dp.message(Command("stars_pay"))
async def cmd_stars_pay(message: Message):
    if int(message.from_user.id) != int(MAIN_ADMIN_ID or 0):
        return await message.answer("⛔ Только для главного админа")
    enabled = await is_stars_payments_enabled()
    status = "🟢 ВКЛ" if enabled else "🔴 ВЫКЛ"
    await message.answer(
        f"⭐ Оплата Stars сейчас: {status}",
        reply_markup=_stars_pay_toggle_kb(enabled)
    )


@dp.callback_query(F.data.startswith("starspay:"))
async def cb_starspay_toggle(cq: CallbackQuery):
    if int(cq.from_user.id) != int(MAIN_ADMIN_ID or 0):
        return await cq.answer("Только для главного админа", show_alert=True)

    action = str(cq.data or "").split(":", 1)[1].strip().lower()
    current = await is_stars_payments_enabled()

    if action == "on":
        enabled = await set_stars_payments_enabled(True, int(cq.from_user.id))
    elif action == "off":
        enabled = await set_stars_payments_enabled(False, int(cq.from_user.id))
    else:
        enabled = current

    status = "🟢 ВКЛ" if enabled else "🔴 ВЫКЛ"
    text = f"⭐ Оплата Stars сейчас: {status}"

    try:
        await cq.message.edit_text(text, reply_markup=_stars_pay_toggle_kb(enabled))
    except Exception:
        try:
            await cq.message.edit_reply_markup(reply_markup=_stars_pay_toggle_kb(enabled))
        except Exception:
            pass

    try:
        await cq.answer(f"Stars {'включены' if enabled else 'выключены'}")
    except Exception:
        pass

    await cq.answer("Сохранено")


@dp.message(Command("stars"))
async def cmd_stars(message: Message):
    if int(message.from_user.id) not in ADMIN_IDS:
        return await message.answer("⛔ Только для админа")
    try:
        bal = await get_bot_stars_balance()
        txs = await get_bot_star_transactions(limit=10)
    except Exception as e:
        log.exception("get stars info failed: %s", e)
        return await message.answer("❌ Не удалось получить Stars баланс бота")

    lines = [
        "⭐ Баланс Stars бота",
        f"Сейчас: {_format_star_amount_obj(bal)}",
    ]
    if txs:
        lines.append("")
        lines.append("Последние операции:")
        for tx in txs[:10]:
            incoming = bool(tx.get("source"))
            partner = _star_partner_text(tx.get("source") if incoming else tx.get("receiver"))
            sign = "+" if incoming else "-"
            lines.append(f"{_format_unix_ts(tx.get('date'))} | {sign}{_format_star_amount_obj(tx)} | {partner}")
    else:
        lines.append("")
        lines.append("Операций пока нет.")

    await message.answer("\n".join(lines))

@dp.message(Command("stars_tx"))
async def cmd_stars_tx(message: Message):
    if int(message.from_user.id) not in ADMIN_IDS:
        return await message.answer("⛔ Только для админа")
    try:
        txs = await get_bot_star_transactions(limit=25)
    except Exception as e:
        log.exception("get stars tx failed: %s", e)
        return await message.answer("❌ Не удалось получить транзакции Stars")

    if not txs:
        return await message.answer("⭐ Транзакций Stars пока нет")

    chunks = []
    cur = ["⭐ Последние Stars транзакции"]
    for i, tx in enumerate(txs[:25], start=1):
        incoming = bool(tx.get("source"))
        partner = _star_partner_text(tx.get("source") if incoming else tx.get("receiver"))
        sign = "+" if incoming else "-"
        row = f"{i}. {_format_unix_ts(tx.get('date'))} | {sign}{_format_star_amount_obj(tx)} | {partner}"
        if sum(len(x) + 1 for x in cur) + len(row) > 3500:
            chunks.append("\n".join(cur))
            cur = ["⭐ Последние Stars транзакции"]
        cur.append(row)
    if cur:
        chunks.append("\n".join(cur))

    for chunk in chunks:
        await message.answer(chunk)


def _admin_stats_kb():
    kb = InlineKeyboardBuilder()
    kb.button(text="🔄 Обновить статистику", callback_data="adminstats:refresh")
    kb.adjust(1)
    return kb.as_markup()


async def build_main_admin_stats_text() -> str:
    now_dt = _now()
    today_d = _day()
    today = today_d.isoformat()
    today_start = datetime.combine(today_d, dt_time.min, tzinfo=timezone.utc)
    yesterday_start = today_start - timedelta(days=1)

    users_total = await sb_count(T_USERS)
    bot_started = await sb_count(T_LIMITS, match={"limit_key": tg_evt_key("bot_start")})
    miniapp_opened = await sb_count(T_LIMITS, match={"limit_key": tg_evt_key("miniapp_open")})

    recent_5m = (now_dt - timedelta(minutes=5)).isoformat()
    recent_10m = (now_dt - timedelta(minutes=10)).isoformat()
    recent_15m = (now_dt - timedelta(minutes=15)).isoformat()
    recent_1h = (now_dt - timedelta(hours=1)).isoformat()
    recent_24h = (now_dt - timedelta(hours=24)).isoformat()
    recent_7d = (now_dt - timedelta(days=7)).isoformat()

    starts_10m = await sb_count(T_LIMITS, match={"limit_key": tg_evt_key("bot_start")}, gte={"last_at": recent_10m})
    starts_1h = await sb_count(T_LIMITS, match={"limit_key": tg_evt_key("bot_start")}, gte={"last_at": recent_1h})
    starts_24h = await sb_count(T_LIMITS, match={"limit_key": tg_evt_key("bot_start")}, gte={"last_at": recent_24h})
    starts_7d = await sb_count(T_LIMITS, match={"limit_key": tg_evt_key("bot_start")}, gte={"last_at": recent_7d})

    mini_10m = await sb_count(T_LIMITS, match={"limit_key": tg_evt_key("miniapp_open")}, gte={"last_at": recent_10m})
    mini_1h = await sb_count(T_LIMITS, match={"limit_key": tg_evt_key("miniapp_open")}, gte={"last_at": recent_1h})
    mini_24h = await sb_count(T_LIMITS, match={"limit_key": tg_evt_key("miniapp_open")}, gte={"last_at": recent_24h})
    mini_7d = await sb_count(T_LIMITS, match={"limit_key": tg_evt_key("miniapp_open")}, gte={"last_at": recent_7d})

    new_users_today = await sb_count(T_USERS, gte={"created_at": today_start.isoformat()})
    new_users_yesterday = await sb_count(T_USERS, gte={"created_at": yesterday_start.isoformat()}, lt={"created_at": today_start.isoformat()})

    online_5m = await sb_count(T_USERS, gte={"last_seen_at": recent_5m})
    online_15m = await sb_count(T_USERS, gte={"last_seen_at": recent_15m})
    online_1h = await sb_count(T_USERS, gte={"last_seen_at": recent_1h})

    tasks_total = await sb_count(T_TASKS)
    tasks_active = await sb_count(T_TASKS, match={"status": "active"}, gt={"qty_left": 0})
    creators_total = await sb_distinct_count(T_TASKS, "owner_id")

    completions_total = await sb_count(T_COMP)
    completions_paid = await sb_count(T_COMP, match={"status": "paid"})
    completions_pending = await sb_count(T_COMP, match={"status": "pending"})
    completions_rejected = await sb_count(T_COMP, match={"status": "rejected"})
    executors_total = await sb_distinct_count(T_COMP, "user_id")

    topups_paid = await sb_count(T_PAY, match={"status": "paid"}, neq={"provider": "admin_credit"})
    topups_pending = await sb_count(T_PAY, match={"status": "pending"}, neq={"provider": "admin_credit"})
    withdrawals_total = await sb_count(T_WD)
    withdrawals_paid = await sb_count(T_WD, match={"status": "paid"})
    withdrawals_pending = await sb_count(T_WD, match={"status": "pending"})

    banned_total = await sb_count(T_USERS, match={"is_banned": True})

    day_stats = await sb_select(T_STATS, {"day": today}, limit=1)
    ds = (day_stats.data or [{}])[0] if getattr(day_stats, "data", None) else {}
    day_revenue = float(ds.get("revenue_rub") or 0)
    day_payouts = float(ds.get("payouts_rub") or 0)
    day_topups = float(ds.get("topups_rub") or 0)

    return (
        "📊 Статистика бота\n"
        f"Обновлено: {now_dt.strftime('%Y-%m-%d %H:%M:%S')} UTC\n\n"
        "👥 Пользователи\n"
        f"• Всего в базе: {users_total}\n"
        f"• Нажали /start: {bot_started}\n"
        f"• Открывали Mini App: {miniapp_opened}\n"
        f"• Забанено: {banned_total}\n\n"
        "🔥 Недавно пришло\n"
        f"• /start за 10 мин: {starts_10m}\n"
        f"• /start за 1 час: {starts_1h}\n"
        f"• /start за 24 часа: {starts_24h}\n"
        f"• /start за 7 дней: {starts_7d}\n"
        f"• Mini App за 10 мин: {mini_10m}\n"
        f"• Mini App за 1 час: {mini_1h}\n"
        f"• Mini App за 24 часа: {mini_24h}\n"
        f"• Mini App за 7 дней: {mini_7d}\n\n"
        "🆕 Новые пользователи\n"
        f"• Сегодня: {new_users_today}\n"
        f"• Вчера: {new_users_yesterday}\n\n"
        "🟢 Онлайн / активность\n"
        f"• Активны за 5 мин: {online_5m}\n"
        f"• Активны за 15 мин: {online_15m}\n"
        f"• Активны за 1 час: {online_1h}\n\n"
        "🧩 Задания\n"
        f"• Всего создано: {tasks_total}\n"
        f"• Активных сейчас: {tasks_active}\n"
        f"• Создателей заданий: {creators_total}\n\n"
        "✅ Выполнения\n"
        f"• Всего попыток/отчётов: {completions_total}\n"
        f"• Оплачено: {completions_paid}\n"
        f"• На проверке: {completions_pending}\n"
        f"• Отклонено: {completions_rejected}\n"
        f"• Уникальных исполнителей: {executors_total}\n\n"
        "💸 Финансы\n"
        f"• Пополнений оплачено: {topups_paid}\n"
        f"• Пополнений в ожидании: {topups_pending}\n"
        f"• Выводов всего: {withdrawals_total}\n"
        f"• Выводов оплачено: {withdrawals_paid}\n"
        f"• Выводов в ожидании: {withdrawals_pending}\n\n"
        f"📅 За сегодня ({today})\n"
        f"• Выручка: {day_revenue:.2f}₽\n"
        f"• Выплаты: {day_payouts:.2f}₽\n"
        f"• Пополнения: {day_topups:.2f}₽"
    )

@dp.message(Command("adminstats"))
async def cmd_adminstats(message: Message):
    if int(message.from_user.id) != int(MAIN_ADMIN_ID or 0):
        return await message.answer("⛔ Только для главного админа")
    text = await build_main_admin_stats_text()
    await message.answer(text, reply_markup=_admin_stats_kb())


@dp.callback_query(F.data == "adminstats:refresh")
async def cb_adminstats_refresh(cq: CallbackQuery):
    if int(cq.from_user.id) != int(MAIN_ADMIN_ID or 0):
        return await cq.answer("Только для главного админа", show_alert=True)
    text = await build_main_admin_stats_text()
    try:
        await cq.message.edit_text(text, reply_markup=_admin_stats_kb())
    except Exception:
        try:
            await cq.message.answer(text, reply_markup=_admin_stats_kb())
        except Exception:
            pass
    await cq.answer("Статистика обновлена")

# Stars платежи: Telegram требует PreCheckout ok=True
@dp.callback_query()
async def track_any_callback(cq: CallbackQuery):
    try:
        uid = int(cq.from_user.id)
        await tg_evt_touch(uid, "callback_any")
        data = str(cq.data or "").strip()
        if data:
            await tg_evt_touch(uid, "callback_data", data)
    except Exception:
        pass

@dp.message()
async def track_any_message(message: Message):
    try:
        uid = int(message.from_user.id)
        await tg_evt_touch(uid, "message_any")
        txt = str(message.text or message.caption or "").strip()
        if txt:
            await tg_evt_touch(uid, "message_text", txt.lower())
    except Exception:
        pass

@dp.poll_answer()
async def track_poll_answer(answer):
    try:
        uid = int(answer.user.id)
        await tg_evt_touch(uid, "poll_answer")
        pid = str(answer.poll_id or "").strip()
        if pid:
            await tg_evt_touch(uid, "poll_answer", pid)
    except Exception:
        pass

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
        meta = prow.get("meta") or {}
        if not isinstance(meta, dict):
            meta = {}

        stars_amount = meta.get("stars")
        try:
            stars_amount = int(round(float(stars_amount))) if stars_amount is not None else None
        except Exception:
            stars_amount = None

        if not stars_amount or stars_amount <= 0:
            try:
                stars_amount = int(round(float(getattr(sp, "total_amount", 0) or 0)))
            except Exception:
                stars_amount = 0
        if stars_amount <= 0:
            stars_amount = max(1, int(round(amount_rub / max(STARS_RUB_RATE, 0.000001))))

        await sb_update(T_PAY, {"id": prow["id"]}, {"status": "paid"})
        await add_stars(uid, stars_amount)
        await stats_add("topups_rub", amount_rub)

        xp_add = int((amount_rub // 100) * XP_PER_TOPUP_100)
        if xp_add > 0:
            await add_xp(uid, xp_add)

        await message.answer(
            f"✅ Пополнение Stars успешно: +{stars_amount}⭐"
            + (f"\nЭквивалент: {amount_rub:.2f}₽" if amount_rub > 0 else "")
        )
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
async def api_error_middleware(req: web.Request, handler):
    try:
        return await handler(req)
    except web.HTTPException:
        raise
    except Exception as e:
        try:
            log.exception("unhandled api error on %s %s: %s", req.method, req.path, e)
        except Exception:
            pass
        if req.path.startswith("/api/"):
            return web.json_response({"ok": False, "error": "Временная ошибка сервера"}, status=500)
        raise

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
    return web.json_response({'ok': True, 'build': BUILD_TAG, 'app_build': APP_BUILD})

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
    app = web.Application(middlewares=[cors_middleware, api_error_middleware, no_cache_mw], client_max_size=10 * 1024 * 1024)

    app.router.add_get("/", health)
    app.router.add_get("/api/health", health)
    app.router.add_get("/api/version", health)
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
    app.router.add_post("/api/user/gender", api_user_gender_set)
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
    app.router.add_post("/api/report/list", api_report_list)
    app.router.add_post("/api/report/clear", api_report_clear)

    # optional crypto
    app.router.add_post("/api/pay/cryptobot/create", api_cryptobot_create)
    app.router.add_post(CRYPTO_WEBHOOK_PATH, cryptobot_webhook)

    # admin
    app.router.add_post("/api/admin/summary", api_admin_summary)
    app.router.add_post("/api/admin/stars-pay/set", api_admin_stars_pay_set)
    app.router.add_post("/api/admin/balance/credit", api_admin_balance_credit)
    app.router.add_post("/api/admin/user/punish", api_admin_user_punish)
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
    global TG_HOLD_WORKER_TASK
    await setup_menu_button(bot)
    # diagnostics: confirm which bot token is running
    try:
        me = await bot.get_me()
        log.warning(f"[SYNC_DIAG] Bot identity: @{me.username} id={me.id}")
    except Exception as e:
        log.error(f"[SYNC_DIAG] Bot identity check failed: {e}")
    hook_base = SERVER_BASE_URL or BASE_URL
    if TG_HOLD_WORKER_TASK is None or TG_HOLD_WORKER_TASK.done():
        TG_HOLD_WORKER_TASK = asyncio.create_task(tg_hold_worker())

    if USE_WEBHOOK and hook_base:
        wh_url = hook_base.rstrip("/") + WEBHOOK_PATH
        await bot.set_webhook(wh_url)
        log.info("Webhook set to %s", wh_url)
    else:
        asyncio.create_task(dp.start_polling(bot))
        log.info("Polling started")

async def on_cleanup(app: web.Application):
    global TG_HOLD_WORKER_TASK
    if TG_HOLD_WORKER_TASK and not TG_HOLD_WORKER_TASK.done():
        TG_HOLD_WORKER_TASK.cancel()
        try:
            await TG_HOLD_WORKER_TASK
        except asyncio.CancelledError:
            pass
        except Exception:
            pass
        TG_HOLD_WORKER_TASK = None

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
