import os
import re
import json
import hmac
import hashlib
import logging
import asyncio
from datetime import datetime, timezone, date, timedelta
from typing import Optional, Dict, Any, List, Tuple

from aiohttp import web
from aiogram import Bot, Dispatcher, F, types
from aiogram.filters import Command
from aiogram.types import (
    InlineKeyboardButton, InlineKeyboardMarkup,
    ReplyKeyboardMarkup, KeyboardButton, WebAppInfo,
    PreCheckoutQuery, LabeledPrice
)
from supabase import create_client
from aiocryptopay import AioCryptoPay, Networks

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("reviewcash")

# =========================
# ENV CONFIG (REQUIRED)
# =========================
BOT_TOKEN = os.getenv("BOT_TOKEN")
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY") or os.getenv("SUPABASE_KEY")
CRYPTOBOT_TOKEN = os.getenv("CRYPTO_BOT_TOKEN")  # aiocryptopay token (CryptoBot)
WEBAPP_URL = os.getenv("WEBAPP_URL")  # your miniapp url
PORT = int(os.getenv("PORT", "8080"))

# Admins
ADMIN_IDS_RAW = os.getenv("ADMIN_IDS", "")  # "123,456"
ADMIN_IDS = set()
if ADMIN_IDS_RAW.strip():
    try:
        ADMIN_IDS = {int(x.strip()) for x in ADMIN_IDS_RAW.split(",") if x.strip()}
    except Exception:
        ADMIN_IDS = set()
# fallback single admin
ADMIN_ID_SINGLE = os.getenv("ADMIN_ID")
if ADMIN_ID_SINGLE and ADMIN_ID_SINGLE.isdigit():
    ADMIN_IDS.add(int(ADMIN_ID_SINGLE))

# Admin web token
ADMIN_WEB_TOKEN = os.getenv("ADMIN_WEB_TOKEN", "")

# Business config
STAR_PRICE_RUB = float(os.getenv("STAR_PRICE_RUB", "1.5"))  # 1 star ~ 1.5 rub
REF_PERCENT = float(os.getenv("REF_PERCENT", "0.05"))       # 5%
USDTRUB_RATE = float(os.getenv("USDTRUB_RATE", "95"))       # simple rate for invoices

# Anti-fraud limits
MAX_DEVICES_PER_USER = int(os.getenv("MAX_DEVICES_PER_USER", "3"))
MAX_USERS_PER_DEVICE = int(os.getenv("MAX_USERS_PER_DEVICE", "2"))

# Limits for platform reviews
YA_COOLDOWN_HOURS = int(os.getenv("YA_COOLDOWN_HOURS", str(72)))  # 3 days
GM_COOLDOWN_HOURS = int(os.getenv("GM_COOLDOWN_HOURS", str(24)))  # 1 day

# Table names (match your current DB)
T_USERS = "users"
T_BALANCES = "balances"
T_TASKS = "tasks"
T_COMPLETIONS = "task_completions"
T_PAYMENTS = "payments"
T_WITHDRAWALS = "withdrawals"
T_USER_DEVICES = "user_devices"
T_USER_LIMITS = "user_limits"
T_STATS = "stats_daily"

if not BOT_TOKEN:
    raise RuntimeError("BOT_TOKEN is missing. Set it in environment variables.")
if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
    raise RuntimeError("SUPABASE_URL / SUPABASE_SERVICE_KEY is missing.")
if not WEBAPP_URL:
    log.warning("WEBAPP_URL is missing. /start will not open Mini App button correctly.")

# =========================
# CLIENTS
# =========================
bot = Bot(BOT_TOKEN)
dp = Dispatcher()

supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

crypto = None
if CRYPTOBOT_TOKEN:
    crypto = AioCryptoPay(
        token=CRYPTOBOT_TOKEN,
        network=Networks.MAIN_NET if "test" not in CRYPTOBOT_TOKEN.lower() else Networks.TEST_NET
    )
else:
    log.warning("CRYPTO_BOT_TOKEN is missing. CryptoBot payments will be disabled.")

# =========================
# HELPERS
# =========================

def now_ts() -> str:
    return datetime.now(timezone.utc).isoformat()

def sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()

def parse_start_ref(text: str) -> Optional[int]:
    parts = (text or "").split()
    if len(parts) > 1 and parts[1].isdigit():
        return int(parts[1])
    return None

def is_admin(user_id: int) -> bool:
    return user_id in ADMIN_IDS

def verify_telegram_init_data(init_data: str, bot_token: str) -> bool:
    """
    Telegram WebApp initData verification (HMAC-SHA256).
    """
    try:
        if not init_data:
            return False

        # init_data is querystring: key=value&key2=value2...
        pairs = [p for p in init_data.split("&") if p]
        data = {}
        for p in pairs:
            if "=" not in p:
                continue
            k, v = p.split("=", 1)
            data[k] = v

        received_hash = data.pop("hash", None)
        if not received_hash:
            return False

        # Create data_check_string
        items = [f"{k}={data[k]}" for k in sorted(data.keys())]
        data_check_string = "\n".join(items)

        secret_key = hmac.new(
            key=b"WebAppData",
            msg=bot_token.encode("utf-8"),
            digestmod=hashlib.sha256
        ).digest()

        computed_hash = hmac.new(
            key=secret_key,
            msg=data_check_string.encode("utf-8"),
            digestmod=hashlib.sha256
        ).hexdigest()

        return hmac.compare_digest(computed_hash, received_hash)
    except Exception:
        return False

async def sb_exec(func):
    """
    Run blocking supabase calls in a thread to not block event loop.
    """
    return await asyncio.to_thread(func)

async def sb_select_one(table: str, **eq) -> Optional[Dict[str, Any]]:
    def _f():
        q = supabase.table(table).select("*")
        for k, v in eq.items():
            q = q.eq(k, v)
        r = q.limit(1).execute()
        return r.data[0] if r.data else None
    return await sb_exec(_f)

