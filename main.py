import os
import re
import hmac
import hashlib
import json
import time
import asyncio
import logging
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, Optional, List, Tuple

from aiogram import Bot, Dispatcher, F, types
from aiogram.filters import Command
from aiogram.types import (
    LabeledPrice, PreCheckoutQuery,
    InlineKeyboardButton, InlineKeyboardMarkup,
    ReplyKeyboardMarkup, KeyboardButton, WebAppInfo
)

from aiohttp import web

from supabase import create_client
from aiocryptopay import AioCryptoPay, Networks


# =========================
# CONFIG
# =========================

def env_str(name: str, default: Optional[str] = None) -> Optional[str]:
    v = os.getenv(name)
    if v is None:
        return default
    v = v.strip()
    return v if v else default

def env_int_list(name: str, default: Optional[List[int]] = None) -> List[int]:
    raw = env_str(name)
    if not raw:
        return default or []
    out = []
    for part in raw.split(","):
        part = part.strip()
        if part.isdigit():
            out.append(int(part))
    return out if out else (default or [])

BOT_TOKEN = env_str("BOT_TOKEN")
if not BOT_TOKEN:
    raise RuntimeError("❌ BOT_TOKEN is not set. Add it in Render → Environment variables.")

# Supabase (используй SERVICE_ROLE_KEY ТОЛЬКО на сервере)
SUPABASE_URL = env_str("SUPABASE_URL")
SUPABASE_SERVICE_KEY = env_str("SUPABASE_SERVICE_ROLE_KEY")  # <-- важно
if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
    raise RuntimeError("❌ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set.")

# CryptoBot (optional)
CRYPTO_BOT_TOKEN = env_str("CRYPTO_BOT_TOKEN")  # optional

# Mini App URL (в /start кнопка)
WEBAPP_URL = env_str("WEBAPP_URL", "https://cdn.miniapps.ai/your_app/index.html")

# Admins
ADMIN_IDS = set(env_int_list("ADMIN_IDS", default=[]))  # example: "6482440657,123"
# Если не хочешь падений — но лучше задать env:
# ADMIN_IDS = {6482440657}

# Admin web (optional but recommended)
ADMIN_WEB_TOKEN = env_str("ADMIN_WEB_TOKEN")  # если задан — включаем /admin/* endpoints

# Economics
STAR_PRICE_RUB = float(env_str("STAR_PRICE_RUB", "1.5"))
REF_PERCENT = float(env_str("REF_PERCENT", "0.05"))  # 5%

# Limits (ms)
LIMIT_YA_MS = 3 * 24 * 60 * 60 * 1000   # 3 days
LIMIT_GM_MS = 1 * 24 * 60 * 60 * 1000   # 1 day

# Anti-fraud
RATE_LIMIT_WINDOW_SEC = int(env_str("RATE_LIMIT_WINDOW_SEC", "10"))   # окно
RATE_LIMIT_MAX = int(env_str("RATE_LIMIT_MAX", "10"))                 # событий в окно
MAX_DEVICES_PER_USER = int(env_str("MAX_DEVICES_PER_USER", "3"))      # базовый лимит

# Render port (для Web Service)
PORT = int(env_str("PORT", "8080"))

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("reviewcash")


# =========================
# INIT CLIENTS
# =========================

bot = Bot(BOT_TOKEN)
dp = Dispatcher()

supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

crypto = None
if CRYPTO_BOT_TOKEN:
    crypto = AioCryptoPay(
        token=CRYPTO_BOT_TOKEN,
        network=Networks.MAIN_NET if "test" not in CRYPTO_BOT_TOKEN.lower() else Networks.TEST_NET
    )


# =========================
# UTIL: sync → async wrappers
# =========================

async def sb_call(fn, *args, **kwargs):
    """Run blocking supabase calls in a thread."""
    return await asyncio.to_thread(fn, *args, **kwargs)

def now_utc() -> datetime:
    return datetime.now(timezone.utc)

def ms_now() -> int:
    return int(time.time() * 1000)


# =========================
# TELEGRAM WEBAPP INITDATA VERIFICATION
# =========================
# Твой Mini App должен присылать initData в sendData.
# Мы проверяем подпись, иначе любой может накрутить баланс.

def verify_telegram_init_data(init_data: str, bot_token: str, max_age_sec: int = 60 * 60) -> Tuple[bool, str, Dict[str, str]]:
    """
    Returns (ok, reason, parsed_dict).
    """
    if not init_data or "hash=" not in init_data:
        return False, "no_hash", {}

    # Parse querystring
    pairs = init_data.split("&")
    data = {}
    for p in pairs:
        if "=" in p:
            k, v = p.split("=", 1)
            data[k] = v

    received_hash = data.get("hash")
    if not received_hash:
        return False, "no_hash", data

    # Check auth_date freshness
    auth_date = data.get("auth_date")
    if auth_date and auth_date.isdigit():
        auth_ts = int(auth_date)
        if int(time.time()) - auth_ts > max_age_sec:
            return False, "expired", data

    # Build data_check_string
    check_items = []
    for k in sorted(data.keys()):
        if k == "hash":
            continue
        check_items.append(f"{k}={data[k]}")
    data_check_string = "\n".join(check_items)

    secret_key = hashlib.sha256(bot_token.encode()).digest()
    calc_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()

    if calc_hash != received_hash:
        return False, "bad_signature", data

    return True, "ok", data


