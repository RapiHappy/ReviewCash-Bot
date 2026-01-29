import os
import asyncio
import logging
import json
import asyncpg
import aiohttp
import ssl
from aiogram import Bot, Dispatcher, F, types
from aiogram.filters import Command
from aiogram.types import LabeledPrice, PreCheckoutQuery
from aiohttp import web

# ================= КОНФИГУРАЦИЯ =================
BOT_TOKEN = "8312086729:AAHQ-cg8Pc_j52qVaf2a8H2RBf_Ol5MbuQQ"
DB_URL = os.environ.get("postgresql://postgres:Rayaz95195!@db.frnxihdfouxbuzodyiaq.supabase.co:6543/postgres?sslmode=require")
WEBAPP_URL = "https://rapihappy.github.io/ReviewCashBot/"

logging.basicConfig(level=logging.INFO)
bot = Bot(token=BOT_TOKEN)
dp = Dispatcher()

# Настройка SSL для обхода ошибок сертификатов в облаке
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

# ================= БАЗА ДАННЫХ =================
async def init_db():
    while True: # Цикл для повторных попыток при сбое сети
        try:
            conn = await asyncpg.connect(DB_URL, ssl=ctx)
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
            logging.info("--- СВЯЗЬ С SUPABASE УСТАНОВЛЕНА ---")
            break
        except Exception as e:
            logging.error(f"Ошибка БД (пробуем снова через 5 сек): {e}")
            await asyncio.sleep(5)

async def get_or_create_user(user_id, username, first_name):
    conn = await asyncpg.connect(DB_URL, ssl=ctx)
    try:
        user = await conn.fetchrow("SELECT * FROM users WHERE user_id = $1", user_id)
        if not user:
            await conn.execute(
                "INSERT INTO users (user_id, username, first_name) VALUES ($1, $2, $3)",
                user_id, username, first_name
            )
            user = await conn.fetchrow("SELECT * FROM users WHERE user_id = $1", user_id)
        return user
    finally:
        await conn.close()

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

# ================= ХЕНДЛЕРЫ =================
@dp.message(Command("start"))
async def start(message: types.Message):
    try:
        await get_or_create_user(message.from_user.id, message.from_user.username, message.from_user.first_name)
        markup = types.ReplyKeyboardMarkup(
            keyboard=[[types.KeyboardButton(text="📱 Открыть Приложение", web_app=types.WebAppInfo(url=WEBAPP_URL))]],
            resize_keyboard=True
        )
        await message.answer(f"👋 Привет! Твой профиль в облаке.", reply_markup=markup)
    except Exception as e:
        await message.answer("⚠️ Ошибка связи с базой. Но я работаю!")
        logging.error(f"Start error: {e}")

async def main():
    await run_web_server() # Сначала сервер, чтобы Render был доволен
    await init_db()        # Потом база
    await dp.start_polling(bot)

if __name__ == "__main__":
    asyncio.run(main())
