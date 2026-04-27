import asyncio
import logging
import os
from datetime import datetime
from aiohttp import web

from config import BOT_TOKEN, SERVER_BASE_URL, BASE_URL, WEBHOOK_PATH, USE_WEBHOOK, PORT, ADMIN_IDS, MAIN_ADMIN_ID
from services.telegram_utils import bot, dp, setup_menu_button
from api.middleware import MaintenanceMiddleware, cors_middleware, no_cache_mw, api_error_middleware
from api.routes import setup_routes
from services.background_workers import start_background_workers

# Handlers are included in on_startup

log = logging.getLogger("reviewcash.main")

# Build/version string
APP_BUILD = (
    os.getenv("APP_BUILD")
    or os.getenv("RENDER_GIT_COMMIT")
    or os.getenv("GIT_COMMIT")
    or datetime.utcnow().strftime("rc_%Y%m%d_%H%M%S")
)

def make_app():
    app = web.Application(middlewares=[api_error_middleware, cors_middleware, no_cache_mw])
    setup_routes(app)
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app



async def on_startup(app: web.Application):
    # Include handlers
    from handlers.users import router as users_router
    from handlers.admin import router as admin_router
    dp.include_router(users_router)
    dp.include_router(admin_router)

    dp.update.outer_middleware(MaintenanceMiddleware())
    await setup_menu_button(bot)
    
    try:
        me = await bot.get_me()
        log.info(f"Bot identity: @{me.username} id={me.id}")
    except Exception as e:
        log.error(f"Bot identity check failed: {e}")
        
    start_background_workers(bot)
    
    hook_base = SERVER_BASE_URL or BASE_URL
    if USE_WEBHOOK and hook_base:
        wh_url = hook_base.rstrip("/") + WEBHOOK_PATH
        await bot.set_webhook(wh_url)
        log.info("Webhook set to %s", wh_url)
    else:
        asyncio.create_task(dp.start_polling(bot))
        log.info("Polling started")

async def on_cleanup(app: web.Application):
    try:
        from crypto_service import crypto
        if crypto:
            await crypto.close()
    except Exception:
        pass
    await bot.session.close()

app = make_app()

if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
    )
    web.run_app(app, host="0.0.0.0", port=PORT)