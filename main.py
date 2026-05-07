import asyncio
import logging
import os
import signal
import json
import uuid
import sys
from datetime import datetime, timezone
from aiohttp import web
import sentry_sdk
from sentry_sdk.integrations.aiohttp import AioHttpIntegration

from config import (
    BOT_TOKEN, SERVER_BASE_URL, BASE_URL, WEBHOOK_PATH, 
    USE_WEBHOOK, PORT, ADMIN_IDS, MAIN_ADMIN_ID, SENTRY_DSN, ENVIRONMENT, APP_BUILD,
    SUPABASE_URL, SUPABASE_SERVICE_ROLE, REDIS_URL
)
from services.telegram_utils import bot, dp, setup_menu_button
from api.middleware import MaintenanceMiddleware, cors_middleware, no_cache_mw, api_error_middleware, security_headers_mw
from api.routes import setup_routes
from services.background_workers import start_background_workers
from database import ping
from services.redis_client import redis_client, check_redis

# JSON Formatter for structured logging
class JSONFormatter(logging.Formatter):
    def format(self, record):
        log_entry = {
            "timestamp": self.formatTime(record, self.datefmt),
            "level": record.levelname,
            "name": record.name,
            "message": record.getMessage(),
            "request_id": getattr(record, "request_id", None),
            "user_id": getattr(record, "user_id", None),
        }
        if record.exc_info:
            log_entry["exception"] = self.formatException(record.exc_info)
        return json.dumps(log_entry)

def setup_logging():
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JSONFormatter())
    logging.root.handlers = [handler]
    logging.root.setLevel(logging.INFO)

def validate_envs():
    required = {
        "BOT_TOKEN": BOT_TOKEN,
        "SUPABASE_URL": SUPABASE_URL,
        "SUPABASE_SERVICE_ROLE": SUPABASE_SERVICE_ROLE,
        "REDIS_URL": REDIS_URL
    }
    missing = [k for k, v in required.items() if not v]
    if missing:
        print(f"CRITICAL: Missing environment variables: {', '.join(missing)}")
        sys.exit(1)

_bg_tasks = []

async def on_startup():
    global _bg_tasks
    
    # 1. ENV Validation
    validate_envs()
    
    # 2. Sentry Init
    if SENTRY_DSN:
        sentry_sdk.init(
            dsn=SENTRY_DSN,
            integrations=[AioHttpIntegration()],
            traces_sample_rate=0.2,
            profiles_sample_rate=0.1,
            environment=ENVIRONMENT or "production",
            release=APP_BUILD,
        )
        logging.info("Sentry initialized")

    # Include handlers
    from handlers.users import router as users_router
    from handlers.admin import router as admin_router
    dp.include_router(users_router)
    dp.include_router(admin_router)

    dp.update.outer_middleware(MaintenanceMiddleware())
    await setup_menu_button(bot)
    
    # 3. Multi-service health check
    db_ok = await ping()
    if not db_ok:
        logging.error("CRITICAL: Database ping failed on startup!")
    
    if not await check_redis():
        logging.critical("CRITICAL: Redis check failed! Bot requires Redis for locking and rate limiting.")
        raise RuntimeError("Redis is unavailable.")
    
    try:
        me = await bot.get_me()
        logging.info(f"Bot identity: @{me.username}")
    except Exception as e:
        logging.exception(f"Bot identity check failed: {e}")
        
    _bg_tasks = start_background_workers(bot)
    
    hook_base = SERVER_BASE_URL or BASE_URL
    if USE_WEBHOOK and hook_base:
        wh_url = hook_base.rstrip("/") + WEBHOOK_PATH
        await bot.set_webhook(wh_url)
    else:
        await bot.delete_webhook(drop_pending_updates=True)

async def on_shutdown():
    global _bg_tasks
    logging.info("Starting graceful shutdown...")
    
    if _bg_tasks:
        for task in _bg_tasks: task.cancel()
        await asyncio.gather(*_bg_tasks, return_exceptions=True)
        _bg_tasks.clear()
    
    try:
        from crypto_service import crypto
        if crypto: await crypto.close()
    except: pass
    
    await dp.stop_polling()
    await bot.session.close()
    await redis_client.close()
    
    if SENTRY_DSN:
        sentry_sdk.flush()
        
    logging.info("Graceful shutdown completed.")

@web.middleware
async def request_id_mw(request, handler):
    request_id = request.headers.get("X-Request-ID", str(uuid.uuid4()))
    request["request_id"] = request_id
    # Add to log record
    old_factory = logging.getLogRecordFactory()
    def record_factory(*args, **kwargs):
        record = old_factory(*args, **kwargs)
        record.request_id = request_id
        return record
    logging.setLogRecordFactory(record_factory)
    try:
        return await handler(request)
    finally:
        logging.setLogRecordFactory(old_factory)

async def main():
    setup_logging()
    
    try: await on_startup()
    except Exception as e:
        logging.critical(f"Startup failed: {e}")
        sys.exit(1)

    app = web.Application(middlewares=[request_id_mw, api_error_middleware, cors_middleware, no_cache_mw, security_headers_mw])
    setup_routes(app)
    
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", PORT)
    await site.start()
    logging.info(f"API server started on port {PORT}")

    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop_event.set)

    polling_task = None
    if not USE_WEBHOOK:
        polling_task = asyncio.create_task(dp.start_polling(bot))
        
    await stop_event.wait()
    
    if polling_task:
        polling_task.cancel()
        try: await polling_task
        except asyncio.CancelledError: pass

    await on_shutdown()
    await runner.cleanup()

if __name__ == "__main__":
    try: asyncio.run(main())
    except (KeyboardInterrupt, SystemExit): pass