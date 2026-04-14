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
async def api_tg_check_chat(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    # Light rate limit: ~1 request per 2 seconds; spam -> 1 minute block
    rate_limit_enforce(uid, "tg_check", min_interval_sec=2, spam_strikes=8, block_sec=60)

    body = await safe_json(req)
    target = str(body.get("target") or body.get("chat") or body.get("target_url") or "").strip()

    chat = normalize_tg_chat(target)
    if not chat:
        # hide internal tags from instructions (XP:/DIFF:/TG_SUBTYPE)
        try:
            for _t in (tasks or []):
                if isinstance(_t, dict) and _t.get("instructions"):
                    _t["instructions"] = strip_meta_tags(_t.get("instructions") or "")
        except Exception:
            pass

        return web.json_response({
            "ok": True,
            "valid": False,
            "code": "TG_CHAT_REQUIRED",
            "message": "Укажи @канал или @группу (например @MyChannel).",
        })

    ok_chat, msg = await ensure_bot_in_chat(chat)
    if not ok_chat:
        return web.json_response({
            "ok": True,
            "valid": False,
            "code": "TG_BOT_NOT_IN_CHAT",
            "chat": chat,
            "message": msg,
        })

    title = chat
    ctype = ""
    try:
        ch = await bot.get_chat(chat)
        ctype = getattr(ch, "type", "") or ""
        title = getattr(ch, "title", "") or getattr(ch, "username", "") or chat
    except Exception:
        pass

    return web.json_response({
        "ok": True,
        "valid": True,
        "chat": chat,
        "type": ctype,
        "title": title,
    })

@web.middleware
async def api_error_middleware(req: web.Request, handler):
    try:
        return await handler(req)
    except web.HTTPException:
        raise
    except Exception as e:
        try:
            log.exception("unhandled api error on %s %s: %s", req.method, req.path, e)
        except Exception:
            pass
        if req.path.startswith("/api/"):
            return web.json_response({"ok": False, "error": "Временная ошибка сервера"}, status=500)
        raise

