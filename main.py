import os
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
BOT_TOKEN = "8312086729:AAHQ-cg8Pc_j52qVaf2a8H2RBf_Ol5MbuQQ"
CRYPTO_BOT_TOKEN = "523619:AA8kStzJyemJLPzeCiyXWkmYbiMdsWtqg6v"
WEBAPP_URL = "https://rapihappy.github.io/ReviewCashBot/"

STAR_PRICE_RUB = 1.5

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

# ================= ВЕБ-СЕРВЕР =================
async def handle_ping(request):
    return web.Response(text="OK", status=200)

async def run_web_server():
    app = web.Application()
    app.router.add_get("/", handle_ping)
    runner = web.AppRunner(app)
    await runner.setup()
    port = int(os.environ.get("PORT", 8080))
    site = web.TCPSite(runner, '0.0.0.0', port)
    await site.start()
    logging.info(f"--- WEB SERVER STARTED ON PORT {port} ---")

# ================= ХЕНДЛЕРЫ =================
@dp.message(Command("start"))
async def start(message: types.Message):
    markup = types.ReplyKeyboardMarkup(
        keyboard=[[types.KeyboardButton(text="📱 Открыть Приложение", web_app=types.WebAppInfo(url=WEBAPP_URL))]],
        resize_keyboard=True
    )
    await message.answer("👋 Привет! Нажми на кнопку ниже 👇", reply_markup=markup)

@dp.message(F.web_app_data)
async def handle_webapp_data(message: types.Message):
    try:
        data = json.loads(message.web_app_data.data)
        amount_rub = float(data.get('amount', 0))
        if data['action'] == 'pay_stars':
            stars_count = int(amount_rub / STAR_PRICE_RUB)
            await bot.send_invoice(
                chat_id=message.chat.id, title="Пополнение", description=f"{stars_count} Stars",
                payload=f"stars_{stars_count}", currency="XTR",
                prices=[LabeledPrice(label="Stars", amount=stars_count)]
            )
    except Exception as e:
        logging.error(f"Error: {e}")

@dp.pre_checkout_query()
async def pre_checkout(query: PreCheckoutQuery):
    await bot.answer_pre_checkout_query(query.id, ok=True)

# ================= ЗАПУСК =================
async def main():
    init_db()
    # 1. Сначала запускаем веб-сервер
    await run_web_server()
    # 2. Потом запускаем бота
    logging.info("--- BOT POLLING STARTED ---")
    await dp.start_polling(bot)

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (KeyboardInterrupt, SystemExit):
        logging.info("Bot stopped")