def parse_user_from_initdata(parsed: Dict[str, str]) -> Optional[Dict[str, Any]]:
    """
    initData user is inside key 'user' as JSON (urlencoded).
    But in initData it's percent-encoded string.
    We'll decode minimally.
    """
    if "user" not in parsed:
        return None
    # URL decode
    import urllib.parse
    user_json = urllib.parse.unquote(parsed["user"])
    try:
        u = json.loads(user_json)
        return u
    except Exception:
        return None


# =========================
# BASIC ANTI-FRAUD (RATE LIMIT + DEVICES)
# =========================

_rate_bucket: Dict[int, List[float]] = {}

def rate_limit_ok(user_id: int) -> bool:
    """
    Simple in-memory rate limiter.
    (Хватает для защиты от спама в бою. Можно вынести в Redis позже.)
    """
    now = time.time()
    arr = _rate_bucket.get(user_id, [])
    arr = [t for t in arr if now - t <= RATE_LIMIT_WINDOW_SEC]
    if len(arr) >= RATE_LIMIT_MAX:
        _rate_bucket[user_id] = arr
        return False
    arr.append(now)
    _rate_bucket[user_id] = arr
    return True


# =========================
# DB LAYER
# =========================

async def db_get_user(user_id: int) -> Optional[Dict[str, Any]]:
    r = await sb_call(lambda: supabase.table("users").select("*").eq("user_id", user_id).execute())
    return r.data[0] if r.data else None

async def db_upsert_user_from_tg(user: types.User, referrer_id: Optional[int] = None, photo_url: Optional[str] = None):
    """
    Create or update user record.
    """
    payload = {
        "user_id": user.id,
        "username": user.username or "",
        "first_name": user.first_name or "",
        "last_name": user.last_name or "",
        "photo_url": photo_url or "",
        "updated_at": now_utc().isoformat()
    }
    existing = await db_get_user(user.id)
    if existing:
        # don't overwrite referrer if already set
        if not existing.get("referrer_id") and referrer_id and referrer_id != user.id:
            payload["referrer_id"] = referrer_id
        await sb_call(lambda: supabase.table("users").update(payload).eq("user_id", user.id).execute())
    else:
        payload.update({
            "balance_rub": 0,
            "balance_stars": 0,
            "referrer_id": referrer_id if (referrer_id and referrer_id != user.id) else None,
            "created_at": now_utc().isoformat(),
            "is_banned": False
        })
        await sb_call(lambda: supabase.table("users").insert(payload).execute())

async def db_add_balance(user_id: int, rub_delta: float = 0, stars_delta: int = 0):
    u = await db_get_user(user_id)
    if not u:
        return
    new_rub = float(u.get("balance_rub", 0)) + float(rub_delta)
    new_stars = int(u.get("balance_stars", 0)) + int(stars_delta)
    await sb_call(lambda: supabase.table("users").update({
        "balance_rub": new_rub,
        "balance_stars": new_stars,
        "updated_at": now_utc().isoformat()
    }).eq("user_id", user_id).execute())

async def db_log_payment(user_id: int, p_type: str, amount: float, currency: str, details: Optional[Dict[str, Any]] = None, status: str = "ok"):
    row = {
        "user_id": user_id,
        "type": p_type,
        "amount": amount,
        "currency": currency,
        "status": status,
        "details": details or {},
        "created_at": now_utc().isoformat()
    }
    await sb_call(lambda: supabase.table("payments").insert(row).execute())

async def db_reward_referrer(user_id: int, deposit_rub: float):
    u = await db_get_user(user_id)
    if not u:
        return
    ref_id = u.get("referrer_id")
    if not ref_id:
        return
    bonus = round(float(deposit_rub) * REF_PERCENT, 2)
    if bonus <= 0:
        return
    await db_add_balance(int(ref_id), rub_delta=bonus)
    await db_log_payment(int(ref_id), "ref_bonus", bonus, "RUB", {"from_user": user_id})

async def db_register_device(user_id: int, device_id: str) -> Tuple[bool, str]:
    """
    Very basic device tracking (device_id comes from client; can be spoofed, but still useful).
    """
    if not device_id or len(device_id) > 128:
        return True, "skip"

    # check how many devices already
    r = await sb_call(lambda: supabase.table("devices").select("*").eq("user_id", user_id).execute())
    devices = r.data or []
    if any(d.get("device_id") == device_id for d in devices):
        return True, "known"

    if len(devices) >= MAX_DEVICES_PER_USER:
        return False, "too_many_devices"

    await sb_call(lambda: supabase.table("devices").insert({
        "user_id": user_id,
        "device_id": device_id,
        "created_at": now_utc().isoformat()
    }).execute())
    return True, "added"

