import os
import asyncio
import logging
import json
from aiogram import Bot, Dispatcher, F, types
from aiogram.filters import Command
from aiogram.types import LabeledPrice, PreCheckoutQuery, InlineKeyboardButton, InlineKeyboardMarkup
from aiohttp import web
from supabase import create_client, Client
from aiocryptopay import AioCryptoPay, Networks # Исправленное название класса

# ================= КОНФИГУРАЦИЯ =================
BOT_TOKEN = "8312086729:AAHQ-cg8Pc_j52qVaf2a8H2RBf_Ol5MbuQQ"
WEBAPP_URL = "https://rapihappy.github.io/ReviewCashBot/"

# Переменные окружения
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")
CRYPTO_TOKEN = os.environ.get("CRYPTO_BOT_TOKEN")

STAR_PRICE_RUB = 1.5 

logging.basicConfig(level=logging.INFO)
bot = Bot(token=BOT_TOKEN)
dp = Dispatcher()

# Инициализация Supabase
supabase: Client = None
if SUPABASE_URL and SUPABASE_KEY:
    supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
    logging.info("✅ Supabase API подключен")

# Инициализация CryptoPay (с исправленным классом AioCryptoPay)
crypto = AioCryptoPay(
    token=CRYPTO_TOKEN, 
    network=Networks.MAIN_NET if CRYPTO_TOKEN and not "test" in CRYPTO_TOKEN.lower() else Networks.TEST_NET
)

# ================= РАБОТА С БАЗОЙ ДАННЫХ =================

async def get_or_create_user(user_id, username, first_name):
    if not supabase: return
    try:
        response = supabase.table("users").select("*").eq("user_id", user_id).execute()
        if not response.data:
            supabase.table("users").insert({
                "user_id": user_id,
                "username": username or "NoUsername",
                "first_name": first_name or "NoName",
                "balance_rub": 0,
                "balance_stars": 0
            }).execute()
            logging.info(f"🆕 Создан пользователь: {user_id}")
    except Exception as e:
        logging.error(f"Ошибка БД (get_user): {e}")

async def add_balance(user_id, amount, currency="RUB"):
    if not supabase: return
    try:
        response = supabase.table("users").select("*").eq("user_id", user_id).execute()
        if response.data:
            user = response.data[0]
            if currency == "RUB":
                new_val = float(user.get('balance_rub', 0)) + float(amount)
                supabase.table("users").update({"balance_rub": new_val}).eq("user_id", user_id).execute()
            elif currency == "STARS":
                new_val = int(user.get('balance_stars', 0)) + int(amount)
                supabase.table("users").update({"balance_stars": new_val}).eq("user_id", user_id).execute()
            logging.info(f"💰 Баланс +{amount} {currency} для {user_id}")
    except Exception as e:
        logging.error(f"Ошибка баланса: {e}")

# ================= ХЕНДЛЕРЫ БОТА =================

@dp.message(Command("start"))
async def start_cmd(message: types.Message):
    asyncio.create_task(get_or_create_user(message.from_user.id, message.from_user.username, message.from_user.first_name))
    
    markup = types.ReplyKeyboardMarkup(
        keyboard=[[types.KeyboardButton(text="📱 Открыть Приложение", web_app=types.WebAppInfo(url=WEBAPP_URL))]],
        resize_keyboard=True
    )
    await message.answer(f"Привет, {message.from_user.first_name}! Выбери способ пополнения в приложении.", reply_markup=markup)

@dp.message(F.web_app_data)
async def handle_webapp_data(message: types.Message):
    try:
        data = json.loads(message.web_app_data.data)
        action = data.get('action')
        amount_rub = float(data.get('amount', 0))

        if action == 'pay_stars':
            stars_count = max(int(amount_rub / STAR_PRICE_RUB), 1)
            await bot.send_invoice(
                chat_id=message.chat.id,
                title="Пополнение баланса",
                description=f"Пакет {stars_count} звезд",
                payload=f"stars_{stars_count}",
                currency="XTR",
                prices=[LabeledPrice(label="Stars", amount=stars_count)]
            )

        elif action == 'pay_crypto':
            amount_usdt = round(amount_rub / 95, 2) 
            invoice = await crypto.create_invoice(asset='USDT', amount=amount_usdt)
            
            kb = InlineKeyboardMarkup(inline_keyboard=[
                [InlineKeyboardButton(text="💎 Оплатить USDT", url=invoice.bot_invoice_url)],
                [InlineKeyboardButton(text="✅ Проверить оплату", callback_data=f"chk_{invoice.invoice_id}_{amount_rub}")]
            ])
            await message.answer(f"Счет на {amount_rub} руб. ({amount_usdt} USDT) через CryptoBot:", reply_markup=kb)

    except Exception as e:
        logging.error(f"Ошибка WebApp Data: {e}")

@dp.callback_query(F.data.startswith("chk_"))
async def check_crypto(callback: types.CallbackQuery):
    _, inv_id, amount = callback.data.split("_")
    invoices = await crypto.get_invoices(invoice_ids=int(inv_id))
    
    # В aiocryptopay может вернуться список, берем первый элемент
    inv = invoices[0] if isinstance(invoices, list) else invoices
    
    if inv and inv.status == 'paid':
        await add_balance(callback.from_user.id, float(amount), "RUB")
        await callback.message.edit_text(f"✅ Успешно! Зачислено {amount} руб.")
    else:
        await callback.answer("❌ Оплата не найдена или еще не обработана", show_alert=True)

@dp.pre_checkout_query()
async def pre_checkout(query: PreCheckoutQuery):
    await query.answer(ok=True)

@dp.message(F.successful_payment)
async def success_stars(message: types.Message):
    stars = message.successful_payment.total_amount
    await add_balance(message.from_user.id, stars, "STARS")
    await message.answer(f"⭐ Звезды ({stars}) начислены на ваш баланс!")

# ================= СЕРВЕР И ЗАПУСК =================

async def handle_ping(request):
    return web.Response(text="Bot Alive", status=200)

async def main():
    app = web.Application()
    app.router.add_get("/", handle_ping)
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, '0.0.0.0', int(os.environ.get("PORT", 8080))).start()

    await bot.delete_webhook(drop_pending_updates=True)
    await dp.start_polling(bot)

if __name__ == "__main__":
    asyncio.run(main())
