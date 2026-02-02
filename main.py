"""
ReviewCashBot - single-file production bot + API
Tech: aiogram 3.x + aiohttp + supabase-py + aiocryptopay

What this file provides:
- Telegram bot (/start + webapp button)
- initData verification endpoint for Mini App
- DB-backed tasks, proofs (manual reviews), withdrawals
- Auto-check for Telegram subscription/join tasks (when bot can see membership)
- Anti-fraud: device hash limits, account-per-device limits, cooldown limits

Run:
  python bot.py

Required env:
  BOT_TOKEN=...
  WEBAPP_URL=https://... (your mini app URL)
  SUPABASE_URL=https://xxxx.supabase.co
  SUPABASE_SERVICE_KEY=... (service_role key)
Optional env:
  CRYPTO_BOT_TOKEN=... (CryptoBot token)
  ADMIN_IDS=6482440657,123456
  PORT=8080
  ALLOWED_ORIGINS=https://cdn.miniapps.ai,https://your-domain (comma-separated)
  MAX_DEVICES_PER_USER=2
  MAX_ACCOUNTS_PER_DEVICE=3
"""

import os
import re
import hmac
import hashlib
import json
import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, Optional, List, Tuple

from aiohttp import web
from aiogram import Bot, Dispatcher, F, types
from aiogram.filters import Command
from aiogram.types import (
    InlineKeyboardMarkup, InlineKeyboardButton,
    ReplyKeyboardMarkup, KeyboardButton, WebAppInfo,
    LabeledPrice, PreCheckoutQuery
)

from supabase import create_client, Client

try:
    from aiocryptopay import AioCryptoPay, Networks
except Exception:
    AioCryptoPay = None  # type: ignore
    Networks = None  # type: ignore


# ----------------- CONFIG -----------------
logging.basicConfig(level=logging.INFO)
log = logging.getLogger("reviewcash")

BOT_TOKEN = os.getenv("BOT_TOKEN")
WEBAPP_URL = os.getenv("WEBAPP_URL")  # must be your published miniapp URL
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY") or os.getenv("SUPABASE_KEY")
CRYPTO_TOKEN = os.getenv("CRYPTO_BOT_TOKEN")

ADMIN_IDS = set()
_admin_raw = os.getenv("ADMIN_IDS", "")
if _admin_raw.strip():
    for x in _admin_raw.split(","):
        x = x.strip()
        if x.isdigit():
            ADMIN_IDS.add(int(x))

PORT = int(os.getenv("PORT", "8080"))

ALLOWED_ORIGINS = [x.strip() for x in os.getenv("ALLOWED_ORIGINS", "").split(",") if x.strip()]
MAX_DEVICES_PER_USER = int(os.getenv("MAX_DEVICES_PER_USER", "2"))
MAX_ACCOUNTS_PER_DEVICE = int(os.getenv("MAX_ACCOUNTS_PER_DEVICE", "3"))

STAR_PRICE_RUB = float(os.getenv("STAR_PRICE_RUB", "1.5"))
REF_PERCENT = float(os.getenv("REF_PERCENT", "0.05"))

# Cooldowns (ms) for review tasks
COOLDOWN_YA = int(os.getenv("COOLDOWN_YA_MS", str(3 * 24 * 60 * 60 * 1000)))  # 3 days
COOLDOWN_GM = int(os.getenv("COOLDOWN_GM_MS", str(1 * 24 * 60 * 60 * 1000)))  # 1 day

# Auto TG check supports only join/sub tasks where bot can read member status
AUTO_TG_SUBTYPES = {"tg_sub", "tg_group", "tg_hold"}


# ----------------- VALIDATION -----------------
def _require_env(name: str, val: Optional[str]) -> str:
    if not val or not isinstance(val, str) or not val.strip():
        raise RuntimeError(f"Missing required env {name}. Set it in Render/hosting env vars.")
    return val.strip()


def parse_tme_target(url_or_username: str) -> Optional[str]:
    """
    Returns @username for t.me/<username> links or plain @username
    Invite links cannot be reliably checked by bots (no username) -> return None.
    """
    s = (url_or_username or "").strip()
    if not s:
        return None
    if s.startswith("@"):
        return s
    m = re.search(r"(?:https?://)?t\.me/([A-Za-z0-9_]{5,})", s)
    if m:
        return "@" + m.group(1)
    # maybe user typed username without @
    if re.fullmatch(r"[A-Za-z0-9_]{5,}", s):
        return "@" + s
    return None


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def verify_telegram_initdata(init_data: str, bot_token: str) -> Tuple[bool, Dict[str, str]]:
    """
    Verifies Telegram WebApp initData signature.
    Returns (ok, parsed_kv).

    Algorithm:
      secret_key = sha256(bot_token)
      data_check_string = "\n".join(f"{k}={v}" for k sorted(params) if k != "hash")
      expected_hash = hmac_sha256(secret_key, data_check_string).hexdigest()
    """
    try:
        pairs = [p.split("=", 1) for p in init_data.split("&") if "=" in p]
        kv = {k: v for k, v in pairs}
        recv_hash = kv.get("hash", "")
        if not recv_hash:
            return False, {}
        secret = hashlib.sha256(bot_token.encode("utf-8")).digest()
        data_check = "\n".join(f"{k}={kv[k]}" for k in sorted(kv.keys()) if k != "hash")
        calc = hmac.new(secret, data_check.encode("utf-8"), hashlib.sha256).hexdigest()
        return hmac.compare_digest(calc, recv_hash), kv
    except Exception:
        return False, {}


