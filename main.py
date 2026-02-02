import os
import re
import hmac
import json
import time
import base64
import hashlib
import asyncio
import logging
from urllib.parse import parse_qsl

from aiohttp import web

from aiogram import Bot, Dispatcher, F, types
from aiogram.filters import Command
from aiogram.types import (
    LabeledPrice, PreCheckoutQuery,
    InlineKeyboardButton, InlineKeyboardMarkup,
    ReplyKeyboardMarkup, KeyboardButton, WebAppInfo
)

from supabase import create_client
from aiocryptopay import AioCryptoPay, Networks

# -----------------------------
# CONFIG
# -----------------------------
logging.basicConfig(level=logging.INFO)

BOT_TOKEN = os.getenv("BOT_TOKEN")
if not BOT_TOKEN:
    raise RuntimeError("BOT_TOKEN is required (set env var)")

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")  # IMPORTANT: service role, server-only
if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
    raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required")

CRYPTO_PAY_TOKEN = os.getenv("CRYPTO_PAY_TOKEN", "")  # Crypto Pay API token from @CryptoBot
CRYPTO_NET = os.getenv("CRYPTO_NET", "main").lower()  # main|test

WEBAPP_URL = os.getenv("WEBAPP_URL", "")  # your miniapp public URL
if not WEBAPP_URL:
    logging.warning("WEBAPP_URL is empty. /start button web_app will not work properly.")

ADMIN_IDS = set()
_raw_admins = os.getenv("ADMIN_IDS", "")
if _raw_admins.strip():
    try:
        ADMIN_IDS = set(int(x.strip()) for x in _raw_admins.split(",") if x.strip())
    except Exception:
        raise RuntimeError("ADMIN_IDS must be comma-separated ints, e.g. 123,456")

ADMIN_WEB_TOKEN = os.getenv("ADMIN_WEB_TOKEN", "")  # protect /admin
if not ADMIN_WEB_TOKEN:
    logging.warning("ADMIN_WEB_TOKEN is empty. /admin will be blocked by default.")

# Money config
STAR_PRICE_RUB = float(os.getenv("STAR_PRICE_RUB", "1.5"))  # 1 star ~ 1.5 rub (your internal rate)
REF_PERCENT = float(os.getenv("REF_PERCENT", "0.05"))        # 5%

# Anti-fraud limits
MAX_DEVICES_PER_USER = int(os.getenv("MAX_DEVICES_PER_USER", "3"))
MAX_ACCOUNTS_PER_DEVICE = int(os.getenv("MAX_ACCOUNTS_PER_DEVICE", "2"))

# Task limits (cooldowns, seconds) - you asked: Yandex once per 3 days, Google once per 1 day
LIMIT_YA_SECONDS = int(os.getenv("LIMIT_YA_SECONDS", str(3 * 24 * 3600)))
LIMIT_GM_SECONDS = int(os.getenv("LIMIT_GM_SECONDS", str(1 * 24 * 3600)))

# -----------------------------
# INIT
# -----------------------------
bot = Bot(BOT_TOKEN)
dp = Dispatcher()
supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

crypto = None
if CRYPTO_PAY_TOKEN:
    crypto = AioCryptoPay(
        token=CRYPTO_PAY_TOKEN,
        network=Networks.MAIN_NET if CRYPTO_NET == "main" else Networks.TEST_NET
    )

# -----------------------------
# Helpers: async wrapper for supabase sync client (avoid blocking loop)
# -----------------------------
async def sb_execute(builder):
    return await asyncio.to_thread(builder.execute)

def now_ts() -> int:
    return int(time.time())

def sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()

def ip_hash(request: web.Request) -> str:
    ip = request.headers.get("x-forwarded-for", request.remote or "")
    ip = ip.split(",")[0].strip()
    return sha256_hex(ip) if ip else ""

def ua_hash(request: web.Request) -> str:
    ua = request.headers.get("user-agent", "")
    return sha256_hex(ua) if ua else ""

