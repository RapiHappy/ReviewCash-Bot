import os
import json
import hmac
import hashlib
import asyncio
import time
from datetime import datetime, timezone, date
from urllib.parse import parse_qsl

from aiohttp import web

from aiogram import Bot, Dispatcher, F
from aiogram.types import (
    Message, WebAppInfo, InlineKeyboardMarkup, InlineKeyboardButton,
    LabeledPrice, PreCheckoutQuery
)
from aiogram.filters import Command
from aiogram.webhook.aiohttp_server import SimpleRequestHandler, setup_application

from supabase import create_client
from postgrest.exceptions import APIError

# ----------------------------
# ENV
# ----------------------------
BOT_TOKEN = os.getenv("BOT_TOKEN")
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY")  # service_role key
WEBHOOK_URL = os.getenv("WEBHOOK_URL")  # https://your-service.onrender.com

ADMIN_IDS = [int(x) for x in (os.getenv("ADMIN_IDS", "").split(",") if os.getenv("ADMIN_IDS") else [])]
ADMIN_WEB_TOKEN = os.getenv("ADMIN_WEB_TOKEN", "change_me")

# Anti-fraud limits
MAX_DEVICES_PER_USER = int(os.getenv("MAX_DEVICES_PER_USER", "3"))
MAX_ACCOUNTS_PER_DEVICE = int(os.getenv("MAX_ACCOUNTS_PER_DEVICE", "2"))

# initData max age
INITDATA_MAX_AGE_SEC = int(os.getenv("INITDATA_MAX_AGE_SEC", "86400"))  # 24h

# CryptoBot (optional)
CRYPTO_PAY_TOKEN = os.getenv("CRYPTO_PAY_TOKEN")  # CryptoBot API token
CRYPTOBOT_WEBHOOK_SECRET = os.getenv("CRYPTOBOT_WEBHOOK_SECRET", "")  # optional

# Optional: broadcast new task
BROADCAST_NEW_TASK = os.getenv("BROADCAST_NEW_TASK", "0") == "1"

# Render port
PORT = int(os.getenv("PORT", "10000"))

if not BOT_TOKEN:
    raise RuntimeError("BOT_TOKEN is missing in env")
if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
    raise RuntimeError("SUPABASE_URL / SUPABASE_SERVICE_KEY are missing in env")

sb = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
bot = Bot(BOT_TOKEN)
dp = Dispatcher()

# ----------------------------
# Table names (as in your DB)
# ----------------------------
T_USERS = "users"
T_BAL = "balances"
T_TASKS = "tasks"
T_TC = "task_completions"
T_PAY = "payments"
T_WD = "withdrawals"
T_DEV = "user_devices"
T_LIM = "user_limits"
T_STATS = "stats_daily"

# ----------------------------
# Helpers: async wrapper around supabase sync client
# ----------------------------
async def sb_exec(func):
    return await asyncio.to_thread(func)

async def sb_select(table, where=None, limit=None, order=None, desc=False):
    def _f():
        q = sb.table(table).select("*")
        if where:
            for k, v in where.items():
                q = q.eq(k, v)
        if order:
            q = q.order(order, desc=desc)
        if limit:
            q = q.limit(limit)
        return q.execute()
    res = await sb_exec(_f)
    return res.data or []

async def sb_upsert(table, payload, on_conflict=None):
    def _f():
        q = sb.table(table).upsert(payload, on_conflict=on_conflict) if on_conflict else sb.table(table).upsert(payload)
        return q.execute()
    res = await sb_exec(_f)
    return res.data or []

async def sb_insert(table, payload):
    def _f():
        return sb.table(table).insert(payload).execute()
    res = await sb_exec(_f)
    return res.data or []

async def sb_update(table, where: dict, payload: dict):
    def _f():
        q = sb.table(table).update(payload)
        for k, v in where.items():
            q = q.eq(k, v)
        return q.execute()
    res = await sb_exec(_f)
    return res.data or []