def extract_user_from_initdata(kv: Dict[str, str]) -> Optional[Dict[str, Any]]:
    """
    initData has field 'user' (json-escaped) when opened by a user.
    """
    if "user" not in kv:
        return None
    try:
        # Telegram url-encodes JSON; aiohttp already gives raw string; it is percent-encoded.
        import urllib.parse
        user_json = urllib.parse.unquote(kv["user"])
        return json.loads(user_json)
    except Exception:
        return None


def cors_headers(origin: Optional[str]) -> Dict[str, str]:
    if not origin or not ALLOWED_ORIGINS:
        return {}
    if origin in ALLOWED_ORIGINS or "*" in ALLOWED_ORIGINS:
        return {
            "Access-Control-Allow-Origin": origin,
            "Vary": "Origin",
            "Access-Control-Allow-Credentials": "true",
            "Access-Control-Allow-Headers": "content-type",
            "Access-Control-Allow-Methods": "POST,GET,OPTIONS",
        }
    return {}


# ----------------- DB LAYER -----------------
@dataclass
class DB:
    sb: Client

    # ---- users ----
    def get_user(self, user_id: int) -> Optional[Dict[str, Any]]:
        r = self.sb.table("users").select("*").eq("user_id", user_id).limit(1).execute()
        return r.data[0] if r.data else None

    def upsert_user(self, user: Dict[str, Any], referrer_id: Optional[int] = None) -> Dict[str, Any]:
        payload = {
            "user_id": int(user["id"]),
            "username": user.get("username") or "",
            "first_name": user.get("first_name") or "",
            "last_name": user.get("last_name") or "",
            "photo_url": user.get("photo_url") or "",
        }
        if referrer_id:
            payload["referrer_id"] = referrer_id
        # upsert via insert on conflict in supabase: use .upsert if available
        self.sb.table("users").upsert(payload, on_conflict="user_id").execute()
        return self.get_user(int(user["id"])) or payload

    def add_balance(self, user_id: int, rub_delta: float = 0.0, stars_delta: int = 0) -> None:
        u = self.get_user(user_id)
        if not u:
            raise RuntimeError("user not found")
        new_rub = float(u.get("balance_rub", 0)) + float(rub_delta)
        new_stars = int(u.get("balance_stars", 0)) + int(stars_delta)
        self.sb.table("users").update({"balance_rub": new_rub, "balance_stars": new_stars}).eq("user_id", user_id).execute()

    # ---- devices (anti-fraud) ----
    def register_device(self, user_id: int, device_hash: str, ip: str, ua: str) -> Dict[str, Any]:
        # upsert user-device record
        self.sb.table("devices").upsert(
            {"user_id": user_id, "device_hash": device_hash, "last_seen": now_utc().isoformat(), "ip": ip, "user_agent": ua},
            on_conflict="user_id,device_hash",
        ).execute()
        # enforce limits
        devs = self.sb.table("devices").select("device_hash").eq("user_id", user_id).execute().data or []
        if len({d["device_hash"] for d in devs}) > MAX_DEVICES_PER_USER:
            raise web.HTTPForbidden(text="Слишком много устройств для одного аккаунта.")
        # accounts per device
        users = self.sb.table("devices").select("user_id").eq("device_hash", device_hash).execute().data or []
        if len({d["user_id"] for d in users}) > MAX_ACCOUNTS_PER_DEVICE:
            raise web.HTTPForbidden(text="Слишком много аккаунтов на одном устройстве.")
        return {"ok": True}

    # ---- tasks ----
    def list_tasks(self, for_user_id: int, only_active: bool = True) -> List[Dict[str, Any]]:
        q = self.sb.table("tasks").select("*")
        if only_active:
            q = q.eq("status", "active")
        r = q.order("created_at", desc=True).limit(200).execute()
        rows = r.data or []
        # map to miniapp shape
        out = []
        for t in rows:
            out.append({
                "id": t["id"],
                "type": t["type"],
                "subType": t.get("subtype"),
                "name": t["title"],
                "price": t["reward_rub"],     # worker reward
                "cost": t["cost_rub"],        # owner cost per item
                "owner": "me" if t["owner_id"] == for_user_id else "other",
                "checkType": t["check_type"],
                "qty": t["qty_total"],
                "qtyDone": t["qty_done"],
                "target": t["target"],
                "text": t["text"],
            })
        return out

    def create_task(self, owner_id: int, payload: Dict[str, Any]) -> Dict[str, Any]:
        # payload: type, subType, qty, target, text, cost_rub, reward_rub, check_type, title
        r = self.sb.table("tasks").insert({
            "owner_id": owner_id,
            "type": payload["type"],
            "subtype": payload.get("subType"),
            "title": payload["title"],
            "target": payload["target"],
            "text": payload.get("text", ""),
            "check_type": payload["check_type"],
            "qty_total": int(payload["qty_total"]),
            "qty_done": 0,
            "cost_rub": float(payload["cost_rub"]),
            "reward_rub": float(payload["reward_rub"]),
            "status": "active",
        }).execute()
        return r.data[0]

    def get_task(self, task_id: str) -> Optional[Dict[str, Any]]:
        r = self.sb.table("tasks").select("*").eq("id", task_id).limit(1).execute()
        return r.data[0] if r.data else None

    def mark_task_done(self, task_id: str) -> None:
        t = self.get_task(task_id)
        if not t:
            raise web.HTTPNotFound(text="task not found")
        done = int(t["qty_done"]) + 1
        status = "active"
        if done >= int(t["qty_total"]):
            status = "closed"
        self.sb.table("tasks").update({"qty_done": done, "status": status}).eq("id", task_id).execute()

    # ---- completions / cooldowns ----
    def has_completed(self, task_id: str, worker_id: int) -> bool:
        r = self.sb.table("task_completions").select("id").eq("task_id", task_id).eq("worker_id", worker_id).limit(1).execute()
        return bool(r.data)

    def record_completion(self, task_id: str, worker_id: int) -> None:
        self.sb.table("task_completions").insert({"task_id": task_id, "worker_id": worker_id}).execute()

    def check_cooldown(self, worker_id: int, kind: str) -> Tuple[bool, int]:
        # kind: 'ya' or 'gm'
        cooldown_ms = COOLDOWN_YA if kind == "ya" else COOLDOWN_GM
        r = self.sb.table("user_limits").select("*").eq("user_id", worker_id).eq("kind", kind).limit(1).execute()
        if not r.data:
            return True, 0
        last_ts = r.data[0].get("last_ts")
        if not last_ts:
            return True, 0
        last = datetime.fromisoformat(last_ts)
        diff_ms = int((now_utc() - last).total_seconds() * 1000)
        if diff_ms < cooldown_ms:
            return False, cooldown_ms - diff_ms
        return True, 0

    def set_cooldown_now(self, worker_id: int, kind: str) -> None:
        self.sb.table("user_limits").upsert(
            {"user_id": worker_id, "kind": kind, "last_ts": now_utc().isoformat()},
            on_conflict="user_id,kind"
        ).execute()

    # ---- proofs (manual) ----
    def create_proof(self, task_id: str, worker_id: int, worker_name: str, screenshot_url: str) -> None:
        self.sb.table("proofs").insert({
            "task_id": task_id,
            "worker_id": worker_id,
            "worker_name": worker_name,
            "screenshot_url": screenshot_url,
            "status": "pending",
        }).execute()

    def list_pending_proofs(self) -> List[Dict[str, Any]]:
        r = self.sb.table("proofs").select("*,tasks(target,title,reward_rub)").eq("status", "pending").order("created_at", desc=True).limit(200).execute()
        out = []
        for p in (r.data or []):
            task = p.get("tasks") or {}
            out.append({
                "id": p["id"],
                "taskId": p["task_id"],
                "taskName": task.get("title") or "Задание",
                "targetUrl": task.get("target") or "",
                "workerName": p.get("worker_name") or "",
                "price": task.get("reward_rub") or 0,
                "screenshotUrl": p.get("screenshot_url") or "",
                "timestamp": p.get("created_at") or "",
            })
        return out

    def resolve_proof(self, proof_id: str, approved: bool, admin_id: int) -> Dict[str, Any]:
        r = self.sb.table("proofs").select("*").eq("id", proof_id).limit(1).execute()
        if not r.data:
            raise web.HTTPNotFound(text="proof not found")
        p = r.data[0]
        status = "approved" if approved else "rejected"
        self.sb.table("proofs").update({"status": status, "reviewed_by": admin_id, "reviewed_at": now_utc().isoformat()}).eq("id", proof_id).execute()
        return p

    # ---- withdrawals ----
    def create_withdrawal(self, user_id: int, amount: float, details: str) -> Dict[str, Any]:
        r = self.sb.table("withdrawals").insert({
            "user_id": user_id,
            "amount_rub": amount,
            "details": details,
            "status": "pending",
        }).execute()
        return r.data[0]

    def list_withdrawals(self, user_id: Optional[int] = None, pending_only: bool = False) -> List[Dict[str, Any]]:
        q = self.sb.table("withdrawals").select("*").order("created_at", desc=True).limit(200)
        if user_id:
            q = q.eq("user_id", user_id)
        if pending_only:
            q = q.eq("status", "pending")
        return q.execute().data or []

    def set_withdrawal_status(self, wid: str, status: str, admin_id: int) -> Dict[str, Any]:
        r = self.sb.table("withdrawals").select("*").eq("id", wid).limit(1).execute()
        if not r.data:
            raise web.HTTPNotFound(text="withdraw not found")
        w = r.data[0]
        self.sb.table("withdrawals").update({"status": status, "reviewed_by": admin_id, "reviewed_at": now_utc().isoformat()}).eq("id", wid).execute()
        return w

    # ---- payments log ----
    def log_payment(self, user_id: int, p_type: str, amount: float, currency: str, meta: Optional[Dict[str, Any]] = None) -> None:
        payload = {"user_id": user_id, "type": p_type, "amount": amount, "currency": currency, "meta": meta or {}}
        self.sb.table("payments").insert(payload).execute()

    def reward_referrer(self, user_id: int, deposit_rub: float) -> None:
        u = self.get_user(user_id) or {}
        ref = u.get("referrer_id")
        if not ref:
            return
        bonus = round(float(deposit_rub) * REF_PERCENT, 2)
        self.add_balance(int(ref), rub_delta=bonus)
        self.log_payment(int(ref), "ref_bonus", bonus, "RUB", {"from_user": user_id})