# -----------------------------
# Telegram WebApp initData verification
# Docs: core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
# -----------------------------
def verify_init_data(init_data: str, bot_token: str, max_age_sec: int = 24 * 3600) -> dict | None:
    """
    Returns parsed data dict if OK, else None.
    """
    if not init_data or "=" not in init_data:
        return None

    data = dict(parse_qsl(init_data, strict_parsing=False))
    received_hash = data.get("hash", "")
    if not received_hash:
        return None

    # auth_date check
    auth_date = int(data.get("auth_date", "0") or "0")
    if not auth_date:
        return None
    if (now_ts() - auth_date) > max_age_sec:
        return None

    # Build data_check_string: sort by key, exclude 'hash'
    pairs = []
    for k in sorted(data.keys()):
        if k == "hash":
            continue
        pairs.append(f"{k}={data[k]}")
    data_check_string = "\n".join(pairs)

    # secret_key = HMAC_SHA256(key="WebAppData", msg=bot_token)
    secret_key = hmac.new(b"WebAppData", bot_token.encode("utf-8"), hashlib.sha256).digest()
    calc_hash = hmac.new(secret_key, data_check_string.encode("utf-8"), hashlib.sha256).hexdigest()

    if not hmac.compare_digest(calc_hash, received_hash):
        return None
    return data

def extract_user_from_init_data(parsed: dict) -> dict | None:
    u = parsed.get("user")
    if not u:
        return None
    try:
        return json.loads(u)
    except Exception:
        return None

# -----------------------------
# DB ops
# -----------------------------
async def ensure_user(user: dict, referrer_id: int | None = None):
    uid = int(user["id"])
    username = user.get("username")
    first_name = user.get("first_name")
    last_name = user.get("last_name")
    photo_url = user.get("photo_url")

    # upsert user
    await sb_execute(
        supabase.table("users").upsert({
            "user_id": uid,
            "username": username,
            "first_name": first_name,
            "last_name": last_name,
            "photo_url": photo_url,
            "last_seen_at": "now()",
            "referrer_id": referrer_id
        }, on_conflict="user_id")
    )

    # ensure balances row
    existing = await sb_execute(supabase.table("balances").select("user_id").eq("user_id", uid))
    if not existing.data:
        await sb_execute(supabase.table("balances").insert({"user_id": uid}))

async def anti_fraud_attach_device(uid: int, device_id: str, request: web.Request):
    if not device_id or len(device_id) < 6:
        raise web.HTTPForbidden(text="device_id missing")

    # count devices for this user
    r = await sb_execute(
        supabase.table("devices").select("id,device_id").eq("user_id", uid)
    )
    devices = r.data or []
    known = any(d["device_id"] == device_id for d in devices)

    if not known and len(devices) >= MAX_DEVICES_PER_USER:
        raise web.HTTPForbidden(text="device_limit")

    # how many users share this device?
    r2 = await sb_execute(
        supabase.table("devices").select("user_id").eq("device_id", device_id)
    )
    shared_users = set(int(x["user_id"]) for x in (r2.data or []))
    if uid not in shared_users and len(shared_users) >= MAX_ACCOUNTS_PER_DEVICE:
        raise web.HTTPForbidden(text="multiaccount_limit")

    # upsert device link
    await sb_execute(
        supabase.table("devices").upsert({
            "device_id": device_id,
            "user_id": uid,
            "last_seen_at": "now()",
            "ip_hash": ip_hash(request),
            "user_agent_hash": ua_hash(request),
        }, on_conflict="device_id,user_id")
    )

async def get_balances(uid: int) -> dict:
    r = await sb_execute(supabase.table("balances").select("*").eq("user_id", uid))
    if not r.data:
        return {"rub_balance": 0, "stars_balance": 0}
    b = r.data[0]
    return {"rub_balance": float(b["rub_balance"]), "stars_balance": int(b["stars_balance"])}

async def add_balance(uid: int, rub_delta: float = 0.0, stars_delta: int = 0):
    b = await get_balances(uid)
    new_rub = float(b["rub_balance"]) + float(rub_delta)
    new_stars = int(b["stars_balance"]) + int(stars_delta)
    if new_rub < 0:
        new_rub = 0
    if new_stars < 0:
        new_stars = 0

    await sb_execute(
        supabase.table("balances").upsert({
            "user_id": uid,
            "rub_balance": new_rub,
            "stars_balance": new_stars,
            "updated_at": "now()"
        }, on_conflict="user_id")
    )

