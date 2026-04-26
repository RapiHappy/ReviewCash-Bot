import logging
import os
from datetime import datetime, timezone, timedelta, date, time as dt_time
from aiogram.types import (
    Message, 
    InlineKeyboardMarkup, 
    InlineKeyboardButton, 
    ReplyKeyboardMarkup, 
    KeyboardButton, 
    ReplyKeyboardRemove,
    FSInputFile
)
from aiogram.utils.keyboard import InlineKeyboardBuilder
from aiogram.enums import ParseMode

from config import (
    BOT_NAME, NEWS_CHANNEL, PAYOUT_CHANNEL, MAIN_ADMIN_ID, ADMIN_IDS, 
    T_USERS, T_LIMITS, T_TASKS, T_COMP, T_PAY, T_WD, T_STATS,
    WELCOME_BANNER_PATH
)
from database import sb_count, sb_select, sb_distinct_count
from services.limits import tg_evt_key, is_stars_payments_enabled, is_notify_muted
from services.telegram_utils import get_required_sub_channel, get_miniapp_url

log = logging.getLogger("reviewcash")

def _now():
    return datetime.now(timezone.utc)

def _day():
    return date.today()

async def build_welcome_kb(uid: int):
    kb = InlineKeyboardBuilder()
    kb.button(text="🚀 Зарабатывать", web_app={"url": get_miniapp_url()})
    
    news = get_required_sub_channel() or NEWS_CHANNEL
    if news:
        # ensure url is valid
        news_id = news.lstrip('@')
        kb.button(text="📢 Канал с новостями", url=f"https://t.me/{news_id}")
        
    muted = await is_notify_muted(uid)
    kb.button(text=("🔕 Уведомления: ВЫКЛ" if muted else "🔔 Уведомления: ВКЛ"), callback_data="toggle_notify")
    kb.button(text="📚 Инструкция", callback_data="help_newbie")
    kb.adjust(1)
    return kb.as_markup()

async def send_main_welcome(message: Message, uid: int):
    news_line = ""
    news = get_required_sub_channel() or NEWS_CHANNEL
    if news:
        news_line = f"📢 *Новости:* {news} — будь в курсе всех событий\\!\n"

    text = (
        f"👋 *Добро пожаловать в {BOT_NAME or 'ReviewCash'}\\!* 💰\n\n"
        "Мы — сервис, где ты можешь легко зарабатывать, выполняя простые задания в Telegram и на популярных картах\\.\n\n"
        "━━━━━━━━━━━━━━━━━━━━━━\n\n"
        f"📊 *Наши выплаты:* {PAYOUT_CHANNEL or '@ReviewCashPayout'} — подтверждения выплат пользователям\\.\n"
        f"{news_line}"
        "\n━━━━━━━━━━━━━━━━━━━━━━\n\n"
        "🤖 *TG\\-задания* проверяются автоматически\n"
        "📝 *Отзывы* проверяет модератор \\(обычно до 24ч\\)\n\n"
        "Жми кнопку ниже и начинай зарабатывать\\! 👇"
    )
    
    markup = await build_welcome_kb(uid)
    
    if WELCOME_BANNER_PATH and os.path.exists(WELCOME_BANNER_PATH):
        try:
            await message.answer_photo(
                photo=FSInputFile(WELCOME_BANNER_PATH),
                caption=text,
                reply_markup=markup,
                parse_mode=ParseMode.MARKDOWN_V2
            )
            return
        except Exception as e:
            log.warning(f"Failed to send welcome banner photo: {e}")

    await message.answer(text, reply_markup=markup, parse_mode=ParseMode.MARKDOWN_V2)
OME_BANNER_PATH):
        try:
            await message.answer_photo(
                photo=FSInputFile(WELCOME_BANNER_PATH),
                caption=text,
                reply_markup=kb.as_markup(),
                parse_mode=ParseMode.MARKDOWN_V2
            )
            return
        except Exception as e:
            log.warning(f"Failed to send welcome banner photo: {e}")

    await message.answer(text, reply_markup=kb.as_markup(), parse_mode=ParseMode.MARKDOWN_V2)

def _stars_pay_toggle_kb(enabled: bool):
    kb = InlineKeyboardBuilder()
    if enabled:
        kb.button(text="🔴 Выключить Stars", callback_data="starspay:off")
    else:
        kb.button(text="🟢 Включить Stars", callback_data="starspay:on")
    kb.button(text="🔄 Обновить", callback_data="starspay:status")
    kb.adjust(1)
    return kb.as_markup()

def _admin_stats_kb():
    kb = InlineKeyboardBuilder()
    kb.button(text="🔄 Обновить статистику", callback_data="adminstats:refresh")
    kb.adjust(1)
    return kb.as_markup()

