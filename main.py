import asyncio
import logging
import os
import signal
import json
import uuid
import sys
import re
import hashlib
import time
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

# Masking helper
def mask_sensitive(text: str) -> str:
    if not text or not isinstance(text, str):
        return text
    # Mask bot token: 123456:ABC-DEF...
    text = re.sub(r"(\d+:[A-Za-z0-9_-]{35})", r"BOT_TOKEN_MASKED", text)
    # Mask initData: query_id=...&user=...&hash=...
    text = re.sub(r"(hash=[a-f0-9]{64})", r"hash=***", text)
    text = re.sub(r"(query_id=[A-Za-z0-9_-]+)", r"query_id=***", text)
    # Mask crypto addresses (USDT/TON): roughly 30-50 chars
    text = re.sub(r"(T[A-Za-z0-9]{33})", r"CRYPTO_ADDR_MASKED", text)
    text = re.sub(r"(0x[a-fA-F0-9]{40})", r"CRYPTO_ADDR_MASKED", text)
    # Mask Supabase Keys
    text = re.sub(r"(eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9._-]+)", r"SUPABASE_KEY_MASKED", text)
    # Mask Sentry DSN (fixed space)
    text = re.sub(r"(https://[a-f0-9]+@[a-z0-9.]+/ \d+)", r"SENTRY_DSN_MASKED", text)
    text = re.sub(r"(https://[a-f0-9]+@[a-z0-9.]+\/\d+)", r"SENTRY_DSN_MASKED", text)
    return text

import contextvars

# Context variables for logging
ctx_request_id = contextvars.ContextVar("request_id", default=None)
ctx_user_id = contextvars.ContextVar("user_id", default=None)
ctx_payment_id = contextvars.ContextVar("payment_id", default=None)
ctx_withdraw_id = contextvars.ContextVar("withdraw_id", default=None)

# JSON Formatter for structured logging
class JSONFormatter(logging.Formatter):
    def format(self, record):
        msg = self.mask(record.getMessage())
        log_entry = {
            "timestamp": self.formatTime(record, self.datefmt),
            "level": record.levelname,
            "name": record.name,
            "message": msg,
            "request_id": ctx_request_id.get() or getattr(record, "request_id", None),
            "user_id": ctx_user_id.get() or getattr(record, "user_id", None),
            "payment_id": ctx_payment_id.get() or getattr(record, "payment_id", None),
            "withdraw_id": ctx_withdraw_id.get() or getattr(record, "withdraw_id", None),
        }
        if record.exc_info:
            log_entry["exception"] = self.mask(self.formatException(record.exc_info))
        return json.dumps(log_entry)

    def mask(self, val: str) -> str:
        return mask_sensitive(val)

def setup_logging():
    from logging.handlers import QueueHandler, QueueListener
    import queue
    
    log_queue = queue.Queue(-1)
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JSONFormatter())
    
    queue_handler = QueueHandler(log_queue)
    logging.root.handlers = [queue_handler]
    logging.root.setLevel(logging.INFO)
    
    # Start listener in background
    listener = QueueListener(log_queue, handler)
    listener.start()
    return listener

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
    from handlers.middlewares import ThrottlingMiddleware
    
    dp.include_router(users_router)
    dp.include_router(admin_router)

    dp.update.outer_middleware(ThrottlingMiddleware())
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
    
    # 4. Webhook setup with secret token
    hook_base = SERVER_BASE_URL or BASE_URL
    if USE_WEBHOOK and hook_base:
        wh_url = hook_base.rstrip("/") + WEBHOOK_PATH
        # Use BOT_TOKEN as base for secret token if no separate secret provided
        # In a real enterprise app, this should be a unique random string
        secret_token = hashlib.sha256(BOT_TOKEN.encode()).hexdigest()[:32]
        await bot.set_webhook(wh_url, secret_token=secret_token)
        logging.info(f"Webhook set to {wh_url} (with secret token)")
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
    except Exception as e:
        logging.warning(f"Failed to close crypto client: {e}")
    
    await dp.stop_polling()
    await bot.session.close()
    await redis_client.close()
    
    if SENTRY_DSN:
        sentry_sdk.flush()
    
    if _log_listener:
        try:
            _log_listener.stop()
        except:
            pass
        
    logging.info("Graceful shutdown completed.")

@web.middleware
async def request_id_mw(request, handler):
    request_id = request.headers.get("X-Request-ID", str(uuid.uuid4()))
    request["request_id"] = request_id
    
    # Set context variables for the duration of the request
    token_req = ctx_request_id.set(request_id)
    try:
        return await handler(request)
    finally:
        ctx_request_id.reset(token_req)
        ctx_user_id.set(None)
        ctx_payment_id.set(None)
        ctx_withdraw_id.set(None)

@web.middleware
async def access_log_mw(request, handler):
    start = time.time()
    request_id = ctx_request_id.get()
    
    # Enrich Sentry context
    with sentry_sdk.configure_scope() as scope:
        scope.set_tag("request_id", request_id)
        # user_id might be set later in require_init, but we can set it if available
        uid = ctx_user_id.get()
        if uid:
            scope.set_user({"id": str(uid)})

    resp = await handler(request)
    duration = time.time() - start
    log.info(f"ACCESS: {request.method} {request.path} -> {resp.status} ({duration:.3f}s)")
    return resp

_log_listener = None

async def main():
    global _log_listener
    _log_listener = setup_logging()
    
    try: await on_startup()
    except Exception as e:
        logging.critical(f"Startup failed: {e}")
        sys.exit(1)

    app = web.Application(middlewares=[request_id_mw, access_log_mw, api_error_middleware, cors_middleware, no_cache_mw, security_headers_mw])
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