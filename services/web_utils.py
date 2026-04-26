import hmac
import hashlib
import json
import base64
import time
import logging
import re
from datetime import datetime, timezone
from aiohttp import web
from urllib.parse import parse_qsl

from config import BOT_TOKEN, ADMIN_IDS, MAIN_ADMIN_ID, WEBAPP_SESSION_SECRET, WEBAPP_SESSION_TTL_SEC
from database import sb, sb_select, sb_upsert, T_LIMITS, T_USERS, T_BAL

log = logging.getLogger("reviewcash")

# Global rate limit state
RATE_LIMIT_STATE = {}

def _now():
    return datetime.now(timezone.utc)

def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode("utf-8").rstrip("=")

def _b64url_decode(s: str) -> bytes:
    s = s.strip()
    pad = "=" * ((4 - len(s) % 4) % 4)
    return base64.urlsafe_b64decode((s + pad).encode("utf-8"))

def _make_session_token(user_id: int) -> str | None:
    secret = (WEBAPP_SESSION_SECRET or "").strip()
    if not secret:
        return None
    ts = int(time.time())
    payload = f"{user_id}:{ts}".encode("utf-8")
    sig = hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).digest()
    return _b64url(payload) + "." + _b64url(sig)

def _verify_session_token(token: str) -> int | None:
    secret = (WEBAPP_SESSION_SECRET or "").strip()
    if not secret:
        return None
    try:
        parts = token.strip().split(".")
        if len(parts) != 2:
            return None
        payload = _b64url_decode(parts[0])
        sig = _b64url_decode(parts[1])
        calc = hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).digest()
        if not hmac.compare_digest(calc, sig):
            return None
        txt = payload.decode("utf-8", errors="strict")
        uid_s, ts_s = txt.split(":", 1)
        uid = int(uid_s)
        ts = int(ts_s)
        if WEBAPP_SESSION_TTL_SEC > 0 and int(time.time()) - ts > WEBAPP_SESSION_TTL_SEC:
            return None
        return uid
    except Exception:
        return None

def _extract_session_token(req: web.Request) -> str | None:
    t = (req.headers.get("X-Session-Token") or "").strip()
    if t:
        return t
    auth = (req.headers.get("Authorization") or "").strip()
    if auth.lower().startswith("bearer "):
        return auth.split(" ", 1)[1].strip()
    return None

