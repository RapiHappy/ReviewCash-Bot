# bot.py
import os
import json
import hmac
import hashlib
import asyncio
import logging
import urllib.parse
from dataclasses import dataclass
from datetime import datetime, timezone, date
from typing import Any, Dict, Optional, List, Tuple

import asyncpg
from aiohttp import web

from aiogram import Bot, Dispatcher, F, Router
from aiogram.types import (
    Message, CallbackQuery,
    InlineKeyboardMarkup, InlineKeyboardButton,
    WebAppInfo, LabeledPrice
)
from aiogram.filters import Command

try:
    from aiocryptopay import AioCryptoPay, Networks
except Exception:
    AioCryptoPay = None
    Networks = None


# ----------------- CONFIG -----------------

@dataclass
class Config:
    bot_token: str
    database_url: str
    webhook_url: str              # e.g. https://your.onrender.com
    webhook_path: str             # e.g. /tg
    webapp_url: str               # URL of your Mini App (https://.../app/)
    port: int

    admin_ids: List[int]
    admin_basic_user: str
    admin_basic_pass: str

    # anti-fraud
    max_devices_per_user: int
    max_users_per_device: int

    # cooldowns in seconds (example: tg join tasks 1 day)
    cooldown_by_kind: Dict[str, int]

    # payments
    cryptobot_token: str
    cryptobot_network: str        # "MAIN_NET" usually
    stars_provider_token: str     # for Telegram Stars payments (if used)

    @staticmethod
    def from_env() -> "Config":
        def env(name: str, default: str = "") -> str:
            return os.getenv(name, default).strip()

        def env_int(name: str, default: int) -> int:
            v = os.getenv(name)
            return int(v) if v and v.strip() else default

        raw_admin = env("ADMIN_IDS", "")
        admin_ids = []
        if raw_admin:
            for x in raw_admin.split(","):
                x = x.strip()
                if x:
                    try:
                        admin_ids.append(int(x))
                    except ValueError:
                        pass

        cooldown_by_kind = {
            "tg_channel_join": env_int("COOLDOWN_TG_CHANNEL_JOIN", 24 * 3600),
            "tg_group_join": env_int("COOLDOWN_TG_GROUP_JOIN", 24 * 3600),
            "feedback": env_int("COOLDOWN_FEEDBACK", 12 * 3600),
        }

        return Config(
            bot_token=env("BOT_TOKEN"),
            database_url=env("DATABASE_URL"),
            webhook_url=env("WEBHOOK_URL", ""),   # if empty => polling mode
            webhook_path=env("WEBHOOK_PATH", "/tg"),
            webapp_url=env("WEBAPP_URL", ""),
            port=env_int("PORT", 10000),

            admin_ids=admin_ids,
            admin_basic_user=env("ADMIN_BASIC_USER", "admin"),
            admin_basic_pass=env("ADMIN_BASIC_PASS", "admin"),

            max_devices_per_user=env_int("MAX_DEVICES_PER_USER", 3),
            max_users_per_device=env_int("MAX_USERS_PER_DEVICE", 3),

            cooldown_by_kind=cooldown_by_kind,

            cryptobot_token=env("CRYPTOBOT_TOKEN", ""),
            cryptobot_network=env("CRYPTOBOT_NETWORK", "MAIN_NET"),
            stars_provider_token=env("STARS_PROVIDER_TOKEN", ""),  # optional
        )


# ----------------- LOGGING -----------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s"
)
log = logging.getLogger("reviewcash")


# ----------------- INITDATA VERIFICATION -----------------

def verify_telegram_initdata(init_data: str, bot_token: str) -> Tuple[bool, Dict[str, str]]:
    """
    Verifies initData signature (Telegram WebApp).
    Returns (ok, parsed_dict).
    """
    if not init_data or not bot_token:
        return False, {}

    parsed = dict(urllib.parse.parse_qsl(init_data, keep_blank_values=True))
    received_hash = parsed.get("hash", "")
    if not received_hash:
        return False, parsed

    # build data_check_string
    items = [(k, v) for k, v in parsed.items() if k != "hash"]
    items.sort(key=lambda x: x[0])
    data_check_string = "\n".join([f"{k}={v}" for k, v in items])

    secret_key = hashlib.sha256(bot_token.encode()).digest()
    computed_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()

    return hmac.compare_digest(computed_hash, received_hash), parsed


def extract_user_from_initdata(parsed: Dict[str, str]) -> Optional[Dict[str, Any]]:
    user_raw = parsed.get("user")
    if not user_raw:
        return None
    try:
        return json.loads(user_raw)
    except Exception:
        return None


