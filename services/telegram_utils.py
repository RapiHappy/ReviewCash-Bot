import re
import logging
from datetime import datetime, timezone
from aiogram import Bot
from aiogram.types import InlineKeyboardMarkup, InlineKeyboardButton, WebAppInfo
from aiogram.enums import ParseMode
import html

from config import MANDATORY_SUB_CHANNEL, BOT_TOKEN, MINIAPP_URL, SERVER_BASE_URL, BASE_URL, APP_BUILD, BOT_USERNAME

log = logging.getLogger("reviewcash")

# create a shared bot instance
bot = Bot(token=BOT_TOKEN) if BOT_TOKEN else None

TG_CHAT_CACHE: dict[str, tuple[float, bool, str]] = {}

def _now():
    return datetime.now(timezone.utc)

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

async def tg_check_required_subscription(user_id: int, bot_instance: Bot | None = None) -> tuple[bool, str | None, str]:
    chat = get_required_sub_channel()
    if not chat:
        return True, None, ""

    b = bot_instance or bot
    if not b:
        return True, chat, "Бот не инициализирован"

    try:
        member = await b.get_chat_member(chat_id=chat, user_id=int(user_id))
        cls_name = type(member).__name__.lower()
        raw_status = getattr(member, "status", None)
        status = str(raw_status).lower() if raw_status is not None else ""

        subscribed_classes = ("chatmembermember", "chatmemberadministrator", "chatmemberowner", "chatmemberrestricted")
        left_classes = ("chatmemberleft", "chatmemberbanned")

        if cls_name in subscribed_classes:
            return True, chat, ""
        if cls_name in left_classes:
            return False, chat, "Подпишись на канал и нажми «Проверить подписку»."

        if status in ("member", "administrator", "creator", "restricted"):
            return True, chat, ""
        if status in ("left", "kicked", "banned"):
            return False, chat, "Подпишись на канал и нажми «Проверить подписку»."

        logging.warning(f"subscription check: unknown member type={cls_name} status={status} for user={user_id}")
        return False, chat, "Не удалось определить подписку."

    except Exception as e:
        err_str = str(e).lower()
        logging.warning(f"subscription check error for user={user_id} chat={chat}: {e}")
        if "chat not found" in err_str or "bot is not a member" in err_str or "not enough rights" in err_str or "forbidden" in err_str:
            logging.error(f"[SUBSCRIPTION] Bot cannot check membership in {chat}. Make sure the bot is an ADMIN of the channel. Allowing user through.")
            return True, chat, ""
        return False, chat, "Не удалось проверить подписку. Подпишись на канал и нажми кнопку проверки ещё раз."

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

def back_to_app_kb() -> InlineKeyboardMarkup:
    """Returns a keyboard with a button to return to the MiniApp."""
    return InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text="📱 Открыть MiniApp", url=f"https://t.me/{BOT_USERNAME}/app")
    ]])

def tg_task_identity(task: dict | None) -> str:
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
    if u.endswith("bot") or ("?start=" in tu) or ("&start=" in tu) or ("/start" in tu):
        return "bot"
    return "chat"

async def tg_calc_check_type(tg_chat: str, target_url: str, bot_instance: Bot | None = None) -> tuple[str, str, str]:
    kind = tg_detect_kind(tg_chat, target_url)
    if kind == "bot":
        return "manual", kind, "BOT_TASK"
    ok, msg = await ensure_bot_in_chat(tg_chat, bot_instance)
    if ok:
        return "auto", kind, ""
    return "manual", kind, (msg or "NO_ACCESS")


async def ensure_bot_in_chat(chat_username: str, bot_instance: Bot | None = None) -> tuple[bool, str]:
    key = str(chat_username).lower()
    now = _now().timestamp()
    if key in TG_CHAT_CACHE:
        ts, ok, msg = TG_CHAT_CACHE[key]
        if (now - ts) < 300:
            return ok, msg
    
    b = bot_instance or bot
    if not b:
        return False, "Бот не инициализирован"

    try:
        me = await b.get_me()
        chat = await b.get_chat(chat_username)
        member = await b.get_chat_member(chat_username, me.id)
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

async def notify_admin(text: str):
    from config import ADMIN_IDS
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
    from services.limits import is_notify_muted
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
    from datetime import timedelta
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


def is_private_tg_target(raw: str | None) -> bool:
    s = str(raw or '').strip().lower()
    return ('t.me/+' in s) or ('t.me/joinchat/' in s) or ('telegram.me/+' in s) or ('joinchat/' in s)


async def tg_get_chat_kind(chat_username: str, bot_instance: Bot | None = None) -> str:
    b = bot_instance or bot
    if not b:
        return ""
    try:
        chat = await b.get_chat(chat_username)
        return str(getattr(chat, 'type', '') or '').strip().lower()
    except Exception:
        return ""

def _normalize_chat_raw(chat: str) -> str:
    if not chat:
        return chat
    chat = chat.strip()
    chat = chat.replace("https://t.me/", "").replace("http://t.me/", "")
    if not chat.startswith("@") and not chat.startswith("-100"):
        chat = "@" + chat
    return chat

async def tg_is_member(chat: str, user_id: int, bot_instance: Bot | None = None) -> bool:
    b = bot_instance or bot
    if not b:
        return False
    try:
        chat = _normalize_chat_raw(chat)
        cm = await b.get_chat_member(chat_id=chat, user_id=user_id)
        status = str(getattr(cm, "status", "")).lower()
        return status in ("member","administrator","creator","restricted")
    except Exception as e:
        log.warning("subscription check error: %s", e)
        return False
def get_miniapp_url() -> str:
    url = (MINIAPP_URL or '').strip()
    if not url:
        base = (SERVER_BASE_URL or BASE_URL or '').strip()
        if base:
            url = base.rstrip('/') + f'/app/?v={APP_BUILD}'
    if url and 'v=' not in url:
        url = url + ('&' if '?' in url else '?') + f'v={APP_BUILD}'
    return url or '/app/'