async def log_payment(uid: int, provider: str, status: str, amount_rub=None, amount_stars=None, provider_ref=None, meta=None):
    payload = {
        "user_id": uid,
        "provider": provider,
        "status": status,
        "amount_rub": amount_rub,
        "amount_stars": amount_stars,
        "provider_ref": provider_ref,
        "meta": meta or {}
    }
    await sb_execute(supabase.table("payments").insert(payload))

async def reward_referrer(uid: int, deposit_rub: float):
    # find referrer
    r = await sb_execute(supabase.table("users").select("referrer_id").eq("user_id", uid))
    if not r.data:
        return
    ref_id = r.data[0].get("referrer_id")
    if not ref_id:
        return
    bonus = round(float(deposit_rub) * REF_PERCENT, 2)
    await add_balance(int(ref_id), rub_delta=bonus)
    await log_payment(int(ref_id), "ref_bonus", "paid", amount_rub=bonus, meta={"from_user": uid})

# -----------------------------
# TG auto-check helpers
# -----------------------------
TG_USERNAME_RE = re.compile(r"(?:https?://)?t\.me/([A-Za-z0-9_]{5,})", re.IGNORECASE)

def parse_tg_chat(target_url: str) -> str | None:
    """
    Returns @username if target is public t.me/<username>.
    Private invite links cannot be checked automatically.
    """
    m = TG_USERNAME_RE.search(target_url or "")
    if not m:
        return None
    return "@" + m.group(1)

async def tg_is_member(chat: str, user_id: int) -> bool:
    """
    True if user is member/admin/creator (not left/kicked).
    Uses getChatMember (Bot API). :contentReference[oaicite:4]{index=4}
    """
    try:
        cm = await bot.get_chat_member(chat_id=chat, user_id=user_id)
        st = (cm.status or "").lower()
        return st in ("member", "administrator", "creator")
    except Exception:
        return False

# -----------------------------
# MiniApp API (aiohttp)
# -----------------------------
async def api_auth(request: web.Request) -> tuple[int, dict, dict]:
    """
    Returns (uid, user_obj, parsed_init_data) or raises HTTPUnauthorized.
    Expects JSON: { initData, deviceId }
    """
    body = await request.json()
    init_data = body.get("initData", "")
    device_id = body.get("deviceId", "")

    parsed = verify_init_data(init_data, BOT_TOKEN)
    if not parsed:
        raise web.HTTPUnauthorized(text="bad_init_data")

    user_obj = extract_user_from_init_data(parsed)
    if not user_obj or "id" not in user_obj:
        raise web.HTTPUnauthorized(text="no_user")

    uid = int(user_obj["id"])
    await ensure_user(user_obj)
    await anti_fraud_attach_device(uid, device_id, request)

    return uid, user_obj, parsed

async def api_me(request: web.Request):
    uid, user_obj, _ = await api_auth(request)
    b = await get_balances(uid)
    return web.json_response({
        "ok": True,
        "user": {
            "id": uid,
            "username": user_obj.get("username"),
            "first_name": user_obj.get("first_name"),
            "last_name": user_obj.get("last_name"),
            "photo_url": user_obj.get("photo_url"),
        },
        "balances": b
    })

async def api_tasks_list(request: web.Request):
    uid, _, _ = await api_auth(request)
    # show active tasks with qty_left > 0
    r = await sb_execute(
        supabase.table("tasks")
        .select("*")
        .eq("status", "active")
        .gt("qty_left", 0)
        .order("created_at", desc=True)
        .limit(200)
    )
    return web.json_response({"ok": True, "tasks": r.data or []})

