import asyncio
import logging
import time
from aiogram import BaseMiddleware
from aiogram.types import TelegramObject, Message, CallbackQuery
from services.redis_client import redis_client

log = logging.getLogger("reviewcash.antispam")

class ThrottlingMiddleware(BaseMiddleware):
    def __init__(self, limit: float = 0.5):
        self.limit = limit
        super().__init__()

    async def __call__(self, handler, event: TelegramObject, data: dict):
        user = data.get("event_from_user")
        if not user:
            return await handler(event, data)

        uid = user.id
        from config import ADMIN_IDS, MAIN_ADMIN_ID
        is_adm = (uid in (ADMIN_IDS or [])) or (uid == MAIN_ADMIN_ID)
        
        # Distributed throttling using Redis
        is_callback = isinstance(event, CallbackQuery)
        limit = self.limit if not is_callback else 0.3
        
        # 1. Check if user is temporarily blocked for flooding
        block_key = f"spam_block:{uid}"
        if await redis_client.get(block_key):
            if is_callback:
                try: await event.answer("🚫 Доступ временно ограничен за флуд", show_alert=True)
                except Exception: pass
            return

        key = f"spam:{'cb' if is_callback else 'msg'}:{uid}"
        strike_key = f"spam_strikes:{uid}"
        
        if await redis_client.get(key):
            if not is_adm:
                # Increment strikes
                strikes = await redis_client.incr(strike_key)
                await redis_client.expire(strike_key, 60) # reset strikes if no spam for 1m
                
                if strikes >= 10:
                    # Block user for 10 minutes
                    await redis_client.set(block_key, "1", ex=600)
                    log.warning(f"User {uid} blocked for 10m due to flooding ({strikes} strikes)")
                    if is_callback:
                        try: await event.answer("🚫 Слишком много запросов! Блок 10 минут.", show_alert=True)
                        except Exception: pass
                    return

                if is_callback:
                    try:
                        await event.answer("⚡ Слишком часто!", show_alert=False)
                    except Exception as e:
                        log.warning(f"Failed to answer throttling callback: {e}")
                return
            else:
                # Admins are not throttled
                pass

        await redis_client.set(key, "1", px=int(limit * 1000))
        return await handler(event, data)