# ----------------- DB -----------------

class DB:
    def __init__(self, dsn: str):
        self.dsn = dsn
        self.pool: Optional[asyncpg.Pool] = None

    async def connect(self):
        self.pool = await asyncpg.create_pool(self.dsn, min_size=1, max_size=10)
        log.info("DB pool connected")

    async def close(self):
        if self.pool:
            await self.pool.close()

    async def q(self, sql: str, *args):
        assert self.pool
        async with self.pool.acquire() as con:
            return await con.execute(sql, *args)

    async def fetch(self, sql: str, *args):
        assert self.pool
        async with self.pool.acquire() as con:
            return await con.fetch(sql, *args)

    async def fetchrow(self, sql: str, *args):
        assert self.pool
        async with self.pool.acquire() as con:
            return await con.fetchrow(sql, *args)

    async def upsert_user(self, u: Dict[str, Any], is_admin: bool):
        tg_user_id = int(u["id"])
        await self.q(
            """
            insert into users (tg_user_id, username, first_name, last_name, photo_url, is_admin, last_seen_at)
            values ($1,$2,$3,$4,$5,$6, now())
            on conflict (tg_user_id) do update set
              username=excluded.username,
              first_name=excluded.first_name,
              last_name=excluded.last_name,
              photo_url=excluded.photo_url,
              is_admin=users.is_admin or excluded.is_admin,
              last_seen_at=now()
            """,
            tg_user_id,
            u.get("username"),
            u.get("first_name"),
            u.get("last_name"),
            u.get("photo_url"),
            is_admin
        )

    async def register_device_and_check_limits(
        self,
        tg_user_id: int,
        device_id: str,
        max_devices_per_user: int,
        max_users_per_device: int
    ) -> Tuple[bool, str]:
        if not device_id:
            return False, "no_device_id"

        # insert device row
        await self.q(
            """
            insert into devices (device_id, tg_user_id, first_seen_at, last_seen_at)
            values ($1,$2, now(), now())
            on conflict (device_id, tg_user_id) do update set last_seen_at=now()
            """,
            device_id, tg_user_id
        )

        # count devices for this user
        r1 = await self.fetchrow(
            "select count(distinct device_id) as c from devices where tg_user_id=$1",
            tg_user_id
        )
        devices_cnt = int(r1["c"])
        if devices_cnt > max_devices_per_user:
            return False, f"device_limit_exceeded ({devices_cnt}>{max_devices_per_user})"

        # count users on this device
        r2 = await self.fetchrow(
            "select count(distinct tg_user_id) as c from devices where device_id=$1",
            device_id
        )
        users_cnt = int(r2["c"])
        if users_cnt > max_users_per_device:
            return False, f"multiaccount_limit_exceeded ({users_cnt}>{max_users_per_device})"

        return True, "ok"

    async def get_user(self, tg_user_id: int):
        return await self.fetchrow("select * from users where tg_user_id=$1", tg_user_id)

    async def add_balance(self, tg_user_id: int, amount_rub: int):
        await self.q("update users set balance_rub=balance_rub+$2 where tg_user_id=$1", tg_user_id, amount_rub)

    async def sub_balance(self, tg_user_id: int, amount_rub: int) -> bool:
        r = await self.fetchrow("select balance_rub from users where tg_user_id=$1", tg_user_id)
        if not r:
            return False
        if int(r["balance_rub"]) < amount_rub:
            return False
        await self.q("update users set balance_rub=balance_rub-$2 where tg_user_id=$1", tg_user_id, amount_rub)
        return True

    async def list_tasks(self, only_active: bool = True, limit: int = 50):
        if only_active:
            return await self.fetch(
                """
                select * from tasks
                where status='active' and qty_left>0
                order by id desc
                limit $1
                """,
                limit
            )
        return await self.fetch("select * from tasks order by id desc limit $1", limit)

    async def create_task(self, owner_tg_id: int, kind: str, title: str, target: str, instruction: str, reward_rub: int, qty: int):
        row = await self.fetchrow(
            """
            insert into tasks (owner_tg_id, kind, title, target, instruction, reward_rub, qty_total, qty_left, status)
            values ($1,$2,$3,$4,$5,$6,$7,$7,'active')
            returning *
            """,
            owner_tg_id, kind, title, target, instruction, reward_rub, qty
        )
        return row

    async def can_do_kind(self, worker_tg_id: int, kind: str, cooldown_seconds: int) -> Tuple[bool, int]:
        r = await self.fetchrow("select last_done_at from limits where worker_tg_id=$1 and kind=$2", worker_tg_id, kind)
        if not r:
            return True, 0
        last = r["last_done_at"]
        now = datetime.now(timezone.utc)
        diff = (now - last).total_seconds()
        remain = int(max(0, cooldown_seconds - diff))
        return remain == 0, remain

    async def record_done_kind(self, worker_tg_id: int, kind: str):
        await self.q(
            """
            insert into limits (worker_tg_id, kind, last_done_at)
            values ($1,$2, now())
            on conflict (worker_tg_id, kind) do update set last_done_at=now()
            """,
            worker_tg_id, kind
        )

    async def create_claim(self, task_id: int, worker_tg_id: int) -> Tuple[bool, str]:
        try:
            await self.q(
                "insert into claims (task_id, worker_tg_id, status) values ($1,$2,'pending')",
                task_id, worker_tg_id
            )
        except asyncpg.UniqueViolationError:
            return False, "already_claimed"

        # decrement qty_left
        await self.q(
            "update tasks set qty_left=qty_left-1 where id=$1 and qty_left>0",
            task_id
        )
        return True, "ok"

    async def set_claim_status(self, claim_id: int, status: str, proof_json: Optional[Dict[str, Any]] = None):
        await self.q(
            "update claims set status=$2, proof_json=$3::jsonb, updated_at=now() where id=$1",
            claim_id, status, json.dumps(proof_json or {})
        )

    async def list_pending_claims(self, limit: int = 50):
        return await self.fetch(
            """
            select c.*, t.title, t.kind, t.target, t.reward_rub
            from claims c
            join tasks t on t.id=c.task_id
            where c.status='pending'
            order by c.id desc
            limit $1
            """,
            limit
        )

    async def create_withdrawal(self, tg_user_id: int, amount_rub: int, details: str):
        row = await self.fetchrow(
            """
            insert into withdrawals (tg_user_id, amount_rub, details, status)
            values ($1,$2,$3,'pending')
            returning *
            """,
            tg_user_id, amount_rub, details
        )
        return row

    async def list_withdrawals(self, status: Optional[str] = None, limit: int = 50):
        if status:
            return await self.fetch("select * from withdrawals where status=$1 order by id desc limit $2", status, limit)
        return await self.fetch("select * from withdrawals order by id desc limit $1", limit)

    async def set_withdrawal_status(self, wid: int, status: str):
        await self.q("update withdrawals set status=$2, updated_at=now() where id=$1", wid, status)

    async def users_for_push(self) -> List[int]:
        rows = await self.fetch("select tg_user_id from users where notifications=true and is_banned=false")
        return [int(r["tg_user_id"]) for r in rows]