async def sb_rpc(fn_name, params):
    def _f():
        return sb.rpc(fn_name, params).execute()
    res = await sb_exec(_f)
    return res.data

def now_ts():
    return datetime.now(timezone.utc)

# ----------------------------
# Telegram initData verification
# ----------------------------
def verify_init_data(init_data: str, bot_token: str, max_age_sec: int) -> dict:
    """
    Returns parsed dict with keys from initData (including 'user' as dict),
    raises ValueError on invalid signature / expired auth_date.
    """
    if not init_data:
        raise ValueError("empty initData")

    data = dict(parse_qsl(init_data, keep_blank_values=True))
    their_hash = data.pop("hash", None)
    if not their_hash:
        raise ValueError("no hash")

    # auth_date check
    auth_date = int(data.get("auth_date", "0"))
    if auth_date <= 0:
        raise ValueError("bad auth_date")
    if int(time.time()) - auth_date > max_age_sec:
        raise ValueError("initData expired")

    # build data_check_string
    pairs = [f"{k}={v}" for k, v in sorted(data.items())]
    data_check_string = "\n".join(pairs)

    secret_key = hashlib.sha256(bot_token.encode()).digest()
    calc_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()

    if not hmac.compare_digest(calc_hash, their_hash):
        raise ValueError("bad signature")

    # parse user json if exists
    if "user" in data:
        try:
            data["user"] = json.loads(data["user"])
        except Exception:
            data["user"] = None

    return data

def sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()

def is_admin(tg_id: int) -> bool:
    return tg_id in ADMIN_IDS

# ----------------------------
# Business logic: ensure user, anti-fraud devices
# ----------------------------
async def ensure_user(tg_user: dict, referrer_id: int | None = None):
    uid = int(tg_user["id"])
    # upsert user
    payload = {
        "user_id": uid,
        "username": tg_user.get("username"),
        "first_name": tg_user.get("first_name"),
        "last_name": tg_user.get("last_name"),
        "photo_url": tg_user.get("photo_url"),
        "last_seen_at": now_ts().isoformat(),
    }
    # set referrer only if not already set
    existing = await sb_select(T_USERS, {"user_id": uid}, limit=1)
    if existing:
        if referrer_id and not existing[0].get("referrer_id") and referrer_id != uid:
            payload["referrer_id"] = int(referrer_id)
    else:
        if referrer_id and referrer_id != uid:
            payload["referrer_id"] = int(referrer_id)

    await sb_upsert(T_USERS, payload, on_conflict="user_id")
    # ensure balances row exists
    await sb_upsert(T_BAL, {"user_id": uid}, on_conflict="user_id")

async def touch_device(uid: int, device_id: str | None, ip: str | None):
    if not device_id:
        return {"ok": True}

    dev_hash = sha256_hex(device_id)
    ip_hash = sha256_hex(ip) if ip else None

    # insert/update device
    existing = await sb_select(T_DEV, {"tg_user_id": uid, "device_hash": dev_hash}, limit=1)
    if existing:
        await sb_update(T_DEV, {"id": existing[0]["id"]}, {"last_seen_at": now_ts().isoformat(), "ip_hash": ip_hash})
    else:
        # anti-fraud checks
        # devices per user
        user_devs = await sb_select(T_DEV, {"tg_user_id": uid})
        if len(user_devs) >= MAX_DEVICES_PER_USER:
            return {"ok": False, "reason": f"device_limit_user:{MAX_DEVICES_PER_USER}"}

        # accounts per device
        dev_users = await sb_select(T_DEV, {"device_hash": dev_hash})
        uniq_users = {int(r["tg_user_id"]) for r in dev_users}
        if uid not in uniq_users and len(uniq_users) >= MAX_ACCOUNTS_PER_DEVICE:
            return {"ok": False, "reason": f"device_limit_accounts:{MAX_ACCOUNTS_PER_DEVICE}"}

        await sb_insert(T_DEV, {
            "tg_user_id": uid,
            "device_hash": dev_hash,
            "first_seen_at": now_ts().isoformat(),
            "last_seen_at": now_ts().isoformat(),
            "ip_hash": ip_hash
        })

    return {"ok": True}

