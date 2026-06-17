from datetime import datetime, timezone, timedelta
import logging
import asyncio
from aiohttp import web

from config import T_WD
from database import sb, sb_select
from services.balances import get_balance
from services.limits import get_withdraw_ban_until, get_limit_until
from services.redis_client import redis_client
from services.web_utils import require_init, safe_json
from api.payments import parse_amount_rub
from aiogram.enums import ParseMode
from services.telegram_utils import bot

log = logging.getLogger("reviewcash.withdraw")

def _now():
    return datetime.now(timezone.utc)

async def api_withdraw_create(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])

    # 1. Distributed Lock with TTL
    lock_key = f"withdraw_lock:{uid}"
    is_locked = await redis_client.set(lock_key, "1", ex=60, nx=True)
    if not is_locked:
        return web.json_response({"ok": False, "error": "Запрос уже обрабатывается. Подождите минуту."}, status=429)

    try:
        # Ban check
        wb = await get_withdraw_ban_until(uid)
        if wb:
            return web.json_response({"ok": False, "error": f"Выводы заблокированы до {wb.strftime('%Y-%m-%d %H:%M')}"}, status=403)

        body = await safe_json(req)
        amount = parse_amount_rub(body.get("amount_rub") or body.get("amount") or 0)
        if amount is None or amount < 300:
            return web.json_response({"ok": False, "error": "Минимум 300 ₽"}, status=400)

        full_name = str(body.get("full_name") or "").strip()
        payout_value = str(body.get("payout_value") or "").strip()
        payout_method = str(body.get("payout_method") or "").strip().lower()

        if not full_name or not payout_value:
            return web.json_response({"ok": False, "error": "Заполните все поля"}, status=400)

        details = f"{full_name} | {payout_method} | {payout_value}"

        # 2. Atomic Database Transaction via RPC
        # RPC should check balance >= amount inside Postgres
        rpc_res = await sb.rpc("withdraw_rub_atomic", {
            "p_user_id": uid,
            "p_amount": amount,
            "p_details": details,
            "p_username": user.get("username")
        }).execute()

        if not rpc_res.data or not rpc_res.data.get("ok"):
            err = rpc_res.data.get("error") if rpc_res.data else "Unknown RPC error"
            log.warning(f"Withdraw RPC failed for uid={uid}: {err}", extra={"user_id": uid})
            return web.json_response({"ok": False, "error": f"Ошибка: {err}"}, status=400)

        wd_id = rpc_res.data.get("withdrawal_id")
        
        try:
            await bot.send_message(
                chat_id=uid,
                text=f"🎉 Заявка №{wd_id} на **{amount}₽** создана! Ожидайте проверки.",
                parse_mode=ParseMode.MARKDOWN
            )
        except Exception as e:
            log.warning(f"Failed to notify user {uid} about withdrawal: {e}")

        return web.json_response({"ok": True, "withdrawal_id": wd_id})

    except Exception as e:
        log.exception(f"Critical withdraw failure for uid={uid}", extra={"user_id": uid})
        return web.json_response({"ok": False, "error": "Внутренняя ошибка сервера"}, status=500)
    finally:
        # 3. Explicit Lock Cleanup
        await redis_client.delete(lock_key)

async def api_withdraw_list(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    r = await sb_select(T_WD, {"user_id": uid}, order="created_at", desc=True, limit=50)
    return web.json_response({"ok": True, "withdrawals": r.data or []})
