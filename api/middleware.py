import json
import logging
from aiohttp import web
from config import ADMIN_IDS, MAIN_ADMIN_ID, CORS_ORIGINS
from services.limits import is_maintenance_mode

log = logging.getLogger("reviewcash.middleware")

@web.middleware
async def api_error_middleware(request: web.Request, handler):
    try:
        return await handler(request)
    except web.HTTPException as ex:
        # Re-raise standard aiohttp HTTP exceptions if they already have JSON body
        if ex.content_type == "application/json":
            raise ex
        # Otherwise, wrap in JSON
        return web.json_response({"ok": False, "error": ex.reason}, status=ex.status)
    except Exception as e:
        log.exception("Unhandled API error: %s", e)
        return web.json_response({"ok": False, "error": "Internal Server Error"}, status=500)

class MaintenanceMiddleware:
    async def __call__(self, handler, event, data):
        if await is_maintenance_mode():
            user = data.get("event_from_user")
            if user:
                is_adm = (user.id in (ADMIN_IDS or [])) or (user.id == MAIN_ADMIN_ID)
                if not is_adm:
                    if getattr(event, "callback_query", None):
                        try:
                            await event.callback_query.answer("Бот на техобслуживании. Приходите позже.", show_alert=True)
                        except Exception: pass
                        return
                    if getattr(event, "message", None):
                        try:
                            await event.message.answer("⚠️ Бот временно отключен на техническое обслуживание. Пожалуйста, попробуйте зайти позже.")
                        except Exception: pass
                        return
                    return
        return await handler(event, data)

def _apply_cors_headers(req: web.Request, resp: web.StreamResponse):
    origin = req.headers.get("Origin")
    if not CORS_ORIGINS or "*" in CORS_ORIGINS:
        resp.headers["Access-Control-Allow-Origin"] = origin or "*"
    elif origin and origin in CORS_ORIGINS:
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Vary"] = "Origin"
    else:
        if not origin: return
        return

    resp.headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type, X-Tg-InitData, X-Tg-Init-Data, X-Telegram-Init-Data, X-Session-Token, Authorization, X-Init-Data"
    resp.headers["Access-Control-Max-Age"] = "86400"

@web.middleware
async def cors_middleware(req: web.Request, handler):
    if req.method == "OPTIONS":
        resp = web.Response(status=204)
        _apply_cors_headers(req, resp)
        return resp
    resp = await handler(req)
    _apply_cors_headers(req, resp)
    return resp

@web.middleware
async def no_cache_mw(request: web.Request, handler):
    resp = await handler(request)
    try:
        if request.path.startswith("/app/") or request.path == "/app":
            resp.headers["Cache-Control"] = "no-store, max-age=0"
            resp.headers["Pragma"] = "no-cache"
            resp.headers["Expires"] = "0"
        if request.path.startswith("/api/"):
            resp.headers["Cache-Control"] = "no-store, max-age=0"
            resp.headers["Pragma"] = "no-cache"
            resp.headers["Expires"] = "0"
    except Exception:
        pass
    return resp