# ----------------------------
# Limits helper (user_limits table)
# ----------------------------
LIMITS_MS = {
    "manual_3d": 3 * 24 * 60 * 60 * 1000,
    "manual_1d": 1 * 24 * 60 * 60 * 1000,
}

async def check_limit(uid: int, limit_key: str) -> tuple[bool, int]:
    rows = await sb_select(T_LIM, {"user_id": uid, "limit_key": limit_key}, limit=1)
    last = None
    if rows:
        last = rows[0].get("last_at")
    if not last:
        return True, 0

    # parse iso
    try:
        last_dt = datetime.fromisoformat(last.replace("Z", "+00:00"))
    except Exception:
        return True, 0

    diff_ms = int((now_ts() - last_dt).total_seconds() * 1000)
    wait_ms = LIMITS_MS.get(limit_key, 0)
    if wait_ms and diff_ms < wait_ms:
        return False, wait_ms - diff_ms
    return True, 0

async def set_limit(uid: int, limit_key: str):
    await sb_upsert(T_LIM, {"user_id": uid, "limit_key": limit_key, "last_at": now_ts().isoformat()},
                    on_conflict="user_id,limit_key")

# ----------------------------
# Stats helper
# ----------------------------
async def stats_add(day: date, topup=0, payout=0, revenue=0):
    day_s = day.isoformat()
    rows = await sb_select(T_STATS, {"day": day_s}, limit=1)
    if rows:
        row = rows[0]
        await sb_update(T_STATS, {"day": day_s}, {
            "topups_rub": float(row.get("topups_rub", 0)) + float(topup),
            "payouts_rub": float(row.get("payouts_rub", 0)) + float(payout),
            "revenue_rub": float(row.get("revenue_rub", 0)) + float(revenue),
        })
    else:
        await sb_insert(T_STATS, {
            "day": day_s,
            "topups_rub": float(topup),
            "payouts_rub": float(payout),
            "revenue_rub": float(revenue),
            "active_users": 0
        })

# ----------------------------
# Telegram: /start + новичок-инструкция + открыть MiniApp
# ----------------------------
START_TEXT = (
    "👋 Добро пожаловать в ReviewCash!\n\n"
    "📌 Здесь вы можете выполнять задания и получать вознаграждение.\n"
    "✅ Telegram-задания проверяются автоматически (канал/группа).\n"
    "📝 Остальные задания — через отправку доказательства и проверку админом.\n\n"
    "🔐 Важно: Mini App авторизуется через Telegram initData.\n"
    "Нажмите кнопку ниже, чтобы открыть приложение."
)

def kb_open_app():
    # ВАЖНО: сюда ставишь URL твоего MiniApp (hosted)
    app_url = os.getenv("MINIAPP_URL", "https://example.com")
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="🚀 Открыть приложение", web_app=WebAppInfo(url=app_url))],
    ])

@dp.message(Command("start"))
async def cmd_start(message: Message):
    ref = None
    try:
        parts = message.text.split()
        if len(parts) > 1:
            ref = int(parts[1])
    except Exception:
        ref = None

    await ensure_user(message.from_user.model_dump(), referrer_id=ref)
    await message.answer(START_TEXT, reply_markup=kb_open_app())

# ----------------------------
# WebApp -> bot: Telegram sends web_app_data
# (можешь использовать для простых действий, но лучше REST API ниже)
# ----------------------------
@dp.message(F.web_app_data)
async def on_webapp_data(message: Message):
    uid = message.from_user.id
    await ensure_user(message.from_user.model_dump())
    try:
        payload = json.loads(message.web_app_data.data)
    except Exception:
        return await message.answer("❌ Некорректные данные из приложения.")

    action = payload.get("action")
    if action == "withdraw_request":
        amount = float(payload.get("amount", 0))
        details = str(payload.get("details", "")).strip()
        if amount <= 0 or not details:
            return await message.answer("❌ Заполните сумму и реквизиты.")
        # списание делай на стороне backend API (а не на фронте)
        await message.answer("✅ Заявка принята. Обработка админом.")
        for a in ADMIN_IDS:
            await bot.send_message(a, f"🧾 Withdraw request от {uid}: {amount}₽\n{details}")
    elif action == "pay_tbank":
        await message.answer("✅ Принял подтверждение оплаты. Админ проверит.")
        for a in ADMIN_IDS:
            await bot.send_message(a, f"💳 T-Bank claim от {uid}: {payload}")
    else:
        await message.answer("ℹ️ Данные получены.")