async def build_main_admin_stats_text() -> str:
    now_dt = _now()
    today_d = _day()
    today = today_d.isoformat()
    today_start = datetime.combine(today_d, dt_time.min, tzinfo=timezone.utc)
    yesterday_start = today_start - timedelta(days=1)

    users_total = await sb_count(T_USERS)
    bot_started = await sb_count(T_LIMITS, match={"limit_key": tg_evt_key("bot_start")})
    miniapp_opened = await sb_count(T_LIMITS, match={"limit_key": tg_evt_key("miniapp_open")})

    recent_5m = (now_dt - timedelta(minutes=5)).isoformat()
    recent_10m = (now_dt - timedelta(minutes=10)).isoformat()
    recent_15m = (now_dt - timedelta(minutes=15)).isoformat()
    recent_1h = (now_dt - timedelta(hours=1)).isoformat()
    recent_24h = (now_dt - timedelta(hours=24)).isoformat()
    recent_7d = (now_dt - timedelta(days=7)).isoformat()

    starts_10m = await sb_count(T_LIMITS, match={"limit_key": tg_evt_key("bot_start")}, gte={"last_at": recent_10m})
    starts_1h = await sb_count(T_LIMITS, match={"limit_key": tg_evt_key("bot_start")}, gte={"last_at": recent_1h})
    starts_24h = await sb_count(T_LIMITS, match={"limit_key": tg_evt_key("bot_start")}, gte={"last_at": recent_24h})
    starts_7d = await sb_count(T_LIMITS, match={"limit_key": tg_evt_key("bot_start")}, gte={"last_at": recent_7d})

    mini_10m = await sb_count(T_LIMITS, match={"limit_key": tg_evt_key("miniapp_open")}, gte={"last_at": recent_10m})
    mini_1h = await sb_count(T_LIMITS, match={"limit_key": tg_evt_key("miniapp_open")}, gte={"last_at": recent_1h})
    mini_24h = await sb_count(T_LIMITS, match={"limit_key": tg_evt_key("miniapp_open")}, gte={"last_at": recent_24h})
    mini_7d = await sb_count(T_LIMITS, match={"limit_key": tg_evt_key("miniapp_open")}, gte={"last_at": recent_7d})

    new_users_today = await sb_count(T_USERS, gte={"created_at": today_start.isoformat()})
    new_users_yesterday = await sb_count(T_USERS, gte={"created_at": yesterday_start.isoformat()}, lt={"created_at": today_start.isoformat()})

    online_5m = await sb_count(T_USERS, gte={"last_seen_at": recent_5m})
    online_15m = await sb_count(T_USERS, gte={"last_seen_at": recent_15m})
    online_1h = await sb_count(T_USERS, gte={"last_seen_at": recent_1h})

    tasks_total = await sb_count(T_TASKS)
    tasks_active = await sb_count(T_TASKS, match={"status": "active"}, gt={"qty_left": 0})
    creators_total = await sb_distinct_count(T_TASKS, "owner_id")

    completions_total = await sb_count(T_COMP)
    completions_paid = await sb_count(T_COMP, match={"status": "paid"})
    completions_pending = await sb_count(T_COMP, match={"status": "pending"})
    completions_rejected = await sb_count(T_COMP, match={"status": "rejected"})
    executors_total = await sb_distinct_count(T_COMP, "user_id")

    topups_paid = await sb_count(T_PAY, match={"status": "paid"}, neq={"provider": "admin_credit"})
    topups_pending = await sb_count(T_PAY, match={"status": "pending"}, neq={"provider": "admin_credit"})
    withdrawals_total = await sb_count(T_WD)
    withdrawals_paid = await sb_count(T_WD, match={"status": "paid"})
    withdrawals_pending = await sb_count(T_WD, match={"status": "pending"})

    banned_total = await sb_count(T_USERS, match={"is_banned": True})

    day_stats = await sb_select(T_STATS, {"day": today}, limit=1)
    ds = (day_stats.data or [{}])[0] if getattr(day_stats, "data", None) else {}
    day_revenue = float(ds.get("revenue_rub") or 0)
    day_payouts = float(ds.get("payouts_rub") or 0)
    day_topups = float(ds.get("topups_rub") or 0)

    return (
        "📊 Статистика бота\n"
        f"Обновлено: {now_dt.strftime('%Y-%m-%d %H:%M:%S')} UTC\n\n"
        "👥 Пользователи\n"
        f"• Всего в базе: {users_total}\n"
        f"• Нажали /start: {bot_started}\n"
        f"• Открывали Mini App: {miniapp_opened}\n"
        f"• Забанено: {banned_total}\n\n"
        "🔥 Недавно пришло\n"
        f"• /start за 10 мин: {starts_10m}\n"
        f"• /start за 1 час: {starts_1h}\n"
        f"• /start за 24 часа: {starts_24h}\n"
        f"• /start за 7 дней: {starts_7d}\n"
        f"• Mini App за 10 мин: {mini_10m}\n"
        f"• Mini App за 1 час: {mini_1h}\n"
        f"• Mini App за 24 часа: {mini_24h}\n"
        f"• Mini App за 7 дней: {mini_7d}\n\n"
        "🆕 Новые пользователи\n"
        f"• Сегодня: {new_users_today}\n"
        f"• Вчера: {new_users_yesterday}\n\n"
        "🟢 Онлайн / активность\n"
        f"• Активны за 5 мин: {online_5m}\n"
        f"• Активны за 15 мин: {online_15m}\n"
        f"• Активны за 1 час: {online_1h}\n\n"
        "🧩 Задания\n"
        f"• Всего создано: {tasks_total}\n"
        f"• Активных сейчас: {tasks_active}\n"
        f"• Создателей заданий: {creators_total}\n\n"
        "✅ Выполнения\n"
        f"• Всего попыток/отчётов: {completions_total}\n"
        f"• Оплачено: {completions_paid}\n"
        f"• На проверке: {completions_pending}\n"
        f"• Отклонено: {completions_rejected}\n"
        f"• Уникальных исполнителей: {executors_total}\n\n"
        "💸 Финансы\n"
        f"• Пополнений оплачено: {topups_paid}\n"
        f"• Пополнений в ожидании: {topups_pending}\n"
        f"• Выводов всего: {withdrawals_total}\n"
        f"• Выводов оплачено: {withdrawals_paid}\n"
        f"• Выводов в ожидании: {withdrawals_pending}\n\n"
        f"📅 За сегодня ({today})\n"
        f"• Выручка: {day_revenue:.2f}₽\n"
        f"• Выплаты: {day_payouts:.2f}₽\n"
        f"• Пополнения: {day_topups:.2f}₽"
    )