async def db_get_limit(user_id: int, limit_type: str) -> int:
    r = await sb_call(lambda: supabase.table("limits").select("*").eq("user_id", user_id).eq("type", limit_type).execute())
    if r.data:
        return int(r.data[0].get("last_ms", 0))
    return 0

async def db_set_limit(user_id: int, limit_type: str, last_ms: int):
    # upsert
    existing = await sb_call(lambda: supabase.table("limits").select("*").eq("user_id", user_id).eq("type", limit_type).execute())
    if existing.data:
        await sb_call(lambda: supabase.table("limits").update({"last_ms": last_ms}).eq("user_id", user_id).eq("type", limit_type).execute())
    else:
        await sb_call(lambda: supabase.table("limits").insert({"user_id": user_id, "type": limit_type, "last_ms": last_ms}).execute())

async def db_create_withdraw(user_id: int, amount: float, details: str):
    await sb_call(lambda: supabase.table("withdraws").insert({
        "user_id": user_id,
        "amount": amount,
        "details": details,
        "status": "pending",
        "created_at": now_utc().isoformat()
    }).execute())

async def db_list_pending_withdraws() -> List[Dict[str, Any]]:
    r = await sb_call(lambda: supabase.table("withdraws").select("*").eq("status", "pending").order("id", desc=True).execute())
    return r.data or []

async def db_update_withdraw_status(wid: int, status: str):
    await sb_call(lambda: supabase.table("withdraws").update({"status": status}).eq("id", wid).execute())

async def db_get_task(task_id: int) -> Optional[Dict[str, Any]]:
    r = await sb_call(lambda: supabase.table("tasks").select("*").eq("id", task_id).execute())
    return r.data[0] if r.data else None

async def db_create_task(owner_id: int, t_type: str, sub_type: str, target: str, text: str, qty: int, cost_rub: float, reward_rub: float, check_type: str):
    """
    owner pays cost, workers earn reward
    """
    await sb_call(lambda: supabase.table("tasks").insert({
        "owner_id": owner_id,
        "type": t_type,
        "sub_type": sub_type,
        "target": target,
        "text": text,
        "qty": qty,
        "cost_rub": cost_rub,
        "reward_rub": reward_rub,
        "check_type": check_type,
        "status": "active",
        "created_at": now_utc().isoformat()
    }).execute())

async def db_complete_task_once(task_id: int, user_id: int) -> Tuple[bool, str]:
    """
    Prevent double completion:
    insert into task_completions unique(task_id,user_id)
    """
    try:
        await sb_call(lambda: supabase.table("task_completions").insert({
            "task_id": task_id,
            "user_id": user_id,
            "created_at": now_utc().isoformat()
        }).execute())
        return True, "ok"
    except Exception:
        return False, "already_done"


# =========================
# TELEGRAM TASK AUTO CHECK
# =========================

def extract_tg_chat_from_url(url: str) -> Optional[str]:
    """
    Supports:
      https://t.me/username
      https://t.me/username/123
      t.me/username
      @username
    returns chat identifier usable in Bot API: '@username' or chat_id if numeric (not typical from link).
    """
    url = (url or "").strip()
    if not url:
        return None
    if url.startswith("@"):
        return url
    m = re.search(r"(?:https?://)?t\.me/([A-Za-z0-9_]+)/?", url)
    if m:
        return "@" + m.group(1)
    # maybe plain username
    if re.fullmatch(r"[A-Za-z0-9_]{5,}", url):
        return "@" + url
    return None

async def check_membership(user_id: int, target: str) -> Tuple[bool, str]:
    chat = extract_tg_chat_from_url(target)
    if not chat:
        return False, "bad_target"
    try:
        cm = await bot.get_chat_member(chat_id=chat, user_id=user_id)
        # statuses: creator, administrator, member, restricted, left, kicked
        if cm.status in ("creator", "administrator", "member", "restricted"):
            return True, "member"
        return False, cm.status
    except Exception as e:
        return False, f"api_error:{e}"


# =========================
# UI TEXTS
# =========================

START_TEXT = (
    "👋 <b>Добро пожаловать в ReviewCash!</b>\n\n"
    "Здесь можно:\n"
    "• ✅ Выполнять задания (Telegram/Яндекс/Google)\n"
    "• 💰 Зарабатывать и выводить деньги\n"
    "• 📣 Продвигать свои каналы/ботов/точки на картах\n\n"
    "<b>Как начать:</b>\n"
    "1) Нажми кнопку «📱 Открыть приложение»\n"
    "2) Выбери задание → выполни → получи награду\n"
    "3) В профиле можно пополнить/вывести\n\n"
    "⚠️ Важно: задания на Карты проверяются через модерацию.\n"
    "Telegram-задания (подписка/вступление) могут проверяться автоматически.\n"
)

