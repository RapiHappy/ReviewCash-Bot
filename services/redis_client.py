import redis.asyncio as redis
import os
import logging

log = logging.getLogger("reviewcash.redis")

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
redis_client = redis.from_url(REDIS_URL, decode_responses=True)

async def check_redis():
    try:
        await redis_client.ping()
        log.info("Redis connection successful.")
        return True
    except Exception as e:
        log.error(f"Redis connection failed: {e}")
        return False