# ----------------- BOT UI -----------------

def kb_main(webapp_url: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="🚀 Открыть приложение", web_app=WebAppInfo(url=webapp_url))],
        [InlineKeyboardButton(text="💳 Пополнить", callback_data="topup"),
         InlineKeyboardButton(text="🏦 Вывод", callback_data="withdraw")],
        [InlineKeyboardButton(text="🔔 Уведомления", callback_data="toggle_notif")]
    ])


def kb_admin() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="🛡️ Pending proofs", callback_data="admin_claims")],
        [InlineKeyboardButton(text="🏦 Pending withdrawals", callback_data="admin_withdraws")],
    ])


# ----------------- APP ACTIONS (from Mini App) -----------------

# The Mini App sends tg.sendData(JSON.stringify(payload))
# We require payload.initData and payload.deviceId
#
# payload examples:
# { action:"auth", initData:"...", deviceId:"..." }
# { action:"create_task", initData:"...", deviceId:"...", kind:"tg_channel_join", title:"...", target:"https://t.me/...", instruction:"...", reward:15, qty:10 }
# { action:"list_tasks", initData:"...", deviceId:"..." }
# { action:"claim_task", initData:"...", deviceId:"...", taskId:123 }
# { action:"withdraw_request", initData:"...", deviceId:"...", amount:300, details:"карта/тел" }

ALLOWED_KINDS = {"tg_channel_join", "tg_group_join", "feedback"}


# ----------------- TELEGRAM AUTO CHECK -----------------

def parse_t_me_target(target: str) -> Optional[str]:
    """
    Returns chat username or invite? We support only @username / t.me/username for auto-check.
    For private invites auto-check is not reliable.
    """
    if not target:
        return None
    t = target.strip()
    # allow "https://t.me/username" or "t.me/username" or "@username"
    if t.startswith("@"):
        return t[1:]
    if "t.me/" in t:
        # strip query
        t = t.split("?")[0]
        username = t.split("t.me/")[-1].strip("/")
        if username and not username.startswith("+"):
            return username
    return None