# ----------------- CRYPTO -----------------
def init_crypto() -> Optional[Any]:
    if not CRYPTO_TOKEN or not AioCryptoPay:
        return None
    network = Networks.MAIN_NET
    if "test" in CRYPTO_TOKEN.lower():
        network = Networks.TEST_NET
    return AioCryptoPay(token=CRYPTO_TOKEN, network=network)


# ----------------- APP -----------------
bot: Bot
dp: Dispatcher
db: DB
crypto = None


# ----------------- BOT HANDLERS -----------------
@dp.message(Command("start"))
async def cmd_start(message: types.Message):
    # /start <ref>
    ref_id = None
    args = (message.text or "").split()
    if len(args) > 1 and args[1].isdigit():
        ref_id = int(args[1])

    # Upsert user (minimal; photo_url will be added from initData too)
    u = message.from_user
    db.sb.table("users").upsert({
        "user_id": u.id,
        "username": u.username or "",
        "first_name": u.first_name or "",
        "last_name": u.last_name or "",
        "photo_url": "",  # we don't have it in Bot API reliably
        "referrer_id": ref_id
    }, on_conflict="user_id").execute()

    kb = ReplyKeyboardMarkup(
        keyboard=[[KeyboardButton(text="📱 Открыть ReviewCash", web_app=WebAppInfo(url=_require_env("WEBAPP_URL", WEBAPP_URL)))]],
        resize_keyboard=True
    )

    text = (
        "👋 <b>Добро пожаловать в ReviewCash!</b>\n\n"
        "📌 <b>Как это работает:</b>\n"
        "1) Открой Mini App кнопкой ниже\n"
        "2) Выбирай задания и выполняй их\n"
        "3) Отправляй отчет (скрин) или проходи авто-проверку TG\n"
        "4) Получай деньги на баланс и выводи\n\n"
        "🛡️ Важно: не создавай много аккаунтов — антифрод может заблокировать.\n\n"
        "Жми кнопку 👇"
    )

    await message.answer(text, reply_markup=kb, parse_mode="HTML")