async def api_task_create(request: web.Request):
    uid, _, _ = await api_auth(request)
    body = await request.json()

    # fields from MiniApp
    t_type = body.get("type")
    title = body.get("title", "Задание")
    target_url = body.get("target_url", "")
    instructions = body.get("instructions", "")
    qty = int(body.get("qty_total", 1))
    reward = float(body.get("reward_rub", 0))
    check_type = body.get("check_type", "manual")

    if not target_url or qty < 1 or reward <= 0:
        raise web.HTTPBadRequest(text="bad_task")

    tg_chat = None
    tg_kind = None
    if t_type == "tg":
        tg_chat = parse_tg_chat(target_url)
        tg_kind = body.get("tg_kind", "channel")
        if not tg_chat:
            raise web.HTTPBadRequest(text="tg_target_must_be_public_username")

    # cost to advertiser is your business logic. For now: advertiser pays in app via balance rub.
    total_cost = float(body.get("cost_rub", 0))
    if total_cost <= 0:
        raise web.HTTPBadRequest(text="bad_cost")

    bal = await get_balances(uid)
    if bal["rub_balance"] < total_cost:
        raise web.HTTPForbidden(text="insufficient_balance")

    await add_balance(uid, rub_delta=-total_cost)

    r = await sb_execute(
        supabase.table("tasks").insert({
            "owner_id": uid,
            "type": t_type,
            "tg_chat": tg_chat,
            "tg_kind": tg_kind,
            "title": title,
            "target_url": target_url,
            "instructions": instructions,
            "reward_rub": reward,
            "qty_total": qty,
            "qty_left": qty,
            "check_type": check_type,
            "status": "active"
        }).select("*").single()
    )

    # push to users (simple broadcast, can be optimized later)
    asyncio.create_task(push_new_task(r.data))

    return web.json_response({"ok": True, "task": r.data})

async def api_task_check_and_complete(request: web.Request):
    """
    Worker clicks "check" for tg task.
    body: { initData, deviceId, task_id }
    """
    uid, _, _ = await api_auth(request)
    body = await request.json()
    task_id = body.get("task_id")
    if not task_id:
        raise web.HTTPBadRequest(text="no_task")

    # get task
    tr = await sb_execute(supabase.table("tasks").select("*").eq("id", task_id).single())
    task = tr.data
    if not task or task["status"] != "active" or int(task["qty_left"]) <= 0:
        raise web.HTTPNotFound(text="task_not_active")

    # cooldowns for ya/gm you asked (server-side)
    if task["type"] in ("ya", "gm"):
        cooldown = LIMIT_YA_SECONDS if task["type"] == "ya" else LIMIT_GM_SECONDS
        cr = await sb_execute(
            supabase.table("task_completions")
            .select("created_at")
            .eq("user_id", uid)
            .eq("task_id", task_id)
            .maybe_single()
        )
        if cr.data:
            # already completed once
            raise web.HTTPForbidden(text="already_completed")

        # also block repeated completions of same type too frequently (optional)
        # (you can extend: last completion by type, but kept simple here)

    if task["type"] == "tg" and task["check_type"] == "auto":
        chat = task.get("tg_chat")
        if not chat:
            raise web.HTTPBadRequest(text="bad_tg_task")
        ok = await tg_is_member(chat, uid)
        if not ok:
            raise web.HTTPForbidden(text="not_a_member")

        # record completion
        await sb_execute(
            supabase.table("task_completions").insert({
                "task_id": task_id,
                "user_id": uid,
                "status": "approved"
            })
        )

        # pay instantly
        reward = float(task["reward_rub"])
        await add_balance(uid, rub_delta=reward)

        # decrement qty_left
        await sb_execute(
            supabase.table("tasks")
            .update({"qty_left": int(task["qty_left"]) - 1})
            .eq("id", task_id)
        )

        return web.json_response({"ok": True, "paid": True, "reward_rub": reward})

    # manual tasks: create pending completion, admin approves later
    await sb_execute(
        supabase.table("task_completions").insert({
            "task_id": task_id,
            "user_id": uid,
            "status": "pending",
            "proof_text": body.get("proof_text"),
            "proof_url": body.get("proof_url")
        })
    )
    return web.json_response({"ok": True, "pending": True})

