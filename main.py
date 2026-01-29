import os
import asyncio
import logging
import json
import asyncpg
import aiohttp
from aiogram import Bot, Dispatcher, F, types
from aiogram.filters import Command
from aiogram.types import LabeledPrice, PreCheckoutQuery
from aiohttp import web

# ================= КОНФИГУРАЦИЯ =================
BOT_TOKEN = "8312086729:AAFNuJ5kfKhdsvYnlBns-7ug6FACR9KwedY"
CRYPTO_BOT_TOKEN = "523403:AAfde4Y1g0j4tOcAafdu78d4KJirmN2JQRT"
WEBAPP_URL = "https://rapihappy.github.io/ReviewCashBot/"
DB_URL = os.environ.get("DATABASE_URL") # Ссылка из настроек Render

STAR_PRICE_RUB = 1.5

logging.basicConfig(level=logging.INFO)
bot = Bot(token=BOT_TOKEN)
dp = Dispatcher()

# ================= БАЗА ДАННЫХ (Supabase) =================
async def init_db():
    conn = await asyncpg.connect(DB_URL)
    await conn.execute('''
        CREATE TABLE IF NOT EXISTS users (
            user_id BIGINT PRIMARY KEY,
            username TEXT,
            first_name TEXT,
            balance_rub REAL DEFAULT 0,
            balance_stars INTEGER DEFAULT 0,
            reg_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    await conn.close()

async def get_or_create_user(user_id, username, first_name):
    conn = await asyncpg.connect(DB_URL)
    user = await conn.fetchrow("SELECT * FROM users WHERE user_id = $1", user_id)
    if not user:
        await conn.execute(
            "INSERT INTO users (user_id, username, first_name) VALUES ($1, $2, $3)",
            user_id, username, first_name
        )
        user = await conn.fetchrow("SELECT * FROM users WHERE user_id = $1", user_id)
    await conn.close()
    return user

# ================= ВЕБ-СЕРВЕР =================
async def handle_ping(request):
    return web.Response(text="Бот в порядке!", status=200)

async def run_web_server():
    app = web.Application()
    app.router.add_get("/", handle_ping)
    runner = web.AppRunner(app)
    await runner.setup()
    port = int(os.environ.get("PORT", 8080))
    site = web.TCPSite(runner, '0.0.0.0', port)
    await site.start()
    logging.info(f"--- SERVER LIVE ON PORT {port} ---")

# ================= ХЕНДЛЕРЫ =================
@dp.message(Command("start"))
async def start(message: types.Message):
    # Регистрируем пользователя в Supabase
    await get_or_create_user(
        message.from_user.id, 
        message.from_user.username, 
        message.from_user.first_name
    )
    
    markup = types.ReplyKeyboardMarkup(
        keyboard=[[types.KeyboardButton(text="📱 Открыть Приложение", web_app=types.WebAppInfo(url=WEBAPP_URL))]],
        resize_keyboard=True
    )
    await message.answer(f"👋 Привет, {message.from_user.first_name}! Данные сохранены в облаке.", reply_markup=markup)

# ... (остальные хендлеры оплаты из прошлых сообщений можно добавить сюда) ...

async def main():
    await init_db()
    await run_web_server()
    logging.info("--- BOT STARTED ---")
    await dp.start_polling(bot)

if __name__ == "__main__":
    asyncio.run(main())