NEWBIE_TIPS = (
    "📌 <b>Инструкция для новичков</b>\n\n"
    "✅ <b>Заработок</b>\n"
    "• Открой приложение → вкладка «Задания»\n"
    "• Выполни задание → отправь отчет (если нужно)\n"
    "• После проверки деньги поступят на баланс\n\n"
    "📣 <b>Создание задания</b>\n"
    "• Нажми «+» → выбери тип → укажи ссылку и текст\n\n"
    "🏦 <b>Вывод</b>\n"
    "• Профиль → «Вывести» → введи реквизиты\n\n"
    "🔔 Уведомления\n"
    "• Бот присылает сообщения о новых заданиях и статусе выплат\n"
)


# =========================
# /start
# =========================

@dp.message(Command("start"))
async def start_cmd(message: types.Message):
    if not rate_limit_ok(message.from_user.id):
        return

    args = message.text.split()
    ref_id = None
    if len(args) > 1 and args[1].isdigit():
        ref_id = int(args[1])

    # Try to get user photo (optional)
    photo_url = ""
    try:
        photos = await bot.get_user_profile_photos(message.from_user.id, limit=1)
        if photos.total_count > 0:
            file_id = photos.photos[0][-1].file_id
            f = await bot.get_file(file_id)
            # Telegram file URL: https://api.telegram.org/file/bot<TOKEN>/<file_path>
            photo_url = f"https://api.telegram.org/file/bot{BOT_TOKEN}/{f.file_path}"
    except Exception:
        pass

    await db_upsert_user_from_tg(message.from_user, referrer_id=ref_id, photo_url=photo_url)

    kb = ReplyKeyboardMarkup(
        keyboard=[[KeyboardButton(text="📱 Открыть приложение", web_app=WebAppInfo(url=WEBAPP_URL))]],
        resize_keyboard=True
    )

    await message.answer(START_TEXT, reply_markup=kb, parse_mode="HTML")
    await message.answer(NEWBIE_TIPS, parse_mode="HTML")


# =========================
# WEBAPP DATA HANDLER
# =========================
"""
Ожидаем JSON примерно такой:

{
  "initData": "...tg.initData...",
  "action": "get_profile" | "pay_stars" | "pay_crypto" | "withdraw_request" |
            "create_task" | "tg_check" | "proof_submit" | "admin_withdraw_list" | ...
  "device_id": "optional",
  ... other fields ...
}

ВАЖНО: Mini App должен передавать initData. См. инструкцию ниже.
"""

async def answer_webapp(message: types.Message, obj: Dict[str, Any]):
    await message.answer(json.dumps(obj, ensure_ascii=False))

