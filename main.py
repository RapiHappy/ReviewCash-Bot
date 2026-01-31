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
# Убедитесь, что токены верные
BOT_TOKEN = os.environ.get("BOT_TOKEN", "8312086729:AAHpyu6GoHAxeq8-i8echHi9FVl5COGPF_M")
SUPABASE_URL = os.environ.get("SUPABASE_URL", "YOUR_SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "YOUR_SUPABASE_KEY")
CRYPTO_TOKEN = os.environ.get("CRYPTO_BOT_TOKEN", "YOUR_CRYPTO_TOKEN")

# ВАЖНО: Замените на ссылку вашего опубликованного Miniapp (из Miniapps.ai)
WEBAPP_URL = "https://cdn.miniapps.ai/..." 

STAR_PRICE_RUB = 1.5
REF_PERCENT = 0.05

# Ваш ID администратора
ADMINS = {6482440657}

logging.basicConfig(level=logging.INFO)

bot = Bot(BOT_TOKEN)
dp = Dispatcher()

# Инициализация клиентов
supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
crypto = AioCryptoPay(
    token=CRYPTO_TOKEN,
    network=Networks.MAIN_NET if CRYPTO_TOKEN and "test" not in CRYPTO_TOKEN.lower() else Networks.TEST_NET
)

# ========= БАЗА ДАННЫХ (ФУНКЦИИ) =========
async def get_user(user_id: int):
    r = supabase.table("users").select("*").eq("user_id", user_id).execute()
    return r.data[0] if r.data else None

async def create_user(user_id, username, first_name, referrer_id=None):
    # Проверка на существование
    existing = await get_user(user_id)
    if existing: return
    
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
    if not user: return
    
    if currency == "RUB":
        new_val = float(user["balance_rub"]) + amount
        supabase.table("users").update({"balance_rub": new_val}).eq("user_id", user_id).execute()
    else:
        new_val = int(user["balance_stars"]) + int(amount)
        supabase.table("users").update({"balance_stars": new_val}).eq("user_id", user_id).execute()

async def log_payment(user_id, p_type, amount, currency, details=None):
    data = {
        "user_id": user_id,
        "type": p_type,
        "amount": amount,
        "currency": currency
    }
    if details: data["details"] = details
    supabase.table("payments").insert(data).execute()

async def reward_referrer(user_id, deposit_rub):
    user = await get_user(user_id)
    ref_id = user.get("referrer_id")
    if not ref_id: return
    bonus = round(deposit_rub * REF_PERCENT, 2)
    await add_balance(ref_id, bonus, "RUB")
    await log_payment(ref_id, "ref_bonus", bonus, "RUB")

# ========= ОБРАБОТЧИКИ =========

@dp.message(Command("start"))
async def start_cmd(message: types.Message):
    args = message.text.split()
    ref_id = int(args[1]) if len(args) > 1 and args[1].isdigit() else None

    # Создаем юзера при старте
    await create_user(
        message.from_user.id,
        message.from_user.username,
        message.from_user.first_name,
        ref_id
    )

    kb = ReplyKeyboardMarkup(
        keyboard=[[KeyboardButton(text="📱 Открыть ReviewCash",
                                  web_app=WebAppInfo(url=WEBAPP_URL))]],
        resize_keyboard=True
    )

    await message.answer(
        "👋 <b>Добро пожаловать в ReviewCash!</b>\n\n"
        "Выполняй задания, продвигай свои соцсети и зарабатывай.\n"
        "Жми кнопку ниже, чтобы начать 👇",
        reply_markup=kb,
        parse_mode="HTML"
    )

# ========= ГЛАВНЫЙ ОБРАБОТЧИК ДАННЫХ ИЗ ПРИЛОЖЕНИЯ =========
@dp.message(F.web_app_data)
async def webapp_handler(message: types.Message):
    try:
        data = json.loads(message.web_app_data.data)
        action = data.get("action")
        user_id = message.from_user.id
        
        # 1. ОПЛАТА STARS
        if action == "pay_stars":
            amount_rub = float(data.get("amount", 0))
            stars = max(int(amount_rub / STAR_PRICE_RUB), 1)
            await bot.send_invoice(
                chat_id=message.chat.id,
                title="Пополнение баланса",
                description=f"Пополнение на {stars} Stars (~{amount_rub} RUB)",
                payload=f"stars_{stars}",
                currency="XTR",
                prices=[LabeledPrice(label="Stars", amount=stars)]
            )

        # 2. ОПЛАТА CRYPTO
        elif action == "pay_crypto":
            amount_rub = float(data.get("amount", 0))
            usdt = round(amount_rub / 95, 2) # Курс примерный
            invoice = await crypto.create_invoice(asset="USDT", amount=usdt)

            kb = InlineKeyboardMarkup(inline_keyboard=[
                [InlineKeyboardButton(text="💎 Оплатить USDT", url=invoice.bot_invoice_url)],
                [InlineKeyboardButton(text="✅ Я оплатил",
                                      callback_data=f"chk_{invoice.invoice_id}_{amount_rub}")]
            ])
            await message.answer(f"💳 <b>Счет создан</b>\nК оплате: {usdt} USDT ({amount_rub} RUB)", 
                                 reply_markup=kb, parse_mode="HTML")

        # 3. ОПЛАТА Т-БАНК (РУЧНАЯ)
        elif action == "pay_tbank":
            amount = float(data.get("amount", 0))
            sender = data.get("sender", "Неизвестно")
            code = data.get("code", "---")
            
            # Уведомляем админа
            for admin_id in ADMINS:
                try:
                    await bot.send_message(
                        admin_id,
                        f"💰 <b>Т-Банк Пополнение</b>\nUser: {user_id} (@{message.from_user.username})\n"
                        f"Сумма: {amount} RUB\nОт: {sender}\nКод: {code}"
                    )
                except: pass
            
            await message.answer(
                f"⏳ <b>Заявка принята!</b>\nМы проверим поступление {amount}₽ от {sender}.\n"
                f"Баланс обновится после проверки администратором.",
                parse_mode="HTML"
            )

        # 4. ЗАПРОС НА ВЫВОД (ИЗ ПРИЛОЖЕНИЯ)
        elif action == "withdraw_request":
            amount = float(data.get("amount", 0))
            details = data.get("details", "")

            user = await get_user(user_id)
            if not user or float(user["balance_rub"]) < amount:
                await message.answer("❌ Ошибка: Недостаточно средств на балансе для вывода.")
                return

            # Списываем баланс сразу
            await add_balance(user_id, -amount, "RUB")

            # Создаем запись в таблице withdraws
            supabase.table("withdraws").insert({
                "user_id": user_id,
                "amount": amount,
                "details": details,
                "status": "pending"
            }).execute()

            await log_payment(user_id, "withdraw_request", amount, "RUB", details)
            
            # Уведомляем админа
            for admin_id in ADMINS:
                try:
                    await bot.send_message(admin_id, f"📤 <b>Заявка на вывод!</b>\nUser: {user_id}\nСумма: {amount}\nРеквизиты: {details}")
                except: pass

            await message.answer(
                f"✅ <b>Заявка на вывод создана</b>\nСумма: {amount} ₽\nРеквизиты: {details}\n\nОжидайте зачисления.",
                parse_mode="HTML"
            )

    except Exception as e:
        logging.error(f"WebApp Error: {e}")
        await message.answer("Произошла ошибка обработки данных.")

# ========= Callback (Crypto) =========
@dp.callback_query(F.data.startswith("chk_"))
async def check_crypto(call: types.CallbackQuery):
    _, inv_id, amount_rub = call.data.split("_")
    try:
        invs = await crypto.get_invoices(invoice_ids=int(inv_id))
        inv = invs[0] if isinstance(invs, list) else invs # aiocryptopay может вернуть список
        
        if inv.status == "paid":
            amount_rub = float(amount_rub)
            # Проверяем, не оплачено ли уже (через payment log или статус)
            # Тут упрощенно: начисляем
            await add_balance(call.from_user.id, amount_rub, "RUB")
            await log_payment(call.from_user.id, "deposit_crypto", amount_rub, "RUB")
            await reward_referrer(call.from_user.id, amount_rub)
            
            await call.message.edit_text(f"✅ Успешно! Баланс пополнен на {amount_rub} RUB")
        else:
            await call.answer("Платеж еще не найден. Попробуйте через минуту.", show_alert=True)
    except Exception as e:
        await call.answer(f"Ошибка проверки: {e}", show_alert=True)

# ========= Оплата Stars =========
@dp.pre_checkout_query()
async def pre_checkout(q: PreCheckoutQuery):
    await q.answer(ok=True)

@dp.message(F.successful_payment)
async def stars_ok(message: types.Message):
    stars = message.successful_payment.total_amount
    rub = stars * STAR_PRICE_RUB
    
    await add_balance(message.from_user.id, stars, "STARS") # Храним звезды отдельно если надо
    # Или конвертируем в рубли: await add_balance(message.from_user.id, rub, "RUB")
    
    await log_payment(message.from_user.id, "deposit_stars", stars, "STARS")
    await reward_referrer(message.from_user.id, rub)
    
    await message.answer(f"⭐ Оплата прошла! Начислено {stars} Stars")

# ========= Админ команды =========
@dp.message(Command("withdraws"))
async def list_withdraws(message: types.Message):
    if message.from_user.id not in ADMINS: return
    rows = supabase.table("withdraws").select("*").eq("status", "pending").execute().data
    if not rows:
        await message.answer("Нет активных заявок.")
        return
    text = "📋 <b>Заявки на вывод:</b>\n\n"
    for w in rows:
        text += f"🆔 {w['id']} | 👤 {w['user_id']}\n💰 {w['amount']}₽ | 💳 {w['details']}\n👇 /w_done_{w['id']} или /w_reject_{w['id']}\n\n"
    await message.answer(text, parse_mode="HTML")

@dp.message(F.text.startswith("/w_done_"))
async def withdraw_done(message: types.Message):
    if message.from_user.id not in ADMINS: return
    wid = message.text.split("_")[2]
    supabase.table("withdraws").update({"status": "done"}).eq("id", wid).execute()
    await message.answer(f"✅ Заявка {wid} отмечена как выплаченная.")

@dp.message(F.text.startswith("/w_reject_"))
async def withdraw_reject(message: types.Message):
    if message.from_user.id not in ADMINS: return
    wid = message.text.split("_")[2]
    w = supabase.table("withdraws").select("*").eq("id", wid).execute().data[0]
    if w["status"] == "pending":
        await add_balance(w["user_id"], float(w["amount"]), "RUB") # Возврат средств
        supabase.table("withdraws").update({"status": "rejected"}).eq("id", wid).execute()
        await message.answer(f"❌ Заявка {wid} отклонена, средства возвращены юзеру.")

# ========= Веб-сервер =========
async def ping(request):
    return web.Response(text="Bot is ALIVE")

async def main():
    # Настройка Webhook или Polling
    # Если запускаете локально или на простом сервере - Polling
    # Если нужен веб-сервер для Keep-Alive (Render/Heroku):
    app = web.Application()
    app.router.add_get("/", ping)
    runner = web.AppRunner(app)
    await runner.setup()
    port = int(os.environ.get("PORT", 8080))
    await web.TCPSite(runner, "0.0.0.0", port).start()
    
    print(f"Бот запущен на порту {port}...")
    await bot.delete_webhook(drop_pending_updates=True)
    await dp.start_polling(bot)

if __name__ == "__main__":
    asyncio.run(main())