async def sb_select(table: str, limit: int = 1000, order: Optional[Tuple[str, bool]] = None, **eq) -> List[Dict[str, Any]]:
    def _f():
        q = supabase.table(table).select("*")
        for k, v in eq.items():
            q = q.eq(k, v)
        if order:
            col, desc = order
            q = q.order(col, desc=desc)
        r = q.limit(limit).execute()
        return r.data or []
    return await sb_exec(_f)

async def sb_insert(table: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    def _f():
        r = supabase.table(table).insert(payload).execute()
        return (r.data[0] if r.data else payload)
    return await sb_exec(_f)

async def sb_update(table: str, where: Dict[str, Any], payload: Dict[str, Any]) -> None:
    def _f():
        q = supabase.table(table).update(payload)
        for k, v in where.items():
            q = q.eq(k, v)
        q.execute()
    await sb_exec(_f)

async def sb_rpc(fn: str, params: Dict[str, Any]) -> Any:
    def _f():
        return supabase.rpc(fn, params).execute()
    return await sb_exec(_f)

# =========================
# DB LOGIC
# =========================

async def ensure_user(tg: types.User, referrer_id: Optional[int] = None) -> Dict[str, Any]:
    user = await sb_select_one(T_USERS, user_id=tg.id)
    payload = {
        "user_id": tg.id,
        "username": tg.username or "",
        "first_name": tg.first_name or "",
        "last_name": (tg.last_name or ""),
        "photo_url": "",  # filled from initData later if provided
        "last_seen_at": now_ts()
    }
    if not user:
        if referrer_id and referrer_id != tg.id:
            payload["referrer_id"] = referrer_id
        await sb_insert(T_USERS, payload)
        # balances row
        await sb_insert(T_BALANCES, {"user_id": tg.id})
        user = await sb_select_one(T_USERS, user_id=tg.id)
    else:
        # update basics & last seen
        upd = {
            "username": payload["username"],
            "first_name": payload["first_name"],
            "last_name": payload["last_name"],
            "last_seen_at": payload["last_seen_at"]
        }
        # keep existing referrer if already set
        await sb_update(T_USERS, {"user_id": tg.id}, upd)
        user = await sb_select_one(T_USERS, user_id=tg.id)
    return user or payload

async def get_balances(user_id: int) -> Dict[str, Any]:
    b = await sb_select_one(T_BALANCES, user_id=user_id)
    if not b:
        await sb_insert(T_BALANCES, {"user_id": user_id})
        b = await sb_select_one(T_BALANCES, user_id=user_id)
    return b or {"user_id": user_id, "rub_balance": 0, "stars_balance": 0}

async def add_rub(user_id: int, amount: float) -> None:
    # use RPC if exists
    try:
        await sb_rpc("add_rub", {"p_user": user_id, "p_amount": amount})
    except Exception:
        # fallback
        b = await get_balances(user_id)
        new_val = float(b.get("rub_balance") or 0) + float(amount)
        await sb_update(T_BALANCES, {"user_id": user_id}, {"rub_balance": new_val, "updated_at": now_ts()})

async def add_stars(user_id: int, amount: int) -> None:
    try:
        await sb_rpc("add_stars", {"p_user": user_id, "p_amount": amount})
    except Exception:
        b = await get_balances(user_id)
        new_val = int(b.get("stars_balance") or 0) + int(amount)
        await sb_update(T_BALANCES, {"user_id": user_id}, {"stars_balance": new_val, "updated_at": now_ts()})

async def log_payment(user_id: int, provider: str, status: str, amount_rub: Optional[float] = None,
                      amount_stars: Optional[int] = None, provider_ref: Optional[str] = None,
                      meta: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    payload = {
        "user_id": user_id,
        "provider": provider,
        "status": status,
        "amount_rub": amount_rub,
        "amount_stars": amount_stars,
        "provider_ref": provider_ref,
        "meta": meta or {}
    }
    return await sb_insert(T_PAYMENTS, payload)

async def mark_payment_paid(payment_id: str) -> None:
    await sb_update(T_PAYMENTS, {"id": payment_id}, {"status": "paid"})

async def reward_referrer(user_id: int, deposit_rub: float) -> None:
    u = await sb_select_one(T_USERS, user_id=user_id)
    if not u:
        return
    ref_id = u.get("referrer_id")
    if not ref_id:
        return
    bonus = round(float(deposit_rub) * REF_PERCENT, 2)
    if bonus <= 0:
        return
    await add_rub(int(ref_id), bonus)
    await log_payment(int(ref_id), "ref_bonus", "paid", amount_rub=bonus, meta={"from_user": user_id})

async def stats_add_topup(amount_rub: float) -> None:
    try:
        await sb_rpc("stats_add_topup", {"p_day": str(date.today()), "p_amount": amount_rub})
    except Exception:
        # fallback: upsert manually
        day = str(date.today())
        row = await sb_select_one(T_STATS, day=day)
        if not row:
            await sb_insert(T_STATS, {"day": day, "topups_rub": amount_rub, "revenue_rub": amount_rub})
        else:
            await sb_update(T_STATS, {"day": day}, {
                "topups_rub": float(row.get("topups_rub") or 0) + amount_rub,
                "revenue_rub": float(row.get("revenue_rub") or 0) + amount_rub,
            })

async def stats_add_payout(amount_rub: float) -> None:
    try:
        await sb_rpc("stats_add_payout", {"p_day": str(date.today()), "p_amount": amount_rub})
    except Exception:
        day = str(date.today())
        row = await sb_select_one(T_STATS, day=day)
        if not row:
            await sb_insert(T_STATS, {"day": day, "payouts_rub": amount_rub})
        else:
            await sb_update(T_STATS, {"day": day}, {
                "payouts_rub": float(row.get("payouts_rub") or 0) + amount_rub,
            })

# =========================
# ANTI-FRAUD: devices
# =========================

async def antifraud_register_device(user_id: int, device_hash: str, ip_hash: str = "", ua_hash: str = "") -> Tuple[bool, str]:
    device_hash = (device_hash or "").strip()
    if not device_hash or len(device_hash) < 6:
        return False, "device_hash missing"

    # upsert device row
    existing = await sb_select_one(T_USER_DEVICES, tg_user_id=user_id, device_hash=device_hash)
    if not existing:
        await sb_insert(T_USER_DEVICES, {
            "tg_user_id": user_id,
            "device_hash": device_hash,
            "first_seen_at": now_ts(),
            "last_seen_at": now_ts(),
            "ip_hash": ip_hash,
            "user_agent_hash": ua_hash
        })
    else:
        await sb_update(T_USER_DEVICES, {"id": existing["id"]}, {"last_seen_at": now_ts(), "ip_hash": ip_hash, "user_agent_hash": ua_hash})

    # count devices for user
    devices = await sb_select(T_USER_DEVICES, limit=2000, tg_user_id=user_id)
    unique_devices = {d.get("device_hash") for d in devices if d.get("device_hash")}
    if len(unique_devices) > MAX_DEVICES_PER_USER:
        return False, f"Too many devices for user (>{MAX_DEVICES_PER_USER})"

    # count users for device
    same_device = await sb_select(T_USER_DEVICES, limit=2000, device_hash=device_hash)
    unique_users = {int(d.get("tg_user_id")) for d in same_device if d.get("tg_user_id") is not None}
    if len(unique_users) > MAX_USERS_PER_DEVICE:
        return False, f"Too many accounts for device (>{MAX_USERS_PER_DEVICE})"

    return True, "ok"

# =========================
# LIMITS: ya/gm cooldown
# =========================

async def check_platform_limit(user_id: int, limit_key: str, cooldown_hours: int) -> Tuple[bool, int]:
    row = await sb_select_one(T_USER_LIMITS, user_id=user_id, limit_key=limit_key)
    if not row:
        return True, 0
    last_at = row.get("last_at")
    if not last_at:
        return True, 0
    try:
        last_dt = datetime.fromisoformat(last_at.replace("Z", "+00:00"))
    except Exception:
        return True, 0
    delta = datetime.now(timezone.utc) - last_dt
    remain = int(cooldown_hours * 3600 - delta.total_seconds())
    if remain > 0:
        return False, remain
    return True, 0

async def set_platform_limit_now(user_id: int, limit_key: str) -> None:
    row = await sb_select_one(T_USER_LIMITS, user_id=user_id, limit_key=limit_key)
    if not row:
        await sb_insert(T_USER_LIMITS, {"user_id": user_id, "limit_key": limit_key, "last_at": now_ts()})
    else:
        await sb_update(T_USER_LIMITS, {"user_id": user_id, "limit_key": limit_key}, {"last_at": now_ts()})

# =========================
# PUSH
# =========================

async def notify_admins(text: str) -> None:
    for aid in ADMIN_IDS:
        try:
            await bot.send_message(aid, text, parse_mode="HTML")
        except Exception:
            pass

async def push_to_user(user_id: int, text: str) -> None:
    try:
        u = await sb_select_one(T_USERS, user_id=user_id)
        if u and u.get("push_enabled") is False:
            return
        await bot.send_message(user_id, text, parse_mode="HTML")
    except Exception:
        pass

async def push_new_task(task: Dict[str, Any]) -> None:
    # Simple push to recent active users (last 7 days), limit 300 to avoid spam/cost.
    try:
        # Supabase python doesn't do "gte" easily via helper; we do raw:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
        def _f():
            r = supabase.table(T_USERS).select("user_id,last_seen_at,push_enabled").gte("last_seen_at", cutoff).limit(300).execute()
            return r.data or []
        users = await sb_exec(_f)
        msg = (
            "🆕 <b>Появилось новое задание!</b>\n"
            f"📌 {task.get('title','Задание')}\n"
            f"💰 Награда: {task.get('reward_rub')} ₽\n"
            "Открой Mini App → Задания."
        )
        for u in users:
            if u.get("push_enabled") is False:
                continue
            uid = int(u["user_id"])
            try:
                await bot.send_message(uid, msg, parse_mode="HTML")
            except Exception:
                continue
    except Exception as e:
        log.warning("push_new_task failed: %s", e)

# =========================
# TELEGRAM AUTO CHECK (channel/group)
# =========================

def normalize_tg_chat(chat: str) -> str:
    chat = (chat or "").strip()
    return chat

async def tg_check_membership(user_id: int, chat: str) -> Tuple[bool, str]:
    """
    Checks membership in a channel/group.
    IMPORTANT: For channels, bot must be admin to read members.
    """
    chat = normalize_tg_chat(chat)
    if not chat:
        return False, "tg_chat missing"
    try:
        member = await bot.get_chat_member(chat_id=chat, user_id=user_id)
        status = member.status
        # statuses: creator, administrator, member, restricted, left, kicked
        if status in ("creator", "administrator", "member", "restricted"):
            return True, status
        return False, status
    except Exception as e:
        return False, f"error: {e}"

# =========================
# UI: keyboards
# =========================

def kb_open_app() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[[KeyboardButton(text="📱 Открыть ReviewCash", web_app=WebAppInfo(url=WEBAPP_URL))]],
        resize_keyboard=True
    )

def kb_age_confirm() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="✅ Мне есть 18+", callback_data="age_yes")],
        [InlineKeyboardButton(text="🚫 Мне нет 18", callback_data="age_no")],
    ])

