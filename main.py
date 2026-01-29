import asyncio
import logging
import json
import sqlite3
import aiohttp
from aiogram import Bot, Dispatcher, F, types
from aiogram.filters import Command
from aiogram.types import LabeledPrice, PreCheckoutQuery

# ================= КОНФИГУРАЦИЯ =================
# Твои токены (ОСТОРОЖНО, ОНИ СЕЙЧАС В ОТКРЫТОМ ДОСТУПЕ!)
BOT_TOKEN = "8312086729:AAHWC-7XDZDxb1d3fpApYeBsVWRaxR63OMg"
CRYPTO_BOT_TOKEN = "523403:AASSagT4q6GFFuxUKNEBhRbH8oVbEQrvjfn"

# Эту ссылку мы получим на следующем шаге (GitHub Pages)
# Пока оставь пустой или замени, когда создашь сайт
WEBAPP_URL = "https://твое_имя.github.io/reviewcash" 

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

def get_user(user_id):
    conn = sqlite3.connect('database.db')
    c = conn.cursor()
    c.execute("SELECT balance_rub, balance_stars FROM users WHERE user_id=?", (user_id,))
    res = c.fetchone()
    if not res:
        c.execute("INSERT INTO users (user_id) VALUES (?)", (user_id,))
        conn.commit()
        return (0, 0)
    conn.close()
    return res

def add_balance(user_id, amount, currency="RUB"):
    conn = sqlite3.connect('database.db')
    c = conn.cursor()
    if currency == "RUB":
        c.execute("UPDATE users SET balance_rub = balance_rub + ? WHERE user_id = ?", (amount, user_id))
    elif currency == "STARS":
        c.execute("UPDATE users SET balance_stars = balance_stars + ? WHERE user_id = ?", (amount, user_id))
    conn.commit()
    conn.close()

# ================= ХЕНДЛЕРЫ =================
@dp.message(Command("start"))
async def start(message: types.Message):
    get_user(message.from_user.id)
    markup = types.ReplyKeyboardMarkup(
        keyboard=[[types.KeyboardButton(text="📱 Открыть приложение", web_app=types.WebAppInfo(url=WEBAPP_URL))]],
        resize_keyboard=True
    )
    await message.answer("Привет! Открой приложение для заработка 👇", reply_markup=markup)

@dp.message(F.web_app_data)
async def handle_webapp_data(message: types.Message):
    try:
        data = json.loads(message.web_app_data.data)
        if data['action'] == 'pay_stars':
            amount_rub = float(data['amount'])
            stars_amount = int(amount_rub / STAR_PRICE_RUB)
            await bot.send_invoice(
                chat_id=message.chat.id,
                title="Пополнение баланса",
                description=f"Покупка {stars_amount} Stars",
                payload=f"topup_{stars_amount}",
                currency="XTR",
                prices=[LabeledPrice(label="Stars", amount=stars_amount)] 
            )
        elif data['action'] == 'pay_crypto':
            amount_rub = float(data['amount'])
            async with aiohttp.ClientSession() as session:
                url = "https://pay.crypt.bot/api/createInvoice"
                headers = {'Crypto-Pay-API-Token': CRYPTO_BOT_TOKEN}
                amount_usdt = amount_rub / 100 
                params = {
                    'asset': 'USDT',
                    'amount': str(round(amount_usdt, 2)),
                    'description': f'Пополнение на {amount_rub} RUB',
                    'payload': str(message.from_user.id)
                }
                async with session.get(url, headers=headers, params=params) as resp:
                    result = await resp.json()
                    if result['ok']:
                        await message.answer(f"🔗 Оплата ({round(amount_usdt, 2)} USDT):\n{result['result']['pay_url']}")
                    else:
                        await message.answer("Ошибка крипто-бота.")
        elif data['action'] == 'deposit' and data['method'] == 'T-Bank':
             # Просто уведомление, так как оплата была по ссылке/QR
             await message.answer(f"⏳ Заявка на пополнение {data['amount']}₽ через Т-Банк принята. Ожидайте зачисления.")

    except Exception as e:
        logging.error(e)

@dp.pre_checkout_query()
async def process_pre_checkout(pre_checkout_query: PreCheckoutQuery):
    await bot.answer_pre_checkout_query(pre_checkout_query.id, ok=True)

@dp.message(F.successful_payment)
async def process_successful_payment(message: types.Message):
    stars_paid = message.successful_payment.total_amount
    add_balance(message.from_user.id, stars_paid, "STARS")
    await message.answer(f"✅ Успешно! Начислено {stars_paid} ⭐")

async def main():
    init_db()
    await bot.delete_webhook(drop_pending_updates=True)
    await dp.start_polling(bot)

if __name__ == "__main__":
    asyncio.run(main())
