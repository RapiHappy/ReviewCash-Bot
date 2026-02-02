import os, asyncio, json, hmac, hashlib, time
from datetime import datetime, timedelta
from aiogram import Bot, Dispatcher, F
from aiogram.types import *
from aiogram.filters import Command
from supabase import create_client
from aiocryptopay import AioCryptoPay, Networks

# ========= CONFIG =========
BOT_TOKEN = os.getenv("BOT_TOKEN")
BOT_USERNAME = os.getenv("BOT_USERNAME")
ADMIN_IDS = list(map(int, os.getenv("ADMIN_IDS").split(",")))

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
CRYPTO_TOKEN = os.getenv("CRYPTOBOT_TOKEN")

STAR_PRICE = 1.5
REF_PERCENT = 0.05

bot = Bot(BOT_TOKEN)
dp = Dispatcher()
db = create_client(SUPABASE_URL, SUPABASE_KEY)

crypto = AioCryptoPay(
    token=CRYPTO_TOKEN,
    network=Networks.MAIN_NET
)

# ========= UTILS =========
def check_initdata(init_data: str) -> bool:
    secret = hashlib.sha256(BOT_TOKEN.encode()).digest()
    data_check = []
    hash_value = None
    for item in init_data.split("&"):
        k, v = item.split("=")
        if k == "hash":
            hash_value = v
        else:
            data_check.append(f"{k}={v}")
    data_check.sort()
    data_string = "\n".join(data_check)
    h = hmac.new(secret, data_string.encode(), hashlib.sha256).hexdigest()
    return h == hash_value

def miniapp_kb():
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(
            text="🚀 Открыть приложение",
            web_app=WebAppInfo(url=f"https://t.me/{BOT_USERNAME}/app")
        )]
    ])

# ========= TEXTS =========
WELCOME = """
👋 *Добро пожаловать в ReviewCash*

💰 Выполняй задания  
📈 Продвигай бизнес  
⚡ Получай выплаты в Telegram
"""

INSTR = """
📘 *Как заработать*

1️⃣ Открой приложение  
2️⃣ Выбери задание  
3️⃣ Выполни условия  
4️⃣ Получи деньги  

⚠️ Мультиаккаунты запрещены  
⚠️ Проверки автоматические и ручные
"""

# ========= START =========
@dp.message(Command("start"))
async def start(msg: Message):
    uid = msg.from_user.id
    user = db.table("users").select("*").eq("id", uid).execute().data

    if not user:
        db.table("users").insert({
            "id": uid,
            "username": msg.from_user.username
        }).execute()
        is_new = True
    else:
        is_new = user[0]["is_new"]

    await msg.answer(WELCOME, reply_markup=miniapp_kb(), parse_mode="Markdown")

    if is_new:
        await asyncio.sleep(1)
        await msg.answer(INSTR, parse_mode="Markdown")
        db.table("users").update({"is_new": False}).eq("id", uid).execute()

# ========= MINI APP DATA =========
@dp.message(F.web_app_data)
async def webapp(msg: Message):
    data = json.loads(msg.web_app_data.data)
    action = data.get("action")
    uid = msg.from_user.id

    # 🔐 initData check
    if not check_initdata(data.get("initData", "")):
        return await msg.answer("❌ Ошибка проверки Telegram")

    # ===== PAYMENTS =====
    if action == "pay_crypto":
        rub = float(data["amount"])
        usdt = round(rub / 95, 2)
        inv = await crypto.create_invoice("USDT", usdt)
        await msg.answer(
            f"💎 Оплата {usdt} USDT",
            reply_markup=InlineKeyboardMarkup(inline_keyboard=[
                [InlineKeyboardButton(text="Оплатить", url=inv.bot_invoice_url)]
            ])
        )

    # ===== WITHDRAW =====
    elif action == "withdraw":
        amount = float(data["amount"])
        user = db.table("users").select("balance").eq("id", uid).execute().data[0]

        if user["balance"] < amount:
            return await msg.answer("❌ Недостаточно средств")

        db.table("users").update({
            "balance": user["balance"] - amount
        }).eq("id", uid).execute()

        db.table("withdraws").insert({
            "user_id": uid,
            "amount": amount,
            "status": "pending"
        }).execute()

        for a in ADMIN_IDS:
            await bot.send_message(a, f"📤 Запрос на вывод {amount}₽ от {uid}")

        await msg.answer("✅ Заявка создана")

# ========= PUSH =========
async def push_new_task():
    users = db.table("users").select("id").execute().data
    for u in users:
        try:
            await bot.send_message(u["id"], "🔥 Появилось новое задание!")
        except:
            pass

# ========= ADMIN =========
@dp.message(Command("stats"))
async def stats(msg: Message):
    if msg.from_user.id not in ADMIN_IDS:
        return
    today = datetime.utcnow().date()
    row = db.table("stats_daily").select("*").eq("date", today).execute().data
    if not row:
        await msg.answer("Нет данных")
    else:
        r = row[0]
        await msg.answer(
            f"📊 Сегодня\nДоход: {r['income']}₽\nПользователи: {r['users']}"
        )

# ========= RUN =========
async def main():
    await bot.delete_webhook(drop_pending_updates=True)
    await dp.start_polling(bot)

if __name__ == "__main__":
    asyncio.run(main())
