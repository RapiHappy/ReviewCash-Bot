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
        # Use Redis for distributed throttling
        key = f"spam:{uid}"
        
        if await redis_client.get(key):
            if isinstance(event, CallbackQuery):
                await event.answer("Слишком часто!", show_alert=False)
            return

        await redis_client.set(key, "1", px=int(self.limit * 1000))
        return await handler(event, data)