# =========================
# COMMANDS
# =========================

@dp.message(Command("start"))
async def cmd_start(message: types.Message):
    ref = parse_start_ref(message.text or "")
    await ensure_user(message.from_user, referrer_id=ref)

    text = (
        "👋 <b>Добро пожаловать в ReviewCash!</b>\n\n"
        "Здесь можно:\n"
        "• выполнять задания и получать ₽\n"
        "• продвигать свои каналы/бизнес через задания\n"
        "• выводить заработанное\n\n"
        "🔒 Важно: мы используем защиту от фрода (лимиты устройств).\n"
        "📌 Перед стартом подтверди возраст."
    )
    await message.answer(text, reply_markup=kb_open_app(), parse_mode="HTML")
    await message.answer("Подтверди, что тебе есть 18+ 👇", reply_markup=kb_age_confirm())

@dp.callback_query(F.data == "age_yes")
async def age_yes(call: types.CallbackQuery):
    await sb_update(T_USERS, {"user_id": call.from_user.id}, {"age_confirmed": True})
    await call.message.edit_text("✅ Отлично! Возраст подтверждён. Можно пользоваться приложением.")
    await call.answer()

@dp.callback_query(F.data == "age_no")
async def age_no(call: types.CallbackQuery):
    await sb_update(T_USERS, {"user_id": call.from_user.id}, {"age_confirmed": False, "is_banned": True})
    await call.message.edit_text("🚫 Доступ ограничен. Если ошибка — напиши в поддержку.")
    await call.answer()

