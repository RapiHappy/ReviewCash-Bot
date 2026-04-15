from datetime import datetime, timezone, timedelta
import math
import re
import json
import base64
import logging
import asyncio
from typing import Any
from aiohttp import web

from config import *
from database import *
from services.balances import *
from services.limits import *
from services.telegram_utils import *
import logging
from aiohttp import web
import json
import base64
import asyncio

# The main.py will later import these and inject missing dependencies
# or they will import from main/config/services properly.
from main import *
from api.task_helpers import *
async def api_withdraw_create(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])

    # Ban from withdrawals (admin)
    wb = await get_withdraw_ban_until(uid)
    if wb:
        return web.json_response({"ok": False, "error": f"Выводы временно заблокированы до {wb.strftime('%Y-%m-%d %H:%M')} UTC"}, status=403)

    # Withdrawals only on Mon/Wed/Sat/Sun (Moscow time). Admins can bypass.
    try:
        if int(uid) not in ADMIN_IDS:
            msk = timezone(timedelta(hours=3))
            wd = datetime.now(msk).weekday()  # Mon=0 ... Sun=6
            if wd not in (0, 2, 5, 6):
                return web.json_response({"ok": False, "error": "Заявки на вывод принимаются только по понедельникам, средам, субботам и воскресеньям."}, status=400)
    except Exception:
        pass

    body = await safe_json(req)

    amount = parse_amount_rub(body.get("amount_rub") or body.get("amount") or body.get("sum") or body.get("value") or body.get("rub"))
    if amount is None:
        return web.json_response({"ok": False, "error": "Некорректная сумма"}, status=400)

    full_name = str(body.get("full_name") or body.get("fio") or body.get("name") or "").strip()
    payout_value = str(body.get("payout_value") or body.get("phone") or body.get("card") or body.get("wallet") or body.get("requisites") or body.get("requisites_text") or body.get("details") or "").strip()
    payout_method = str(body.get("payout_method") or "").strip().lower()

    if amount < 300:
        return web.json_response({"ok": False, "error": "Минимальная сумма для вывода — 300 ₽"}, status=400)
    if not full_name or len(full_name) < 5 or " " not in full_name:
        return web.json_response({"ok": False, "error": "Укажи имя и фамилию"}, status=400)
    if not payout_value:
        return web.json_response({"ok": False, "error": "Укажи номер телефона или карты"}, status=400)

    normalized = "".join(ch for ch in payout_value if ch.isdigit())
    if payout_method == "phone":
        if len(normalized) < 10:
            return web.json_response({"ok": False, "error": "Некорректный номер телефона"}, status=400)
    elif payout_method == "card":
        if len(normalized) < 16:
            return web.json_response({"ok": False, "error": "Некорректный номер карты"}, status=400)
    else:
        if len(normalized) < 10:
            return web.json_response({"ok": False, "error": "Укажи корректный номер телефона или карты"}, status=400)
        payout_method = "card" if len(normalized) >= 16 else "phone"

    details = f"{full_name} | {payout_method} | {payout_value}"

    first_withdraw_done = await get_limit_until(uid, FIRST_WITHDRAW_DONE_KEY)
    if not first_withdraw_done:
        paid = await sb_select(T_COMP, {"user_id": uid, "status": "paid"}, limit=FIRST_WITHDRAW_MIN_PAID_TASKS)
        paid_count = len(paid.data or [])
        if paid_count < max(1, FIRST_WITHDRAW_MIN_PAID_TASKS):
            return web.json_response({"ok": False, "error": f"Первый вывод доступен после {FIRST_WITHDRAW_MIN_PAID_TASKS} выполненных и оплаченных заданий."}, status=400)

    bal = await get_balance(uid)
    cur = float(bal.get("rub_balance") or 0)
    if cur < float(amount):
        return web.json_response({"ok": False, "error": "Недостаточно средств"}, status=400)

    wd_row = None
    debited = False
    try:
        await balances_update(uid, {"rub_balance": cur - float(amount), "updated_at": _now().isoformat()})
        debited = True

        # Provide redundant fields for different DB schemas
        wd_payload = {
            "user_id": uid,
            "tg_user_id": uid,
            "username": user.get("username"),
            "amount_rub": amount,
            "details": details,
            "status": "awaiting_review"
        }
        
        log.info("Attempting withdrawal insert for uid=%s: %s", uid, wd_payload)
        try:
            wd = await sb_insert(T_WD, wd_payload)
        except Exception as e:
            if _is_pgrst_missing_column(e, "username"):
                wd_payload.pop("username", None)
                wd = await sb_insert(T_WD, wd_payload)
            else:
                raise e
        
        if not wd or not wd.data:
            log.error("Withdrawal insert returned empty data: %s", wd)
            # Try a skeleton insert if full one failed? No, better to fail and rollback.
            raise Exception("Empty data from Supabase")

        wd_row = wd.data[0]

        try:
            # Prompt user in bot
            await bot.send_message(
                chat_id=uid,
                text=(
                    f"🎉 Ваша заявка на **{amount}₽** создана!\n\n"
                    "Для того чтобы мы обработали выплату, пожалуйста, **напишите хороший и подробный отзыв** о нашем боте прямо здесь, в этом чате.\n\n"
                    "Ваш отзыв проверит ИИ, и после этого заявка будет передана на выплату."
                ),
                parse_mode=ParseMode.MARKDOWN
            )
        except Exception as e:
            log.warning("Failed to send bot message to user %s: %s", uid, e)

        return web.json_response({"ok": True, "withdrawal": wd_row})
    except Exception as e:
        log.exception("withdraw create failed uid=%s amount=%s error=%s", uid, amount, e)
        if debited:
            try:
                await add_rub(uid, amount)
            except Exception:
                log.exception("withdraw rollback failed uid=%s amount=%s", uid, amount)
        
        # Extract more info from Supabase error if possible
        err_msg = str(e)
        if "null value" in err_msg and "tg_user_id" in err_msg:
             err_msg = "Ошибка БД: отсутствует колонка или права (tg_user_id). Обратитесь к админу."
             
        return web.json_response({"ok": False, "error": f"Ошибка сервера при создании заявки: {err_msg}"}, status=500)