# Telegram Stars payments
@dp.pre_checkout_query()
async def pre_checkout(q: PreCheckoutQuery):
    await q.answer(ok=True)


@dp.message(F.successful_payment)
async def on_stars_payment(message: types.Message):
    stars = int(message.successful_payment.total_amount)  # XTR minor units == stars
    rub = stars * STAR_PRICE_RUB

    db.add_balance(message.from_user.id, stars_delta=stars)
    db.log_payment(message.from_user.id, "deposit_stars", stars, "STARS", {"rub_equiv": rub})
    db.reward_referrer(message.from_user.id, rub)

    await message.answer(f"⭐ Оплата прошла! Начислено {stars} Stars.")


# ----------------- API HANDLERS -----------------
async def handle_options(request: web.Request):
    origin = request.headers.get("Origin")
    return web.Response(status=204, headers=cors_headers(origin))


async def json_in(request: web.Request) -> Dict[str, Any]:
    try:
        return await request.json()
    except Exception:
        return {}


async def require_init(request: web.Request) -> Tuple[int, Dict[str, Any], Dict[str, str]]:
    """
    Verifies initData and returns (user_id, user_obj, kv).
    Also registers device anti-fraud.
    """
    body = await json_in(request)
    init_data = body.get("initData") or request.headers.get("X-Tg-Init-Data")
    if not init_data or not isinstance(init_data, str):
        raise web.HTTPUnauthorized(text="Missing initData")

    ok, kv = verify_telegram_initdata(init_data, _require_env("BOT_TOKEN", BOT_TOKEN))
    if not ok:
        raise web.HTTPUnauthorized(text="Bad initData signature")

    user = extract_user_from_initdata(kv)
    if not user or "id" not in user:
        raise web.HTTPUnauthorized(text="No user in initData")

    # optional ref id
    ref_id = None
    if "start_param" in kv and str(kv["start_param"]).isdigit():
        ref_id = int(kv["start_param"])

    # upsert user
    db.upsert_user(user, referrer_id=ref_id)

    # device fingerprint
    ua = request.headers.get("User-Agent", "")[:512]
    ip = request.headers.get("X-Forwarded-For", request.remote or "")[:128]
    device_seed = f"{user['id']}|{ua}|{ip}"
    device_hash = sha256_hex(device_seed)[:32]
    db.register_device(int(user["id"]), device_hash, ip, ua)

    return int(user["id"]), user, kv