async def check_membership(bot: Bot, chat_username: str, user_id: int) -> bool:
    """
    True if member (not left/kicked). Requires bot access to chat.
    """
    try:
        cm = await bot.get_chat_member(chat_id=f"@{chat_username}", user_id=user_id)
        status = getattr(cm, "status", None)
        return status in ("member", "administrator", "creator")
    except Exception:
        return False


# ----------------- STATS -----------------

async def bump_daily(db: DB, field: str, delta: int = 1):
    today = date.today()
    # upsert stats row
    await db.q(
        """
        insert into stats_daily(day, revenue_rub, payout_rub, tasks_created, tasks_done, users_active)
        values ($1,0,0,0,0,0)
        on conflict (day) do nothing
        """,
        today
    )
    await db.q(f"update stats_daily set {field}={field}+$2 where day=$1", today, delta)


# ----------------- WEB ADMIN (aiohttp) -----------------

def basic_auth_ok(request: web.Request, user: str, pwd: str) -> bool:
    hdr = request.headers.get("Authorization", "")
    if not hdr.startswith("Basic "):
        return False
    import base64
    try:
        raw = base64.b64decode(hdr.split(" ", 1)[1]).decode()
        u, p = raw.split(":", 1)
        return hmac.compare_digest(u, user) and hmac.compare_digest(p, pwd)
    except Exception:
        return False


async def handle_admin(request: web.Request) -> web.Response:
    app = request.app
    cfg: Config = app["cfg"]
    db: DB = app["db"]

    if not basic_auth_ok(request, cfg.admin_basic_user, cfg.admin_basic_pass):
        return web.Response(status=401, headers={"WWW-Authenticate": 'Basic realm="admin"'}, text="Auth required")

    tasks = await db.fetch("select count(*) c from tasks")
    users = await db.fetch("select count(*) c from users")
    pend_claims = await db.fetch("select count(*) c from claims where status='pending'")
    pend_wd = await db.fetch("select count(*) c from withdrawals where status='pending'")

    rows = await db.fetch(
        "select * from stats_daily order by day desc limit 14"
    )
    stats_html = "".join(
        f"<tr><td>{r['day']}</td><td>{r['revenue_rub']}</td><td>{r['payout_rub']}</td><td>{r['tasks_created']}</td><td>{r['tasks_done']}</td><td>{r['users_active']}</td></tr>"
        for r in rows
    )

    html = f"""
    <html><head><meta charset="utf-8"><title>Admin</title></head>
    <body style="font-family:Arial;padding:20px">
      <h2>ReviewCash Admin</h2>
      <ul>
        <li>Users: {int(users[0]['c'])}</li>
        <li>Tasks: {int(tasks[0]['c'])}</li>
        <li>Pending claims: {int(pend_claims[0]['c'])}</li>
        <li>Pending withdrawals: {int(pend_wd[0]['c'])}</li>
      </ul>

      <h3>Stats (last 14 days)</h3>
      <table border="1" cellpadding="6" cellspacing="0">
        <tr><th>Day</th><th>Revenue</th><th>Payout</th><th>Created</th><th>Done</th><th>Active users</th></tr>
        {stats_html}
      </table>

      <p>Tip: add endpoints for approving claims/withdrawals here if you want full web moderation.</p>
    </body></html>
    """
    return web.Response(text=html, content_type="text/html")


# ----------------- MAIN BOT LOGIC -----------------

router = Router()

async def push_all(bot: Bot, db: DB, text: str):
    ids = await db.users_for_push()
    for uid in ids:
        try:
            await bot.send_message(uid, text)
        except Exception:
            pass

@router.message(Command("start"))
async def cmd_start(m: Message, bot: Bot, db: DB, cfg: Config):
    u = m.from_user
    if not u:
        return

    is_admin = int(u.id) in cfg.admin_ids
    await db.upsert_user(
        {
            "id": u.id,
            "username": u.username,
            "first_name": u.first_name,
            "last_name": u.last_name,
            "photo_url": None,
        },
        is_admin=is_admin
    )

    text = (
        "👋 Привет! Это ReviewCash.\n\n"
        "✅ Тут можно выполнять задания и получать баланс.\n"
        "🚀 Открывай приложение кнопкой ниже.\n\n"
        "⚠️ Важно: авто-проверка работает только для Telegram-заданий, где бот может проверить участие (getChatMember).\n"
    )
    kb = kb_main(cfg.webapp_url) if cfg.webapp_url else None
    await m.answer(text, reply_markup=kb)
    if is_admin:
        await m.answer("🛡️ Ты админ.", reply_markup=kb_admin())
    await bump_daily(db, "users_active", 1)