# =========================
# STARS PAYMENTS
# =========================

@dp.pre_checkout_query()
async def pre_checkout(q: PreCheckoutQuery):
    await q.answer(ok=True)

@dp.message(F.successful_payment)
async def stars_paid(message: types.Message):
    stars = int(message.successful_payment.total_amount)  # XTR amount is in stars
    rub = round(stars * STAR_PRICE_RUB, 2)

    await add_stars(message.from_user.id, stars)
    await log_payment(message.from_user.id, "stars", "paid", amount_rub=rub, amount_stars=stars, provider_ref=message.successful_payment.provider_payment_charge_id)
    await stats_add_topup(rub)
    await reward_referrer(message.from_user.id, rub)

    await message.answer(f"⭐ Оплата прошла!\nНачислено: {stars} Stars (~{rub} ₽)")

# =========================
# CRYPTOBOT CHECK CALLBACK
# =========================

@dp.callback_query(F.data.startswith("chkcrypto:"))
async def cb_check_crypto(call: types.CallbackQuery):
    if not crypto:
        return await call.answer("CryptoBot отключён (нет токена).", show_alert=True)

    _, invoice_id, payment_id = call.data.split(":", 2)
    try:
        invs = await crypto.get_invoices(invoice_ids=int(invoice_id))
        inv = invs[0] if isinstance(invs, list) else invs
        if inv.status == "paid":
            pay = await sb_select_one(T_PAYMENTS, id=payment_id)
            if not pay:
                return await call.answer("Платёж не найден в БД.", show_alert=True)
            if pay.get("status") == "paid":
                return await call.answer("Уже зачислено.", show_alert=True)

            amount_rub = float(pay.get("amount_rub") or 0)
            await add_rub(call.from_user.id, amount_rub)
            await mark_payment_paid(payment_id)
            await stats_add_topup(amount_rub)
            await reward_referrer(call.from_user.id, amount_rub)

            await call.message.edit_text(f"✅ Оплата подтверждена!\nБаланс пополнен на {amount_rub} ₽")
        else:
            await call.answer(f"Статус: {inv.status}. Попробуй позже.", show_alert=True)
    except Exception as e:
        await call.answer(f"Ошибка проверки: {e}", show_alert=True)

# =========================
# WEBAPP DATA (from Mini App)
# =========================

