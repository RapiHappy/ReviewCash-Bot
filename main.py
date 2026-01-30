import os
import asyncio
import logging
import json
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

# ========= НАСТРОЙКИ =========
BOT_TOKEN = os.environ.get("BOT_TOKEN", "8312086729:AAFCo7umh4toeSXrcGRrC4tMh9EaH2a6HeU")
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")
CRYPTO_TOKEN = os.environ.get("CRYPTO_BOT_TOKEN")

WEBAPP_URL = "https://rapihappy.github.io/ReviewCashBot/"
STAR_PRICE_RUB = 1.5
REF_PERCENT = 0.05

ADMINS = {6482440657}  # впиши свой Telegram user_id

logging.basicConfig(level=logging.INFO)

bot = Bot(BOT_TOKEN)
dp = Dispatcher()

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

crypto = AioCryptoPay(
    token=CRYPTO_TOKEN,
    network=Networks.MAIN_NET if CRYPTO_TOKEN and "test" not in CRYPTO_TOKEN.lower() else Networks.TEST_NET
)

# ========= БАЗА ДАННЫХ =========
async def get_user(user_id: int):
    r = supabase.table("users").select("*").eq("user_id", user_id).execute()
    return r.data[0] if r.data else None

async def create_user(user_id, username, first_name, referrer_id=None):
    supabase.table("users").insert({
        "user_id": user_id,
        "username": username or "",
        "first_name": first_name or "",
        "balance_rub": 0,
        "balance_stars": 0,
        "referrer_id": referrer_id
    }).execute()

async def add_balance(user_id, amount, currency="RUB"):
    user = await get_user(user_id)
    if currency == "RUB":
        new_val = float(user["balance_rub"]) + amount
        supabase.table("users").update({"balance_rub": new_val}).eq("user_id", user_id).execute()
    else:
        new_val = int(user["balance_stars"]) + int(amount)
        supabase.table("users").update({"balance_stars": new_val}).eq("user_id", user_id).execute()

async def log_payment(user_id, p_type, amount, currency):
    supabase.table("payments").insert({
        "user_id": user_id,
        "type": p_type,
        "amount": amount,
        "currency": currency
    }).execute()

async def reward_referrer(user_id, deposit_rub):
    user = await get_user(user_id)
    ref_id = user.get("referrer_id")
    if not ref_id:
        return
    bonus = round(deposit_rub * REF_PERCENT, 2)
    await add_balance(ref_id, bonus, "RUB")
    await log_payment(ref_id, "ref_bonus", bonus, "RUB")

# ========= /start и рефералы =========
@dp.message(Command("start"))
async def start_cmd(message: types.Message):
    args = message.text.split()
    ref_id = int(args[1]) if len(args) > 1 and args[1].isdigit() else None

    user = await get_user(message.from_user.id)
    if not user:
        if ref_id == message.from_user.id:
            ref_id = None
        await create_user(
            message.from_user.id,
            message.from_user.username,
            message.from_user.first_name,
            ref_id
        )

    kb = ReplyKeyboardMarkup(
        keyboard=[[KeyboardButton(text="📱 Открыть приложение",
                                  web_app=WebAppInfo(url=WEBAPP_URL))]],
        resize_keyboard=True
    )

    await message.answer(
        "👋 Добро пожаловать!\n\n"
        "Пополняй баланс и приглашай друзей.\n"
        "Ты получаешь 5% от каждого их пополнения 💸",
        reply_markup=kb
    )

# ========= Реферальная ссылка =========
@dp.message(Command("ref"))
async def ref_link(message: types.Message):
    me = await bot.get_me()
    link = f"https://t.me/{me.username}?start={message.from_user.id}"
    await message.answer(f"Твоя реферальная ссылка:\n{link}")

# ========= Баланс =========
@dp.message(Command("balance"))
async def balance(message: types.Message):
    user = await get_user(message.from_user.id)
    await message.answer(
        f"💰 RUB: {user['balance_rub']}\n"
        f"⭐ Stars: {user['balance_stars']}"
    )

# ========= Оплата из WebApp =========
@dp.message(F.web_app_data)
async def webapp_pay(message: types.Message):
    data = json.loads(message.web_app_data.data)
    action = data["action"]
    amount_rub = float(data["amount"])

    if action == "pay_stars":
        stars = max(int(amount_rub / STAR_PRICE_RUB), 1)
        await bot.send_invoice(
            chat_id=message.chat.id,
            title="Stars",
            description=f"{stars} звезд",
            payload=f"stars_{stars}",
            currency="XTR",
            prices=[LabeledPrice(label="Stars", amount=stars)]
        )

    elif action == "pay_crypto":
        usdt = round(amount_rub / 95, 2)
        invoice = await crypto.create_invoice(asset="USDT", amount=usdt)

        kb = InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text="💎 Оплатить", url=invoice.bot_invoice_url)],
            [InlineKeyboardButton(text="✅ Проверить оплату",
                                  callback_data=f"chk_{invoice.invoice_id}_{amount_rub}")]
        ])
        await message.answer(f"К оплате {amount_rub} RUB (~{usdt} USDT)", reply_markup=kb)