@router.callback_query(F.data == "toggle_notif")
async def toggle_notif(c: CallbackQuery, db: DB):
    uid = c.from_user.id
    r = await db.fetchrow("select notifications from users where tg_user_id=$1", uid)
    if not r:
        await c.answer("Сначала нажми /start", show_alert=True)
        return
    newv = not bool(r["notifications"])
    await db.q("update users set notifications=$2 where tg_user_id=$1", uid, newv)
    await c.answer("🔔 Уведомления: " + ("ON" if newv else "OFF"), show_alert=True)

@router.callback_query(F.data == "admin_claims")
async def admin_claims(c: CallbackQuery, bot: Bot, db: DB, cfg: Config):
    if int(c.from_user.id) not in cfg.admin_ids:
        await c.answer("Нет доступа", show_alert=True)
        return
    rows = await db.list_pending_claims()
    if not rows:
        await c.message.answer("Pending proofs: пусто ✅")
        await c.answer()
        return
    # show top 10
    msg = "🛡️ Pending proofs:\n\n"
    for r in rows[:10]:
        msg += f"claim_id={r['id']} | user={r['worker_tg_id']} | task={r['title']} | reward={r['reward_rub']}₽\n"
    msg += "\nКоманды:\n/approve_claim <claim_id>\n/reject_claim <claim_id>"
    await c.message.answer(msg)
    await c.answer()

@router.callback_query(F.data == "admin_withdraws")
async def admin_withdraws(c: CallbackQuery, db: DB, cfg: Config):
    if int(c.from_user.id) not in cfg.admin_ids:
        await c.answer("Нет доступа", show_alert=True)
        return
    rows = await db.list_withdrawals(status="pending")
    if not rows:
        await c.message.answer("Pending withdrawals: пусто ✅")
        await c.answer()
        return
    msg = "🏦 Pending withdrawals:\n\n"
    for w in rows[:10]:
        msg += f"id={w['id']} | user={w['tg_user_id']} | {w['amount_rub']}₽ | {w['details']}\n"
    msg += "\nКоманды:\n/pay_withdraw <id>\n/reject_withdraw <id>"
    await c.message.answer(msg)
    await c.answer()

@router.message(Command("approve_claim"))
async def approve_claim(m: Message, bot: Bot, db: DB, cfg: Config):
    if int(m.from_user.id) not in cfg.admin_ids:
        return
    parts = m.text.split()
    if len(parts) != 2:
        await m.answer("Usage: /approve_claim <claim_id>")
        return
    cid = int(parts[1])
    r = await db.fetchrow("select * from claims where id=$1", cid)
    if not r:
        await m.answer("Not found")
        return
    if r["status"] != "pending":
        await m.answer("Already processed")
        return

    # payout
    task = await db.fetchrow("select * from tasks where id=$1", int(r["task_id"]))
    reward = int(task["reward_rub"]) if task else 0
    await db.add_balance(int(r["worker_tg_id"]), reward)
    await db.set_claim_status(cid, "approved", proof_json=r["proof_json"] or {})
    await bump_daily(db, "tasks_done", 1)
    await bump_daily(db, "payout_rub", reward)

    await m.answer(f"✅ Approved claim {cid}, +{reward}₽ user {r['worker_tg_id']}")
    try:
        await bot.send_message(int(r["worker_tg_id"]), f"✅ Задание подтверждено! Начислено +{reward}₽")
    except Exception:
        pass

@router.message(Command("reject_claim"))
async def reject_claim(m: Message, bot: Bot, db: DB, cfg: Config):
    if int(m.from_user.id) not in cfg.admin_ids:
        return
    parts = m.text.split()
    if len(parts) != 2:
        await m.answer("Usage: /reject_claim <claim_id>")
        return
    cid = int(parts[1])
    r = await db.fetchrow("select * from claims where id=$1", cid)
    if not r:
        await m.answer("Not found")
        return
    if r["status"] != "pending":
        await m.answer("Already processed")
        return
    await db.set_claim_status(cid, "rejected", proof_json=r["proof_json"] or {})
    await m.answer(f"❌ Rejected claim {cid}")
    try:
        await bot.send_message(int(r["worker_tg_id"]), "❌ Отчет отклонен админом.")
    except Exception:
        pass

