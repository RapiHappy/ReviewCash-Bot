import os
import json
import hmac
import hashlib
import asyncio
import logging
from datetime import datetime, timezone, date
from urllib.parse import parse_qsl
from pathlib import Path

from aiohttp import web

from aiogram import Bot, Dispatcher, F
from aiogram.types import (
    Message,
    CallbackQuery,
    WebAppInfo,
    PreCheckoutQuery,
    LabeledPrice,
)
from aiogram.filters import CommandStart
from aiogram.utils.keyboard import InlineKeyboardBuilder

from supabase import create_client, Client

# CryptoBot
from aiocryptopay import AioCryptoPay, Networks

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("reviewcash")

# -------------------------
# ENV
# -------------------------
BOT_TOKEN = os.getenv("BOT_TOKEN")  # required
SUPABASE_URL = os.getenv("SUPABASE_URL")  # required
SUPABASE_SERVICE_ROLE = os.getenv("SUPABASE_SERVICE_ROLE")  # required

ADMIN_IDS = [int(x) for x in os.getenv("ADMIN_IDS", "").split(",") if x.strip().isdigit()]
ADMIN_WEB_SECRET = os.getenv("ADMIN_WEB_SECRET", "change-me")

BASE_URL = os.getenv("BASE_URL", "")  # e.g. https://reviewcash-bot.onrender.com  (DOMAIN)
PORT = int(os.getenv("PORT", "10000"))
USE_WEBHOOK = os.getenv("USE_WEBHOOK", "1") == "1"
WEBHOOK_PATH = os.getenv("WEBHOOK_PATH", "/tg/webhook")

# anti-fraud
MAX_ACCOUNTS_PER_DEVICE = int(os.getenv("MAX_ACCOUNTS_PER_DEVICE", "2"))

# limits
YA_COOLDOWN_SEC = int(os.getenv("YA_COOLDOWN_SEC", str(3 * 24 * 3600)))
GM_COOLDOWN_SEC = int(os.getenv("GM_COOLDOWN_SEC", str(1 * 24 * 3600)))

# topup minimum
MIN_TOPUP_RUB = float(os.getenv("MIN_TOPUP_RUB", "300"))

# Stars: how many RUB is 1 Star worth in your system (default: 1 RUB per Star)
STARS_RUB_RATE = float(os.getenv("STARS_RUB_RATE", "1.0"))

# CryptoBot
CRYPTO_PAY_TOKEN = os.getenv("CRYPTO_PAY_TOKEN", "")
CRYPTO_PAY_NETWORK = os.getenv("CRYPTO_PAY_NETWORK", "MAIN_NET")  # MAIN_NET / TEST_NET
CRYPTO_WEBHOOK_PATH = os.getenv("CRYPTO_WEBHOOK_PATH", "/cryptobot/webhook")

# simple conversion for invoice amount (RUB per 1 USDT), used only to build invoice amount
CRYPTO_RUB_PER_USDT = float(os.getenv("CRYPTO_RUB_PER_USDT", "100"))

# -------------------------
# sanity
# -------------------------
if not BOT_TOKEN:
    raise RuntimeError("BOT_TOKEN is missing in env")
if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE:
    raise RuntimeError("SUPABASE_URL / SUPABASE_SERVICE_ROLE is missing in env")

bot = Bot(BOT_TOKEN)
dp = Dispatcher()

sb: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE)

crypto = None
if CRYPTO_PAY_TOKEN:
    crypto = AioCryptoPay(
        token=CRYPTO_PAY_TOKEN,
        network=Networks.MAIN_NET if CRYPTO_PAY_NETWORK.upper().startswith("MAIN") else Networks.TEST_NET
    )

# -------------------------
# DB table names (match your Supabase)
# -------------------------
T_USERS = "users"
T_BAL = "balances"
T_TASKS = "tasks"
T_COMP = "task_completions"
T_DEV = "user_devices"
T_PAY = "payments"
T_WD = "withdrawals"
T_LIMITS = "user_limits"
T_STATS = "stats_daily"

# -------------------------
# helpers: supabase safe exec in thread
# -------------------------
async def sb_exec(fn):
    return await asyncio.to_thread(fn)