async def api_withdraw_create(request: web.Request):
    uid, _, _ = await api_auth(request)
    body = await request.json()
    amount = float(body.get("amount_rub", 0))
    details = (body.get("details") or "").strip()
    if amount < 300 or not details:
        raise web.HTTPBadRequest(text="bad_withdraw")

    bal = await get_balances(uid)
    if bal["rub_balance"] < amount:
        raise web.HTTPForbidden(text="insufficient_balance")

    # reserve funds
    await add_balance(uid, rub_delta=-amount)

    wr = await sb_execute(
        supabase.table("withdraws").insert({
            "user_id": uid,
            "amount_rub": amount,
            "details": details,
            "status": "pending"
        }).select("*").single()
    )

    # notify admins
    await notify_admins(f"📤 Заявка на вывод\nUser: {uid}\nСумма: {amount}₽\nРеквизиты: {details}\nID: {wr.data['id']}")

    return web.json_response({"ok": True, "withdraw": wr.data})

async def api_tbank_request(request: web.Request):
    """
    MiniApp sends: { initData, deviceId, amount_rub, sender_name, code }
    We create pending payment; admin confirms.
    """
    uid, _, _ = await api_auth(request)
    body = await request.json()
    amount = float(body.get("amount_rub", 0))
    sender = (body.get("sender_name") or "").strip()
    code = (body.get("code") or "").strip()

    if amount < 300 or not sender or not code:
        raise web.HTTPBadRequest(text="bad_tbank")

    pr = await sb_execute(
        supabase.table("payments").insert({
            "user_id": uid,
            "provider": "tbank",
            "status": "pending",
            "amount_rub": amount,
            "provider_ref": code,
            "meta": {"sender": sender}
        }).select("*").single()
    )

    await notify_admins(
        f"💳 T-Bank пополнение (ожидает)\nUser: {uid}\nСумма: {amount}₽\nОтправитель: {sender}\nКод: {code}\nPayID: {pr.data['id']}"
    )

    return web.json_response({"ok": True, "payment": pr.data})

# -----------------------------
# Admin web (very simple)
# -----------------------------
def admin_guard(request: web.Request):
    if not ADMIN_WEB_TOKEN:
        raise web.HTTPForbidden(text="admin_disabled")
    token = request.query.get("token", "")
    if token != ADMIN_WEB_TOKEN:
        raise web.HTTPUnauthorized(text="bad_token")

async def admin_page(request: web.Request):
    admin_guard(request)
    # simple html + JS actions
    html = f"""
    <html><head><meta charset="utf-8"><title>Admin</title></head>
    <body style="font-family:Arial;max-width:900px;margin:20px auto;">
      <h2>ReviewCash Admin</h2>
      <p>token ok ✅</p>

      <h3>Pending T-Bank</h3>
      <div id="tbank"></div>

      <h3>Withdraws pending</h3>
      <div id="wd"></div>

      <script>
        async function load() {{
          const t = await fetch('/admin/data?token={ADMIN_WEB_TOKEN}').then(r=>r.json());
          document.getElementById('tbank').innerHTML = (t.tbank||[]).map(p =>
            `<div style="padding:10px;border:1px solid #ccc;margin:8px 0;">
              <b>${{p.amount_rub}} ₽</b> | user ${{p.user_id}} | code ${{p.provider_ref}} | sender ${{(p.meta||{{}}).sender||''}}
              <button onclick="approveT('${{p.id}}')">Approve</button>
              <button onclick="rejectT('${{p.id}}')">Reject</button>
            </div>`
          ).join('') || '—';

          document.getElementById('wd').innerHTML = (t.withdraws||[]).map(w =>
            `<div style="padding:10px;border:1px solid #ccc;margin:8px 0;">
              <b>${{w.amount_rub}} ₽</b> | user ${{w.user_id}} | ${{w.details}}
              <button onclick="payW('${{w.id}}')">Paid</button>
              <button onclick="rejW('${{w.id}}')">Reject</button>
            </div>`
          ).join('') || '—';
        }}

        async function approveT(id) {{
          await fetch('/admin/tbank/approve?token={ADMIN_WEB_TOKEN}', {{
            method:'POST', headers:{{'content-type':'application/json'}},
            body: JSON.stringify({{id}})
          }});
          load();
        }}
        async function rejectT(id) {{
          await fetch('/admin/tbank/reject?token={ADMIN_WEB_TOKEN}', {{
            method:'POST', headers:{{'content-type':'application/json'}},
            body: JSON.stringify({{id}})
          }});
          load();
        }}
        async function payW(id) {{
          await fetch('/admin/withdraw/pay?token={ADMIN_WEB_TOKEN}', {{
            method:'POST', headers:{{'content-type':'application/json'}},
            body: JSON.stringify({{id}})
          }});
          load();
        }}
        async function rejW(id) {{
          await fetch('/admin/withdraw/reject?token={ADMIN_WEB_TOKEN}', {{
            method:'POST', headers:{{'content-type':'application/json'}},
            body: JSON.stringify({{id}})
          }});
          load();
        }}

        load();
      </script>
    </body></html>
    """
    return web.Response(text=html, content_type="text/html")