def verify_init_data(init_data: str, token: str) -> dict | None:
    if not init_data:
        return None
    token = (token or "").strip()
    if not token:
        return None
    try:
        pairs = dict(parse_qsl(init_data, keep_blank_values=True))
    except Exception:
        return None
    received_hash = pairs.pop("hash", None)
    if not received_hash:
        return None
    data_check_string = "\n".join(f"{k}={pairs[k]}" for k in sorted(pairs.keys()))
    secret_key = hmac.new(b"WebAppData", token.encode("utf-8"), hashlib.sha256).digest()
    calculated_hash = hmac.new(secret_key, data_check_string.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(calculated_hash, received_hash):
        return None
    if "user" in pairs:
        try:
            pairs["user"] = json.loads(pairs["user"])
        except Exception:
            pass
    return pairs

async def require_init(req: web.Request):
    from services.user_service import ensure_user
    from services.limits import get_global_ban_until, tg_evt_touch
    from services.telegram_utils import tg_check_required_subscription

    init_data = (
        (req.headers.get("X-Tg-Init-Data") or "")
        or (req.headers.get("X-Tg-InitData") or "")
        or (req.headers.get("X-Telegram-Init-Data") or "")
        or (req.headers.get("X-Tg-Initdata") or "")
        or (req.headers.get("X-Init-Data") or "")
        or (req.headers.get("X-Initdata") or "")
        or (req.headers.get("X-Telegram-WebApp-Init-Data") or "")
        or (req.query.get("initData") or "")
    ).strip()

    if init_data:
        parsed = verify_init_data(init_data, BOT_TOKEN or "")
        if parsed and isinstance(parsed.get("user"), dict):
            tg_user = parsed["user"]
            user = await ensure_user(tg_user)
            merged = {**user}
            merged.setdefault("id", int(tg_user.get("id")))
            merged.setdefault("user_id", int(tg_user.get("id")))
            merged.setdefault("username", tg_user.get("username"))
            merged.setdefault("first_name", tg_user.get("first_name"))
            merged.setdefault("last_name", tg_user.get("last_name"))
            merged.setdefault("photo_url", tg_user.get("photo_url"))

            uid = int(merged.get("id") or merged.get("user_id") or 0)
            if merged.get("is_banned"):
                raise web.HTTPForbidden(text=json.dumps({"ok": False, "error": "Аккаунт заблокирован"}), content_type="application/json")
            
            gban = await get_global_ban_until(uid)
            if gban:
                raise web.HTTPForbidden(text=json.dumps({"ok": False, "error": f"Временная блокировка до {gban.strftime('%Y-%m-%d %H:%M')} UTC"}), content_type="application/json")

            sub_ok, sub_chat, sub_msg = await tg_check_required_subscription(uid)
            if not sub_ok:
                raise web.HTTPForbidden(
                    text=json.dumps({
                        "ok": False,
                        "error": sub_msg or "Нужна подписка на канал",
                        "code": "REQUIRED_SUBSCRIPTION",
                        "channel": sub_chat,
                    }, ensure_ascii=False),
                    content_type="application/json",
                )

            try:
                await tg_evt_touch(uid, "miniapp_open")
            except Exception:
                pass
            return init_data, merged

    token = _extract_session_token(req)
    uid = _verify_session_token(token) if token else None
    if uid:
        await sb_upsert(T_USERS, {"user_id": uid}, on_conflict="user_id")
        await sb_upsert(T_BAL, {"user_id": uid}, on_conflict="user_id")
        rows = await sb_select(T_USERS, {"user_id": uid}, limit=1)
        u = (rows.data[0] if getattr(rows, "data", None) else None) or {"user_id": uid}
        user = {**u, "id": int(u.get("user_id") or uid), "user_id": int(u.get("user_id") or uid)}
        
        if user.get("is_banned"):
            raise web.HTTPForbidden(text=json.dumps({"ok": False, "error": "Аккаунт заблокирован"}), content_type="application/json")
        
        gban = await get_global_ban_until(uid)
        if gban:
            raise web.HTTPForbidden(text=json.dumps({"ok": False, "error": f"Временная блокировка до {gban.strftime('%Y-%m-%d %H:%M')} UTC"}), content_type="application/json")

        sub_ok, sub_chat, sub_msg = await tg_check_required_subscription(uid)
        if not sub_ok:
            raise web.HTTPForbidden(
                text=json.dumps({
                    "ok": False,
                    "error": sub_msg or "Нужна подписка на канал",
                    "code": "REQUIRED_SUBSCRIPTION",
                    "channel": sub_chat,
                }, ensure_ascii=False),
                content_type="application/json",
            )

        try:
            await tg_evt_touch(uid, "miniapp_open")
        except Exception:
            pass
        return None, user

    raise web.HTTPUnauthorized(text="No initData/session")

async def require_init_optional(req: web.Request):
    try:
        return await require_init(req)
    except web.HTTPUnauthorized:
        return None, None

async def require_admin(req: web.Request) -> dict:
    _, user = await require_init(req)
    uid = int(user["id"])
    if uid not in ADMIN_IDS and uid != MAIN_ADMIN_ID:
        raise web.HTTPForbidden(text="Admin only")
    return user

async def require_main_admin(req: web.Request) -> dict:
    _, user = await require_init(req)
    uid = int(user["id"])
    if uid != MAIN_ADMIN_ID:
        raise web.HTTPForbidden(text="Main admin only")
    return user

async def safe_json(req: web.Request) -> dict:
    try:
        return await req.json()
    except Exception:
        return {}

def get_ip(req: web.Request) -> str:
    xff = req.headers.get("X-Forwarded-For", "")
    if xff:
        return xff.split(",")[0].strip()
    return req.remote or ""

def json_error(status: int, error: str, code: str | None = None, **extra):
    data = {"ok": False, "error": error}
    if code: data["code"] = code
    data.update(extra)
    return web.json_response(data, status=status)

def rate_limit_enforce(uid: int, action: str, min_interval_sec: int = 60, spam_strikes: int = 3, block_sec: int = 600):
    now = time.time()
    key = (int(uid), str(action))
    st = RATE_LIMIT_STATE.get(key, {"last_ok": 0.0, "strikes": 0, "blocked_until": 0.0})
    if st.get("blocked_until", 0.0) > now:
        left = int(st["blocked_until"] - now)
        raise web.HTTPTooManyRequests(text=json.dumps({"ok": False, "error": f"Слишком часто. Блок {max(1, left // 60)} мин.", "code": "SPAM_BLOCK", "retry_after": left}), content_type="application/json")
    last_ok = float(st.get("last_ok", 0.0))
    if last_ok and (now - last_ok) < min_interval_sec:
        st["strikes"] = int(st.get("strikes", 0)) + 1
        left = int(min_interval_sec - (now - last_ok))
        if st["strikes"] >= spam_strikes:
            st["blocked_until"] = now + block_sec
            st["strikes"] = 0
            RATE_LIMIT_STATE[key] = st
            raise web.HTTPTooManyRequests(text=json.dumps({"ok": False, "error": "Слишком часто. Блок 10 минут.", "code": "SPAM_BLOCK", "retry_after": block_sec}), content_type="application/json")
        RATE_LIMIT_STATE[key] = st
        raise web.HTTPTooManyRequests(text=json.dumps({"ok": False, "error": f"Лимит: раз в 1 минуту. Осталось ~{left}с", "code": "RATE_LIMIT", "retry_after": left}), content_type="application/json")
    st["last_ok"] = now
    st["strikes"] = 0
    RATE_LIMIT_STATE[key] = st