# ----------------------------
# TG auto-check: channel/group membership
# ----------------------------
async def tg_check_member(user_id: int, chat: str) -> bool:
    """
    chat can be @username or -100...
    bot must be admin in that chat (at least can read members).
    """
    try:
        m = await bot.get_chat_member(chat_id=chat, user_id=user_id)
        # statuses: left/kicked/member/administrator/creator/restricted
        return m.status not in ("left", "kicked")
    except Exception:
        return False

# ----------------------------
# Stars payments
# ----------------------------
@dp.message(Command("topup_stars"))
async def cmd_topup_stars(message: Message):
    """
    Demo command: /topup_stars 100
    In production you trigger it from MiniApp via API.
    """
    try:
        amount_stars = int(message.text.split()[1])
    except Exception:
        return await message.answer("Использование: /topup_stars 100")

    if amount_stars < 1:
        return await message.answer("Минимум 1⭐")

    uid = message.from_user.id
    await ensure_user(message.from_user.model_dump())

    prices = [LabeledPrice(label="Top up", amount=amount_stars)]  # XTR uses stars units
    # For Stars: currency must be "XTR", provider_token empty
    await bot.send_invoice(
        chat_id=uid,
        title="Пополнение Stars",
        description="Пополнение баланса через Telegram Stars",
        payload=f"stars_topup:{uid}:{amount_stars}:{int(time.time())}",
        provider_token="",
        currency="XTR",
        prices=prices
    )

@dp.pre_checkout_query()
async def pre_checkout(pre: PreCheckoutQuery):
    await bot.answer_pre_checkout_query(pre.id, ok=True)

@dp.message(F.successful_payment)
async def on_success_payment(message: Message):
    uid = message.from_user.id
    sp = message.successful_payment
    if sp.currency == "XTR":
        # Stars amount is in total_amount (stars)
        stars = int(sp.total_amount)
        # record payment
        await sb_insert(T_PAY, {
            "user_id": uid,
            "provider": "stars",
            "status": "paid",
            "amount_stars": stars,
            "provider_ref": sp.telegram_payment_charge_id,
            "meta": {"payload": sp.invoice_payload}
        })
        # credit stars_balance
        bal = await sb_select(T_BAL, {"user_id": uid}, limit=1)
        cur = int(bal[0].get("stars_balance", 0)) if bal else 0
        await sb_upsert(T_BAL, {"user_id": uid, "stars_balance": cur + stars, "updated_at": now_ts().isoformat()},
                        on_conflict="user_id")
        await message.answer(f"✅ Пополнение: +{stars}⭐")

# ----------------------------
# Admin commands (minimal)
# ----------------------------
@dp.message(Command("admin"))
async def cmd_admin(message: Message):
    if not is_admin(message.from_user.id):
        return
    await message.answer("🛡️ Admin OK.\nAdmin-web: /admin (через браузер, token нужен)")

# ----------------------------
# AIOHTTP: admin-web + miniapp API + webhook endpoints
# ----------------------------
def require_admin_web(request: web.Request):
    auth = request.headers.get("Authorization", "")
    if auth == f"Bearer {ADMIN_WEB_TOKEN}":
        return True
    # allow token in query for quick test
    if request.query.get("token") == ADMIN_WEB_TOKEN:
        return True
    return False

async def handle_root(request):
    return web.Response(text="OK")

