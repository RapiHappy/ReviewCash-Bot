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
async def api_stars_link(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    if not await is_stars_payments_enabled():
        return web.json_response({"ok": False, "error": "Оплата Stars временно отключена администратором"}, status=403)
    rate_limit_enforce(uid, "topup", min_interval_sec=60, spam_strikes=3, block_sec=600)
    body = await safe_json(req)

    amount = parse_amount_rub(body.get("amount_rub") or body.get("amount") or body.get("sum") or body.get("value") or body.get("rub"))
    if amount is None:
        return web.json_response({"ok": False, "error": "Некорректная сумма"}, status=400)
    if amount < MIN_STARS_TOPUP_RUB:
        return web.json_response({"ok": False, "error": f"Минимум {MIN_STARS_TOPUP_RUB:.0f}₽"}, status=400)

    stars = int(round(float(amount) / STARS_RUB_RATE))
    if stars <= 0:
        stars = 1

    payload_ref = f"stars_topup:{uid}:{float(amount):.2f}:{int(_now().timestamp())}"

    try:
        await sb_insert(T_PAY, {
            "user_id": uid,
            "provider": "stars",
            "status": "pending",
            "amount_rub": float(amount),
            "provider_ref": payload_ref,
            "meta": {"stars": stars, "stars_rub_rate": STARS_RUB_RATE}
        })
    except Exception as e:
        log.exception("DB insert payment(stars) failed: %s", e)
        return web.json_response({"ok": False, "error": "Ошибка записи платежа"}, status=500)

    prices = [LabeledPrice(label=f"Пополнение {float(amount):.0f} ₽", amount=stars)]

    try:
        invoice_link = None
        if hasattr(bot, "create_invoice_link"):
            invoice_link = await bot.create_invoice_link(
                title="Пополнение баланса",
                description=f"Пополнение баланса на {float(amount):.0f} ₽ (Telegram Stars)",
                payload=payload_ref,
                provider_token="",
                currency="XTR",
                prices=prices,
            )
        else:
            await bot.send_invoice(
                chat_id=uid,
                title="Пополнение баланса",
                description=f"Пополнение баланса на {float(amount):.0f} ₽ (Telegram Stars)",
                payload=payload_ref,
                provider_token="",
                currency="XTR",
                prices=prices,
            )

        return web.json_response({
            "ok": True,
            "amount_rub": float(amount),
            "stars": stars,
            "payload": payload_ref,
            "invoice_link": invoice_link,
        })
    except Exception as e:
        log.exception("create_invoice_link/send_invoice(XTR) failed: %s", e)
        try:
            await sb_update(T_PAY, {"provider": "stars", "provider_ref": payload_ref}, {"status": "failed"})
        except Exception:
            pass
        return web.json_response({"ok": False, "error": "Не удалось создать инвойс Stars"}, status=500)

# -------------------------
# CryptoBot create invoice (optional)
# -------------------------

async def api_cryptobot_create(req: web.Request):
    if not crypto:
        return web.json_response({"ok": False, "error": "CryptoBot not configured"}, status=500)

    _, user = await require_init(req)
    uid = int(user["id"])
    body = await safe_json(req)

    amount = float(body.get("amount_rub") or 0)
    if amount < MIN_STARS_TOPUP_RUB:
        return web.json_response({"ok": False, "error": f"Минимум {MIN_STARS_TOPUP_RUB:.0f}₽"}, status=400)

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

async def api_proof_upload(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])

    reader = await req.multipart()
    file_field = None
    while True:
        part = await reader.next()
        if part is None:
            break
        if part.name == "file":
            file_field = part
            break

    if not file_field:
        return web.json_response({"ok": False, "error": "Нет файла (field=file)"}, status=400)

    filename = safe_filename(file_field.filename or "proof.png")
    content_type = file_field.headers.get("Content-Type", "application/octet-stream")

    limit = MAX_PROOF_MB * 1024 * 1024
    buf = bytearray()
    while True:
        chunk = await file_field.read_chunk(size=256 * 1024)
        if not chunk:
            break
        buf.extend(chunk)
        if len(buf) > limit:
            return web.json_response({"ok": False, "error": f"Файл слишком большой (>{MAX_PROOF_MB}MB)"}, status=413)

    ts = int(_now().timestamp())
    path = f"{uid}/{ts}_{filename}"

    try:
        await sb_storage_upload(PROOF_BUCKET, path, bytes(buf), content_type)
        url = await sb_storage_public_url(PROOF_BUCKET, path)
    except Exception as e:
        log.exception("proof upload failed: %s", e)
        return web.json_response({"ok": False, "error": "Не удалось загрузить доказательство"}, status=500)

    return web.json_response({"ok": True, "url": url, "path": path})

# -------------------------
# API: create task
# -------------------------

async def api_vip_buy(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    body = await safe_json(req)

    currency = str(body.get("currency") or "rub").strip().lower()

    # Prevent double purchase if already VIP
    v_dt = await get_vip_until(uid)
    if v_dt and v_dt > _now():
        return web.json_response({"ok": False, "error": "У вас уже есть активный VIP-статус"}, status=400)

    if currency in ["star", "stars"]:
        price = int(VIP_PRICE_STARS)
        ok = await sub_stars(uid, price)
        if not ok:
            return web.json_response({"ok": False, "error": f"Недостаточно Stars. Нужно {price} ⭐"}, status=400)
        rev = price * STARS_RUB_RATE
    else:
        price = float(VIP_PRICE_RUB)
        ok = await sub_rub(uid, price)
        if not ok:
            return web.json_response({"ok": False, "error": f"Недостаточно средств. Нужно {price} ₽"}, status=400)
        rev = price

    until = await set_vip_until(uid, 30)
    await stats_add("revenue_rub", rev)
    
    msg = (f"👑 <b>Поздравляем! Ваш VIP-статус активирован до {until.strftime('%d.%m %H:%M UTC')}.</b>\n\n"
           f"Ваши привилегии:\n"
           f"✅ <b>+10%</b> к доходу за задания\n"
           f"✅ <b>+50%</b> к получаемому опыту\n"
           f"✅ Доступ к эксклюзивным VIP-заданиям\n"
           f"✅ Приоритет: самые дорогие задания всегда сверху!")
    await notify_user(uid, msg)

    return web.json_response({"ok": True, "vip_until": until.isoformat()})

