from config import *
from config import TG_HOLD_PREFIX
from database import *
from services.balances import *
from services.limits import *
from services.telegram_utils import *
from services.user_service import *
from services.web_utils import *
from services.ui_handlers import *





import os
import math
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
import google.generativeai as genai

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
DG_ALLOWED_HOST = ("2gis.ru", "2gis.kz", "2gis.com", "go.2gis.com", "2gis.by")

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
        elif ttype == "dg":
            if "2gis" not in host and host != "go.2gis.com":
                return False, "", "Ссылка не похожа на 2GIS. Нужна ссылка на 2GIS"
            if not _host_allowed(host, DG_ALLOWED_HOST):
                return False, "", "Разрешены только ссылки 2GIS"
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

from aiogram import Bot, Dispatcher, F, BaseMiddleware
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
RATE_LIMIT_STATE = {}

# Build tag for diagnostics (to ensure Render runs the expected version)
BUILD_TAG = 'rc_backend_release5_lvldouble'
try:
    log.warning('[BUILD] %s', BUILD_TAG)
except Exception:
    pass


# Sanity checks
if not BOT_TOKEN:
    raise RuntimeError("BOT_TOKEN is missing in env")
if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE:
    raise RuntimeError("SUPABASE_URL / SUPABASE_SERVICE_ROLE is missing in env")

bot = Bot(BOT_TOKEN)
dp = Dispatcher()

from handlers.users import router as users_router
from handlers.admin import router as admin_router

dp.include_router(users_router)
dp.include_router(admin_router)

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

class MaintenanceMiddleware(BaseMiddleware):
    async def __call__(self, handler, event, data):
        if await is_maintenance_mode():
            user = data.get("event_from_user")
            if user:
                is_adm = (user.id in ADMIN_IDS) or (user.id == MAIN_ADMIN_ID)
                if not is_adm:
                    if getattr(event, "callback_query", None):
                        try:
                            await event.callback_query.answer("Бот на техобслуживании. Приходите позже.", show_alert=True)
                        except Exception: pass
                        return
                    if getattr(event, "message", None):
                        try:
                            await event.message.answer("⚠️ Бот временно отключен на техническое обслуживание. Пожалуйста, попробуйте зайти позже.")
                        except Exception: pass
                        return
                    return
        return await handler(event, data)


def _now():
    return datetime.now(timezone.utc)

def _day():
    return date.today()

# Removed moved functions to services.web_utils


    # Removed moved functions to services


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

async def notify_user(uid: int, text: str, force: bool = False, reply_markup=None):
    if not force:
        try:
            if await is_notify_muted(uid):
                return
        except Exception:
            pass
    try:
        await bot.send_message(uid, text, parse_mode="HTML", reply_markup=reply_markup)
    except Exception:
        pass


# -------------------------
# VIP Expiration Reminders
# -------------------------
async def vip_expiry_worker():
    """Background worker to send VIP expiration reminders."""
    while True:
        try:
            now = _now()
            # Users who have vip_until set
            # We use markers in 'user_limits' to avoid duplicate notifications.
            
            users_res = await sb_exec(lambda: sb.table(T_USERS).select("*").not_.is_("vip_until", "null").execute())
            for u in (users_res.data or []):
                uid = int(u.get("user_id") or 0)
                if not uid: continue
                
                v_str = u.get("vip_until")
                if not v_str: continue
                v_dt = _parse_dt(v_str)
                if not v_dt: continue
                
                diff = v_dt - now
                hours_left = diff.total_seconds() / 3600
                
                # Check 3 days (72h)
                if 0 < hours_left <= 72:
                    reminded = await get_limit_until(uid, "vip_remind_3d")
                    if not reminded:
                        msg = (f"👑 <b>Ваш VIP-статус заканчивается через {int(hours_left/24) + 1} дн.</b>\n\n"
                               f"Продлите его в профиле, чтобы сохранить бонус +10% к доходу и +50% к опыту! ✨")
                        await notify_user(uid, msg)
                        await set_limit_until(uid, "vip_remind_3d", now + timedelta(days=7))
                
                # Check 24h
                if 0 < hours_left <= 24:
                    reminded = await get_limit_until(uid, "vip_remind_1d")
                    if not reminded:
                        msg = (f"👑 <b>Внимание! Ваш VIP-статус закончится через 24 часа.</b>\n\n"
                               f"Успейте выполнить все VIP-задания и продлить статус! 🚀")
                        await notify_user(uid, msg)
                        await set_limit_until(uid, "vip_remind_1d", now + timedelta(days=7))
                
                # Check expired (within last hour)
                if -1 < hours_left <= 0:
                    reminded = await get_limit_until(uid, "vip_remind_expired")
                    if not reminded:
                        msg = (f"🚫 <b>Ваш VIP-статус закончился.</b>\n\n"
                               f"Бонусы к доходу и опыту больше не действуют. Ждем вас снова! 👋")
                        await notify_user(uid, msg)
                        await set_limit_until(uid, "vip_remind_expired", now + timedelta(days=30))

        except Exception as e:
            log.warning("VIP worker tick failed: %s", e)
        
        await asyncio.sleep(3600) # Check once an hour


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
# Removed moved get_miniapp_url to services.telegram_utils

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
        in_maintenance = await is_maintenance_mode()
        title = str(task.get('title') or task.get('platform') or 'Новое задание').strip()
        try:
            reward_i = int(float(task.get('reward_rub') or task.get('reward') or 0))
        except Exception:
            reward_i = 0
        kind_map = {'tg': 'Telegram', 'ya': 'Яндекс', 'gm': 'Google', 'dg': '2GIS'}
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
            if in_maintenance:
                if uid not in ADMIN_IDS and uid != MAIN_ADMIN_ID:
                    continue
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
# Removed moved web helpers

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