async def api_withdraw_list(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    # List all for the user
    r = await sb_select(T_WD, {"user_id": uid}, order="created_at", desc=True, limit=100)
    return web.json_response({"ok": True, "withdrawals": r.data or []})

# -------------------------
# T-Bank claim (Mini App -> API)
# -------------------------

async def api_tbank_claim(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])

    # Ban from T-Bank topups (admin)
    b = await get_tbank_ban_until(uid)
    if b:
        return web.json_response({"ok": False, "error": f"Пополнение T-Bank временно заблокировано до {b.strftime('%Y-%m-%d %H:%M')} UTC"}, status=403)

    cool = await get_tbank_cooldown_until(uid)
    if cool and int(uid) not in ADMIN_IDS:
        left = int((cool - _now()).total_seconds())
        h = left // 3600
        m = (left % 3600) // 60
        return web.json_response({"ok": False, "error": f"Пополнение через Т-Банк доступно раз в сутки. Повтори через {h}ч {m}м."}, status=429)
    rate_limit_enforce(uid, "topup", min_interval_sec=60, spam_strikes=3, block_sec=600)
    body = await safe_json(req)

    amount = parse_amount_rub(body.get("amount_rub") or body.get("amount") or body.get("sum") or body.get("value") or body.get("rub"))
    if amount is None:
        return web.json_response({"ok": False, "error": "Некорректная сумма"}, status=400)

    sender = str(body.get("sender") or body.get("name") or body.get("from") or body.get("payer") or "").strip()
    code = str(body.get("code") or body.get("comment") or body.get("payment_code") or body.get("provider_ref") or body.get("reference") or "").strip()
    phone_raw = str(body.get("phone") or body.get("sender_phone") or body.get("payer_phone") or "").strip()
    proof_url = str(body.get("proof_url") or body.get("screenshot_url") or body.get("receipt_url") or "").strip()

    phone_digits = "".join(ch for ch in phone_raw if ch.isdigit())
    if len(phone_digits) == 10:
        phone_digits = "7" + phone_digits
    elif len(phone_digits) == 11 and phone_digits.startswith("8"):
        phone_digits = "7" + phone_digits[1:]

    if amount < MIN_TOPUP_RUB:
        return web.json_response({"ok": False, "error": f"Минимум {MIN_TOPUP_RUB:.0f}₽"}, status=400)
    if not sender:
        return web.json_response({"ok": False, "error": "Укажи имя отправителя"}, status=400)
    if not code:
        return web.json_response({"ok": False, "error": "Нет кода платежа"}, status=400)
    if len(phone_digits) != 11 or not phone_digits.startswith("7"):
        return web.json_response({"ok": False, "error": "Укажи корректный номер телефона"}, status=400)
    if not proof_url:
        return web.json_response({"ok": False, "error": "Прикрепи скрин оплаты"}, status=400)

    await sb_insert(T_PAY, {
        "user_id": uid,
        "provider": "tbank",
        "status": "pending",
        "amount_rub": amount,
        "provider_ref": code,
        "meta": {"sender": sender, "phone": phone_digits, "proof_url": proof_url}
    })

    await notify_admin(
        f"💳 T-Bank заявка\nСумма: {amount}₽\nUser: {uid}\nCode: {code}\nSender: {sender}\nPhone: +{phone_digits}\nСкрин: {proof_url}"
    )
    return web.json_response({"ok": True})

# -------------------------
# Telegram Stars (Mini App -> API): create invoice link
# -------------------------

