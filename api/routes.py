import asyncio
import logging
from pathlib import Path
from aiohttp import web
from config import WEBHOOK_PATH, APP_BUILD, CRYPTO_WEBHOOK_PATH, STARS_RUB_RATE, XP_PER_TOPUP_100, T_PAY
from database import sb_select, sb_update
from services.balances import add_rub, add_xp
from services.user_service import stats_add
from services.telegram_utils import bot, dp, notify_user
from services.web_utils import safe_json

# Import all API handlers
from api.tasks import *
from api.withdraw import *
from api.admin import *
from api.payments import *
from api.user import *
from api.misc import *

log = logging.getLogger("reviewcash.routes")

async def health(req: web.Request):
    return web.json_response({'ok': True, 'app_build': APP_BUILD})

async def tg_webhook(req: web.Request):
    update = await safe_json(req)
    try:
        asyncio.create_task(dp.feed_webhook_update(bot, update))
    except Exception:
        await dp.feed_webhook_update(bot, update)
    return web.Response(text="OK")

async def cryptobot_webhook(req: web.Request):
    try:
        from crypto_service import crypto
    except Exception:
        crypto = None
        
    if not crypto:
        return web.Response(text="no cryptobot", status=200)

    data = await safe_json(req)
    try:
        update = data.get("update", {})
        inv = update.get("payload", {}) or update.get("invoice", {}) or update
        invoice_id = str(inv.get("invoice_id") or inv.get("id") or "")
        status = str(inv.get("status") or "").lower()

        if not invoice_id:
            return web.Response(text="ok", status=200)

        pay = await sb_select(T_PAY, {"provider": "cryptobot", "provider_ref": invoice_id}, limit=1)
        if not pay.data:
            return web.Response(text="ok", status=200)

        prow = pay.data[0]
        if prow.get("status") == "paid":
            return web.Response(text="ok", status=200)

        if status in ("paid", "completed"):
            uid = int(prow["user_id"])
            amount = float(prow.get("amount_rub") or 0)
            await sb_update(T_PAY, {"id": prow["id"]}, {"status": "paid"})
            await add_rub(uid, amount)
            await stats_add("topups_rub", amount)

            # XP for topup
            xp_add = int((amount // 100) * XP_PER_TOPUP_100)
            if xp_add > 0:
                await add_xp(uid, xp_add)

            await notify_user(bot, uid, f"✅ Пополнение успешно: +{amount:.2f}₽")

        return web.Response(text="ok", status=200)
    except Exception as e:
        log.exception("cryptobot webhook error: %s", e)
        return web.Response(text="ok", status=200)

def setup_routes(app: web.Application):
    app.router.add_get("/", health)
    app.router.add_get("/api/health", health)
    app.router.add_get("/api/version", health)
    
    # Static Mini App serving
    base_dir = Path(__file__).resolve().parent.parent
    static_dir = base_dir / "public"
    
    if static_dir.exists():
        async def app_redirect(req: web.Request):
            raise web.HTTPFound(f"/app/?v={APP_BUILD}")

        async def app_index(req: web.Request):
            try:
                html_content = (static_dir / "index.html").read_text(encoding="utf-8")
                html_content = html_content.replace("__APP_BUILD__", APP_BUILD)
                return web.Response(text=html_content, content_type="text/html")
            except Exception:
                return web.FileResponse(static_dir / "index.html")

        app.router.add_get("/app", app_redirect)
        app.router.add_get("/app/", app_index)
        app.router.add_static("/app/", path=str(static_dir), show_index=False)
    
    # Webhooks
    app.router.add_post(WEBHOOK_PATH, tg_webhook)
    app.router.add_post(CRYPTO_WEBHOOK_PATH, cryptobot_webhook)

    # API
    app.router.add_post("/api/sync", api_sync)
    app.router.add_post("/api/user/gender", api_user_gender_set)
    app.router.add_post("/api/tg/check_chat", api_tg_check_chat)
    app.router.add_post("/api/task/create", api_task_create)
    app.router.add_post("/api/task/click", api_task_click)
    app.router.add_post("/api/task/submit", api_task_submit)
    app.router.add_post("/api/proof/upload", api_proof_upload)
    app.router.add_post("/api/referrals", api_referrals)
    app.router.add_post("/api/bonus/claim", api_bonus_claim)
    app.router.add_post("/api/leaderboard/top", api_leaderboard_top)
    app.router.add_post("/api/withdraw/create", api_withdraw_create)
    app.router.add_post("/api/withdraw/list", api_withdraw_list)
    app.router.add_post("/api/tbank/claim", api_tbank_claim)
    app.router.add_post("/api/pay/stars/link", api_stars_link)
    app.router.add_post("/api/ops/list", api_ops_list)
    app.router.add_post("/api/report/list", api_report_list)
    app.router.add_post("/api/report/clear", api_report_clear)
    app.router.add_post("/api/vip/buy", api_vip_buy)
    app.router.add_post("/api/admin/config/toggle_commission", api_admin_toggle_commission)
    app.router.add_post("/api/admin/config/toggle_maintenance", api_admin_toggle_maintenance)
    app.router.add_post("/api/pay/cryptobot/create", api_cryptobot_create)
    
    # Admin API
    app.router.add_post("/api/admin/summary", api_admin_summary)
    app.router.add_post("/api/admin/stars-pay/set", api_admin_stars_pay_set)
    app.router.add_post("/api/admin/balance/credit", api_admin_balance_credit)
    app.router.add_post("/api/admin/user/punish", api_admin_user_punish)
    app.router.add_post("/api/admin/proof/list", api_admin_proof_list)
    app.router.add_post("/api/admin/proof/decision", api_admin_proof_decision)
    app.router.add_post("/api/admin/withdraw/list", api_admin_withdraw_list)
    app.router.add_post("/api/admin/withdraw/decision", api_admin_withdraw_decision)
    app.router.add_post("/api/admin/tbank/list", api_admin_tbank_list)
    app.router.add_post("/api/admin/tbank/decision", api_admin_tbank_decision)
    app.router.add_post("/api/admin/task/list", api_admin_task_list)
    app.router.add_post("/api/admin/task/delete", api_admin_task_delete)
    app.router.add_post("/api/admin/task/tg_audit", api_admin_tg_audit)
    app.router.add_post("/api/admin/user/search", api_admin_user_search)
    app.router.add_post("/api/admin/user/suspicious", api_admin_user_suspicious)
