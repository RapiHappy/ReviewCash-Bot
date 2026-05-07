import asyncio
import logging
import os
import signal
from datetime import datetime, timezone
from aiohttp import web

from config import (
    BOT_TOKEN, SERVER_BASE_URL, BASE_URL, WEBHOOK_PATH, 
    USE_WEBHOOK, PORT, ADMIN_IDS, MAIN_ADMIN_ID
)
from services.telegram_utils import bot, dp, setup_menu_button
from api.middleware import MaintenanceMiddleware, cors_middleware, no_cache_mw, api_error_middleware
from api.routes import setup_routes
from services.background_workers import start_background_workers
from database import ping
from services.redis_client import redis_client, check_redis

log = logging.getLogger("reviewcash.main")

_bg_tasks = []

async def on_startup():
    global _bg_tasks
    # Include handlers
    from handlers.users import router as users_router
    from handlers.admin import router as admin_router
    dp.include_router(users_router)
    dp.include_router(admin_router)

    dp.update.outer_middleware(MaintenanceMiddleware())
    await setup_menu_button(bot)
    
    db_ok = await ping()
    if not db_ok:
        log.error("CRITICAL: Database ping failed on startup!")
    else:
        log.info("Database ping successful.")

    if not await check_redis():
        log.critical("CRITICAL: Redis check failed! Bot requires Redis for locking and rate limiting.")
        raise RuntimeError("Redis is unavailable. Check your configuration and ensure Redis is running.")
    
    try:
        me = await bot.get_me()
        log.info(f"Bot identity: @{me.username} id={me.id}")
    except Exception as e:
        log.error(f"Bot identity check failed: {e}")
        
    _bg_tasks = start_background_workers(bot)
    
    hook_base = SERVER_BASE_URL or BASE_URL
    if USE_WEBHOOK and hook_base:
        wh_url = hook_base.rstrip("/") + WEBHOOK_PATH
        await bot.set_webhook(wh_url)
        log.info("Webhook set to %s", wh_url)
    else:
        await bot.delete_webhook(drop_pending_updates=True)
        log.info("Polling mode active")

async def on_shutdown():
    global _bg_tasks
    log.info("Starting graceful shutdown...")
    
    # 1. Cancel background workers
    if _bg_tasks:
        log.info(f"Cancelling {_bg_tasks} background tasks...")
        for task in _bg_tasks:
            task.cancel()
        await asyncio.gather(*_bg_tasks, return_exceptions=True)
        _bg_tasks.clear()
    
    # 2. Close crypto service
    try:
        from crypto_service import crypto
        if crypto:
            await crypto.close()
    except Exception as e:
        log.error(f"Error closing crypto_service: {e}")
    
    # 3. Stop polling if active
    await dp.stop_polling()
    
    # 4. Close bot session
    await bot.session.close()
    
    # 5. Close Redis connection
    await redis_client.close()
    
    log.info("Graceful shutdown completed.")

async def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
    )
    
    try:
        await on_startup()
    except Exception as e:
        log.critical(f"Startup failed: {e}")
        return

    app = web.Application(middlewares=[api_error_middleware, cors_middleware, no_cache_mw])
    setup_routes(app)
    
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", PORT)
    await site.start()
    log.info(f"API server started on port {PORT}")

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
        try:
            await polling_task
        except asyncio.CancelledError:
            pass

    await on_shutdown()
    await runner.cleanup()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (KeyboardInterrupt, SystemExit):
        pass