def _now():
    return datetime.now(timezone.utc)

def _day():
    return date.today()

async def sb_upsert(table: str, row: dict, on_conflict: str | None = None):
    def _f():
        q = sb.table(table).upsert(row, on_conflict=on_conflict)
        return q.execute()
    return await sb_exec(_f)

async def sb_insert(table: str, row: dict):
    def _f():
        return sb.table(table).insert(row).execute()
    return await sb_exec(_f)

async def sb_update(table: str, match: dict, updates: dict):
    def _f():
        q = sb.table(table).update(updates)
        for k, v in match.items():
            q = q.eq(k, v)
        return q.execute()
    return await sb_exec(_f)

async def sb_select(
    table: str,
    match: dict | None = None,
    columns: str = "*",
    limit: int | None = None,
    order: str | None = None,
    desc: bool = True
):
    def _f():
        q = sb.table(table).select(columns)
        if match:
            for k, v in match.items():
                q = q.eq(k, v)
        if order:
            q = q.order(order, desc=desc)
        if limit:
            q = q.limit(limit)
        return q.execute()
    return await sb_exec(_f)

# -------------------------
# Telegram initData verify
# -------------------------
def verify_init_data(init_data: str, token: str) -> dict | None:
    if not init_data:
        return None

    pairs = dict(parse_qsl(init_data, keep_blank_values=True))
    received_hash = pairs.pop("hash", None)
    if not received_hash:
        return None

    data_check_arr = [f"{k}={pairs[k]}" for k in sorted(pairs.keys())]
    data_check_string = "\n".join(data_check_arr)

    secret_key = hashlib.sha256(token.encode()).digest()
    calc_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()

    if not hmac.compare_digest(calc_hash, received_hash):
        return None

    if "user" in pairs:
        try:
            pairs["user"] = json.loads(pairs["user"])
        except Exception:
            pass

    return pairs

# -------------------------
# anti-fraud: device limits
# -------------------------
def sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()

async def anti_fraud_check_and_touch(user_id: int, device_hash: str, ip: str, user_agent: str):
    if not device_hash:
        return True, None

    ip_hash = sha256_hex(ip or "")
    ua_hash = sha256_hex(user_agent or "")

    await sb_upsert(T_DEV, {
        "tg_user_id": user_id,
        "device_hash": device_hash,
        "last_seen_at": _now().isoformat(),
        "ip_hash": ip_hash,
        "user_agent_hash": ua_hash
    }, on_conflict="tg_user_id,device_hash")

    def _f():
        return sb.table(T_DEV).select("tg_user_id").eq("device_hash", device_hash).execute()
    res = await sb_exec(_f)
    users = {row["tg_user_id"] for row in (res.data or []) if "tg_user_id" in row}

    if len(users) > MAX_ACCOUNTS_PER_DEVICE:
        await sb_update(T_USERS, {"user_id": user_id}, {"is_banned": True})
        return False, f"Слишком много аккаунтов на одном устройстве ({len(users)})."
    return True, None

# -------------------------
# users/balances
# -------------------------
async def ensure_user(user: dict, referrer_id: int | None = None):
    uid = int(user["id"])
    upd = {
        "user_id": uid,
        "username": user.get("username"),
        "first_name": user.get("first_name"),
        "last_name": user.get("last_name"),
        "photo_url": user.get("photo_url"),
        "last_seen_at": _now().isoformat(),
    }
    if referrer_id and referrer_id != uid:
        upd["referrer_id"] = referrer_id

    await sb_upsert(T_USERS, upd, on_conflict="user_id")
    await sb_upsert(T_BAL, {"user_id": uid}, on_conflict="user_id")

    u = await sb_select(T_USERS, {"user_id": uid}, limit=1)
    return (u.data or [upd])[0]

async def get_balance(uid: int):
    r = await sb_select(T_BAL, {"user_id": uid}, limit=1)
    if r.data:
        return r.data[0]
    return {"user_id": uid, "rub_balance": 0, "stars_balance": 0}