@router.message(Command("pay_withdraw"))
async def pay_withdraw(m: Message, bot: Bot, db: DB, cfg: Config):
    if int(m.from_user.id) not in cfg.admin_ids:
        return
    parts = m.text.split()
    if len(parts) != 2:
        await m.answer("Usage: /pay_withdraw <id>")
        return
    wid = int(parts[1])
    w = await db.fetchrow("select * from withdrawals where id=$1", wid)
    if not w:
        await m.answer("Not found")
        return
    if w["status"] != "pending":
        await m.answer("Already processed")
        return
    await db.set_withdrawal_status(wid, "paid")
    await m.answer(f"✅ Withdrawal {wid} marked as PAID")
    try:
        await bot.send_message(int(w["tg_user_id"]), f"✅ Ваша выплата {int(w['amount_rub'])}₽ одобрена и отправлена!")
    except Exception:
        pass

@router.message(Command("reject_withdraw"))
async def reject_withdraw(m: Message, bot: Bot, db: DB, cfg: Config):
    if int(m.from_user.id) not in cfg.admin_ids:
        return
    parts = m.text.split()
    if len(parts) != 2:
        await m.answer("Usage: /reject_withdraw <id>")
        return
    wid = int(parts[1])
    w = await db.fetchrow("select * from withdrawals where id=$1", wid)
    if not w:
        await m.answer("Not found")
        return
    if w["status"] != "pending":
        await m.answer("Already processed")
        return
    # refund
    await db.add_balance(int(w["tg_user_id"]), int(w["amount_rub"]))
    await db.set_withdrawal_status(wid, "rejected")
    await m.answer(f"❌ Withdrawal {wid} rejected, refunded")
    try:
        await bot.send_message(int(w["tg_user_id"]), f"❌ Выплата отклонена. Средства возвращены: +{int(w['amount_rub'])}₽")
    except Exception:
        pass