async def handle_admin_page(request):
    if not require_admin_web(request):
        return web.Response(status=401, text="Unauthorized")
    html = f"""
    <html><head><meta charset="utf-8"><title>Admin</title></head>
    <body style="font-family:Arial;padding:20px;">
      <h2>ReviewCash Admin</h2>
      <p>Use API:</p>
      <ul>
        <li>GET /admin/api/proofs</li>
        <li>GET /admin/api/withdrawals</li>
        <li>GET /admin/api/payments</li>
        <li>GET /admin/api/stats</li>
      </ul>
      <p>Auth: Authorization: Bearer {ADMIN_WEB_TOKEN}</p>
    </body></html>
    """
    return web.Response(text=html, content_type="text/html")

async def admin_api_proofs(request):
    if not require_admin_web(request):
        return web.Response(status=401)
    rows = await sb_select(T_TC, order="created_at", desc=True, limit=200)
    return web.json_response(rows)

async def admin_api_withdrawals(request):
    if not require_admin_web(request):
        return web.Response(status=401)
    rows = await sb_select(T_WD, order="created_at", desc=True, limit=200)
    return web.json_response(rows)

async def admin_api_payments(request):
    if not require_admin_web(request):
        return web.Response(status=401)
    rows = await sb_select(T_PAY, order="created_at", desc=True, limit=200)
    return web.json_response(rows)

async def admin_api_stats(request):
    if not require_admin_web(request):
        return web.Response(status=401)
    rows = await sb_select(T_STATS, order="day", desc=True, limit=60)
    return web.json_response(rows)

# ---- MiniApp REST API (recommended) ----
# Client sends initData in header: X-Tg-Init-Data
def get_initdata(request: web.Request) -> str:
    return request.headers.get("X-Tg-Init-Data", "")

async def auth_miniapp(request: web.Request):
    init_data = get_initdata(request)
    parsed = verify_init_data(init_data, BOT_TOKEN, INITDATA_MAX_AGE_SEC)
    tg_user = parsed.get("user")
    if not tg_user:
        raise web.HTTPUnauthorized(text="no user")
    uid = int(tg_user["id"])
    await ensure_user(tg_user)
    # anti-fraud device
    try:
        body = await request.json()
    except Exception:
        body = {}
    device_id = body.get("device_id")  # from miniapp
    ip = request.remote
    chk = await touch_device(uid, device_id, ip)
    if not chk.get("ok"):
        raise web.HTTPForbidden(text=f"anti-fraud: {chk.get('reason')}")
    return uid, tg_user, body

async def api_state(request):
    uid, tg_user, body = await auth_miniapp(request)
    bal = await sb_select(T_BAL, {"user_id": uid}, limit=1)
    tasks = await sb_select(T_TASKS, {"status": "active"}, order="created_at", desc=True, limit=50)
    return web.json_response({
        "user": tg_user,
        "balance": bal[0] if bal else {"user_id": uid, "rub_balance": 0, "stars_balance": 0},
        "tasks": tasks,
    })

async def api_create_task(request):
    uid, tg_user, body = await auth_miniapp(request)
    # create TG auto task OR manual task
    title = str(body.get("title", "")).strip() or "Task"
    target_url = str(body.get("target_url", "")).strip()
    instructions = str(body.get("instructions", "")).strip()
    reward_rub = float(body.get("reward_rub", 0))
    qty = int(body.get("qty", 1))

    ttype = str(body.get("type", "manual"))
    check_type = "manual"
    tg_chat = None
    tg_kind = None

    if ttype == "tg":
        tg_chat = str(body.get("tg_chat", "")).strip()
        tg_kind = str(body.get("tg_kind", "channel")).strip()
        check_type = "auto"
        if not tg_chat:
            raise web.HTTPBadRequest(text="tg_chat required")

    if not target_url:
        raise web.HTTPBadRequest(text="target_url required")
    if reward_rub <= 0:
        raise web.HTTPBadRequest(text="reward_rub must be > 0")
    if qty < 1:
        qty = 1

    # NOTE: billing/commission is your business logic. Here we just create task record.
    row = (await sb_insert(T_TASKS, {
        "owner_id": uid,
        "type": ttype,
        "tg_chat": tg_chat,
        "tg_kind": tg_kind,
        "title": title,
        "target_url": target_url,
        "instructions": instructions,
        "reward_rub": reward_rub,
        "qty_total": qty,
        "qty_left": qty,
        "check_type": check_type,
        "status": "active",
    }))[0]

    # admin push
    for a in ADMIN_IDS:
        try:
            await bot.send_message(a, f"🆕 New task: {title}\nby {uid}\n{target_url}")
        except Exception:
            pass

    return web.json_response({"ok": True, "task": row})

