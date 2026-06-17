from datetime import datetime, timezone, timedelta
import math
import re
import json
import base64
import logging
import asyncio
import io
from typing import Any
from aiohttp import web
from PIL import Image

from config import *
from database import *
from services.balances import *
from services.limits import *
from services.telegram_utils import *

# The main.py will later import these and inject missing dependencies
# or they will import from main/config/services properly.
from services.user_service import *
from services.web_utils import *
from api.task_helpers import *
from aiogram.types import LabeledPrice

def _now():
    return datetime.now(timezone.utc)

def parse_amount_rub(v) -> float | None:
    try:
        if v is None: return None
        s = str(v).replace(",", ".").replace("₽", "").replace("$", "").strip()
        # strip non-numeric except dot
        s = "".join(c for c in s if c.isdigit() or c == ".")
        if not s: return None
        return float(s)
    except Exception as e:
        log.warning(f"parse_amount_rub failed for {v}: {e}")
        return None

# CryptoBot client (optional — None if CRYPTO_PAY_TOKEN not set)
try:
    from crypto_service import crypto as _crypto_client
except Exception as e:
    log.warning(f"CryptoBot service not loaded: {e}")
    _crypto_client = None
crypto = _crypto_client

async def api_stars_link(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    if not await is_stars_payments_enabled():
        return web.json_response({"ok": False, "error": "Оплата Stars временно отключена администратором"}, status=403)
    await rate_limit_enforce(uid, "topup", min_interval_sec=60, spam_strikes=3, block_sec=600)
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
        return web.json_response({"ok": False, "error": f"Ошибка записи платежа: {type(e).__name__}: {e}"}, status=500)

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
        except Exception as e:
            log.warning(f"Failed to update payment status for {payload_ref}: {e}")
        return web.json_response({"ok": False, "error": f"Stars ошибка: {type(e).__name__}: {e}"}, status=500)

# -------------------------
# CryptoBot create invoice (optional)
# -------------------------

async def api_cryptobot_create(req: web.Request):
    if not crypto:
        return web.json_response({"ok": False, "error": "CryptoBot не настроен. Обратитесь к администратору."}, status=503)

    _, user = await require_init(req)
    uid = int(user["id"])
    await rate_limit_enforce(uid, "cryptopay_create", min_interval_sec=30, spam_strikes=5, block_sec=300)
    body = await safe_json(req)

    amount = parse_amount_rub(body.get("amount_rub") or body.get("amount") or 0)
    if amount is None:
        return web.json_response({"ok": False, "error": "Некорректная сумма"}, status=400)
    if amount < max(MIN_TOPUP_RUB, 1):
        return web.json_response({"ok": False, "error": f"Минимум {MIN_TOPUP_RUB:.0f}₽"}, status=400)

    usdt = round(amount / max(CRYPTO_RUB_PER_USDT, 0.000001), 2)
    if usdt <= 0:
        return web.json_response({"ok": False, "error": "Некорректный курс конвертации"}, status=400)

    try:
        inv = await crypto.create_invoice(
            asset="USDT",
            amount=usdt,
            description=f"ReviewCash topup {amount:.0f}₽ uid={uid}",
            payload=str(uid),
        )
    except Exception as e:
        log.exception("cryptobot create_invoice failed uid=%s: %s", uid, e)
        return web.json_response({"ok": False, "error": f"CryptoBot ошибка: {type(e).__name__}: {e}"}, status=502)

    try:
        await sb_insert(T_PAY, {
            "user_id": uid,
            "provider": "cryptobot",
            "status": "pending",
            "amount_rub": amount,
            "provider_ref": str(inv.invoice_id),
            "meta": {"asset": "USDT", "amount_asset": usdt, "crypto_rub_rate": CRYPTO_RUB_PER_USDT}
        })
    except Exception as e:
        log.exception("cryptobot payment DB insert failed uid=%s: %s", uid, e)
        # Don't block the user — invoice was created, we can still receive webhook

    return web.json_response({
        "ok": True,
        "bot_invoice_url": inv.bot_invoice_url,
        "invoice_id": inv.invoice_id,
        "amount_usdt": usdt,
        "amount_rub": amount,
    })

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

    ts_dt = _now()
    path = f"uploads/{ts_dt.year}/{ts_dt.month:02d}/{uid}/{ts_dt.strftime('%H%M%S')}_{filename}"

    # MIME & Image validation
    try:
        img = Image.open(io.BytesIO(buf))
        img.verify() # Basic verification
        
        # Check format
        if img.format not in ["JPEG", "PNG"]:
            return web.json_response({"ok": False, "error": "Разрешены только JPEG и PNG"}, status=400)
            
        # Optional: Re-check content_type based on actual format
        if img.format == "JPEG":
            content_type = "image/jpeg"
        elif img.format == "PNG":
            content_type = "image/png"
    except Exception as e:
        log.warning(f"Image verification failed for proof upload: {e}")
        return web.json_response({"ok": False, "error": "Файл не является корректным изображением"}, status=400)

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

    # SECURE: Use Redis lock to prevent double purchase race condition
    async with redis_client.lock(f"lock:vip:{uid}", timeout=15):
        # 1. Re-check VIP status inside lock
        v_dt = await get_vip_until(uid)
        if v_dt and v_dt > _now():
            return web.json_response({"ok": False, "error": "У вас уже есть активный VIP-статус"}, status=400)

        # 2. Process payment
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

        # 3. Set VIP status
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
    await rate_limit_enforce(uid, "topup", min_interval_sec=60, spam_strikes=3, block_sec=600)
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