@dp.message(F.web_app_data)
async def webapp_handler(message: types.Message):
    if not rate_limit_ok(message.from_user.id):
        return

    try:
        data = json.loads(message.web_app_data.data)
    except Exception:
        await message.answer("❌ Некорректные данные из приложения.")
        return

    init_data = data.get("initData", "")
    ok, reason, parsed = verify_telegram_init_data(init_data, BOT_TOKEN)
    if not ok:
        # Разрешим только безопасные действия без подписи? лучше запретить все.
        await message.answer(f"❌ Ошибка безопасности: initData invalid ({reason}). Обнови приложение и попробуй снова.")
        return

    # User from initData (более доверенный, чем message.from_user)
    init_user = parse_user_from_initdata(parsed) or {}
    user_id = int(init_user.get("id") or message.from_user.id)

    # device anti-fraud
    device_id = str(data.get("device_id") or "").strip()
    if device_id:
        dev_ok, dev_reason = await db_register_device(user_id, device_id)
        if not dev_ok:
            await message.answer("❌ Слишком много устройств на аккаунт. Обратись в поддержку.")
            return

    action = data.get("action")
    if not action:
        await message.answer("❌ Нет action.")
        return

    # Update profile fields quickly
    try:
        pseudo_user = message.from_user
        # if init_user has username/first_name
        if init_user:
            pseudo_user = types.User(
                id=user_id,
                is_bot=False,
                first_name=init_user.get("first_name") or message.from_user.first_name,
                last_name=init_user.get("last_name") or message.from_user.last_name,
                username=init_user.get("username") or message.from_user.username,
                language_code=message.from_user.language_code
            )
        await db_upsert_user_from_tg(pseudo_user)
    except Exception:
        pass

    # -----------------------
    # ACTIONS
    # -----------------------

    # 1) PROFILE
    if action == "get_profile":
        u = await db_get_user(user_id)
        if not u:
            await message.answer("❌ Профиль не найден. Нажми /start.")
            return
        await answer_webapp(message, {
            "ok": True,
            "user": {
                "user_id": u["user_id"],
                "username": u.get("username", ""),
                "first_name": u.get("first_name", ""),
                "last_name": u.get("last_name", ""),
                "photo_url": u.get("photo_url", ""),
                "balance_rub": float(u.get("balance_rub", 0)),
                "balance_stars": int(u.get("balance_stars", 0)),
            }
        })
        return

    # 2) PAY STARS
    if action == "pay_stars":
        amount_rub = float(data.get("amount", 0))
        if amount_rub < 300:
            await message.answer("❌ Минимальная сумма пополнения: 300 ₽")
            return

        stars = max(int(amount_rub / STAR_PRICE_RUB), 1)
        await bot.send_invoice(
            chat_id=message.chat.id,
            title="Пополнение баланса ReviewCash",
            description=f"Пополнение на {stars} Stars (~{amount_rub} ₽)",
            payload=f"stars_{stars}_{user_id}",
            currency="XTR",
            prices=[LabeledPrice(label="Stars", amount=stars)]
        )
        return

    # 3) PAY CRYPTO (USDT via CryptoBot)
    if action == "pay_crypto":
        if not crypto:
            await message.answer("❌ CryptoBot не подключен. Добавь CRYPTO_BOT_TOKEN.")
            return

        amount_rub = float(data.get("amount", 0))
        if amount_rub < 300:
            await message.answer("❌ Минимальная сумма пополнения: 300 ₽")
            return

        # Пример курса. Лучше вынести в env или обновлять через cron.
        rub_per_usdt = float(env_str("RUB_PER_USDT", "95"))
        usdt = round(amount_rub / rub_per_usdt, 2)

        inv = await crypto.create_invoice(asset="USDT", amount=usdt)
        kb = InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text="💎 Оплатить USDT", url=inv.bot_invoice_url)],
            [InlineKeyboardButton(text="✅ Я оплатил", callback_data=f"chkcrypto:{inv.invoice_id}:{amount_rub}:{user_id}")]
        ])
        await message.answer(
            f"💳 <b>Счет создан</b>\nК оплате: <b>{usdt} USDT</b> (~{amount_rub} ₽)\n\nПосле оплаты нажми «Я оплатил».",
            reply_markup=kb,
            parse_mode="HTML"
        )
        return

    # 4) WITHDRAW REQUEST
    if action == "withdraw_request":
        amount = float(data.get("amount", 0))
        details = str(data.get("details", "")).strip()
        if amount < 300:
            await message.answer("❌ Минимальная сумма вывода: 300 ₽")
            return
        if not details:
            await message.answer("❌ Укажи реквизиты.")
            return

        u = await db_get_user(user_id)
        if not u or float(u.get("balance_rub", 0)) < amount:
            await message.answer("❌ Недостаточно средств.")
            return

        # списываем сразу
        await db_add_balance(user_id, rub_delta=-amount)
        await db_create_withdraw(user_id, amount, details)
        await db_log_payment(user_id, "withdraw_request", amount, "RUB", {"details": details}, status="pending")

        # push admin
        for aid in ADMIN_IDS:
            try:
                await bot.send_message(
                    aid,
                    f"📤 <b>Заявка на вывод</b>\n"
                    f"👤 {user_id}\n"
                    f"💰 {amount} ₽\n"
                    f"💳 {details}",
                    parse_mode="HTML"
                )
            except Exception:
                pass

        await message.answer("✅ Заявка на вывод создана. Ожидай решения администратора.")
        return

    # 5) CREATE TASK (owner creates)
    if action == "create_task":
        t_type = str(data.get("type", "")).strip()  # tg / ya / gm
        sub_type = str(data.get("sub_type", "")).strip()  # tg_sub etc
        target = str(data.get("target", "")).strip()
        text = str(data.get("text", "")).strip()
        qty = int(data.get("qty", 1))
        currency = str(data.get("currency", "rub")).strip()  # rub/star
        cost_rub = float(data.get("cost_rub", 0))  # what owner pays per item (or total - your choice)
        reward_rub = float(data.get("reward_rub", 0))  # what worker earns per completion
        check_type = str(data.get("check_type", "manual")).strip()

        if t_type not in ("tg", "ya", "gm"):
            await message.answer("❌ Неверный тип задания.")
            return
        if qty < 1 or qty > 10000:
            await message.answer("❌ Неверное количество.")
            return
        if not target:
            await message.answer("❌ Нужна ссылка.")
            return
        if cost_rub <= 0 or reward_rub <= 0:
            await message.answer("❌ Неверная цена.")
            return

        u = await db_get_user(user_id)
        if not u:
            await message.answer("❌ Профиль не найден. Нажми /start.")
            return

        total_cost_rub = cost_rub * qty

        # списание
        if currency == "rub":
            if float(u.get("balance_rub", 0)) < total_cost_rub:
                await message.answer("❌ Недостаточно рублей на балансе.")
                return
            await db_add_balance(user_id, rub_delta=-total_cost_rub)
            await db_log_payment(user_id, "task_create", total_cost_rub, "RUB", {"type": t_type, "qty": qty}, status="ok")
        elif currency == "star":
            stars_need = int((total_cost_rub / STAR_PRICE_RUB) + 0.999)
            if int(u.get("balance_stars", 0)) < stars_need:
                await message.answer("❌ Недостаточно Stars.")
                return
            await db_add_balance(user_id, stars_delta=-stars_need)
            await db_log_payment(user_id, "task_create", stars_need, "STARS", {"type": t_type, "qty": qty}, status="ok")
        else:
            await message.answer("❌ Неверная валюта.")
            return

        await db_create_task(
            owner_id=user_id,
            t_type=t_type,
            sub_type=sub_type,
            target=target,
            text=text,
            qty=qty,
            cost_rub=cost_rub,
            reward_rub=reward_rub,
            check_type=check_type
        )

        # push users/admin optional
        for aid in ADMIN_IDS:
            try:
                await bot.send_message(aid, f"📣 Новое задание создано: {t_type} x{qty}\nOwner: {user_id}")
            except Exception:
                pass

        await message.answer("✅ Задание создано.")
        return

    # 6) TG AUTO CHECK (worker check membership)
    if action == "tg_check":
        task_id = int(data.get("task_id", 0))
        if task_id <= 0:
            await message.answer("❌ Нет task_id.")
            return

        task = await db_get_task(task_id)
        if not task or task.get("status") != "active":
            await message.answer("❌ Задание не найдено или не активно.")
            return

        # LIMITS for ya/gm
        t_type = task.get("type")
        if t_type in ("ya", "gm"):
            # these are manual proofs - should not go via tg_check
            await message.answer("❌ Это задание не проверяется автоматически.")
            return

        # Only membership type auto-check in this bot
        # sub_type expected: tg_sub / tg_group / tg_hold (same as member)
        sub_type = (task.get("sub_type") or "").strip()
        if sub_type not in ("tg_sub", "tg_group", "tg_hold"):
            await message.answer("❌ Этот тип Telegram задания пока не поддерживает авто-проверку.")
            return

        ok_member, detail = await check_membership(user_id, task.get("target", ""))
        if not ok_member:
            await message.answer(f"❌ Не найдено выполнение. Статус: {detail}\nПроверь подписку/вступление и повтори.")
            return

        # prevent double payout
        ok_once, why = await db_complete_task_once(task_id, user_id)
        if not ok_once:
            await message.answer("⚠️ Уже засчитано ранее.")
            return

        # pay reward
        reward = float(task.get("reward_rub", 0))
        await db_add_balance(user_id, rub_delta=reward)
        await db_log_payment(user_id, "task_reward", reward, "RUB", {"task_id": task_id, "type": sub_type}, status="ok")

        await message.answer(f"✅ Выполнение подтверждено! Начислено +{reward} ₽")

        return

    # 7) SUBMIT PROOF (YA/GM) -> admin queue
    if action == "proof_submit":
        task_id = int(data.get("task_id", 0))
        worker_name = str(data.get("worker_name", "")).strip()
        screenshot_url = str(data.get("screenshot_url", "")).strip()  # if you upload to storage
        if task_id <= 0 or not worker_name:
            await message.answer("❌ Неверные данные.")
            return

        task = await db_get_task(task_id)
        if not task or task.get("status") != "active":
            await message.answer("❌ Задание не найдено или не активно.")
            return

        t_type = task.get("type")
        # check limits
        if t_type == "ya":
            last = await db_get_limit(user_id, "ya")
            if ms_now() - last < LIMIT_YA_MS:
                remain_h = int((LIMIT_YA_MS - (ms_now() - last)) / (3600 * 1000) + 1)
                await message.answer(f"⏳ Яндекс можно выполнять раз в 3 дня. Доступно через ~{remain_h} ч.")
                return
        if t_type == "gm":
            last = await db_get_limit(user_id, "gm")
            if ms_now() - last < LIMIT_GM_MS:
                remain_h = int((LIMIT_GM_MS - (ms_now() - last)) / (3600 * 1000) + 1)
                await message.answer(f"⏳ Google можно выполнять раз в день. Доступно через ~{remain_h} ч.")
                return

        # create moderation item
        await sb_call(lambda: supabase.table("proofs").insert({
            "task_id": task_id,
            "user_id": user_id,
            "worker_name": worker_name,
            "screenshot_url": screenshot_url,
            "status": "pending",
            "created_at": now_utc().isoformat()
        }).execute())

        # record limit moment (submit counts as attempt)
        if t_type in ("ya", "gm"):
            await db_set_limit(user_id, t_type, ms_now())

        # notify admins
        for aid in ADMIN_IDS:
            try:
                await bot.send_message(
                    aid,
                    f"🧾 <b>Новый отчет</b>\n"
                    f"Task: {task_id} ({t_type})\n"
                    f"User: {user_id}\n"
                    f"Nick: {worker_name}\n"
                    f"Target: {task.get('target','')}\n"
                    f"Скрин: {screenshot_url or '(нет url)'}\n\n"
                    f"Команды: /p_ok_{task_id}_{user_id} или /p_no_{task_id}_{user_id}",
                    parse_mode="HTML"
                )
            except Exception:
                pass

        await message.answer("✅ Отчет отправлен на модерацию.")
        return

    await message.answer("❌ Неизвестное действие.")