async def add_rub(uid: int, amount: float):
    bal = await get_balance(uid)
    new_val = float(bal.get("rub_balance") or 0) + float(amount)
    await sb_update(T_BAL, {"user_id": uid}, {"rub_balance": new_val, "updated_at": _now().isoformat()})
    return new_val

async def sub_rub(uid: int, amount: float) -> bool:
    bal = await get_balance(uid)
    cur = float(bal.get("rub_balance") or 0)
    if cur < float(amount):
        return False
    await sb_update(T_BAL, {"user_id": uid}, {"rub_balance": cur - float(amount), "updated_at": _now().isoformat()})
    return True

# -------------------------
# stats
# -------------------------
async def stats_add(field: str, amount: float):
    day = _day().isoformat()
    r = await sb_select(T_STATS, {"day": day}, limit=1)
    if r.data:
        cur = float(r.data[0].get(field) or 0)
        await sb_update(T_STATS, {"day": day}, {field: cur + float(amount)})
    else:
        row = {"day": day, "revenue_rub": 0, "payouts_rub": 0, "topups_rub": 0, "active_users": 0}
        row[field] = float(amount)
        await sb_insert(T_STATS, row)

# -------------------------
# limits (ya/gm cooldown)
# -------------------------
async def check_limit(uid: int, key: str, cooldown_sec: int):
    r = await sb_select(T_LIMITS, {"user_id": uid, "limit_key": key}, limit=1)
    last_at = None
    if r.data:
        last_at = r.data[0].get("last_at")
    if not last_at:
        return True, 0
    try:
        dt = datetime.fromisoformat(last_at.replace("Z", "+00:00"))
    except Exception:
        return True, 0
    diff = (_now() - dt).total_seconds()
    if diff < cooldown_sec:
        return False, int(cooldown_sec - diff)
    return True, 0

async def touch_limit(uid: int, key: str):
    await sb_upsert(
        T_LIMITS,
        {"user_id": uid, "limit_key": key, "last_at": _now().isoformat()},
        on_conflict="user_id,limit_key"
    )

# -------------------------
# Telegram auto-check: member status
# -------------------------
async def tg_is_member(chat: str, user_id: int) -> bool:
    try:
        cm = await bot.get_chat_member(chat_id=chat, user_id=user_id)
        status = getattr(cm, "status", None)
        return status in ("member", "administrator", "creator")
    except Exception as e:
        log.warning("get_chat_member failed: %s", e)
        return False

# -------------------------
# Push helpers
# -------------------------
async def notify_admin(text: str):
    for aid in ADMIN_IDS:
        try:
            await bot.send_message(aid, text)
        except Exception:
            pass

async def notify_user(uid: int, text: str):
    try:
        await bot.send_message(uid, text)
    except Exception:
        pass

# =========================================================
# WEB API (Mini App -> Bot backend)  (initData)
# =========================================================
def get_ip(req: web.Request) -> str:
    xff = req.headers.get("X-Forwarded-For", "")
    if xff:
        return xff.split(",")[0].strip()
    return req.remote or ""

async def require_init(req: web.Request) -> tuple[dict, dict]:
    init_data = req.headers.get("X-Tg-InitData", "")
    parsed = verify_init_data(init_data, BOT_TOKEN)
    if not parsed:
        raise web.HTTPUnauthorized(text="Bad initData")

    user = parsed.get("user") or {}
    if not user or "id" not in user:
        raise web.HTTPUnauthorized(text="No user in initData")

    return parsed, user

async def api_sync(req: web.Request):
    _, user = await require_init(req)
    body = await req.json()
    device_hash = (body.get("device_hash") or "").strip()
    ua = req.headers.get("User-Agent", "")
    ip = get_ip(req)

    ref = None
    if isinstance(body.get("referrer_id"), int):
        ref = body["referrer_id"]

    urow = await ensure_user(user, referrer_id=ref)

    ok, reason = await anti_fraud_check_and_touch(int(user["id"]), device_hash, ip, ua)
    if not ok:
        return web.json_response({"ok": False, "error": reason}, status=403)

    if urow.get("is_banned"):
        return web.json_response({"ok": False, "error": "Аккаунт заблокирован"}, status=403)

    bal = await get_balance(int(user["id"]))

    tasks = await sb_select(T_TASKS, {"status": "active"}, order="created_at", desc=True, limit=200)
    return web.json_response({
        "ok": True,
        "user": {
            "user_id": int(user["id"]),
            "username": user.get("username"),
            "first_name": user.get("first_name"),
            "last_name": user.get("last_name"),
            "photo_url": user.get("photo_url"),
        },
        "balance": bal,
        "tasks": tasks.data or [],
    })

