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
        
        # Distributed throttling using Redis
        # Different keys for messages vs callbacks to allow faster interaction in MiniApp
        is_callback = isinstance(event, CallbackQuery)
        limit = self.limit if not is_callback else 0.3
        key = f"spam:{'cb' if is_callback else 'msg'}:{uid}"
        
        if await redis_client.get(key):
            if is_callback:
                try:
                    await event.answer("⚡ Слишком часто!", show_alert=False)
                except Exception as e:
                    log.warning(f"Failed to answer throttling callback: {e}")
            return

        await redis_client.set(key, "1", px=int(limit * 1000))
        return await handler(event, data)