# Removed moved UI helpers to services.ui_handlers


# Moved build_main_admin_stats_text to services.ui_handlers

def _apply_cors_headers(req: web.Request, resp: web.StreamResponse):
    origin = req.headers.get("Origin")
    
    # If CORS_ORIGINS is empty or contains *, allow the current origin (or *)
    if not CORS_ORIGINS or "*" in CORS_ORIGINS:
        resp.headers["Access-Control-Allow-Origin"] = origin or "*"
    elif origin and origin in CORS_ORIGINS:
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Vary"] = "Origin"
    else:
        # If origin is not allowed and not same-origin (no origin header), we don't set CORS
        if not origin: return
        return

    resp.headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type, X-Tg-InitData, X-Tg-Init-Data, X-Telegram-Init-Data, X-Session-Token, Authorization, X-Init-Data"
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
    return web.json_response({'ok': True, 'build': BUILD_TAG, 'app_build': APP_BUILD})

async def tg_webhook(req: web.Request):
    update = await safe_json(req)
    # Быстрый ответ Telegram: обработку делаем в фоне, чтобы webhook не таймаутился
    try:
        asyncio.create_task(dp.feed_webhook_update(bot, update))
    except Exception:
        await dp.feed_webhook_update(bot, update)
    return web.Response(text="OK")

from api.tasks import *
from api.withdraw import *
from api.admin import *
from api.payments import *
from api.user import *
from api.misc import *

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
    app.router.add_post("/api/bonus/claim", api_bonus_claim)
    app.router.add_post("/api/leaderboard/top", api_leaderboard_top)

    app.router.add_post("/api/withdraw/create", api_withdraw_create)
    app.router.add_post("/api/withdraw/list", api_withdraw_list)

    app.router.add_post("/api/tbank/claim", api_tbank_claim)
    app.router.add_post("/api/pay/stars/link", api_stars_link)
    app.router.add_post("/api/ops/list", api_ops_list)
    app.router.add_post("/api/report/list", api_report_list)
    app.router.add_post("/api/report/clear", api_report_clear)

    app.router.add_post("/api/vip/buy", api_vip_buy)
    app.router.add_post("/api/admin/config/toggle_commission", api_admin_toggle_commission)
    app.router.add_post("/api/admin/config/toggle_maintenance", api_admin_toggle_maintenance)

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
    app.router.add_post("/api/admin/user/search", api_admin_user_search)
    app.router.add_post("/api/admin/user/suspicious", api_admin_user_suspicious)

    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app

async def on_startup(app: web.Application):
    global TG_HOLD_WORKER_TASK
    dp.update.outer_middleware(MaintenanceMiddleware())
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
        VIP_WORKER_TASK = asyncio.create_task(vip_expiry_worker())

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

    try:
        from crypto_service import crypto
        if crypto:
            await crypto.close()
    except Exception:
        pass
    await bot.session.close()




# -------------------------
# ADMIN: tasks list + delete (delete only by main admin)
# -------------------------


app = make_app()

if __name__ == "__main__":
    web.run_app(make_app(), host="0.0.0.0", port=PORT)