# =========================
# STARS PAYMENTS
# =========================

@dp.pre_checkout_query()
async def pre_checkout(q: PreCheckoutQuery):
    await q.answer(ok=True)

@dp.message(F.successful_payment)
async def stars_ok(message: types.Message):
    if not rate_limit_ok(message.from_user.id):
        return

    stars = int(message.successful_payment.total_amount)
    rub_equiv = stars * STAR_PRICE_RUB

    # credit balance
    await db_add_balance(message.from_user.id, stars_delta=stars)
    await db_log_payment(message.from_user.id, "deposit_stars", stars, "STARS", {
        "rub_equiv": rub_equiv,
        "telegram_payment_charge_id": message.successful_payment.telegram_payment_charge_id
    }, status="paid")

    await db_reward_referrer(message.from_user.id, rub_equiv)

    await message.answer(f"⭐ Оплата прошла! Начислено {stars} Stars")


# =========================
# CRYPTO CHECK CALLBACK
# =========================

@dp.callback_query(F.data.startswith("chkcrypto:"))
async def check_crypto(call: types.CallbackQuery):
    if not rate_limit_ok(call.from_user.id):
        return

    if not crypto:
        await call.answer("CryptoBot не подключен.", show_alert=True)
        return

    try:
        _, inv_id, amount_rub, credited_user = call.data.split(":")
        invs = await crypto.get_invoices(invoice_ids=int(inv_id))
        inv = invs[0] if isinstance(invs, list) else invs

        if getattr(inv, "status", "") == "paid":
            amount_rub = float(amount_rub)
            credited_user = int(credited_user)

            # (простая защита) — не начислять дважды по одному invoice
            existing = await sb_call(lambda: supabase.table("payments").select("*").eq("type", "deposit_crypto").contains("details", {"invoice_id": int(inv_id)}).execute())
            if existing.data:
                await call.message.edit_text("⚠️ Этот платеж уже был учтен.")
                return

            await db_add_balance(credited_user, rub_delta=amount_rub)
            await db_log_payment(credited_user, "deposit_crypto", amount_rub, "RUB", {
                "invoice_id": int(inv_id),
                "asset": getattr(inv, "asset", ""),
                "amount": getattr(inv, "amount", None),
            }, status="paid")

            await db_reward_referrer(credited_user, amount_rub)

            await call.message.edit_text(f"✅ Оплата найдена! Баланс пополнен на {amount_rub} ₽")
        else:
            await call.answer("Платеж еще не найден. Попробуй через минуту.", show_alert=True)

    except Exception as e:
        await call.answer(f"Ошибка проверки: {e}", show_alert=True)