async def api_take_task(request):
    uid, tg_user, body = await auth_miniapp(request)
    task_id = body.get("task_id")
    if not task_id:
        raise web.HTTPBadRequest(text="task_id required")

    tasks = await sb_select(T_TASKS, {"id": task_id}, limit=1)
    if not tasks:
        raise web.HTTPNotFound(text="task not found")
    task = tasks[0]
    if task.get("status") != "active" or int(task.get("qty_left", 0)) <= 0:
        raise web.HTTPConflict(text="task closed")

    # if manual, you may want limits
    # Example: use limit_key from request (manual_3d/manual_1d)
    limit_key = body.get("limit_key")
    if limit_key in LIMITS_MS:
        ok, rem = await check_limit(uid, limit_key)
        if not ok:
            raise web.HTTPTooManyRequests(text=f"limit:{rem}")

    # create completion unique(task_id,user_id)
    try:
        await sb_insert(T_TC, {
            "task_id": task_id,
            "user_id": uid,
            "status": "pending"
        })
    except APIError as e:
        # already exists
        pass

    return web.json_response({"ok": True})

async def api_submit_proof(request):
    uid, tg_user, body = await auth_miniapp(request)
    task_id = body.get("task_id")
    proof_text = str(body.get("proof_text", "")).strip() or None
    proof_url = str(body.get("proof_url", "")).strip() or None
    if not task_id:
        raise web.HTTPBadRequest(text="task_id required")

    tasks = await sb_select(T_TASKS, {"id": task_id}, limit=1)
    if not tasks:
        raise web.HTTPNotFound(text="task not found")
    task = tasks[0]

    # TG auto-check
    if task.get("check_type") == "auto" and task.get("type") == "tg":
        chat = task.get("tg_chat")
        ok = await tg_check_member(uid, chat)
        if not ok:
            raise web.HTTPForbidden(text="not a member")
        # auto approve + pay
        await sb_update(T_TC, {"task_id": task_id, "user_id": uid}, {
            "status": "paid",
            "proof_text": "auto:member_ok",
            "proof_url": None
        })
        # pay reward
        bal = await sb_select(T_BAL, {"user_id": uid}, limit=1)
        cur = float(bal[0].get("rub_balance", 0)) if bal else 0.0
        reward = float(task.get("reward_rub", 0))
        await sb_upsert(T_BAL, {"user_id": uid, "rub_balance": cur + reward, "updated_at": now_ts().isoformat()},
                        on_conflict="user_id")
        # decrement qty_left
        qty_left = int(task.get("qty_left", 0))
        await sb_update(T_TASKS, {"id": task_id}, {"qty_left": max(0, qty_left - 1)})
        # stats payout
        await stats_add(date.today(), payout=reward)
        return web.json_response({"ok": True, "status": "paid", "reward": reward})

    # manual proof -> pending (admin approves)
    await sb_update(T_TC, {"task_id": task_id, "user_id": uid}, {
        "status": "pending",
        "proof_text": proof_text,
        "proof_url": proof_url
    })

    for a in ADMIN_IDS:
        try:
            await bot.send_message(a, f"📝 Proof pending: task={task_id}\nuser={uid}\n{proof_text or ''}\n{proof_url or ''}")
        except Exception:
            pass

    return web.json_response({"ok": True, "status": "pending"})