async def api_init(request: web.Request):
    origin = request.headers.get("Origin")
    user_id, user, _kv = await require_init(request)

    urow = db.get_user(user_id) or {}
    tasks = db.list_tasks(user_id, only_active=True)

    res = {
        "ok": True,
        "user": {
            "id": user_id,
            "username": urow.get("username", ""),
            "first_name": urow.get("first_name", ""),
            "last_name": urow.get("last_name", ""),
            "photo_url": urow.get("photo_url", ""),
            "rub": float(urow.get("balance_rub", 0)),
            "stars": int(urow.get("balance_stars", 0)),
            "xp": int(urow.get("xp", 0)),
            "level": int(urow.get("level", 1)),
        },
        "tasks": tasks,
        "withdrawals": db.list_withdrawals(user_id=user_id),
        "referrals": {"count": int(urow.get("ref_count", 0)), "earned": float(urow.get("ref_earned", 0))},
        "limits": {},
    }
    return web.json_response(res, headers=cors_headers(origin))


async def api_tasks_list(request: web.Request):
    origin = request.headers.get("Origin")
    user_id, _user, _kv = await require_init(request)
    tasks = db.list_tasks(user_id, only_active=True)
    return web.json_response({"ok": True, "tasks": tasks}, headers=cors_headers(origin))


def price_config(type_: str, subtype: Optional[str]) -> Tuple[float, float, str, str]:
    """
    Returns (cost_rub, reward_rub, title, check_type)
    """
    if type_ == "tg":
        # you can tune these
        mapping = {
            "tg_sub":   (30, 15, "Подписка на канал", "auto"),
            "tg_group": (25, 12, "Вступление в группу", "auto"),
            "tg_hold":  (60, 30, "Подписка + 24ч", "auto"),
            "tg_poll":  (15, 7,  "Участие в опросе", "auto"),   # NOTE: not truly auto-verified
            "tg_react": (10, 5,  "Просмотр + Реакция", "auto"), # NOTE: not truly auto-verified
        }
        if subtype not in mapping:
            # unknown subtype -> treat as manual
            return (30, 15, "Telegram активность", "manual")
        return mapping[subtype]
    if type_ == "ya":
        return (120, 60, "Отзыв Яндекс", "manual")
    if type_ == "gm":
        return (75,  37, "Отзыв Google", "manual")
    raise web.HTTPBadRequest(text="Unknown task type")


async def api_tasks_create(request: web.Request):
    origin = request.headers.get("Origin")
    user_id, _user, _kv = await require_init(request)
    body = await json_in(request)

    type_ = str(body.get("type") or "").strip()
    subtype = body.get("subType")
    qty = int(body.get("qty") or 0)
    currency = str(body.get("currency") or "rub")
    target = str(body.get("target") or "").strip()
    text = str(body.get("text") or "").strip()

    if qty < 1:
        raise web.HTTPBadRequest(text="qty must be >= 1")
    if not target:
        raise web.HTTPBadRequest(text="target required")

    cost, reward, title, check_type = price_config(type_, subtype)

    total_cost = cost * qty
    # only RUB supported in DB balance; Stars can be stored separately
    urow = db.get_user(user_id) or {}
    if currency == "rub":
        if float(urow.get("balance_rub", 0)) < total_cost:
            raise web.HTTPForbidden(text="Недостаточно средств")
        db.add_balance(user_id, rub_delta=-total_cost)
        db.log_payment(user_id, "spend_create_task", total_cost, "RUB", {"type": type_, "subtype": subtype, "qty": qty})
    else:
        # stars
        stars_needed = int((total_cost / STAR_PRICE_RUB) + 0.999)
        if int(urow.get("balance_stars", 0)) < stars_needed:
            raise web.HTTPForbidden(text="Недостаточно stars")
        db.add_balance(user_id, stars_delta=-stars_needed)
        db.log_payment(user_id, "spend_create_task", stars_needed, "STARS", {"rub_equiv": total_cost, "type": type_, "subtype": subtype, "qty": qty})

    task = db.create_task(user_id, {
        "type": type_,
        "subType": subtype,
        "title": title,
        "target": target,
        "text": text,
        "check_type": check_type,
        "qty_total": qty,
        "cost_rub": cost,
        "reward_rub": reward,
    })

    # Push: notify admins about new task (optional)
    for admin_id in ADMIN_IDS:
        try:
            await bot.send_message(admin_id, f"🆕 Новое задание: {title}\nТип: {type_}/{subtype}\nКол-во: {qty}\nСсылка: {target}")
        except Exception:
            pass

    return web.json_response({"ok": True, "task": task}, headers=cors_headers(origin))