@dp.message(F.web_app_data)
async def webapp_data(message: types.Message):
    try:
        data = json.loads(message.web_app_data.data)
    except Exception:
        return await message.answer("❌ Некорректные данные из приложения.")

    action = data.get("action")
    uid = message.from_user.id

    # 0) initData verification + device antifraud
    if action == "init":
        init_data = data.get("initData", "")
        device_hash = data.get("device_hash", "")
        ua = data.get("ua", "")
        ip = data.get("ip", "")  # can't trust, but ok for hashing

        if not verify_telegram_init_data(init_data, BOT_TOKEN):
            await message.answer("❌ Ошибка безопасности: initData подпись неверна.")
            return

        await ensure_user(message.from_user, referrer_id=None)

        ok, reason = await antifraud_register_device(
            uid,
            device_hash=device_hash,
            ip_hash=sha256_hex(ip) if ip else "",
            ua_hash=sha256_hex(ua) if ua else ""
        )
        if not ok:
            await sb_update(T_USERS, {"user_id": uid}, {"is_banned": True})
            await message.answer("🚫 Доступ ограничен (anti-fraud). Напиши в поддержку.")
            await notify_admins(f"🚨 <b>Anti-fraud блок</b>\nUser: <code>{uid}</code>\nПричина: {reason}")
            return

        # store photo_url if provided by miniapp user object
        photo_url = data.get("photo_url")
        if isinstance(photo_url, str) and photo_url.startswith("http"):
            await sb_update(T_USERS, {"user_id": uid}, {"photo_url": photo_url})

        await message.answer("✅ Подключено. Можно пользоваться приложением.")
        return

    # age check
    u = await sb_select_one(T_USERS, user_id=uid)
    if u and u.get("is_banned"):
        return await message.answer("🚫 Аккаунт заблокирован.")
    if u and not u.get("age_confirmed"):
        return await message.answer("⚠️ Сначала подтвердите возраст в /start.")

    # 1) Stars topup request
    if action == "pay_stars":
        amount_rub = float(data.get("amount", 0))
        stars = max(int(amount_rub / STAR_PRICE_RUB), 1)

        await bot.send_invoice(
            chat_id=message.chat.id,
            title="Пополнение баланса",
            description=f"Пополнение на {stars} Stars (~{amount_rub} ₽)",
            payload=f"stars_{stars}",
            currency="XTR",
            prices=[LabeledPrice(label="Stars", amount=stars)]
        )
        return

    # 2) Crypto topup request
    if action == "pay_crypto":
        if not crypto:
            return await message.answer("❌ CryptoBot не подключен (нет токена).")
        amount_rub = float(data.get("amount", 0))
        usdt = round(amount_rub / USDTRUB_RATE, 2)
        invoice = await crypto.create_invoice(asset="USDT", amount=usdt)

        pay_row = await log_payment(
            uid, "cryptobot", "pending",
            amount_rub=amount_rub,
            provider_ref=str(invoice.invoice_id),
            meta={"asset": "USDT", "amount": usdt}
        )

        kb = InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text="💎 Оплатить USDT", url=invoice.bot_invoice_url)],
            [InlineKeyboardButton(text="✅ Я оплатил", callback_data=f"chkcrypto:{invoice.invoice_id}:{pay_row.get('id')}")]
        ])
        await message.answer(
            f"💳 <b>Счёт создан</b>\nК оплате: {usdt} USDT (~{amount_rub} ₽)\n"
            "После оплаты нажмите «Я оплатил».",
            reply_markup=kb, parse_mode="HTML"
        )
        return

    # 3) TBank manual topup (pending)
    if action == "pay_tbank":
        amount = float(data.get("amount", 0))
        sender = data.get("sender", "Неизвестно")
        code = data.get("code", "---")

        pay_row = await log_payment(
            uid, "tbank", "pending",
            amount_rub=amount,
            provider_ref=str(code),
            meta={"sender": sender, "code": code}
        )
        await notify_admins(
            "💰 <b>T-Bank пополнение (pending)</b>\n"
            f"User: <code>{uid}</code> (@{message.from_user.username or '-'})\n"
            f"Сумма: <b>{amount} ₽</b>\nОт: <b>{sender}</b>\nКод: <code>{code}</code>\n\n"
            f"✅ /tbank_ok {pay_row.get('id')}\n"
            f"❌ /tbank_no {pay_row.get('id')}"
        )

        await message.answer(
            f"⏳ <b>Заявка принята</b>\n"
            f"Мы проверим поступление <b>{amount} ₽</b> (код <code>{code}</code>).\n"
            "Баланс обновится после проверки администратором.",
            parse_mode="HTML"
        )
        return

    # 4) Withdraw request
    if action == "withdraw_request":
        amount = float(data.get("amount", 0))
        details = (data.get("details") or "").strip()
        if amount <= 0 or not details:
            return await message.answer("❌ Заполните сумму и реквизиты.")

        bal = await get_balances(uid)
        if float(bal.get("rub_balance") or 0) < amount:
            return await message.answer("❌ Недостаточно средств.")

        # subtract immediately
        await add_rub(uid, -amount)

        w = await sb_insert(T_WITHDRAWALS, {
            "user_id": uid,
            "amount_rub": amount,
            "details": details,
            "status": "pending",
            "created_at": now_ts()
        })

        await stats_add_payout(0)  # no payout yet; real payout on approve
        await notify_admins(
            "📤 <b>Заявка на вывод</b>\n"
            f"ID: <code>{w.get('id')}</code>\n"
            f"User: <code>{uid}</code>\n"
            f"Сумма: <b>{amount} ₽</b>\n"
            f"Реквизиты: <code>{details}</code>\n\n"
            f"✅ /wd_ok {w.get('id')}\n"
            f"❌ /wd_no {w.get('id')}"
        )

        await message.answer(
            f"✅ <b>Заявка создана</b>\nСумма: <b>{amount} ₽</b>\nРеквизиты: <code>{details}</code>\n\nОжидайте обработки.",
            parse_mode="HTML"
        )
        return

    # 5) Create task (owner)
    if action == "create_task":
        # expects:
        # type: 'tg'|'ya'|'gm', title, target_url, instructions, reward_rub, qty_total,
        # tg_chat, tg_kind, check_type
        ttype = (data.get("type") or "").strip()
        title = (data.get("title") or "").strip() or "Задание"
        target_url = (data.get("target_url") or "").strip()
        instructions = (data.get("instructions") or "").strip()
        reward_rub = float(data.get("reward_rub") or 0)
        qty_total = int(data.get("qty_total") or 1)
        check_type = (data.get("check_type") or "manual").strip()

        tg_chat = (data.get("tg_chat") or "").strip()
        tg_kind = (data.get("tg_kind") or "").strip()

        if ttype not in ("tg", "ya", "gm"):
            return await message.answer("❌ Неверный тип задания.")
        if not target_url:
            return await message.answer("❌ Нужна ссылка.")
        if reward_rub <= 0:
            return await message.answer("❌ Награда должна быть > 0.")
        if qty_total < 1:
            return await message.answer("❌ Количество должно быть >= 1.")

        # cost model: owner pays reward * qty_total (simple)
        cost = round(reward_rub * qty_total, 2)
        bal = await get_balances(uid)
        if float(bal.get("rub_balance") or 0) < cost:
            return await message.answer(f"❌ Недостаточно средств. Нужно {cost} ₽")

        # for tg auto-check: require tg_chat
        if ttype == "tg" and check_type == "auto":
            if not tg_chat:
                return await message.answer("❌ Для TG авто-проверки нужен tg_chat (@channel или -100...)")
            if tg_kind not in ("channel", "group"):
                return await message.answer("❌ tg_kind должен быть channel или group")

        # debit owner
        await add_rub(uid, -cost)

        task = await sb_insert(T_TASKS, {
            "owner_id": uid,
            "type": ttype,
            "tg_chat": tg_chat,
            "tg_kind": tg_kind,
            "title": title,
            "target_url": target_url,
            "instructions": instructions,
            "reward_rub": reward_rub,
            "qty_total": qty_total,
            "qty_left": qty_total,
            "check_type": check_type,
            "status": "active",
            "created_at": now_ts()
        })

        await message.answer(f"✅ Задание создано!\nСписано: {cost} ₽\nID: {task.get('id')}")
        await notify_admins(f"🆕 <b>Новое задание</b>\n{title}\nID: <code>{task.get('id')}</code>\nНаграда: {reward_rub} ₽ × {qty_total}")
        asyncio.create_task(push_new_task(task))
        return

    # 6) Submit proof (manual reviews) OR auto-check request
    if action == "submit_task":
        # expects: task_id, proof_text(optional), proof_url(optional)
        task_id = (data.get("task_id") or "").strip()
        proof_text = (data.get("proof_text") or "").strip()
        proof_url = (data.get("proof_url") or "").strip()

        if not task_id:
            return await message.answer("❌ task_id пустой.")

        task = await sb_select_one(T_TASKS, id=task_id)
        if not task or task.get("status") != "active":
            return await message.answer("❌ Задание не найдено или не активно.")

        # qty check
        if int(task.get("qty_left") or 0) <= 0:
            return await message.answer("❌ Лимит выполнений по заданию исчерпан.")

        # ya/gm limits
        if task.get("type") == "ya":
            ok, remain = await check_platform_limit(uid, "ya_review", YA_COOLDOWN_HOURS)
            if not ok:
                hrs = max(1, int(remain // 3600))
                return await message.answer(f"⏳ Яндекс можно раз в 3 дня. Доступно через ~{hrs}ч.")
        if task.get("type") == "gm":
            ok, remain = await check_platform_limit(uid, "gm_review", GM_COOLDOWN_HOURS)
            if not ok:
                hrs = max(1, int(remain // 3600))
                return await message.answer(f"⏳ Google можно раз в день. Доступно через ~{hrs}ч.")

        # already completed?
        existing = await sb_select_one(T_COMPLETIONS, task_id=task_id, user_id=uid)
        if existing:
            return await message.answer("⚠️ Ты уже отправлял выполнение по этому заданию.")

        check_type = task.get("check_type")

        # TG auto-check (channel/group)
        if task.get("type") == "tg" and check_type == "auto":
            chat = task.get("tg_chat") or ""
            ok, status = await tg_check_membership(uid, chat)
            if not ok:
                return await message.answer(
                    "❌ Авто-проверка не прошла.\n"
                    f"Статус: {status}\n"
                    "Убедись, что ты подписался/вступил и попробуй снова."
                )

            # approve + pay immediately
            await sb_insert(T_COMPLETIONS, {
                "task_id": task_id,
                "user_id": uid,
                "status": "paid",
                "proof_text": "auto_check",
                "proof_url": None,
                "created_at": now_ts()
            })

            # decrement qty_left
            await sb_update(T_TASKS, {"id": task_id}, {"qty_left": int(task["qty_left"]) - 1})

            reward = float(task.get("reward_rub") or 0)
            await add_rub(uid, reward)
            await stats_add_payout(reward)

            await message.answer(f"✅ Выполнено и оплачено!\n+{reward} ₽")
            return

        # manual path
        row = await sb_insert(T_COMPLETIONS, {
            "task_id": task_id,
            "user_id": uid,
            "status": "pending",
            "proof_text": proof_text,
            "proof_url": proof_url,
            "created_at": now_ts()
        })

        await message.answer("✅ Отчёт отправлен на модерацию. Ожидай решения.")
        await notify_admins(
            "🕵️ <b>Новый отчёт на проверку</b>\n"
            f"Task: <code>{task_id}</code>\n"
            f"User: <code>{uid}</code>\n"
            f"ID: <code>{row.get('id')}</code>\n"
            f"Proof: {proof_text or '-'}\n{proof_url or ''}\n\n"
            f"✅ /proof_ok {row.get('id')}\n"
            f"❌ /proof_no {row.get('id')}"
        )

        # set platform limit when submitted
        if task.get("type") == "ya":
            await set_platform_limit_now(uid, "ya_review")
        if task.get("type") == "gm":
            await set_platform_limit_now(uid, "gm_review")

        return

    await message.answer("⚠️ Неизвестное действие из приложения.")

# =========================
# ADMIN COMMANDS (bot)
# =========================

@dp.message(Command("tbank_ok"))
async def admin_tbank_ok(message: types.Message):
    if not is_admin(message.from_user.id):
        return
    parts = message.text.split()
    if len(parts) < 2:
        return await message.answer("Usage: /tbank_ok <payment_id>")
    pid = parts[1].strip()
    pay = await sb_select_one(T_PAYMENTS, id=pid)
    if not pay:
        return await message.answer("Payment not found.")
    if pay.get("status") == "paid":
        return await message.answer("Already paid.")
    uid = int(pay["user_id"])
    amount = float(pay.get("amount_rub") or 0)
    await add_rub(uid, amount)
    await sb_update(T_PAYMENTS, {"id": pid}, {"status": "paid"})
    await stats_add_topup(amount)
    await reward_referrer(uid, amount)
    await message.answer(f"✅ OK. Credited {amount} ₽ to {uid}")
    await push_to_user(uid, f"✅ Пополнение подтверждено: +{amount} ₽")

@dp.message(Command("tbank_no"))
async def admin_tbank_no(message: types.Message):
    if not is_admin(message.from_user.id):
        return
    parts = message.text.split()
    if len(parts) < 2:
        return await message.answer("Usage: /tbank_no <payment_id>")
    pid = parts[1].strip()
    pay = await sb_select_one(T_PAYMENTS, id=pid)
    if not pay:
        return await message.answer("Payment not found.")
    await sb_update(T_PAYMENTS, {"id": pid}, {"status": "failed"})
    await message.answer("❌ Marked failed.")
    await push_to_user(int(pay["user_id"]), "❌ Пополнение отклонено администратором.")

@dp.message(Command("wd_ok"))
async def admin_wd_ok(message: types.Message):
    if not is_admin(message.from_user.id):
        return
    parts = message.text.split()
    if len(parts) < 2:
        return await message.answer("Usage: /wd_ok <withdrawal_id>")
    wid = parts[1].strip()
    w = await sb_select_one(T_WITHDRAWALS, id=wid)
    if not w:
        return await message.answer("Withdrawal not found.")
    if w.get("status") != "pending":
        return await message.answer("Not pending.")
    await sb_update(T_WITHDRAWALS, {"id": wid}, {"status": "paid"})
    amount = float(w.get("amount_rub") or 0)
    await stats_add_payout(amount)
    await message.answer("✅ Withdrawal marked PAID.")
    await push_to_user(int(w["user_id"]), f"✅ Выплата одобрена: {amount} ₽")

@dp.message(Command("wd_no"))
async def admin_wd_no(message: types.Message):
    if not is_admin(message.from_user.id):
        return
    parts = message.text.split()
    if len(parts) < 2:
        return await message.answer("Usage: /wd_no <withdrawal_id>")
    wid = parts[1].strip()
    w = await sb_select_one(T_WITHDRAWALS, id=wid)
    if not w:
        return await message.answer("Withdrawal not found.")
    if w.get("status") != "pending":
        return await message.answer("Not pending.")
    amount = float(w.get("amount_rub") or 0)
    uid = int(w["user_id"])
    # refund
    await add_rub(uid, amount)
    await sb_update(T_WITHDRAWALS, {"id": wid}, {"status": "rejected"})
    await message.answer("❌ Withdrawal rejected + refunded.")
    await push_to_user(uid, f"❌ Выплата отклонена. Средства возвращены: +{amount} ₽")

@dp.message(Command("proof_ok"))
async def admin_proof_ok(message: types.Message):
    if not is_admin(message.from_user.id):
        return
    parts = message.text.split()
    if len(parts) < 2:
        return await message.answer("Usage: /proof_ok <completion_id>")
    cid = parts[1].strip()
    c = await sb_select_one(T_COMPLETIONS, id=cid)
    if not c:
        return await message.answer("Completion not found.")
    if c.get("status") != "pending":
        return await message.answer("Not pending.")
    task = await sb_select_one(T_TASKS, id=c["task_id"])
    if not task:
        return await message.answer("Task not found.")
    if int(task.get("qty_left") or 0) <= 0:
        return await message.answer("Task qty is 0.")

    reward = float(task.get("reward_rub") or 0)
    uid = int(c["user_id"])

    await add_rub(uid, reward)
    await sb_update(T_COMPLETIONS, {"id": cid}, {"status": "paid"})
    await sb_update(T_TASKS, {"id": task["id"]}, {"qty_left": int(task["qty_left"]) - 1})
    await stats_add_payout(reward)

    await message.answer(f"✅ Approved + paid {reward} ₽ to {uid}")
    await push_to_user(uid, f"✅ Отчёт принят. Начислено: +{reward} ₽")

@dp.message(Command("proof_no"))
async def admin_proof_no(message: types.Message):
    if not is_admin(message.from_user.id):
        return
    parts = message.text.split()
    if len(parts) < 2:
        return await message.answer("Usage: /proof_no <completion_id>")
    cid = parts[1].strip()
    c = await sb_select_one(T_COMPLETIONS, id=cid)
    if not c:
        return await message.answer("Completion not found.")
    await sb_update(T_COMPLETIONS, {"id": cid}, {"status": "rejected"})
    await message.answer("❌ Rejected.")
    await push_to_user(int(c["user_id"]), "❌ Отчёт отклонён администратором.")

# =========================
# ADMIN WEB (aiohttp)
# =========================

def admin_auth(request: web.Request) -> bool:
    if not ADMIN_WEB_TOKEN:
        return False
    token = request.query.get("token", "")
    hdr = request.headers.get("x-admin-token", "")
    return token == ADMIN_WEB_TOKEN or hdr == ADMIN_WEB_TOKEN

async def http_health(request: web.Request):
    return web.Response(text="OK")

async def http_admin_home(request: web.Request):
    if not admin_auth(request):
        return web.Response(status=401, text="unauthorized")
    html = f"""
    <html><head><meta charset="utf-8"><title>ReviewCash Admin</title></head>
    <body style="font-family:Arial; padding:20px;">
      <h2>ReviewCash Admin</h2>
      <ul>
        <li><a href="/admin/payments?token={ADMIN_WEB_TOKEN}">Payments</a></li>
        <li><a href="/admin/withdrawals?token={ADMIN_WEB_TOKEN}">Withdrawals</a></li>
        <li><a href="/admin/proofs?token={ADMIN_WEB_TOKEN}">Task Proofs</a></li>
        <li><a href="/admin/stats?token={ADMIN_WEB_TOKEN}">Stats (table)</a></li>
        <li><a href="/admin/stats.json?token={ADMIN_WEB_TOKEN}">Stats JSON</a></li>
      </ul>
    </body></html>
    """
    return web.Response(text=html, content_type="text/html")

async def http_admin_payments(request: web.Request):
    if not admin_auth(request):
        return web.Response(status=401, text="unauthorized")
    rows = await sb_select(T_PAYMENTS, limit=200, order=("created_at", True))
    lines = []
    for p in rows:
        lines.append(f"<tr><td>{p.get('created_at')}</td><td>{p.get('provider')}</td><td>{p.get('status')}</td><td>{p.get('user_id')}</td><td>{p.get('amount_rub')}</td><td>{p.get('provider_ref')}</td></tr>")
    html = f"""
    <html><head><meta charset="utf-8"><title>Payments</title></head>
    <body style="font-family:Arial; padding:20px;">
      <h2>Payments</h2>
      <a href="/admin?token={ADMIN_WEB_TOKEN}">← back</a>
      <table border="1" cellpadding="6" cellspacing="0" style="margin-top:10px;">
        <tr><th>created</th><th>provider</th><th>status</th><th>user</th><th>amount_rub</th><th>ref</th></tr>
        {''.join(lines)}
      </table>
    </body></html>
    """
    return web.Response(text=html, content_type="text/html")

async def http_admin_withdrawals(request: web.Request):
    if not admin_auth(request):
        return web.Response(status=401, text="unauthorized")
    rows = await sb_select(T_WITHDRAWALS, limit=200, order=("created_at", True))
    lines = []
    for w in rows:
        lines.append(f"<tr><td>{w.get('created_at')}</td><td>{w.get('status')}</td><td>{w.get('user_id')}</td><td>{w.get('amount_rub')}</td><td>{w.get('details')}</td><td>{w.get('id')}</td></tr>")
    html = f"""
    <html><head><meta charset="utf-8"><title>Withdrawals</title></head>
    <body style="font-family:Arial; padding:20px;">
      <h2>Withdrawals</h2>
      <a href="/admin?token={ADMIN_WEB_TOKEN}">← back</a>
      <p>Approve/Reject делай пока через команды бота: <code>/wd_ok ID</code> или <code>/wd_no ID</code></p>
      <table border="1" cellpadding="6" cellspacing="0" style="margin-top:10px;">
        <tr><th>created</th><th>status</th><th>user</th><th>amount</th><th>details</th><th>id</th></tr>
        {''.join(lines)}
      </table>
    </body></html>
    """
    return web.Response(text=html, content_type="text/html")

async def http_admin_proofs(request: web.Request):
    if not admin_auth(request):
        return web.Response(status=401, text="unauthorized")
    rows = await sb_select(T_COMPLETIONS, limit=200, order=("created_at", True))
    lines = []
    for c in rows:
        lines.append(
            "<tr>"
            f"<td>{c.get('created_at')}</td>"
            f"<td>{c.get('status')}</td>"
            f"<td>{c.get('user_id')}</td>"
            f"<td>{c.get('task_id')}</td>"
            f"<td>{(c.get('proof_text') or '')[:80]}</td>"
            f"<td>{(c.get('proof_url') or '')[:80]}</td>"
            f"<td>{c.get('id')}</td>"
            "</tr>"
        )
    html = f"""
    <html><head><meta charset="utf-8"><title>Proofs</title></head>
    <body style="font-family:Arial; padding:20px;">
      <h2>Task Proofs</h2>
      <a href="/admin?token={ADMIN_WEB_TOKEN}">← back</a>
      <p>Approve/Reject через команды бота: <code>/proof_ok ID</code> или <code>/proof_no ID</code></p>
      <table border="1" cellpadding="6" cellspacing="0" style="margin-top:10px;">
        <tr><th>created</th><th>status</th><th>user</th><th>task</th><th>text</th><th>url</th><th>id</th></tr>
        {''.join(lines)}
      </table>
    </body></html>
    """
    return web.Response(text=html, content_type="text/html")

async def http_admin_stats(request: web.Request):
    if not admin_auth(request):
        return web.Response(status=401, text="unauthorized")
    rows = await sb_select(T_STATS, limit=120, order=("day", True))
    lines = []
    for s in rows:
        lines.append(f"<tr><td>{s.get('day')}</td><td>{s.get('topups_rub')}</td><td>{s.get('payouts_rub')}</td><td>{s.get('revenue_rub')}</td><td>{s.get('active_users')}</td></tr>")
    html = f"""
    <html><head><meta charset="utf-8"><title>Stats</title></head>
    <body style="font-family:Arial; padding:20px;">
      <h2>Stats Daily</h2>
      <a href="/admin?token={ADMIN_WEB_TOKEN}">← back</a>
      <table border="1" cellpadding="6" cellspacing="0" style="margin-top:10px;">
        <tr><th>day</th><th>topups</th><th>payouts</th><th>revenue</th><th>active_users</th></tr>
        {''.join(lines)}
      </table>
    </body></html>
    """
    return web.Response(text=html, content_type="text/html")

async def http_admin_stats_json(request: web.Request):
    if not admin_auth(request):
        return web.Response(status=401, text="unauthorized")
    rows = await sb_select(T_STATS, limit=60, order=("day", False))
    return web.json_response(rows)

# =========================
# MINIAPP API (optional but useful)
# Use initData in headers to auth:
#   x-init-data: <Telegram initData string>
# =========================

def get_init_data_from_request(request: web.Request) -> str:
    return request.headers.get("x-init-data", "") or request.query.get("initData", "")

async def api_auth_user(request: web.Request) -> Optional[int]:
    init_data = get_init_data_from_request(request)
    if not verify_telegram_init_data(init_data, BOT_TOKEN):
        return None
    # extract user from initDataUnsafe "user" json (urlencoded) -> we just parse "user=" param if exists
    # simplest: look for "user=" and json-decode it
    try:
        # initData is querystring, values are urlencoded
        from urllib.parse import parse_qs, unquote
        qs = parse_qs(init_data, keep_blank_values=True)
        user_raw = qs.get("user", [None])[0]
        if not user_raw:
            return None
        user_json = json.loads(unquote(user_raw))
        return int(user_json["id"])
    except Exception:
        return None

async def http_api_me(request: web.Request):
    uid = await api_auth_user(request)
    if not uid:
        return web.Response(status=401, text="unauthorized")
    u = await sb_select_one(T_USERS, user_id=uid)
    b = await get_balances(uid)
    return web.json_response({"user": u, "balances": b})

async def http_api_tasks(request: web.Request):
    uid = await api_auth_user(request)
    if not uid:
        return web.Response(status=401, text="unauthorized")
    rows = await sb_select(T_TASKS, limit=200, order=("created_at", True), status="active")
    return web.json_response(rows)

# =========================
# APP MAIN
# =========================

async def run_web():
    app = web.Application()
    app.router.add_get("/health", http_health)

    # admin web
    app.router.add_get("/admin", http_admin_home)
    app.router.add_get("/admin/payments", http_admin_payments)
    app.router.add_get("/admin/withdrawals", http_admin_withdrawals)
    app.router.add_get("/admin/proofs", http_admin_proofs)
    app.router.add_get("/admin/stats", http_admin_stats)
    app.router.add_get("/admin/stats.json", http_admin_stats_json)

    # miniapp api (optional)
    app.router.add_get("/api/me", http_api_me)
    app.router.add_get("/api/tasks", http_api_tasks)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", PORT)
    await site.start()
    log.info("HTTP server started on port %s", PORT)

async def main():
    await run_web()
    await bot.delete_webhook(drop_pending_updates=True)
    await dp.start_polling(bot)

if __name__ == "__main__":
    asyncio.run(main())
