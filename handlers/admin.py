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
@router.message(Command("stars_pay"))
async def cmd_stars_pay(message: Message):
    if int(message.from_user.id) != int(MAIN_ADMIN_ID or 0):
        return await message.answer("⛔ Только для главного админа")
    from services.ui_handlers import _stars_pay_toggle_kb
    enabled = await is_stars_payments_enabled()
    status = "🟢 ВКЛ" if enabled else "🔴 ВЫКЛ"
    await message.answer(
        f"⭐ Оплата Stars сейчас: {status}",
        reply_markup=_stars_pay_toggle_kb(enabled)
    )

@router.callback_query(F.data.startswith("starspay:"))
async def cb_starspay_toggle(cq: CallbackQuery):
    if int(cq.from_user.id) != int(MAIN_ADMIN_ID or 0):
        return await cq.answer("Только для главного админа", show_alert=True)

    action = str(cq.data or "").split(":", 1)[1].strip().lower()
    current = await is_stars_payments_enabled()

    if action == "on":
        enabled = await set_stars_payments_enabled(True, int(cq.from_user.id))
    elif action == "off":
        enabled = await set_stars_payments_enabled(False, int(cq.from_user.id))
    else:
        enabled = current

    from services.ui_handlers import _stars_pay_toggle_kb
    status = "🟢 ВКЛ" if enabled else "🔴 ВЫКЛ"
    text = f"⭐ Оплата Stars сейчас: {status}"

    try:
        await cq.message.edit_text(text, reply_markup=_stars_pay_toggle_kb(enabled))
    except Exception:
        try:
            await cq.message.edit_reply_markup(reply_markup=_stars_pay_toggle_kb(enabled))
        except Exception:
            pass

    try:
        await cq.answer(f"Stars {'включены' if enabled else 'выключены'}")
    except Exception:
        pass

@router.message(Command("adminstats"))
async def cmd_adminstats(message: Message):
    if int(message.from_user.id) != int(MAIN_ADMIN_ID or 0):
        return await message.answer("⛔ Только для главного админа")
    from services.ui_handlers import build_main_admin_stats_text, _admin_stats_kb
    text = await build_main_admin_stats_text()
    await message.answer(text, reply_markup=_admin_stats_kb())

@router.callback_query(F.data == "adminstats:refresh")
async def cb_adminstats_refresh(cq: CallbackQuery):
    if int(cq.from_user.id) != int(MAIN_ADMIN_ID or 0):
        return await cq.answer("Только для главного админа", show_alert=True)
    from services.ui_handlers import build_main_admin_stats_text, _admin_stats_kb
    text = await build_main_admin_stats_text()
    try:
        await cq.message.edit_text(text, reply_markup=_admin_stats_kb())
    except Exception:
        try:
            await cq.message.answer(text, reply_markup=_admin_stats_kb())
        except Exception:
            pass
    await cq.answer("Статистика обновлена")