async def api_tg_check_and_complete(request: web.Request):
    """
    Auto-check: only for tg_sub / tg_group / tg_hold and only if target is a public @username chat
    and the bot can read member status (bot must be in that chat, ideally admin).
    """
    origin = request.headers.get("Origin")
    user_id, _user, _kv = await require_init(request)
    body = await json_in(request)
    task_id = str(body.get("task_id") or "").strip()
    if not task_id:
        raise web.HTTPBadRequest(text="task_id required")

    task = db.get_task(task_id)
    if not task or task.get("status") != "active":
        raise web.HTTPNotFound(text="task not found / not active")

    if task["owner_id"] == user_id:
        raise web.HTTPForbidden(text="Нельзя выполнять свои задания")

    if db.has_completed(task_id, user_id):
        raise web.HTTPForbidden(text="Это задание уже выполнено вами")

    if task.get("type") != "tg":
        raise web.HTTPBadRequest(text="not a tg task")

    subtype = task.get("subtype") or ""
    if subtype not in AUTO_TG_SUBTYPES:
        raise web.HTTPBadRequest(text="Этот тип TG задания не поддерживает авто-проверку")

    chat_username = parse_tme_target(task.get("target") or "")
    if not chat_username:
        raise web.HTTPBadRequest(text="Нужна публичная ссылка t.me/<username> (инвайт ссылки не поддерживаются)")

    try:
        member = await bot.get_chat_member(chat_username, user_id)
        status = getattr(member, "status", "")
        if status in ("left", "kicked"):
            raise web.HTTPForbidden(text="Подписка/вступление не найдено. Выполните задание и попробуйте снова.")
    except web.HTTPException:
        raise
    except Exception as e:
        # Usually means bot has no access to chat member list.
        raise web.HTTPBadRequest(text="Бот не может проверить это задание. Добавьте бота в канал/группу (админ) или используйте ручную проверку.") from e

    # success: reward + mark completion + increment qty_done
    reward = float(task.get("reward_rub", 0))
    db.add_balance(user_id, rub_delta=reward)
    db.log_payment(user_id, "earn_task_tg", reward, "RUB", {"task_id": task_id, "subtype": subtype})
    db.record_completion(task_id, user_id)
    db.mark_task_done(task_id)

    # Push: notify user
    try:
        await bot.send_message(user_id, f"✅ Задание подтверждено! +{int(reward)} ₽ начислено.")
    except Exception:
        pass

    return web.json_response({"ok": True, "reward": reward}, headers=cors_headers(origin))


async def api_reviews_submit(request: web.Request):
    """
    Manual reviews: upload screenshot to Supabase Storage (bucket 'proofs') and create pending proof.
    Expects multipart/form-data:
      - initData
      - task_id
      - worker_name
      - file (image)
    """
    origin = request.headers.get("Origin")

    # We need initData from form, so parse multipart first
    reader = await request.multipart()
    fields = {}
    file_bytes = None
    file_name = None
    content_type = None

    async for part in reader:
        if part.name == "file":
            file_name = part.filename or "proof.jpg"
            content_type = part.headers.get("Content-Type", "application/octet-stream")
            file_bytes = await part.read(decode=False)
        else:
            fields[part.name] = await part.text()

    init_data = fields.get("initData")
    if not init_data:
        raise web.HTTPUnauthorized(text="Missing initData")

    ok, kv = verify_telegram_initdata(init_data, _require_env("BOT_TOKEN", BOT_TOKEN))
    if not ok:
        raise web.HTTPUnauthorized(text="Bad initData signature")
    user = extract_user_from_initdata(kv)
    if not user or "id" not in user:
        raise web.HTTPUnauthorized(text="No user in initData")
    user_id = int(user["id"])

    task_id = str(fields.get("task_id") or "").strip()
    worker_name = str(fields.get("worker_name") or "").strip()

    if not task_id or not worker_name or not file_bytes:
        raise web.HTTPBadRequest(text="task_id, worker_name, file required")

    task = db.get_task(task_id)
    if not task or task.get("status") != "active":
        raise web.HTTPNotFound(text="task not found / not active")

    if task["owner_id"] == user_id:
        raise web.HTTPForbidden(text="Нельзя выполнять свои задания")

    if db.has_completed(task_id, user_id):
        raise web.HTTPForbidden(text="Это задание уже выполнено вами")

    # cooldown check for ya/gm
    if task["type"] in ("ya", "gm"):
        ok_cd, remaining = db.check_cooldown(user_id, task["type"])
        if not ok_cd:
            raise web.HTTPForbidden(text=f"Лимит: попробуйте позже. Осталось ~{int(remaining/3600000)+1}ч")

    # upload to storage
    # Note: storage bucket must exist and allow service role uploads.
    path = f"{user_id}/{task_id}/{int(datetime.now().timestamp())}_{re.sub('[^a-zA-Z0-9._-]', '_', file_name or 'proof.jpg')}"
    try:
        storage = db.sb.storage.from_("proofs")
        storage.upload(path, file_bytes, {"content-type": content_type})
        public_url = storage.get_public_url(path)
    except Exception as e:
        raise web.HTTPInternalServerError(text="Upload failed. Check Supabase Storage bucket 'proofs'.") from e

    db.create_proof(task_id, user_id, worker_name, public_url)
    db.record_completion(task_id, user_id)  # prevents spam
    db.set_cooldown_now(user_id, task["type"])  # enforce ya/gm limits on submit
    # do NOT pay here; pay after admin approves

    # Push: notify admins
    for admin_id in ADMIN_IDS:
        try:
            await bot.send_message(admin_id, f"🧾 Новый отчет на проверку\nTask: {task.get('title')}\nUser: {user_id}\nНик: {worker_name}")
        except Exception:
            pass

    return web.json_response({"ok": True, "screenshotUrl": public_url}, headers=cors_headers(origin))


