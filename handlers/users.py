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
from aiogram import Router, F
from aiogram.types import Message, CallbackQuery, PreCheckoutQuery, LabeledPrice
from aiogram.filters import Command, CommandStart

router = Router()
# Temporary blankets, everything will be combined in Step 8
@router.message(F.text == "/app")
async def open_app_cmd(m: Message):
    kb = InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text="🚀 Открыть ReviewCash", web_app=WebAppInfo(url=MINIAPP_URL))
    ]])
    await m.answer("Открывай Mini App только этой кнопкой (WebApp):", reply_markup=kb)

sb: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE)

crypto = None
if CRYPTO_PAY_TOKEN and AioCryptoPay:
    crypto = AioCryptoPay(
        token=CRYPTO_PAY_TOKEN,
        network=Networks.MAIN_NET if CRYPTO_PAY_NETWORK.upper().startswith("MAIN") else Networks.TEST_NET
    )

# -------------------------
# DB table names
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
T_REF = "referral_events"

# -------------------------
# In-memory rate limiting (per process)
#   - 1 minute between actions
#   - if spamming, block for 10 minutes
# -------------------------
RATE_LIMIT_STATE: dict[tuple[int, str], dict] = {}
TG_CHAT_CACHE: dict[str, tuple[float, bool, str]] = {}


# -------------------------
# helpers: supabase safe exec in thread
# -------------------------

@router.message(CommandStart())
async def cmd_start(message: Message):
    uid = message.from_user.id
    args = (message.text or "").split(maxsplit=1)
    ref = None
    start_arg = ""
    if len(args) == 2:
        start_arg = str(args[1] or "").strip()
    if start_arg.isdigit():
        ref = int(start_arg)
    else:
        m_ref = re.match(r"(?i)^ref[_:\-]?(\d+)$", start_arg)
        if m_ref:
            ref = int(m_ref.group(1))

    await ensure_user(message.from_user.model_dump(), referrer_id=ref)

    sub_ok, sub_chat, sub_msg = await tg_check_required_subscription(uid)
    if not sub_ok:
        channel_name = (sub_chat or 'канал').lstrip('@')
        await message.answer(
            f"👋 Привет\! Рады тебя видеть\!\n\n"
            f"📢 Для начала подпишись на наш канал с новостями *@{channel_name}*\n\n"
            f"Там мы публикуем:\n"
            f"💎 Новые возможности заработка\n"
            f"📊 Обновления сервиса\n"
            f"🎁 Бонусы и акции\n\n"
            f"После подписки нажми *«Проверить подписку»* ✅",
            reply_markup=required_subscribe_kb(),
            parse_mode=ParseMode.MARKDOWN_V2,
        )
        return

    try:
        await tg_evt_touch(uid, "bot_start")
    except Exception:
        pass

    user_gender = await tg_get_gender(uid)
    if not user_gender:
        gender_kb = ReplyKeyboardMarkup(
            keyboard=[[KeyboardButton(text="👨 Мужской"), KeyboardButton(text="👩 Женский")]],
            resize_keyboard=True,
            one_time_keyboard=True,
            selective=True,
        )
        await message.answer(
            "👤 *Последний шаг — выбери пол:*\n\n"
            "Это нужно, чтобы подбирать для тебя подходящие задания\. "
            "Некоторые заказчики ищут исполнителей определённого пола\.",
            reply_markup=gender_kb,
            parse_mode=ParseMode.MARKDOWN_V2,
        )
        return

    await send_main_welcome(message, uid)

@router.message(F.text.in_(["👨 Мужской", "👩 Женский"]))
async def handle_gender_pick(message: Message):
    uid = int(message.from_user.id)

    sub_ok, sub_chat, sub_msg = await tg_check_required_subscription(uid)
    if not sub_ok:
        channel_name = (sub_chat or 'канал').lstrip('@')
        await message.answer(
            f"📢 Сначала подпишись на наш канал с новостями *@{channel_name}*\n\n"
            f"После подписки нажми кнопку проверки 👇",
            reply_markup=required_subscribe_kb(),
            parse_mode=ParseMode.MARKDOWN_V2,
        )
        return

    if str(message.text or "").strip() == "👨 Мужской":
        await tg_set_gender(uid, TASK_GENDER_MALE)
    else:
        await tg_set_gender(uid, TASK_GENDER_FEMALE)

    await message.answer("✅ Отлично, пол сохранён\! Теперь всё готово 🎉", reply_markup=ReplyKeyboardRemove(), parse_mode=ParseMode.MARKDOWN_V2)
    await send_main_welcome(message, uid)