# =========================
# ADMIN COMMANDS
# =========================

def is_admin(uid: int) -> bool:
    return uid in ADMIN_IDS

@dp.message(Command("admin"))
async def admin_help(message: types.Message):
    if not is_admin(message.from_user.id):
        return
    await message.answer(
        "🛡️ <b>Админ команды</b>\n\n"
        "/withdraws — список заявок на вывод\n"
        "/w_ok_ID — отметить выплаченной\n"
        "/w_no_ID — отклонить (вернуть баланс)\n\n"
        "Proof (карты):\n"
        "/p_ok_TASKID_USERID — принять отчет и начислить\n"
        "/p_no_TASKID_USERID — отклонить\n",
        parse_mode="HTML"
    )

@dp.message(Command("withdraws"))
async def list_withdraws(message: types.Message):
    if not is_admin(message.from_user.id):
        return
    rows = await db_list_pending_withdraws()
    if not rows:
        await message.answer("Нет активных заявок.")
        return

    text = "📋 <b>Заявки на вывод (pending)</b>\n\n"
    for w in rows[:50]:
        text += (
            f"🆔 {w['id']} | 👤 {w['user_id']}\n"
            f"💰 {w['amount']} ₽\n"
            f"💳 {w['details']}\n"
            f"Команды: /w_ok_{w['id']}  /w_no_{w['id']}\n\n"
        )
    await message.answer(text, parse_mode="HTML")

@dp.message(F.text.startswith("/w_ok_"))
async def withdraw_ok(message: types.Message):
    if not is_admin(message.from_user.id):
        return
    wid = int(message.text.split("_")[2])
    # mark paid
    await db_update_withdraw_status(wid, "paid")
    await message.answer(f"✅ Вывод {wid} отмечен как выплаченный.")