async def api_admin_queue(request: web.Request):
    origin = request.headers.get("Origin")
    user_id, _user, _kv = await require_init(request)
    if user_id not in ADMIN_IDS:
        raise web.HTTPForbidden(text="admin only")
    proofs = db.list_pending_proofs()
    withdrawals = db.list_withdrawals(user_id=None, pending_only=False)
    return web.json_response({"ok": True, "proofs": proofs, "withdrawals": withdrawals}, headers=cors_headers(origin))


async def api_admin_proof_decide(request: web.Request):
    origin = request.headers.get("Origin")
    admin_id, _user, _kv = await require_init(request)
    if admin_id not in ADMIN_IDS:
        raise web.HTTPForbidden(text="admin only")

    body = await json_in(request)
    proof_id = str(body.get("proof_id") or "").strip()
    approved = bool(body.get("approved"))

    p = db.resolve_proof(proof_id, approved, admin_id)
    task = db.get_task(p["task_id"]) or {}
    worker_id = int(p["worker_id"])
    reward = float(task.get("reward_rub", 0))

    if approved:
        db.add_balance(worker_id, rub_delta=reward)
        db.log_payment(worker_id, "earn_task_manual", reward, "RUB", {"task_id": p["task_id"], "proof_id": proof_id})
        db.mark_task_done(p["task_id"])
        try:
            await bot.send_message(worker_id, f"✅ Отчет принят! +{int(reward)} ₽ начислено.")
        except Exception:
            pass
    else:
        # allow user to retry later? You can remove completion record on reject if you want
        try:
            await bot.send_message(worker_id, "❌ Отчет отклонен. Попробуйте выполнить задание снова и отправьте новый скрин.")
        except Exception:
            pass

    return web.json_response({"ok": True}, headers=cors_headers(origin))


async def api_withdraw_create(request: web.Request):
    origin = request.headers.get("Origin")
    user_id, _user, _kv = await require_init(request)
    body = await json_in(request)
    amount = float(body.get("amount") or 0)
    details = str(body.get("details") or "").strip()

    if amount < 300:
        raise web.HTTPBadRequest(text="minimum 300")
    if not details:
        raise web.HTTPBadRequest(text="details required")

    u = db.get_user(user_id) or {}
    if float(u.get("balance_rub", 0)) < amount:
        raise web.HTTPForbidden(text="Недостаточно средств")

    db.add_balance(user_id, rub_delta=-amount)
    w = db.create_withdrawal(user_id, amount, details)
    db.log_payment(user_id, "withdraw_request", amount, "RUB", {"withdrawal_id": w["id"]})

    for admin_id in ADMIN_IDS:
        try:
            await bot.send_message(admin_id, f"📤 Заявка на вывод\nUser: {user_id}\nСумма: {amount}₽\nРеквизиты: {details}\nID: {w['id']}")
        except Exception:
            pass

    return web.json_response({"ok": True, "withdrawal": w}, headers=cors_headers(origin))


async def api_admin_withdraw_decide(request: web.Request):
    origin = request.headers.get("Origin")
    admin_id, _user, _kv = await require_init(request)
    if admin_id not in ADMIN_IDS:
        raise web.HTTPForbidden(text="admin only")

    body = await json_in(request)
    wid = str(body.get("withdrawal_id") or "").strip()
    approved = bool(body.get("approved"))

    w = db.set_withdrawal_status(wid, "paid" if approved else "rejected", admin_id)
    user_id = int(w["user_id"])
    amount = float(w["amount_rub"])

    if approved:
        try:
            await bot.send_message(user_id, f"✅ Выплата одобрена! Сумма {int(amount)}₽ будет отправлена по реквизитам.")
        except Exception:
            pass
    else:
        # refund
        db.add_balance(user_id, rub_delta=amount)
        db.log_payment(user_id, "withdraw_rejected_refund", amount, "RUB", {"withdrawal_id": wid})
        try:
            await bot.send_message(user_id, f"❌ Выплата отклонена. {int(amount)}₽ возвращены на баланс.")
        except Exception:
            pass

    return web.json_response({"ok": True}, headers=cors_headers(origin))


# payments: CryptoBot invoice create/check (for miniapp)
async def api_pay_crypto_create(request: web.Request):
    origin = request.headers.get("Origin")
    user_id, _user, _kv = await require_init(request)
    if not crypto:
        raise web.HTTPBadRequest(text="CryptoBot not configured")
    body = await json_in(request)
    amount_rub = float(body.get("amount") or 0)
    if amount_rub < 300:
        raise web.HTTPBadRequest(text="minimum 300")
    # very rough example rate; replace with a real rate fetch
    usdt = round(amount_rub / 95, 2)
    invoice = await crypto.create_invoice(asset="USDT", amount=usdt)
    # Store invoice in DB for later check
    db.sb.table("crypto_invoices").insert({
        "user_id": user_id,
        "invoice_id": invoice.invoice_id,
        "amount_rub": amount_rub,
        "amount_asset": usdt,
        "asset": "USDT",
        "status": "pending",
    }).execute()
    return web.json_response({"ok": True, "invoice_id": invoice.invoice_id, "pay_url": invoice.bot_invoice_url}, headers=cors_headers(origin))