async def api_withdraw(request):
    uid, tg_user, body = await auth_miniapp(request)
    amount = float(body.get("amount_rub", 0))
    details = str(body.get("details", "")).strip()
    if amount <= 0 or not details:
        raise web.HTTPBadRequest(text="bad data")

    bal = await sb_select(T_BAL, {"user_id": uid}, limit=1)
    cur = float(bal[0].get("rub_balance", 0)) if bal else 0.0
    if amount > cur:
        raise web.HTTPForbidden(text="insufficient")

    await sb_upsert(T_BAL, {"user_id": uid, "rub_balance": cur - amount, "updated_at": now_ts().isoformat()},
                    on_conflict="user_id")

    row = (await sb_insert(T_WD, {
        "user_id": uid,
        "amount_rub": amount,
        "details": details,
        "status": "pending"
    }))[0]

    for a in ADMIN_IDS:
        try:
            await bot.send_message(a, f"🏦 Withdrawal pending: {amount}₽\nuser={uid}\n{details}\nid={row['id']}")
        except Exception:
            pass

    return web.json_response({"ok": True, "withdrawal": row})

# ----------------------------
# CryptoBot webhook (optional)
# ----------------------------
async def cryptobot_webhook(request):
    if not CRYPTO_PAY_TOKEN:
        return web.Response(status=404, text="Crypto disabled")

    body = await request.text()
    # optional secret verification if you configured it on CryptoBot side
    if CRYPTOBOT_WEBHOOK_SECRET:
        sig = request.headers.get("Crypto-Pay-Signature", "")
        calc = hmac.new(CRYPTOBOT_WEBHOOK_SECRET.encode(), body.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, calc):
            return web.Response(status=401, text="bad signature")

    data = json.loads(body)
    # Here you map invoice status -> credit balance.
    # Different CryptoBot payload formats exist; store raw meta.
    await sb_insert(T_PAY, {
        "user_id": int(data.get("payload", {}).get("user_id", 0)) if isinstance(data.get("payload"), dict) else 0,
        "provider": "cryptobot",
        "status": str(data.get("status", "paid")),
        "amount_rub": None,
        "provider_ref": str(data.get("invoice_id", "")),
        "meta": data
    })
    return web.Response(text="OK")

# ----------------------------
# Build aiohttp app + aiogram webhook
# ----------------------------
async def on_startup(app: web.Application):
    if WEBHOOK_URL:
        await bot.set_webhook(f"{WEBHOOK_URL}/telegram")
    else:
        # fallback to polling if no webhook url
        asyncio.create_task(dp.start_polling(bot))

async def on_shutdown(app: web.Application):
    try:
        await bot.delete_webhook(drop_pending_updates=False)
    except Exception:
        pass
    await bot.session.close()

def build_app() -> web.Application:
    app = web.Application()
    app.router.add_get("/", handle_root)
    app.router.add_head("/", handle_root)

    # admin web
    app.router.add_get("/admin", handle_admin_page)
    app.router.add_get("/admin/api/proofs", admin_api_proofs)
    app.router.add_get("/admin/api/withdrawals", admin_api_withdrawals)
    app.router.add_get("/admin/api/payments", admin_api_payments)
    app.router.add_get("/admin/api/stats", admin_api_stats)

    # miniapp api
    app.router.add_post("/api/state", api_state)
    app.router.add_post("/api/create_task", api_create_task)
    app.router.add_post("/api/take_task", api_take_task)
    app.router.add_post("/api/submit_proof", api_submit_proof)
    app.router.add_post("/api/withdraw", api_withdraw)

    # cryptobot webhook
    app.router.add_post("/cryptobot/webhook", cryptobot_webhook)

    # aiogram webhook handler
    SimpleRequestHandler(dispatcher=dp, bot=bot).register(app, path="/telegram")
    setup_application(app, dp, bot=bot)

    app.on_startup.append(on_startup)
    app.on_shutdown.append(on_shutdown)
    return app

if __name__ == "__main__":
    web.run_app(build_app(), host="0.0.0.0", port=PORT)