# ========= Проверка крипто оплаты =========
@dp.callback_query(F.data.startswith("chk_"))
async def check_crypto(call: types.CallbackQuery):
    _, inv_id, amount = call.data.split("_")
    invs = await crypto.get_invoices(invoice_ids=int(inv_id))
    inv = invs[0] if isinstance(invs, list) else invs

    if inv.status == "paid":
        amount = float(amount)
        await add_balance(call.from_user.id, amount, "RUB")
        await log_payment(call.from_user.id, "deposit_crypto", amount, "RUB")
        await reward_referrer(call.from_user.id, amount)
        await call.message.edit_text(f"✅ Оплачено +{amount} RUB")
    else:
        await call.answer("Не оплачено", show_alert=True)

# ========= Stars успешно =========
@dp.pre_checkout_query()
async def pre_checkout(q: PreCheckoutQuery):
    await q.answer(ok=True)

@dp.message(F.successful_payment)
async def stars_ok(message: types.Message):
    stars = message.successful_payment.total_amount
    rub = stars * STAR_PRICE_RUB

    await add_balance(message.from_user.id, stars, "STARS")
    await log_payment(message.from_user.id, "deposit_stars", stars, "STARS")
    await reward_referrer(message.from_user.id, rub)

    await message.answer(f"⭐ Зачислено {stars} Stars")

# ========= Вывод средств (заявка) =========
@dp.message(Command("withdraw"))
async def withdraw(message: types.Message):
    parts = message.text.split(maxsplit=2)
    if len(parts) < 3:
        await message.answer("Формат: /withdraw 100 РЕКВИЗИТЫ")
        return

    amount = float(parts[1])
    details = parts[2]

    user = await get_user(message.from_user.id)
    if user["balance_rub"] < amount:
        await message.answer("Недостаточно средств")
        return

    await add_balance(message.from_user.id, -amount, "RUB")

    supabase.table("withdraws").insert({
        "user_id": message.from_user.id,
        "amount": amount,
        "details": details,
        "status": "pending"
    }).execute()

    await log_payment(message.from_user.id, "withdraw_request", amount, "RUB")
    await message.answer("Заявка создана, ожидайте выплату администратора.")

# ========= Админ: список заявок =========
@dp.message(Command("withdraws"))
async def list_withdraws(message: types.Message):
    if message.from_user.id not in ADMINS:
        return

    rows = supabase.table("withdraws").select("*").eq("status", "pending").execute().data
    if not rows:
        await message.answer("Нет заявок.")
        return

    text = ""
    for w in rows:
        text += (
            f"ID: {w['id']}\n"
            f"User: {w['user_id']}\n"
            f"{w['amount']} RUB\n"
            f"{w['details']}\n\n"
        )
    await message.answer(text)

# ========= Админ: подтвердить выплату =========
@dp.message(Command("withdraw_done"))
async def withdraw_done(message: types.Message):
    if message.from_user.id not in ADMINS:
        return
    wid = message.text.split()[1]
    supabase.table("withdraws").update({"status": "done"}).eq("id", wid).execute()
    await message.answer("Отмечено как выплачено.")

# ========= Админ: отклонить и вернуть баланс =========
@dp.message(Command("withdraw_reject"))
async def withdraw_reject(message: types.Message):
    if message.from_user.id not in ADMINS:
        return
    wid = message.text.split()[1]

    w = supabase.table("withdraws").select("*").eq("id", wid).execute().data[0]
    if w["status"] != "pending":
        return

    await add_balance(w["user_id"], float(w["amount"]), "RUB")
    supabase.table("withdraws").update({"status": "rejected"}).eq("id", wid).execute()

    await message.answer("Заявка отклонена, деньги возвращены.")

# ========= Статистика админа =========
@dp.message(Command("stats"))
async def stats(message: types.Message):
    if message.from_user.id not in ADMINS:
        return

    users_count = supabase.table("users").select("user_id", count="exact").execute().count
    pays = supabase.table("payments").select("*").execute().data

    dep = sum(p["amount"] for p in pays if p["type"].startswith("deposit"))
    wdr = sum(p["amount"] for p in pays if p["type"].startswith("withdraw"))

    await message.answer(
        f"👥 Пользователей: {users_count}\n"
        f"💰 Пополнено: {dep}\n"
        f"📤 Запрошено на вывод: {wdr}"
    )

# ========= Топ рефералов =========
@dp.message(Command("toprefs"))
async def top_refs(message: types.Message):
    rows = supabase.table("payments").select("user_id,amount").eq("type", "ref_bonus").execute().data

    totals = {}
    for r in rows:
        totals[r["user_id"]] = totals.get(r["user_id"], 0) + r["amount"]

    top = sorted(totals.items(), key=lambda x: x[1], reverse=True)[:10]

    text = "🏆 Топ рефералов:\n"
    for i, (uid, total) in enumerate(top, 1):
        text += f"{i}. {uid} — {round(total,2)} RUB\n"

    await message.answer(text)

# ========= Веб-сервер для хостинга =========
async def ping(request):
    return web.Response(text="OK")

async def main():
    app = web.Application()
    app.router.add_get("/", ping)
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", int(os.environ.get("PORT", 8080))).start()

    await bot.delete_webhook(drop_pending_updates=True)
    await dp.start_polling(bot)

if __name__ == "__main__":
    asyncio.run(main())