async def api_pay_crypto_check(request: web.Request):
    origin = request.headers.get("Origin")
    user_id, _user, _kv = await require_init(request)
    if not crypto:
        raise web.HTTPBadRequest(text="CryptoBot not configured")
    body = await json_in(request)
    invoice_id = int(body.get("invoice_id") or 0)
    if not invoice_id:
        raise web.HTTPBadRequest(text="invoice_id required")

    invs = await crypto.get_invoices(invoice_ids=invoice_id)
    inv = invs[0] if isinstance(invs, list) else invs
    if inv.status != "paid":
        return web.json_response({"ok": True, "status": inv.status}, headers=cors_headers(origin))

    # idempotency: check DB
    row = db.sb.table("crypto_invoices").select("*").eq("invoice_id", invoice_id).limit(1).execute().data
    if not row:
        raise web.HTTPNotFound(text="invoice not found")
    row = row[0]
    if row.get("status") == "paid":
        return web.json_response({"ok": True, "status": "paid"}, headers=cors_headers(origin))

    amount_rub = float(row["amount_rub"])
    db.add_balance(user_id, rub_delta=amount_rub)
    db.log_payment(user_id, "deposit_crypto", amount_rub, "RUB", {"invoice_id": invoice_id})
    db.reward_referrer(user_id, amount_rub)
    db.sb.table("crypto_invoices").update({"status": "paid", "paid_at": now_utc().isoformat()}).eq("invoice_id", invoice_id).execute()

    try:
        await bot.send_message(user_id, f"✅ Крипто-платеж подтвержден! +{int(amount_rub)}₽ на баланс.")
    except Exception:
        pass

    return web.json_response({"ok": True, "status": "paid"}, headers=cors_headers(origin))


# Stars: create invoice from miniapp via API
async def api_pay_stars_invoice(request: web.Request):
    origin = request.headers.get("Origin")
    user_id, _user, _kv = await require_init(request)
    body = await json_in(request)
    amount_rub = float(body.get("amount") or 0)
    if amount_rub < 300:
        raise web.HTTPBadRequest(text="minimum 300")
    stars = max(int(amount_rub / STAR_PRICE_RUB), 1)

    await bot.send_invoice(
        chat_id=user_id,
        title="Пополнение баланса",
        description=f"Пополнение на {stars} Stars (~{amount_rub} RUB)",
        payload=f"stars_{stars}",
        currency="XTR",
        prices=[LabeledPrice(label="Stars", amount=stars)],
    )
    return web.json_response({"ok": True, "stars": stars}, headers=cors_headers(origin))


# ----------------- WEB SERVER -----------------
async def health(request: web.Request):
    origin = request.headers.get("Origin")
    return web.Response(text="OK", headers=cors_headers(origin))


def build_app() -> web.Application:
    app = web.Application()

    # CORS preflight
    app.router.add_route("OPTIONS", "/{tail:.*}", handle_options)

    # Health
    app.router.add_get("/health", health)

    # API
    app.router.add_post("/api/init", api_init)
    app.router.add_post("/api/tasks/list", api_tasks_list)
    app.router.add_post("/api/tasks/create", api_tasks_create)
    app.router.add_post("/api/tasks/complete_tg", api_tg_check_and_complete)

    app.router.add_post("/api/reviews/submit", api_reviews_submit)

    app.router.add_post("/api/withdraw/create", api_withdraw_create)

    app.router.add_post("/api/admin/queue", api_admin_queue)
    app.router.add_post("/api/admin/proof_decide", api_admin_proof_decide)
    app.router.add_post("/api/admin/withdraw_decide", api_admin_withdraw_decide)

    app.router.add_post("/api/pay/crypto/create", api_pay_crypto_create)
    app.router.add_post("/api/pay/crypto/check", api_pay_crypto_check)
    app.router.add_post("/api/pay/stars/invoice", api_pay_stars_invoice)

    return app


async def main():
    global bot, dp, db, crypto

    # Hard requirements
    token = _require_env("BOT_TOKEN", BOT_TOKEN)
    webapp_url = _require_env("WEBAPP_URL", WEBAPP_URL)
    sb_url = _require_env("SUPABASE_URL", SUPABASE_URL)
    sb_key = _require_env("SUPABASE_SERVICE_KEY", SUPABASE_SERVICE_KEY)

    bot = Bot(token)
    dp = Dispatcher()

    # (Re)register handlers (needed because decorators capture dp at import time if we created earlier)
    # We already created dp globally; rebuild not needed here.

    sb = create_client(sb_url, sb_key)
    db = DB(sb=sb)

    crypto = init_crypto()

    app = build_app()
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", PORT)
    await site.start()
    log.info("HTTP server started on port %s", PORT)

    await bot.delete_webhook(drop_pending_updates=True)
    log.info("Bot polling started")
    await dp.start_polling(bot)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:
        log.exception("Fatal error: %s", e)
        raise