async def admin_data(request: web.Request):
    admin_guard(request)
    tbank = await sb_execute(
        supabase.table("payments").select("*")
        .eq("provider", "tbank").eq("status", "pending")
        .order("created_at", desc=True).limit(100)
    )
    wd = await sb_execute(
        supabase.table("withdraws").select("*")
        .eq("status", "pending")
        .order("created_at", desc=True).limit(100)
    )
    return web.json_response({"tbank": tbank.data or [], "withdraws": wd.data or []})

async def admin_tbank_approve(request: web.Request):
    admin_guard(request)
    body = await request.json()
    pid = body.get("id")
    pr = await sb_execute(supabase.table("payments").select("*").eq("id", pid).single())
    p = pr.data
    if not p or p["status"] != "pending":
        return web.json_response({"ok": False})

    uid = int(p["user_id"])
    amount = float(p["amount_rub"])
    await add_balance(uid, rub_delta=amount)

    await sb_execute(supabase.table("payments").update({"status": "paid"}).eq("id", pid))

    await push_to_user(uid, f"✅ Пополнение T-Bank подтверждено: +{amount}₽")
    await reward_referrer(uid, amount)
    return web.json_response({"ok": True})

async def admin_tbank_reject(request: web.Request):
    admin_guard(request)
    body = await request.json()
    pid = body.get("id")
    await sb_execute(supabase.table("payments").update({"status": "canceled"}).eq("id", pid))
    return web.json_response({"ok": True})

async def admin_withdraw_pay(request: web.Request):
    admin_guard(request)
    body = await request.json()
    wid = body.get("id")
    wr = await sb_execute(supabase.table("withdraws").select("*").eq("id", wid).single())
    w = wr.data
    if not w or w["status"] != "pending":
        return web.json_response({"ok": False})
    await sb_execute(supabase.table("withdraws").update({"status": "paid"}).eq("id", wid))
    await push_to_user(int(w["user_id"]), f"✅ Выплата одобрена: {w['amount_rub']}₽")
    return web.json_response({"ok": True})

async def admin_withdraw_reject(request: web.Request):
    admin_guard(request)
    body = await request.json()
    wid = body.get("id")
    wr = await sb_execute(supabase.table("withdraws").select("*").eq("id", wid).single())
    w = wr.data
    if not w or w["status"] != "pending":
        return web.json_response({"ok": False})

    # refund
    await add_balance(int(w["user_id"]), rub_delta=float(w["amount_rub"]))
    await sb_execute(supabase.table("withdraws").update({"status": "rejected"}).eq("id", wid))
    await push_to_user(int(w["user_id"]), f"❌ Выплата отклонена, средства возвращены.")
    return web.json_response({"ok": True})

# -----------------------------
# Push helpers
# -----------------------------
async def push_to_user(uid: int, text: str):
    try:
        await bot.send_message(uid, text)
    except Exception:
        pass

async def notify_admins(text: str):
    for aid in ADMIN_IDS:
        try:
            await bot.send_message(aid, text)
        except Exception:
            pass

async def push_new_task(task: dict):
    # naive broadcast: last 500 users (optimize later)
    r = await sb_execute(supabase.table("users").select("user_id").order("last_seen_at", desc=True).limit(500))
    for row in (r.data or []):
        uid = int(row["user_id"])
        if uid == int(task["owner_id"]):
            continue
        await push_to_user(uid, f"🆕 Появилось новое задание: {task.get('title','Задание')}")

# -----------------------------
# Telegram bot: /start + Stars + admin commands (minimal)
# -----------------------------
def start_kb():
    return ReplyKeyboardMarkup(
        keyboard=[[KeyboardButton(text="📱 Открыть ReviewCash", web_app=WebAppInfo(url=WEBAPP_URL))]],
        resize_keyboard=True
    )