async def api_task_create(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    body = await req.json()

    ttype = (body.get("type") or "").strip()  # tg|ya|gm
    title = (body.get("title") or "").strip()
    target_url = (body.get("target_url") or "").strip()
    instructions = (body.get("instructions") or "").strip()
    reward_rub = float(body.get("reward_rub") or 0)
    cost_rub = float(body.get("cost_rub") or 0)
    qty_total = int(body.get("qty_total") or 1)
    check_type = (body.get("check_type") or "manual").strip()
    tg_chat = (body.get("tg_chat") or "").strip() or None
    tg_kind = (body.get("tg_kind") or "").strip() or None

    if ttype not in ("tg", "ya", "gm"):
        raise web.HTTPBadRequest(text="Bad type")
    if not title or not target_url:
        raise web.HTTPBadRequest(text="Missing title/target_url")
    if reward_rub <= 0 or qty_total <= 0:
        raise web.HTTPBadRequest(text="Bad reward/qty")

    if cost_rub <= 0:
        cost_rub = reward_rub * qty_total * 2.0

    total_cost = cost_rub
    ok = await sub_rub(uid, total_cost)
    if not ok:
        return web.json_response({"ok": False, "error": f"Недостаточно RUB. Нужно {total_cost:.2f}"}, status=400)

    row = {
        "owner_id": uid,
        "type": ttype,
        "tg_chat": tg_chat,
        "tg_kind": tg_kind,
        "title": title,
        "target_url": target_url,
        "instructions": instructions,
        "reward_rub": reward_rub,
        "cost_rub": cost_rub,
        "qty_total": qty_total,
        "qty_left": qty_total,
        "check_type": check_type,
        "status": "active",
    }
    ins = await sb_insert(T_TASKS, row)
    task = (ins.data or [row])[0]

    await stats_add("revenue_rub", total_cost)
    await notify_admin(f"🆕 Новое задание: {title}\nТип: {ttype}\nНаграда: {reward_rub}₽ x{qty_total}\nOwner: {uid}")

    return web.json_response({"ok": True, "task": task})

async def api_task_submit(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    body = await req.json()

    task_id = (body.get("task_id") or "").strip()
    proof_text = (body.get("proof_text") or "").strip()
    proof_url = (body.get("proof_url") or "").strip() or None

    if not task_id:
        raise web.HTTPBadRequest(text="Missing task_id")

    t = await sb_select(T_TASKS, {"id": task_id}, limit=1)
    if not t.data:
        return web.json_response({"ok": False, "error": "Task not found"}, status=404)
    task = t.data[0]

    if task.get("status") != "active" or int(task.get("qty_left") or 0) <= 0:
        return web.json_response({"ok": False, "error": "Task closed"}, status=400)

    if task.get("type") == "ya":
        ok_lim, rem = await check_limit(uid, "ya_review", YA_COOLDOWN_SEC)
        if not ok_lim:
            return web.json_response({"ok": False, "error": f"Лимит: раз в 3 дня. Осталось ~{rem//3600}ч"}, status=400)
    if task.get("type") == "gm":
        ok_lim, rem = await check_limit(uid, "gm_review", GM_COOLDOWN_SEC)
        if not ok_lim:
            return web.json_response({"ok": False, "error": f"Лимит: раз в день. Осталось ~{rem//3600}ч"}, status=400)

    dup = await sb_select(T_COMP, {"task_id": task_id, "user_id": uid}, limit=1)
    if dup.data:
        return web.json_response({"ok": False, "error": "Уже отправляли выполнение"}, status=400)

    is_auto = (task.get("check_type") == "auto") and (task.get("type") == "tg")
    if is_auto:
        chat = task.get("tg_chat") or ""
        if not chat:
            return web.json_response({"ok": False, "error": "TG task misconfigured (no tg_chat)"}, status=400)

        ok_member = await tg_is_member(chat, uid)
        if not ok_member:
            return web.json_response({"ok": False, "error": "Бот не видит подписку/участие. Подпишись и попробуй снова."}, status=400)

        reward = float(task.get("reward_rub") or 0)
        await add_rub(uid, reward)
        await stats_add("payouts_rub", reward)

        await sb_update(T_TASKS, {"id": task_id}, {"qty_left": int(task["qty_left"]) - 1})

        await sb_insert(T_COMP, {
            "task_id": task_id,
            "user_id": uid,
            "status": "paid",
            "proof_text": "AUTO_TG_OK",
            "proof_url": None
        })

        return web.json_response({"ok": True, "status": "paid", "earned": reward})

    await sb_insert(T_COMP, {
        "task_id": task_id,
        "user_id": uid,
        "status": "pending",
        "proof_text": proof_text,
        "proof_url": proof_url
    })

    if task.get("type") == "ya":
        await touch_limit(uid, "ya_review")
    if task.get("type") == "gm":
        await touch_limit(uid, "gm_review")

    await notify_admin(f"🧾 Новый отчет на проверку\nTask: {task.get('title')}\nUser: {uid}\nTaskID: {task_id}")
    return web.json_response({"ok": True, "status": "pending"})

async def api_withdraw_create(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    body = await req.json()

    amount = float(body.get("amount_rub") or 0)
    details = (body.get("details") or "").strip()
    if amount < 300:
        return web.json_response({"ok": False, "error": "Минимум 300₽"}, status=400)
    if not details:
        return web.json_response({"ok": False, "error": "Укажи реквизиты"}, status=400)

    ok = await sub_rub(uid, amount)
    if not ok:
        return web.json_response({"ok": False, "error": "Недостаточно средств"}, status=400)

    wd = await sb_insert(T_WD, {
        "user_id": uid,
        "amount_rub": amount,
        "details": details,
        "status": "pending",
    })
    await notify_admin(f"🏦 Заявка на вывод: {amount}₽\nUser: {uid}\nID: {(wd.data or [{}])[0].get('id')}")
    return web.json_response({"ok": True, "withdrawal": (wd.data or [])[0] if wd.data else None})

async def api_withdraw_list(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    r = await sb_select(T_WD, {"user_id": uid}, order="created_at", desc=True, limit=100)
    return web.json_response({"ok": True, "withdrawals": r.data or []})

async def api_tbank_claim(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    body = await req.json()

    amount = float(body.get("amount_rub") or 0)
    sender = (body.get("sender") or "").strip()
    code = (body.get("code") or "").strip()

    if amount < MIN_TOPUP_RUB:
        return web.json_response({"ok": False, "error": f"Минимум {MIN_TOPUP_RUB:.0f}₽"}, status=400)
    if not sender or not code:
        return web.json_response({"ok": False, "error": "Нужно имя отправителя и код"}, status=400)

    row = await sb_insert(T_PAY, {
        "user_id": uid,
        "provider": "tbank",
        "status": "pending",
        "amount_rub": amount,
        "provider_ref": code,
        "meta": {"sender": sender}
    })

    pid = (row.data or [{}])[0].get("id")
    await notify_admin(f"💳 T-Bank: заявка на пополнение {amount}₽\nUser: {uid}\nCode: {code}\nPaymentID: {pid}")
    return web.json_response({"ok": True, "payment_id": pid})

async def api_cryptobot_create(req: web.Request):
    if not crypto:
        return web.json_response({"ok": False, "error": "CryptoBot not configured"}, status=500)

    _, user = await require_init(req)
    uid = int(user["id"])
    body = await req.json()

    amount = float(body.get("amount_rub") or 0)
    if amount < MIN_TOPUP_RUB:
        return web.json_response({"ok": False, "error": f"Минимум {MIN_TOPUP_RUB:.0f}₽"}, status=400)

    usdt = round(amount / CRYPTO_RUB_PER_USDT, 2)
    inv = await crypto.create_invoice(asset="USDT", amount=usdt, description=f"Topup {amount} RUB for {uid}")

    await sb_insert(T_PAY, {
        "user_id": uid,
        "provider": "cryptobot",
        "status": "pending",
        "amount_rub": amount,
        "provider_ref": str(inv.invoice_id),
        "meta": {"asset": "USDT", "amount_asset": usdt}
    })

    return web.json_response({"ok": True, "pay_url": inv.pay_url, "invoice_id": inv.invoice_id})

async def cryptobot_webhook(req: web.Request):
    if not crypto:
        return web.Response(text="no cryptobot", status=200)
    data = await req.json()

    try:
        update = data.get("update", {})
        inv = update.get("payload", {}) or update.get("invoice", {}) or update
        invoice_id = str(inv.get("invoice_id") or inv.get("id") or "")
        status = (inv.get("status") or "").lower()

        if not invoice_id:
            return web.Response(text="ok", status=200)

        pay = await sb_select(T_PAY, {"provider": "cryptobot", "provider_ref": invoice_id}, limit=1)
        if not pay.data:
            return web.Response(text="ok", status=200)

        prow = pay.data[0]
        if prow.get("status") == "paid":
            return web.Response(text="ok", status=200)

        if status in ("paid", "completed"):
            uid = int(prow["user_id"])
            amount = float(prow.get("amount_rub") or 0)
            await sb_update(T_PAY, {"id": prow["id"]}, {"status": "paid"})
            await add_rub(uid, amount)
            await stats_add("topups_rub", amount)
            await notify_user(uid, f"✅ Пополнение успешно: +{amount:.2f}₽")

        return web.Response(text="ok", status=200)
    except Exception as e:
        log.exception("cryptobot webhook error: %s", e)
        return web.Response(text="ok", status=200)

def _dt_key(v: str):
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0

async def api_ops_list(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])

    pays = await sb_select(T_PAY, {"user_id": uid}, order="created_at", desc=True, limit=200)
    wds = await sb_select(T_WD, {"user_id": uid}, order="created_at", desc=True, limit=200)

    ops = []
    for p in (pays.data or []):
        ops.append({
            "kind": "payment",
            "provider": p.get("provider"),
            "status": p.get("status"),
            "amount_rub": float(p.get("amount_rub") or 0),
            "created_at": p.get("created_at"),
            "id": p.get("id"),
        })

    for w in (wds.data or []):
        ops.append({
            "kind": "withdrawal",
            "status": w.get("status"),
            "amount_rub": float(w.get("amount_rub") or 0),
            "details": w.get("details"),
            "created_at": w.get("created_at"),
            "id": w.get("id"),
        })

    ops.sort(key=lambda x: _dt_key(x.get("created_at")), reverse=True)
    return web.json_response({"ok": True, "operations": ops})

@dp.message(CommandStart())
async def cmd_start(message: Message):
    uid = message.from_user.id
    args = (message.text or "").split(maxsplit=1)
    ref = None
    if len(args) == 2 and args[1].isdigit():
        ref = int(args[1])

    await ensure_user(message.from_user.model_dump(), referrer_id=ref)

    kb = InlineKeyboardBuilder()
    if BASE_URL:
        kb.button(text="🚀 Открыть приложение", web_app=WebAppInfo(url=BASE_URL.rstrip("/") + "/app/"))
    kb.button(text="📌 Инструкция новичку", callback_data="help_newbie")

    text = (
        "👋 Добро пожаловать в ReviewCash!\n\n"
        "Как это работает:\n"
        "1) Открываешь Mini App\n"
        "2) Выбираешь задание и выполняешь\n"
        "3) Отправляешь отчет (или авто-проверка TG)\n"
        "4) Получаешь ₽ на баланс\n"
        "5) Оформляешь вывод\n\n"
        "⚡ TG задания проверяются автоматически, если бот добавлен в чат и может проверять участников.\n"
        "🛡️ Anti-fraud: ограничение аккаунтов на устройство.\n"
    )
    await message.answer(text, reply_markup=kb.as_markup())

@dp.callback_query(F.data == "help_newbie")
async def cb_help(cq: CallbackQuery):
    await cq.answer()
    await cq.message.answer(
        "📌 Инструкция для новичков:\n\n"
        "• Перейди в «Задания» и нажми «Выполнить»\n"
        "• Если это TG задание — подпишись/вступи и нажми «Проверить»\n"
        "• Если это отзыв — прикрепи доказательства (скрин/ссылка) и отправь на проверку\n"
        "• В профиле можно пополнить и вывести средства\n\n"
        "Если что-то не работает — напиши в поддержку 🙂"
    )

@dp.pre_checkout_query()
async def on_pre_checkout_query(pre_checkout: PreCheckoutQuery):
    try:
        await bot.answer_pre_checkout_query(pre_checkout.id, ok=True)
    except Exception as e:
        log.warning("pre_checkout error: %s", e)

@dp.message(F.successful_payment)
async def on_successful_payment(message: Message):
    sp = message.successful_payment
    payload = sp.invoice_payload or ""
    uid = message.from_user.id

    if not payload.startswith("stars_topup:"):
        return

    try:
        pay = await sb_select(T_PAY, {"provider": "stars", "provider_ref": payload}, limit=1)
        if not pay.data:
            await message.answer("✅ Платеж получен, но запись не найдена. Напишите в поддержку.")
            return

        prow = pay.data[0]
        if prow.get("status") == "paid":
            return

        amount_rub = float(prow.get("amount_rub") or 0)
        await sb_update(T_PAY, {"id": prow["id"]}, {"status": "paid"})
        await add_rub(uid, amount_rub)
        await stats_add("topups_rub", amount_rub)
        await message.answer(f"✅ Пополнение Stars успешно: +{amount_rub:.2f}₽")
    except Exception as e:
        log.exception("successful_payment handle error: %s", e)

@dp.message(F.web_app_data)
async def on_webapp_data(message: Message):
    uid = message.from_user.id
    try:
        payload = json.loads(message.web_app_data.data)
    except Exception:
        return await message.answer("Некорректные данные из приложения.")

    action = payload.get("action")

    if action == "pay_tbank":
        amount = float(payload.get("amount") or 0)
        sender = (payload.get("sender") or "").strip()
        code = (payload.get("code") or "").strip()
        if amount < MIN_TOPUP_RUB or not sender or not code:
            return await message.answer("❌ Неверные данные для T-Bank.")
        await sb_insert(T_PAY, {
            "user_id": uid,
            "provider": "tbank",
            "status": "pending",
            "amount_rub": amount,
            "provider_ref": code,
            "meta": {"sender": sender}
        })
        await notify_admin(f"💳 T-Bank (через sendData): {amount}₽\nUser: {uid}\nCode: {code}\nSender: {sender}")
        return await message.answer("✅ Заявка на пополнение отправлена администратору.")

    if action == "pay_crypto":
        amount = float(payload.get("amount") or 0)
        if amount < MIN_TOPUP_RUB:
            return await message.answer(f"❌ Минимальная сумма пополнения — {MIN_TOPUP_RUB:.0f} ₽")

        if not crypto:
            return await message.answer("❌ CryptoBot не настроен. Включи CRYPTO_PAY_TOKEN.")

        usdt = round(amount / CRYPTO_RUB_PER_USDT, 2)
        inv = await crypto.create_invoice(asset="USDT", amount=usdt, description=f"Topup {amount} RUB for {uid}")

        await sb_insert(T_PAY, {
            "user_id": uid,
            "provider": "cryptobot",
            "status": "pending",
            "amount_rub": amount,
            "provider_ref": str(inv.invoice_id),
            "meta": {"asset": "USDT", "amount_asset": usdt}
        })

        return await message.answer(
            "✅ Счёт CryptoBot создан.\n\n"
            f"Сумма: {amount:.0f} ₽ (~{usdt} USDT)\n"
            f"Оплата: {inv.pay_url}\n\n"
            "После оплаты баланс обновится автоматически."
        )

    if action == "pay_stars":
        amount = float(payload.get("amount") or 0)
        if amount < MIN_TOPUP_RUB:
            return await message.answer(f"❌ Минимальная сумма пополнения — {MIN_TOPUP_RUB:.0f} ₽")

        stars = int(round(amount / STARS_RUB_RATE))
        if stars <= 0:
            stars = int(amount)

        payload_ref = f"stars_topup:{uid}:{amount:.2f}:{int(_now().timestamp())}"
        await sb_insert(T_PAY, {
            "user_id": uid,
            "provider": "stars",
            "status": "pending",
            "amount_rub": amount,
            "provider_ref": payload_ref,
            "meta": {"stars": stars, "stars_rub_rate": STARS_RUB_RATE}
        })

        prices = [LabeledPrice(label=f"Пополнение {amount:.0f} ₽", amount=stars)]
        try:
            await bot.send_invoice(
                chat_id=uid,
                title="Пополнение баланса",
                description=f"Пополнение баланса на {amount:.0f} ₽ (Stars)",
                payload=payload_ref,
                provider_token="",
                currency="XTR",
                prices=prices
            )
            return await message.answer("⭐ Счёт Stars отправлен. Оплати инвойс выше.")
        except Exception as e:
            log.exception("send_invoice Stars failed: %s", e)
            return await message.answer("❌ Не удалось создать инвойс Stars. Проверь, что бот может принимать Stars.")

    if action == "withdraw_request":
        amount = float(payload.get("amount") or 0)
        details = (payload.get("details") or "").strip()
        if amount < 300:
            return await message.answer("❌ Минимум 300₽")
        if not details:
            return await message.answer("❌ Укажи реквизиты")

        ok = await sub_rub(uid, amount)
        if not ok:
            return await message.answer("❌ Недостаточно средств")

        wd = await sb_insert(T_WD, {
            "user_id": uid,
            "amount_rub": amount,
            "details": details,
            "status": "pending",
        })
        await notify_admin(f"🏦 Заявка на вывод (sendData): {amount}₽\nUser: {uid}\nID: {(wd.data or [{}])[0].get('id')}")
        return await message.answer("✅ Заявка на вывод создана. Ожидайте обработки.")

    return await message.answer("✅ Данные получены.")

# =========================================================
# aiohttp app + webhook + static Mini App
# =========================================================
async def health(req: web.Request):
    return web.Response(text="OK")

async def tg_webhook(req: web.Request):
    update = await req.json()
    await dp.feed_webhook_update(bot, update)
    return web.Response(text="OK")

def make_app():
    app = web.Application()

    # Health endpoint at "/"
    app.router.add_get("/", health)

    # Static Mini App at /app/
    # Put files into ./public:
    #   public/index.html
    #   public/main.js
    #   public/styles.css
    base_dir = Path(__file__).resolve().parent
    static_dir = base_dir / "public"
    app.router.add_static("/app/", path=str(static_dir), show_index=True)

    # tg webhook
    app.router.add_post(WEBHOOK_PATH, tg_webhook)

    # public api for miniapp (initData)
    app.router.add_post("/api/sync", api_sync)
    app.router.add_post("/api/task/create", api_task_create)
    app.router.add_post("/api/task/submit", api_task_submit)
    app.router.add_post("/api/withdraw/create", api_withdraw_create)
    app.router.add_post("/api/withdraw/list", api_withdraw_list)

    app.router.add_post("/api/tbank/claim", api_tbank_claim)
    app.router.add_post("/api/pay/cryptobot/create", api_cryptobot_create)
    app.router.add_post("/api/ops/list", api_ops_list)

    # cryptobot webhook
    app.router.add_post(CRYPTO_WEBHOOK_PATH, cryptobot_webhook)

    return app

async def on_startup(app: web.Application):
    if USE_WEBHOOK and BASE_URL:
        wh_url = BASE_URL.rstrip("/") + WEBHOOK_PATH
        await bot.set_webhook(wh_url)
        log.info("Webhook set to %s", wh_url)
    else:
        asyncio.create_task(dp.start_polling(bot))
        log.info("Polling started")

async def on_cleanup(app: web.Application):
    if crypto:
        await crypto.close()
    await bot.session.close()

def main():
    app = make_app()
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    web.run_app(app, host="0.0.0.0", port=PORT)

if __name__ == "__main__":
    main()