@router.callback_query(F.data == "check_required_sub")
async def cb_check_required_sub(cq: CallbackQuery):
    uid = int(cq.from_user.id)
    sub_ok, sub_chat, sub_msg = await tg_check_required_subscription(uid)
    if not sub_ok:
        await cq.answer("❌ Подписка не найдена. Подпишись и попробуй снова.", show_alert=True)
        try:
            channel_name = (sub_chat or 'канал').lstrip('@')
            await cq.message.answer(
                f"🔍 Подписка на канал с новостями *@{channel_name}* пока не обнаружена\n\n"
                f"Убедись, что ты:\n"
                f"1️⃣ Перешёл по кнопке *«Подписаться»*\n"
                f"2️⃣ Нажал *«Вступить»* в канале\n\n"
                f"Затем вернись и нажми *«Проверить подписку»* 👇",
                reply_markup=required_subscribe_kb(),
                parse_mode=ParseMode.MARKDOWN_V2,
            )
        except Exception:
            pass
        return
    await cq.answer("Подписка подтверждена ✅")
    try:
        await cq.message.delete()
    except Exception:
        pass
    await send_main_welcome(cq.message, uid)

@router.callback_query(F.data == "help_newbie")
async def cb_help(cq: CallbackQuery):
    await cq.answer()
    await cq.message.answer(
        "📚 *ReviewCash — Полная инструкция*\n\n"
        "━━━━━━━━━━━━━━━━━━━━━━\n\n"
        "🚀 *КАК ВЫПОЛНИТЬ ЗАДАНИЕ:*\n\n"
        "1️⃣ Открой приложение кнопкой ниже\n"
        "2️⃣ Выбери задание из списка\n"
        "3️⃣ Нажми *«Перейти к выполнению»*\n"
        "4️⃣ Выполни задание по инструкции\n"
        "5️⃣ Отправь отчёт \(скриншот или авто\)\n"
        "6️⃣ Получи оплату после проверки 💰\n\n"
        "━━━━━━━━━━━━━━━━━━━━━━\n\n"
        "📝 *ОТЗЫВЫ \(Яндекс / Google / 2GIS\):*\n\n"
        "Перед тем как писать отзыв, обязательно:\n"
        "  ✅ Лайкни *5 положительных* отзывов\n"
        "  ✅ Лайкни *5 фото*, если они есть\n"
        "  ✅ Зайди на *сайт* организации\n"
        "  ✅ Потом пиши свой отзыв\n\n"
        "⚠️ Без этих действий отзыв может быть удалён\!\n\n"
        "━━━━━━━━━━━━━━━━━━━━━━\n\n"
        "📲 *TELEGRAM\-ЗАДАНИЯ:*\n\n"
        "  🤖 Проверяются *автоматически*\n"
        "  ⏱ Нужно оставаться подписанным мин\. 2\-3 дня\n"
        "  ❌ Отписался раньше → деньги не придут\n\n"
        "━━━━━━━━━━━━━━━━━━━━━━\n\n"
        "💸 *ВЫВОД ДЕНЕГ:*\n\n"
        "  🗓 Дни: *ПН, СР, СБ, ВС*\n"
        "  💳 На карту или телефон\n"
        "  📊 Минимум для вывода: *300₽*\n"
        "  ⏳ Обработка: до 24 часов\n\n"
        "━━━━━━━━━━━━━━━━━━━━━━\n\n"
        f"🎁 *РЕФЕРАЛКА:*\n\n"
        f"  👥 Пригласи друга по ссылке\n"
        f"  💰 Получи *{REF_BONUS_RUB:.0f}₽* когда он выполнит первое задание\n"
        f"  ♾ Без ограничений на количество друзей\n\n"
        "━━━━━━━━━━━━━━━━━━━━━━\n\n"
        "❓ *ЧАСТЫЕ ВОПРОСЫ:*\n\n"
        "*Почему не вижу задания?*\n"
        "  → Задание уже выполнено или действует лимит\n\n"
        "*Не могу отправить отчёт?*\n"
        "  → Сначала нажми *«Перейти к выполнению»*\n\n"
        "*Когда придёт оплата?*\n"
        "  → TG — сразу после авто\-проверки\n"
        r"  → Отзывы — после модерации \(до 24ч\)\n\n"
        "━━━━━━━━━━━━━━━━━━━━━━\n\n"
        "🚫 *ЗАПРЕЩЕНО:*\n\n"
        "  ❌ Фейковые скриншоты\n"
        "  ❌ Отзывы не со своего аккаунта\n"
        r"  ❌ Мульти\-аккаунты\n\n"
        r"За нарушения — *блокировка и штраф*\.\n\n"
        "Работай честно — и выплаты будут стабильными 💎",
        parse_mode=ParseMode.MARKDOWN_V2,
    )