@router.message(F.web_app_data)
async def on_webapp_data(m: Message, bot: Bot, db: DB, cfg: Config):
    """
    Receives payload from tg.sendData(...) from your Mini App.
    """
    uid = m.from_user.id
    try:
        payload = json.loads(m.web_app_data.data)
    except Exception:
        await m.answer("❌ Invalid payload")
        return

    action = payload.get("action")
    init_data = payload.get("initData", "")
    device_id = payload.get("deviceId", "")

    ok, parsed = verify_telegram_initdata(init_data, cfg.bot_token)
    if not ok:
        await m.answer("❌ initData signature invalid")
        return

    iu = extract_user_from_initdata(parsed)
    if not iu or int(iu.get("id", 0)) != int(uid):
        await m.answer("❌ initData user mismatch")
        return

    is_admin = int(uid) in cfg.admin_ids
    await db.upsert_user(iu, is_admin=is_admin)

    # anti-fraud
    ok2, reason = await db.register_device_and_check_limits(
        tg_user_id=int(uid),
        device_id=str(device_id),
        max_devices_per_user=cfg.max_devices_per_user,
        max_users_per_device=cfg.max_users_per_device
    )
    if not ok2:
        await m.answer(f"🚫 Доступ ограничен: {reason}")
        return

    if action == "auth":
        me = await db.get_user(int(uid))
        await m.answer(
            f"✅ Авторизация ок.\nБаланс: {int(me['balance_rub'])}₽\nУведомления: {'ON' if me['notifications'] else 'OFF'}"
        )
        return

    if action == "list_tasks":
        tasks = await db.list_tasks(only_active=True, limit=50)
        # In real app you'd return JSON back to Mini App via server;
        # In Telegram WebApp data flow, easiest is to respond in chat.
        # But your MiniApp can also maintain UI list client-side.
        text = "📋 Доступные задания:\n\n"
        for t in tasks[:20]:
            text += f"#{t['id']} | {t['title']} | {t['reward_rub']}₽ | left {t['qty_left']}\n"
        await m.answer(text)
        return

    if action == "create_task":
        kind = str(payload.get("kind", "")).strip()
        if kind not in ALLOWED_KINDS:
            await m.answer("❌ kind not allowed")
            return

        title = str(payload.get("title", "")).strip()[:80] or "Задание"
        target = str(payload.get("target", "")).strip()[:400]
        instruction = str(payload.get("instruction", "")).strip()[:1500]
        reward = int(payload.get("reward", 0))
        qty = int(payload.get("qty", 1))

        if reward <= 0 or qty <= 0:
            await m.answer("❌ reward/qty invalid")
            return

        # owner pays = reward * qty
        total_cost = reward * qty
        okpay = await db.sub_balance(int(uid), total_cost)
        if not okpay:
            await m.answer(f"❌ Недостаточно средств. Нужно {total_cost}₽")
            return

        row = await db.create_task(int(uid), kind, title, target, instruction, reward, qty)
        await bump_daily(db, "tasks_created", 1)
        await bump_daily(db, "revenue_rub", total_cost)

        await m.answer(f"✅ Задание создано: #{row['id']} (списано {total_cost}₽)")
        # push
        await push_all(bot, db, f"🆕 Новое задание: {title} (+{reward}₽)")
        return

    if action == "claim_task":
        task_id = int(payload.get("taskId", 0))
        t = await db.fetchrow("select * from tasks where id=$1", task_id)
        if not t or t["status"] != "active" or int(t["qty_left"]) <= 0:
            await m.answer("❌ Task not available")
            return

        kind = str(t["kind"])
        cooldown = int(cfg.cooldown_by_kind.get(kind, 0))
        okc, remain = await db.can_do_kind(int(uid), kind, cooldown)
        if not okc:
            await m.answer(f"⏳ Лимит на выполнение: доступно через {remain//3600}ч {remain%3600//60}м")
            return

        ok_claim, reason = await db.create_claim(task_id, int(uid))
        if not ok_claim:
            await m.answer("❌ Уже выполняешь/выполнял это задание")
            return

        await m.answer(f"✅ Ты взял задание #{task_id}. Нажми 'Проверить' в приложении/выполни шаги.")
        return

    if action == "check_tg_task":
        # auto-check for tg_channel_join / tg_group_join
        task_id = int(payload.get("taskId", 0))
        t = await db.fetchrow("select * from tasks where id=$1", task_id)
        if not t:
            await m.answer("❌ Task not found")
            return
        kind = str(t["kind"])
        if kind not in ("tg_channel_join", "tg_group_join"):
            await m.answer("❌ Auto-check not supported for this kind")
            return

        chat_username = parse_t_me_target(str(t["target"] or ""))
        if not chat_username:
            await m.answer("❌ Нужна ссылка формата t.me/username (публичный чат/канал)")
            return

        is_member = await check_membership(bot, chat_username, int(uid))
        if not is_member:
            await m.answer("❌ Не вижу подписку/участие. Убедись что ты вступил и что бот имеет доступ к чату.")
            return

        # approve by creating a claim if not exists? Here we approve pending claim for this user+task.
        claim = await db.fetchrow(
            "select * from claims where task_id=$1 and worker_tg_id=$2",
            task_id, int(uid)
        )
        if not claim:
            await m.answer("❌ Сначала возьми задание (claim)")
            return
        if claim["status"] != "pending":
            await m.answer(f"ℹ️ Уже обработано: {claim['status']}")
            return

        reward = int(t["reward_rub"])
        await db.add_balance(int(uid), reward)
        await db.set_claim_status(int(claim["id"]), "approved", proof_json={"auto": True, "checked": "getChatMember"})
        await db.record_done_kind(int(uid), kind)
        await bump_daily(db, "tasks_done", 1)
        await bump_daily(db, "payout_rub", reward)

        await m.answer(f"✅ Проверено автоматически! Начислено +{reward}₽")
        return

    if action == "withdraw_request":
        amount = int(payload.get("amount", 0))
        details = str(payload.get("details", "")).strip()[:200]

        if amount < 300:
            await m.answer("❌ Минимальный вывод: 300₽")
            return
        if not details:
            await m.answer("❌ Укажи реквизиты")
            return

        okpay = await db.sub_balance(int(uid), amount)
        if not okpay:
            await m.answer("❌ Недостаточно средств")
            return

        w = await db.create_withdrawal(int(uid), amount, details)
        await m.answer(f"✅ Заявка на вывод создана: #{w['id']} ({amount}₽)")
        # notify admins
        for aid in cfg.admin_ids:
            try:
                await bot.send_message(aid, f"🏦 New withdrawal #{w['id']} user={uid} amount={amount} details={details}")
            except Exception:
                pass
        return

    if action == "topup_cryptobot":
        if not cfg.cryptobot_token or not AioCryptoPay:
            await m.answer("❌ CryptoBot not configured")
            return
        amount = int(payload.get("amount", 0))
        if amount < 300:
            await m.answer("❌ Минимум 300₽")
            return

        # create invoice in CryptoBot (USDT etc)
        crypto = AioCryptoPay(token=cfg.cryptobot_token, network=Networks.MAIN_NET)
        inv = await crypto.create_invoice(asset="USDT", amount=round(amount / 100, 2), description=f"Topup {uid}")
        await db.q(
            "insert into payments (tg_user_id, provider, provider_invoice, amount_rub, status, payload_json) values ($1,'cryptobot',$2,$3,'pending',$4::jsonb)",
            int(uid), str(inv.invoice_id), amount, json.dumps(inv.model_dump())
        )
        await m.answer(f"💳 CryptoBot invoice создан.\nОплати: {inv.pay_url}")
        return

    if action == "topup_stars":
        # Telegram Stars invoices require provider token or special flow depending on setup.
        # Here is a minimal invoice example; you'll need a valid STARS_PROVIDER_TOKEN.
        if not cfg.stars_provider_token:
            await m.answer("❌ Stars not configured (STARS_PROVIDER_TOKEN)")
            return
        amount = int(payload.get("amount", 0))
        if amount < 300:
            await m.answer("❌ Минимум 300₽")
            return

        prices = [LabeledPrice(label="Пополнение баланса", amount=amount * 100)]  # in smallest units
        await bot.send_invoice(
            chat_id=uid,
            title="Пополнение баланса",
            description="Пополнение через Stars",
            payload=f"topup:{uid}:{amount}:{int(datetime.now().timestamp())}",
            provider_token=cfg.stars_provider_token,
            currency="RUB",
            prices=prices
        )
        await m.answer("⭐ Отправил счет Stars.")
        return

    await m.answer("❌ Unknown action")