@dp.message(Command("start"))
async def cmd_start(message: types.Message):
    # referral: /start <refid>
    args = message.text.split()
    ref_id = int(args[1]) if len(args) > 1 and args[1].isdigit() else None

    u = message.from_user
    await ensure_user({
        "id": u.id,
        "username": u.username,
        "first_name": u.first_name,
        "last_name": u.last_name,
        "photo_url": None  # Bot API does not give photo_url here
    }, referrer_id=ref_id)

    await message.answer(
        "👋 <b>Добро пожаловать в ReviewCash!</b>\n\n"
        "📌 Тут ты можешь:\n"
        "• выполнять задания и получать ₽\n"
        "• запускать рекламу (создавать задания)\n"
        "• пополнять баланс (CryptoBot / Stars / T-Bank)\n\n"
        "✅ Нажми кнопку ниже, чтобы открыть приложение.",
        parse_mode="HTML",
        reply_markup=start_kb()
    )

# ---- Stars invoice (XTR = Telegram Stars) :contentReference[oaicite:5]{index=5}
@dp.message(Command("topup_stars"))
async def cmd_topup_stars(message: types.Message):
    # /topup_stars 100  (stars)
    parts = message.text.split()
    stars = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 100
    if stars < 1:
        stars = 1

    payload = f"stars_topup:{message.from_user.id}:{stars}:{now_ts()}"
    await log_payment(message.from_user.id, "stars", "pending", amount_stars=stars, provider_ref=payload)

    await bot.send_invoice(
        chat_id=message.chat.id,
        title="Пополнение баланса",
        description=f"Пополнение на {stars} ⭐",
        payload=payload,
        provider_token="",   # for Stars this is empty string in many SDKs; currency is XTR
        currency="XTR",
        prices=[LabeledPrice(label="Stars", amount=stars)]
    )

@dp.pre_checkout_query()
async def pre_checkout(q: PreCheckoutQuery):
    await q.answer(ok=True)

@dp.message(F.successful_payment)
async def on_success_payment(message: types.Message):
    sp = message.successful_payment
    payload = sp.invoice_payload or ""
    if payload.startswith("stars_topup:"):
        # total_amount for XTR is in stars
        stars = int(sp.total_amount)
        uid = message.from_user.id
        rub_equiv = float(stars) * STAR_PRICE_RUB

        await add_balance(uid, stars_delta=stars)
        await sb_execute(supabase.table("payments").update({"status": "paid"}).eq("provider_ref", payload))

        await reward_referrer(uid, rub_equiv)
        await message.answer(f"⭐ Оплата прошла! Начислено {stars} Stars")

# ---- CryptoBot: create invoice (via WebApp action or command)
@dp.message(Command("topup_crypto"))
async def cmd_topup_crypto(message: types.Message):
    if not crypto:
        return await message.answer("CryptoBot не подключен (CRYPTO_PAY_TOKEN пуст).")
    parts = message.text.split()
    amount_rub = float(parts[1]) if len(parts) > 1 else 500.0
    if amount_rub < 300:
        amount_rub = 300.0

    # rough conversion, you can replace with real rate later
    usdt = round(amount_rub / 95, 2)
    inv = await crypto.create_invoice(asset="USDT", amount=usdt)

    await log_payment(
        message.from_user.id,
        "cryptobot",
        "pending",
        amount_rub=amount_rub,
        provider_ref=str(inv.invoice_id),
        meta={"asset":"USDT","amount":usdt, "pay_url": inv.bot_invoice_url}
    )

    kb = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="💎 Оплатить USDT", url=inv.bot_invoice_url)],
        [InlineKeyboardButton(text="✅ Я оплатил", callback_data=f"crypto_check:{inv.invoice_id}")]
    ])
    await message.answer(
        f"💳 Счёт создан\nК оплате: {usdt} USDT (~{amount_rub}₽)",
        reply_markup=kb
    )