@router.callback_query(F.data == "toggle_notify")
async def cb_toggle_notify(cq: CallbackQuery):
    uid = cq.from_user.id
    muted = await is_notify_muted(uid)
    new_muted = not muted
    await set_notify_muted(uid, new_muted)

    try:
        kb = InlineKeyboardBuilder()

        miniapp_url = MINIAPP_URL
        if not miniapp_url:
            base = SERVER_BASE_URL or BASE_URL
            if base:
                miniapp_url = base.rstrip("/") + f"/app/?v={APP_BUILD}"

        if miniapp_url:
            kb.button(text="🚀 Открыть приложение", web_app=WebAppInfo(url=miniapp_url))
        kb.button(text=("🔕 Уведомления: ВЫКЛ" if new_muted else "🔔 Уведомления: ВКЛ"), callback_data="toggle_notify")
        kb.button(text="📌 Инструкция новичку", callback_data="help_newbie")
        kb.adjust(1)

        await cq.message.edit_reply_markup(reply_markup=kb.as_markup())
    except Exception:
        pass

    await cq.answer("Уведомления выключены 🔕" if new_muted else "Уведомления включены 🔔", show_alert=False)

    # Confirm in chat (force=true so it always arrives)
    await notify_user(uid, ("🔕 Уведомления отключены. Чтобы включить — нажми кнопку ещё раз." if new_muted
                            else "🔔 Уведомления включены."), force=True)

@router.message(Command("notify"))
async def cmd_notify(message: Message):
    uid = message.from_user.id
    muted = await is_notify_muted(uid)
    new_muted = not muted
    await set_notify_muted(uid, new_muted)
    await message.answer("🔕 Уведомления отключены." if new_muted else "🔔 Уведомления включены.")

@router.message(Command("me"))
async def cmd_me(message: Message):
    uid = message.from_user.id
    bal = await get_balance(uid)
    ref = await referrals_summary(uid)
    await message.answer(
        "👤 Профиль\n"
        f"Баланс: {float(bal.get('rub_balance') or 0):.0f} ₽\n"
        f"Stars: {int(float(bal.get('stars_balance') or 0))} ⭐\n"
        f"XP: {int(bal.get('xp') or 0)} | LVL: {int(bal.get('level') or 1)}\n"
        f"До следующего уровня: {int(bal.get('xp_remaining') or 0)} XP\n\n"
        "👥 Рефералы\n"
        f"Друзей: {ref['count']}\n"
        f"Заработано: {ref['earned_rub']:.0f} ₽\n"
        f"Ожидают бонуса: {ref.get('pending', 0)}"
    )