@router.message(F.successful_payment)
async def on_success_payment(m: Message, db: DB):
    """
    Telegram payment success handler.
    """
    uid = m.from_user.id
    sp = m.successful_payment
    # payload looks like: topup:uid:amount:ts
    amount_rub = 0
    try:
        parts = sp.invoice_payload.split(":")
        amount_rub = int(parts[2])
    except Exception:
        pass
    if amount_rub > 0:
        await db.add_balance(uid, amount_rub)
        await bump_daily(db, "revenue_rub", amount_rub)
        await m.answer(f"✅ Оплата получена. Баланс пополнен на {amount_rub}₽")


# ----------------- APP SERVER + BOT RUN -----------------

async def setup_webhook(bot: Bot, cfg: Config):
    if not cfg.webhook_url:
        return
    url = cfg.webhook_url.rstrip("/") + cfg.webhook_path
    await bot.set_webhook(url)
    log.info("Webhook set: %s", url)

async def delete_webhook(bot: Bot):
    try:
        await bot.delete_webhook(drop_pending_updates=True)
    except Exception:
        pass

async def create_aiohttp_app(cfg: Config, bot: Bot, dp: Dispatcher, db: DB) -> web.Application:
    app = web.Application()
    app["cfg"] = cfg
    app["bot"] = bot
    app["dp"] = dp
    app["db"] = db

    # Telegram webhook handler (if enabled)
    async def tg_webhook(request: web.Request) -> web.Response:
        update = await request.json()
        from aiogram.types import Update
        await dp.feed_update(bot, Update.model_validate(update))
        return web.Response(text="ok")

    # routes
    app.router.add_get("/admin", handle_admin)
    if cfg.webhook_url:
        app.router.add_post(cfg.webhook_path, tg_webhook)

    # health
    async def health(_):
        return web.Response(text="ok")
    app.router.add_get("/health", health)

    return app

def ensure_env(cfg: Config):
    if not cfg.bot_token:
        raise RuntimeError("BOT_TOKEN is not set")
    if not cfg.database_url:
        raise RuntimeError("DATABASE_URL is not set")
    if cfg.webapp_url and not (cfg.webapp_url.startswith("https://") or cfg.webapp_url.startswith("http://")):
        raise RuntimeError("WEBAPP_URL must be a full URL")

async def main():
    cfg = Config.from_env()
    ensure_env(cfg)

    bot = Bot(cfg.bot_token)
    dp = Dispatcher()
    db = DB(cfg.database_url)

    await db.connect()

    # inject deps into handlers
    dp.include_router(router)
    dp["db"] = db
    dp["cfg"] = cfg

    # aiogram dependency injection style:
    # We pass them via middleware-like simple partials using lambda in handler signature.
    # Easiest: set as globals by using dp.workflow_data:
    dp.workflow_data.update({"db": db, "cfg": cfg})

    # start mode
    if cfg.webhook_url:
        await setup_webhook(bot, cfg)
        app = await create_aiohttp_app(cfg, bot, dp, db)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "0.0.0.0", cfg.port)
        await site.start()
        log.info("Web server started on port %s", cfg.port)
        # keep running
        await asyncio.Event().wait()
    else:
        # polling mode (no port)
        await delete_webhook(bot)
        log.info("Starting polling mode")
        await dp.start_polling(bot, db=db, cfg=cfg)

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:
        log.exception("Fatal: %s", e)
        raise
