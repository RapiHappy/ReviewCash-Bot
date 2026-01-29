import asyncio
import logging
import json
import sqlite3
import aiohttp
from aiogram import Bot, Dispatcher, F, types
from aiogram.filters import Command
from aiogram.types import LabeledPrice, PreCheckoutQuery
from aiohttp import web

# ================= КОНФИГУРАЦИЯ =================
BOT_TOKEN = "8312086729:AAFNuJ5kfKhdsvYnlBns-7ug6FACR9KwedY"
CRYPTO_BOT_TOKEN = "523403:AAfde4Y1g0j4tOcAafdu78d4KJirmN2JQRT"
WEBAPP_URL = "https://rapihappy.github.io/ReviewCashBot/" 

STAR_PRICE_RUB = 1.5  # Курс: 1 звезда = 1.5 рубля

logging.basicConfig(level=logging.INFO)
bot = Bot(token=BOT_TOKEN)
dp = Dispatcher()

# ================= БАЗА ДАННЫХ =================
def init_db():
    conn = sqlite3.connect('database.db')
    c = conn.cursor()
    c.execute('''CREATE TABLE IF NOT EXISTS users 
                 (user_id INTEGER PRIMARY KEY, balance_rub REAL DEFAULT 0, balance_stars INTEGER DEFAULT 0)''')
    conn.commit()
    conn.close()

def add_balance(user_id, amount, currency="RUB"):
    conn = sqlite3.connect('database.db')
    c = conn.cursor()
    if currency == "RUB":
        c.execute("UPDATE users SET balance_rub = balance_rub + ? WHERE user_id = ?", (amount, user_id))
    elif currency == "STARS":
        c.execute("UPDATE users SET balance_stars = balance_stars + ? WHERE user_id = ?", (amount, user_id))
    conn.commit()
    conn.close()

# ================= ВЕБ-СЕРВЕР ДЛЯ UPTIMEROBOT =================
async def handle_ping(request):
    return web.Response(text="Бот в сети и готов к работе!")

# ================= ХЕНДЛЕРЫ БОТА =================
@dp.message(Command("start"))
async def start(message: types.Message):
    markup = types.ReplyKeyboardMarkup(
        keyboard=[[types.KeyboardButton(text="📱 Открыть Приложение", web_app=types.WebAppInfo(url=WEBAPP_URL))]],
        resize_keyboard=True
    )
    await message.answer(
        f"👋 Привет, {message.from_user.first_name}!\n\n"
        "Добро пожаловать в **ReviewCash**. Здесь ты можешь заказать продвижение или заработать на отзывах.\n\n"
        "Нажми кнопку ниже, чтобы войти в личный кабинет 👇",
        reply_markup=markup,
        parse_mode="Markdown"
    )

@dp.message(F.web_app_data)
async def handle_webapp_data(message: types.Message):
    try:
        data = json.loads(message.web_app_data.data)
        amount_rub = float(data.get('amount', 0))

        if data['action'] == 'pay_stars':
            stars_count = int(amount_rub / STAR_PRICE_RUB)
            await bot.send_invoice(
                chat_id=message.chat.id,
                title="Пополнение баланса",
                description=f"Покупка пакета: {stars_count} Stars",
                payload=f"stars_{stars_count}",
                currency="XTR",
                prices=[LabeledPrice(label="Stars", amount=stars_amount)]
            )

        elif data['action'] == 'pay_crypto':
            async with aiohttp.ClientSession() as session:
                headers = {'Crypto-Pay-API-Token': CRYPTO_BOT_TOKEN}
                # Конвертируем рубли в USDT (условно курс 100)
                amount_usdt = round(amount_rub / 100, 2)
                params = {
                    'asset': 'USDT',
                    'amount': str(amount_usdt),
                    'description': f'Пополнение счета {message.from_user.id}',
                    'payload': str(message.from_user.id)
                }
                async with session.get("https://pay.crypt.bot/api/createInvoice", headers=headers, params=params) as resp:
                    res = await resp.json()
                    if res['ok']:
                        await message.answer(f"💰 К оплате: **{amount_usdt} USDT**\n\nОплати по ссылке ниже 👇\n{res['result']['pay_url']}", parse_mode="Markdown")
                    else:
                        await message.answer("❌ Ошибка CryptoBot. Попробуйте позже.")

    except Exception as e:
        logging.error(f"Ошибка данных: {e}")

# --- ОБРАБОТКА STARS (ПЛАТЕЖИ) ---
@dp.pre_checkout_query()
async def pre_checkout(query: PreCheckoutQuery):
    await bot.answer_pre_checkout_query(query.id, ok=True)

@dp.message(F.successful_payment)
async def success_pay(message: types.Message):
    stars_count = message.successful_payment.total_amount
    add_balance(message.from_user.id, stars_count, "STARS")
    await message.answer(f"⭐ Успешно! Вы получили {stars_count} звезд на баланс.")

# ================= ЗАПУСК =================
async def main():
    init_db()
    
    # Настройка веб-сервера для пинга
    app = web.Application()
    app.router.add_get("/", handle_ping)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '0.0.0.0', 8080) # Порт для Render
    
    print("Бот запущен...")
    await asyncio.gather(
        site.start(),
        dp.start_polling(bot)
    )

if __name__ == "__main__":
    asyncio.run(main())