@dp.message(F.text.startswith("/w_no_"))
async def withdraw_no(message: types.Message):
    if not is_admin(message.from_user.id):
        return
    wid = int(message.text.split("_")[2])
    # get withdraw row
    r = await sb_call(lambda: supabase.table("withdraws").select("*").eq("id", wid).execute())
    if not r.data:
        await message.answer("Не найдено.")
        return
    w = r.data[0]
    if w["status"] != "pending":
        await message.answer("Уже обработано.")
        return

    # refund
    await db_add_balance(int(w["user_id"]), rub_delta=float(w["amount"]))
    await db_update_withdraw_status(wid, "rejected")

    # push user
    try:
        await bot.send_message(int(w["user_id"]), f"❌ Ваша заявка на вывод {w['amount']} ₽ отклонена. Средства возвращены на баланс.")
    except Exception:
        pass

    await message.answer(f"❌ Вывод {wid} отклонен, средства возвращены.")

@dp.message(F.text.startswith("/p_ok_"))
async def proof_ok(message: types.Message):
    if not is_admin(message.from_user.id):
        return
    # /p_ok_TASKID_USERID
    parts = message.text.split("_")
    if len(parts) < 4:
        await message.answer("Формат: /p_ok_TASKID_USERID")
        return
    task_id = int(parts[2])
    user_id = int(parts[3])

    task = await db_get_task(task_id)
    if not task:
        await message.answer("Задание не найдено.")
        return

    # prevent double payout
    ok_once, _ = await db_complete_task_once(task_id, user_id)
    if not ok_once:
        await message.answer("⚠️ Уже засчитано ранее.")
        return

    reward = float(task.get("reward_rub", 0))
    await db_add_balance(user_id, rub_delta=reward)
    await db_log_payment(user_id, "task_reward_manual", reward, "RUB", {"task_id": task_id}, status="ok")

    # update proofs pending -> approved (optional)
    await sb_call(lambda: supabase.table("proofs").update({"status": "approved"}).eq("task_id", task_id).eq("user_id", user_id).execute())

    # push user
    try:
        await bot.send_message(user_id, f"✅ Отчет принят! Начислено +{reward} ₽")
    except Exception:
        pass

    await message.answer("✅ Принято и начислено.")

@dp.message(F.text.startswith("/p_no_"))
async def proof_no(message: types.Message):
    if not is_admin(message.from_user.id):
        return
    parts = message.text.split("_")
    if len(parts) < 4:
        await message.answer("Формат: /p_no_TASKID_USERID")
        return
    task_id = int(parts[2])
    user_id = int(parts[3])

    await sb_call(lambda: supabase.table("proofs").update({"status": "rejected"}).eq("task_id", task_id).eq("user_id", user_id).execute())
    try:
        await bot.send_message(user_id, "❌ Отчет отклонен. Попробуй снова внимательно выполнить условия.")
    except Exception:
        pass
    await message.answer("❌ Отклонено.")


# =========================
# ADMIN WEB (JSON API)
# =========================

async def admin_auth(request: web.Request) -> bool:
    if not ADMIN_WEB_TOKEN:
        return False
    token = request.headers.get("X-Admin-Token", "")
    return token == ADMIN_WEB_TOKEN

async def handle_health(request):
    return web.Response(text="OK")

async def handle_admin_stats(request):
    if not await admin_auth(request):
        return web.Response(status=401, text="unauthorized")

    # simple daily revenue from payments (RUB only)
    # NOTE: supabase filters on server; easiest is to just fetch last 1000 and aggregate
    r = await sb_call(lambda: supabase.table("payments").select("*").order("id", desc=True).limit(1000).execute())
    rows = r.data or []
    daily = {}
    for p in rows:
        try:
            dt = p.get("created_at", "")[:10]
            amt = float(p.get("amount", 0))
            cur = p.get("currency", "")
            typ = p.get("type", "")
            # revenue: deposits and task_create (as gross)
            if cur == "RUB" and typ in ("deposit_crypto", "task_create"):
                daily[dt] = daily.get(dt, 0.0) + amt
        except Exception:
            pass

    # sort by date asc
    out = [{"date": k, "revenue_rub": round(daily[k], 2)} for k in sorted(daily.keys())]
    return web.json_response({"ok": True, "daily": out})

async def handle_admin_withdraws(request):
    if not await admin_auth(request):
        return web.Response(status=401, text="unauthorized")
    rows = await db_list_pending_withdraws()
    return web.json_response({"ok": True, "withdraws": rows})

def build_app() -> web.Application:
    app = web.Application()
    app.router.add_get("/health", handle_health)

    if ADMIN_WEB_TOKEN:
        app.router.add_get("/admin/stats", handle_admin_stats)
        app.router.add_get("/admin/withdraws", handle_admin_withdraws)

    return app


# =========================
# MAIN
# =========================

async def main():
    # start aiohttp server (so Render Web Service sees an open port)
    app = build_app()
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", PORT)
    await site.start()
    log.info(f"HTTP server started on :{PORT}")

    # polling
    await bot.delete_webhook(drop_pending_updates=True)
    log.info("Bot polling started")
    await dp.start_polling(bot)

if __name__ == "__main__":
    asyncio.run(main())