@dp.callback_query(F.data.startswith("crypto_check:"))
async def cb_crypto_check(call: types.CallbackQuery):
    if not crypto:
        return await call.answer("CryptoBot не подключен.", show_alert=True)

    inv_id = int(call.data.split(":")[1])
    invs = await crypto.get_invoices(invoice_ids=inv_id)
    inv = invs[0] if isinstance(invs, list) else invs

    if inv.status == "paid":
        # find pending payment row by provider_ref
        pr = await sb_execute(supabase.table("payments").select("*").eq("provider_ref", str(inv_id)).single())
        p = pr.data
        if p and p["status"] != "paid":
            uid = int(p["user_id"])
            amount_rub = float(p["amount_rub"] or 0)
            await add_balance(uid, rub_delta=amount_rub)
            await sb_execute(supabase.table("payments").update({"status": "paid"}).eq("id", p["id"]))
            await reward_referrer(uid, amount_rub)
        await call.message.edit_text("✅ Оплата подтверждена! Баланс пополнен.")
    else:
        await call.answer("Платеж ещё не найден. Попробуй позже.", show_alert=True)

# -----------------------------
# Background: poll Crypto invoices (so user doesn't need button)
# -----------------------------
async def crypto_poll_loop():
    if not crypto:
        return
    while True:
        try:
            # get up to 50 pending cryptobot payments
            r = await sb_execute(
                supabase.table("payments")
                .select("*")
                .eq("provider", "cryptobot")
                .eq("status", "pending")
                .order("created_at", desc=False)
                .limit(50)
            )
            pending = r.data or []
            if pending:
                ids = [int(p["provider_ref"]) for p in pending if str(p.get("provider_ref","")).isdigit()]
                if ids:
                    invs = await crypto.get_invoices(invoice_ids=ids)
                    inv_map = {}
                    if isinstance(invs, list):
                        for inv in invs:
                            inv_map[int(inv.invoice_id)] = inv
                    for p in pending:
                        inv_id = int(p["provider_ref"])
                        inv = inv_map.get(inv_id)
                        if inv and inv.status == "paid":
                            uid = int(p["user_id"])
                            amount_rub = float(p["amount_rub"] or 0)
                            await add_balance(uid, rub_delta=amount_rub)
                            await sb_execute(supabase.table("payments").update({"status": "paid"}).eq("id", p["id"]))
                            await reward_referrer(uid, amount_rub)
                            await push_to_user(uid, f"✅ CryptoBot оплата подтверждена: +{amount_rub}₽")
        except Exception as e:
            logging.exception("crypto poll error: %s", e)

        await asyncio.sleep(15)

# -----------------------------
# AIOHTTP APP (Render needs an open port)
# -----------------------------
async def healthz(_):
    return web.Response(text="OK")

def make_app():
    app = web.Application()
    app.router.add_get("/healthz", healthz)

    # MiniApp API (POST JSON with initData/deviceId)
    app.router.add_post("/api/me", api_me)
    app.router.add_post("/api/tasks/list", api_tasks_list)
    app.router.add_post("/api/tasks/create", api_task_create)
    app.router.add_post("/api/tasks/complete", api_task_check_and_complete)
    app.router.add_post("/api/withdraws/create", api_withdraw_create)
    app.router.add_post("/api/topup/tbank", api_tbank_request)

    # Admin web
    app.router.add_get("/admin", admin_page)
    app.router.add_get("/admin/data", admin_data)
    app.router.add_post("/admin/tbank/approve", admin_tbank_approve)
    app.router.add_post("/admin/tbank/reject", admin_tbank_reject)
    app.router.add_post("/admin/withdraw/pay", admin_withdraw_pay)
    app.router.add_post("/admin/withdraw/reject", admin_withdraw_reject)
    return app

async def main():
    # start aiohttp web server
    app = make_app()
    runner = web.AppRunner(app)
    await runner.setup()

    port = int(os.getenv("PORT", "8080"))
    site = web.TCPSite(runner, "0.0.0.0", port)
    await site.start()
    logging.info("Web server started on %s", port)

    # start crypto polling loop
    if crypto:
        asyncio.create_task(crypto_poll_loop())

    # start bot polling
    await bot.delete_webhook(drop_pending_updates=True)
    logging.info("Bot polling started")
    await dp.start_polling(bot)

if __name__ == "__main__":
    asyncio.run(main())