@router.message(Command("stars"))
async def cmd_stars(message: Message):
    if int(message.from_user.id) not in ADMIN_IDS:
        return await message.answer("⛔ Только для админа")
    try:
        bal = await get_bot_stars_balance()
        txs = await get_bot_star_transactions(limit=10)
    except Exception as e:
        log.exception("get stars info failed: %s", e)
        return await message.answer("❌ Не удалось получить Stars баланс бота")

    lines = [
        "⭐ Баланс Stars бота",
        f"Сейчас: {_format_star_amount_obj(bal)}",
    ]
    if txs:
        lines.append("")
        lines.append("Последние операции:")
        for tx in txs[:10]:
            incoming = bool(tx.get("source"))
            partner = _star_partner_text(tx.get("source") if incoming else tx.get("receiver"))
            sign = "+" if incoming else "-"
            lines.append(f"{_format_unix_ts(tx.get('date'))} | {sign}{_format_star_amount_obj(tx)} | {partner}")
    else:
        lines.append("")
        lines.append("Операций пока нет.")

    await message.answer("\n".join(lines))

@router.message(Command("stars_tx"))
async def cmd_stars_tx(message: Message):
    if int(message.from_user.id) not in ADMIN_IDS:
        return await message.answer("⛔ Только для админа")
    try:
        txs = await get_bot_star_transactions(limit=25)
    except Exception as e:
        log.exception("get stars tx failed: %s", e)
        return await message.answer("❌ Не удалось получить транзакции Stars")

    if not txs:
        return await message.answer("⭐ Транзакций Stars пока нет")

    chunks = []
    cur = ["⭐ Последние Stars транзакции"]
    for i, tx in enumerate(txs[:25], start=1):
        incoming = bool(tx.get("source"))
        partner = _star_partner_text(tx.get("source") if incoming else tx.get("receiver"))
        sign = "+" if incoming else "-"
        row = f"{i}. {_format_unix_ts(tx.get('date'))} | {sign}{_format_star_amount_obj(tx)} | {partner}"
        if sum(len(x) + 1 for x in cur) + len(row) > 3500:
            chunks.append("\n".join(cur))
            cur = ["⭐ Последние Stars транзакции"]
        cur.append(row)
    if cur:
        chunks.append("\n".join(cur))

    for chunk in chunks:
        await message.answer(chunk)

@router.callback_query(F.data == "start_again")
async def start_again_handler(cq: CallbackQuery):
    await cq.answer()
    kb = InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text="🚀 Открыть ReviewCash", web_app=WebAppInfo(url=MINIAPP_URL))
    ]])
    await cq.message.answer("Привет! Открывай Mini App кнопкой ниже:", reply_markup=kb)

# Stars платежи: Telegram требует PreCheckout ok=True

@router.callback_query()
async def track_any_callback(cq: CallbackQuery):
    try:
        uid = int(cq.from_user.id)
        await tg_evt_touch(uid, "callback_any")
        data = str(cq.data or "").strip()
        if data:
            await tg_evt_touch(uid, "callback_data", data)
    except Exception:
        pass

@router.message()
async def fallback_handler(m: Message):
    uid = int(m.from_user.id)
    txt = str(m.text or m.caption or "").strip()
    if not txt:
        return # Ignore empty messages
    
    try:
        # Search by both possible columns
        log.info("fallback_handler: check withdrawal review for uid=%s", uid)
        def _f():
            return sb.table(T_WD).select("*").or_(f"user_id.eq.{uid},tg_user_id.eq.{uid}").eq("status", "awaiting_review").order("created_at", desc=True).limit(1).execute()
        
        r = await sb_exec(_f)

        if r.data:
            wd = r.data[0]
            log.info("fallback_handler: found awaiting_review withdrawal ID=%s for uid=%s", wd.get("id"), uid)
            
            # AI Check
            ok, reason = await check_review_ai(txt)
            if not ok:
                await m.reply(f"❌ **Ваш отзыв не прошел проверку:**\n{reason}\n\nПожалуйста, напишите более подробный и честный отзыв о боте (минимум 5-8 слов), чтобы мы могли подтвердить вашу выплату.")
                return

            # Success! Forward to channel
            amount = wd.get("amount_rub")
            user_display = f"Пользователь"
            if m.from_user.username:
                user_display = f"@{m.from_user.username}"

            channel_text = (
                f"💸 <b>НОВАЯ ВЫПЛАТА: {amount}₽</b>\n\n"
                f"👤 <b>{user_display}</b>\n"
                f"💬 <b>ОТЗЫВ:</b>\n<i>«{html.escape(txt)}»</i>\n\n"
                f"🚀 Заработай на отзывах в @ReviewCashOrg_Bot"
            )
            
            try:
                await bot.send_message(chat_id=PAYOUT_REVIEWS_CHANNEL, text=channel_text, parse_mode=ParseMode.HTML)
            except Exception as e:
                log.warning(f"Failed to forward review to channel: {e}")

            # Update status to pending
            await sb_update(T_WD, {"id": wd["id"]}, {"status": "pending"})
            
            # Notify ADMIN about new pending withdrawal (original logic from api_withdraw_create)
            try:
                await notify_admin(
                    f"🏦 Заявка на вывод (ОТЗЫВ ПОЛУЧЕН): {amount}₽\n"
                    f"User: {uid}\n"
                    f"ID: {wd.get('id')}"
                )
            except Exception:
                pass

            await m.answer(
                "✨ <b>Отзыв принят и проверен ИИ!</b>\n\n"
                "Ваша заявка передана в очередь на выплату. Обычно это занимает от пары часов до 2-х дней в выходные.\n\n"
                "<i>Спасибо за честное мнение! ❤️</i>",
                parse_mode=ParseMode.HTML
            )
            return
    except Exception as e:
        log.exception(f"Error in review fallback handler: {e}")
        # If we are here, something went wrong during lookup or AI check.
        # Let's see if we should still try to provide a fallback or if we already replied.

    # Default fallback tracking
    try:
        await tg_evt_touch(uid, "message_any")
        txt = str(m.text or m.caption or "").strip()
        if txt:
            await tg_evt_touch(uid, "message_text", txt.lower())
    except Exception:
        pass

    # Then, we respond
    kb = InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text="🚀 Начать заново", callback_data="start_again")
    ]])
    try:
        await m.answer(
            "Я не понимаю эту команду или сообщение. Нажми /start или кнопку ниже, чтобы начать заново.",
            reply_markup=kb
        )
    except Exception:
        pass

# start_again_handler moved above catch-all @router.callback_query() — see above

@router.poll_answer()
async def track_poll_answer(answer):
    try:
        uid = int(answer.user.id)
        await tg_evt_touch(uid, "poll_answer")
        pid = str(answer.poll_id or "").strip()
        if pid:
            await tg_evt_touch(uid, "poll_answer", pid)
    except Exception:
        pass

@router.pre_checkout_query()
async def on_pre_checkout_query(pre_checkout: PreCheckoutQuery):
    try:
        await bot.answer_pre_checkout_query(pre_checkout.id, ok=True)
    except Exception as e:
        log.warning("pre_checkout error: %s", e)

@router.message(F.successful_payment)
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
        meta = prow.get("meta") or {}
        if not isinstance(meta, dict):
            meta = {}

        stars_amount = meta.get("stars")
        try:
            stars_amount = int(round(float(stars_amount))) if stars_amount is not None else None
        except Exception:
            stars_amount = None

        if not stars_amount or stars_amount <= 0:
            try:
                stars_amount = int(round(float(getattr(sp, "total_amount", 0) or 0)))
            except Exception:
                stars_amount = 0
        if stars_amount <= 0:
            stars_amount = max(1, int(round(amount_rub / max(STARS_RUB_RATE, 0.000001))))

        await sb_update(T_PAY, {"id": prow["id"]}, {"status": "paid"})
        await add_stars(uid, stars_amount)
        await stats_add("topups_rub", amount_rub)

        xp_add = int((amount_rub // 100) * XP_PER_TOPUP_100)
        if xp_add > 0:
            await add_xp(uid, xp_add)

        await message.answer(
            f"✅ Пополнение Stars успешно: +{stars_amount}⭐"
            + (f"\nЭквивалент: {amount_rub:.2f}₽" if amount_rub > 0 else "")
        )
    except Exception as e:
        log.exception("successful_payment handle error: %s", e)

# -------------------------
# CORS middleware
# -------------------------

