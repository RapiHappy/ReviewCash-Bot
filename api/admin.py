from datetime import datetime, timezone, timedelta
import math
import re
import json
import base64
import logging
import asyncio
from typing import Any
from aiohttp import web

from config import *
from database import *
from services.balances import *
from services.limits import *
from services.telegram_utils import *
from crypto_service import auto_payout_crypto
import logging
from aiohttp import web
import json
import base64
import asyncio

# The main.py will later import these and inject missing dependencies
# or they will import from main/config/services properly.
from main import *
from api.task_helpers import *
async def api_admin_withdraw_list(req: web.Request):
    await require_admin(req)
    # 1. Simple fetch without join first to guarantee it works
    try:
        try:
            def _f():
                # Use 'created_at' which is known to exist from api_withdraw_list (line 3611)
                return sb.table(T_WD).select("*").neq("status", "awaiting_review").order("created_at", desc=True).limit(300).execute()
            r = await sb_exec(_f)
        except Exception as e:
            # If still error, try without order just in case
            log.error("Withdrawals fetch with order failed, trying fallback: %s", e)
            r = await sb_exec(lambda: sb.table(T_WD).select("*").limit(300).execute())
            
        data = r.data or []
        # Fallback names: if username is missing in the row, we show ID
        for item in data:
            if not item.get("username"):
                item["username"] = f"User {item.get('user_id') or item.get('tg_user_id')}"
                
        return web.json_response({"ok": True, "withdrawals": data})
        
    except Exception as e:
        log.exception("CRITICAL: api_admin_withdraw_list crash: %s", e)
        return web.json_response({"ok": False, "error": f"Ошибка БД: {str(e)}"}, status=500)

async def api_admin_tbank_list(req: web.Request):
    await require_admin(req)
    
    # Join with users to get username
    r = await sb_exec(lambda: sb.from_(T_PAY).select("*, user:users(username)").eq("provider", "tbank").eq("status", "pending").order("created_at", desc=True).limit(200).execute())
    data = r.data or []
    for item in data:
        user_obj = item.pop("user", {}) or {}
        item["username"] = user_obj.get("username")
    return web.json_response({"ok": True, "tbank": data})

async def api_admin_user_punish(req: web.Request):
    """
    Admin sanctions:
      - temporary ban (global/tasks/tbank/withdraw)
      - permanent ban via users.is_banned
      - fine / manual balance adjustment (rub only)
    Body:
      { user_id, action: "ban"|"unban"|"permaban"|"unpermaban"|"fine",
        kind: "global"|"tasks"|"tbank"|"withdraw",
        days, hours, seconds,
        amount_rub, reason }
    """
    admin = await require_admin(req)
    body = await safe_json(req)

    raw_uid = body.get("user_id") or body.get("uid")
    uid = await resolve_user_id(str(raw_uid))
    
    if not uid:
        return web.json_response({"ok": False, "error": f"Пользователь '{raw_uid}' не найден"}, status=400)

    action = str(body.get("action") or "").strip().lower()
    if not action:
        # backward-compat: if "ban_days" provided assume ban
        action = "ban" if body.get("days") or body.get("ban_days") else "fine"

    kind = str(body.get("kind") or "global").strip().lower()
    if kind not in ("global", "tasks", "tbank", "withdraw"):
        kind = "global"

    reason = str(body.get("reason") or "").strip()
    admin_id = int(admin.get("id") or 0)

    # Permanent ban/unban (only main admin)
    if action in ("permaban", "ban_perm", "perma"):
        if int(MAIN_ADMIN_ID or 0) and admin_id != int(MAIN_ADMIN_ID or 0):
            return web.json_response({"ok": False, "error": "Только главный админ"}, status=403)
        try:
            await sb_update(T_USERS, {"user_id": uid}, {"is_banned": True})
        except Exception:
            # row might not exist yet
            await sb_upsert(T_USERS, {"user_id": uid, "is_banned": True}, on_conflict="user_id")
        await notify_user(uid, f"🚫 Аккаунт заблокирован администратором.\n{('Причина: ' + reason) if reason else ''}".strip())
        return web.json_response({"ok": True, "action": "permaban", "user_id": uid})

    if action in ("unpermaban", "unban_perm", "unperma"):
        if int(MAIN_ADMIN_ID or 0) and admin_id != int(MAIN_ADMIN_ID or 0):
            return web.json_response({"ok": False, "error": "Только главный админ"}, status=403)
        try:
            await sb_update(T_USERS, {"user_id": uid}, {"is_banned": False})
        except Exception:
            await sb_upsert(T_USERS, {"user_id": uid, "is_banned": False}, on_conflict="user_id")
        await notify_user(uid, "✅ Блокировка аккаунта снята администратором.")
        return web.json_response({"ok": True, "action": "unpermaban", "user_id": uid})

    # Temporary bans
    if action in ("ban", "tempban"):
        # only main admin can set GLOBAL ban longer than 30 days
        days = body.get("days") if body.get("days") is not None else body.get("ban_days")
        hours = body.get("hours")
        seconds = body.get("seconds")

        try:
            days = int(days or 0)
        except Exception:
            days = 0
        try:
            hours = int(hours or 0)
        except Exception:
            hours = 0
        try:
            seconds = int(seconds or 0)
        except Exception:
            seconds = 0

        total_sec = max(0, seconds + hours * 3600 + days * 86400)
        if total_sec <= 0:
            total_sec = 86400  # default 1 day

        if kind == "global":
            if days >= 30 and int(MAIN_ADMIN_ID or 0) and admin_id != int(MAIN_ADMIN_ID or 0):
                return web.json_response({"ok": False, "error": "Длительный глобальный бан — только главный админ"}, status=403)
            until = await set_limit_until(uid, GLOBAL_BAN_KEY, total_sec)
        elif kind == "tasks":
            until = await set_task_ban(uid, max(1, int(total_sec // 86400) or 1))
        elif kind == "tbank":
            until = await set_limit_until(uid, TBANK_BAN_KEY, total_sec)
        else:  # withdraw
            until = await set_limit_until(uid, WITHDRAW_BAN_KEY, total_sec)

        await notify_user(uid, f"⛔ Временная блокировка ({kind}) до {until.strftime('%Y-%m-%d %H:%M')} UTC.\n{('Причина: ' + reason) if reason else ''}".strip())
        return web.json_response({"ok": True, "action": "ban", "kind": kind, "user_id": uid, "until": until.isoformat()})

    if action in ("unban", "clearban"):
        if kind == "tasks":
            await clear_limit(uid, TASK_BAN_KEY)
        elif kind == "tbank":
            await clear_limit(uid, TBANK_BAN_KEY)
        elif kind == "withdraw":
            await clear_limit(uid, WITHDRAW_BAN_KEY)
        else:
            await clear_limit(uid, GLOBAL_BAN_KEY)

        await notify_user(uid, f"✅ Бан ({kind}) снят администратором.")
        return web.json_response({"ok": True, "action": "unban", "kind": kind, "user_id": uid})

    # Fine / manual adjustment (rub only)
    if action in ("fine", "adjust", "balance"):
        try:
            amount = float(body.get("amount_rub") if body.get("amount_rub") is not None else body.get("rub") or body.get("amount") or 0)
        except Exception:
            amount = 0.0
        if amount == 0:
            return web.json_response({"ok": False, "error": "Укажи сумму (amount_rub)"}, status=400)

        # amount can be negative (fine) or positive (manual credit)
        new_rub = await add_rub(uid, float(amount))

        # record in payments so it appears in history
        try:
            await sb_insert(T_PAY, {
                "user_id": uid,
                "provider": "admin",
                "status": "paid",
                "amount_rub": float(amount),
                "provider_ref": f"admin:{admin_id}:{int(_now().timestamp())}",
                "meta": {"reason": reason, "by": admin_id, "kind": "fine" if amount < 0 else "credit"}
            })
        except Exception:
            pass

        txt = "💸 Штраф" if amount < 0 else "➕ Начисление"
        await notify_user(uid, f"{txt}: {amount:+.0f} ₽\nБаланс: {new_rub:.0f} ₽\n{('Причина: ' + reason) if reason else ''}".strip())

        return web.json_response({"ok": True, "action": "fine", "user_id": uid, "amount_rub": float(amount), "rub_balance": new_rub})

    return web.json_response({"ok": False, "error": "Неизвестное действие"}, status=400)

async def api_admin_withdraw_decision(req: web.Request):
    await require_admin(req)
    body = await safe_json(req)

    withdraw_id = body.get("withdraw_id")
    approved = bool(body.get("approved"))

    if withdraw_id is None:
        raise web.HTTPBadRequest(text="Missing withdraw_id")

    r = await sb_select(T_WD, {"id": withdraw_id}, limit=1)
    if not r.data:
        return web.json_response({"ok": False, "error": "Withdrawal not found"}, status=404)
    wd = r.data[0]

    if wd.get("status") != "pending":
        return web.json_response({"ok": True, "status": wd.get("status")})

    uid = int(wd.get("user_id") or 0)
    amount = float(wd.get("amount_rub") or 0)
    details = str(wd.get("details") or "")
    
    # Parse payout_method from details: "full_name | method | value"
    payout_method = "phone"
    if "|" in details:
        parts = [p.strip().lower() for p in details.split("|")]
        if len(parts) >= 2:
            payout_method = parts[1]

    if approved:
        if payout_method == "cryptobot":
            # Автоматическая выплата через CryptoBot (USDT)
            # Округляем до 2 знаков для API
            amount_usdt = round(amount / max(CRYPTO_RUB_PER_USDT, 0.01), 2)
            
            is_success, msg = await auto_payout_crypto(uid, amount_usdt, withdraw_id)
            if not is_success:
                return web.json_response({"ok": False, "error": f"Ошибка перевода крипты: {msg}"})

            await sb_update(T_WD, {"id": withdraw_id}, {"status": "paid"})
            await stats_add("payouts_rub", amount)
            await notify_user(uid, f"✅ Заявка на вывод подтверждена. Переведено {amount_usdt} USDT через CryptoBot. Ожидай зачисление.")
        else:
            # Ручная выплата (карта/телефон) - админ уже перевел средства сам
            await sb_update(T_WD, {"id": withdraw_id}, {"status": "paid"})
            await stats_add("payouts_rub", amount)
            await notify_user(uid, f"✅ Ваша заявка на вывод ({amount}₽) успешно обработана и выплачена.")
    else:
        await add_rub(uid, amount)
        await sb_update(T_WD, {"id": withdraw_id}, {"status": "rejected"})
        await notify_user(uid, "❌ Заявка на вывод отклонена. Средства возвращены на баланс.")

    return web.json_response({"ok": True})

async def api_admin_balance_credit(req: web.Request):
    admin = await require_admin(req)
    body = await safe_json(req)
    raw_uid = body.get("user_id") or body.get("uid")
    uid = await resolve_user_id(str(raw_uid))
    
    if not uid:
        return web.json_response({"ok": False, "error": f"Пользователь '{raw_uid}' не найден"}, status=400)

    amount = parse_amount_rub(body.get("amount_rub") or body.get("amount") or body.get("sum") or body.get("value") or body.get("rub"))
    if amount is None or amount <= 0:
        return web.json_response({"ok": False, "error": "Некорректная сумма"}, status=400)
    reason = str(body.get("reason") or body.get("comment") or "Начисление админом").strip()

    await add_rub(uid, float(amount))
    try:
        await sb_insert(T_PAY, {
            "user_id": uid,
            "provider": "admin_credit",
            "status": "paid",
            "amount_rub": float(amount),
            "provider_ref": f"admin_credit:{int(admin['id'])}:{int(_now().timestamp())}",
            "meta": {"reason": reason, "admin_id": int(admin["id"])}
        })
    except Exception:
        pass

    try:
        await notify_user(uid, f"💸 Начисление: +{float(amount):.2f}₽\nПричина: {reason}")
    except Exception:
        pass

    return web.json_response({"ok": True})

async def api_admin_task_delete(req: web.Request):
    await require_main_admin(req)
    body = await safe_json(req)
    task_id = str(body.get("task_id") or "").strip()
    if not task_id:
        return json_error(400, "task_id required", code="BAD_TASK_ID")
    # delete task and related proofs (best effort)
    await sb_delete(T_TASKS, {"id": cast_id(task_id)})
    try:
        await sb_delete(T_COMP, {"task_id": cast_id(task_id)})
    except Exception:
        pass
    return web.json_response({"ok": True})
# =========================================================

async def api_admin_user_suspicious(req: web.Request):
    await require_admin(req)
    
    # 1. Multi-accounting detector
    def _f():
        return sb.table(T_DEV).select("tg_user_id, device_hash").order("last_seen_at", desc=True).limit(3000).execute()
    r = await sb_exec(_f)
    data = r.data or []
    
    hash_map = {}
    for row in data:
        uid = row.get("tg_user_id")
        h = row.get("device_hash")
        if not h or not uid: continue
        if h not in hash_map: hash_map[h] = set()
        hash_map[h].add(uid)
    
    suspicious = []
    multi_uids = set()
    for h, uids in hash_map.items():
        if len(uids) > 1:
            multi_uids.update(uids)
            
    if multi_uids:
        def _u():
            return sb.table(T_USERS).select("user_id, username, first_name, is_banned").in_("user_id", list(multi_uids)).limit(300).execute()
        ur = await sb_exec(_u)
        for u in (ur.data or []):
            u["reason"] = "Мультиаккаунт (одно устройство)"
            suspicious.append(u)
            
    return web.json_response({"ok": True, "users": suspicious})

# =========================================================
# Telegram handlers
# =========================================================

async def api_admin_tbank_decision(req: web.Request):
    await require_admin(req)
    body = await safe_json(req)

    payment_id = body.get("payment_id")
    approved = bool(body.get("approved"))

    if payment_id is None:
        raise web.HTTPBadRequest(text="Missing payment_id")

    r = await sb_select(T_PAY, {"id": payment_id}, limit=1)
    if not r.data:
        return web.json_response({"ok": False, "error": "Payment not found"}, status=404)
    pay = r.data[0]

    if pay.get("provider") != "tbank":
        return web.json_response({"ok": False, "error": "Not tbank payment"}, status=400)
    if pay.get("status") != "pending":
        return web.json_response({"ok": True, "status": pay.get("status")})

    uid = int(pay.get("user_id") or 0)
    amount = float(pay.get("amount_rub") or 0)

    if approved:
        await sb_update(T_PAY, {"id": payment_id}, {"status": "paid"})
        await add_rub(uid, amount)
        await stats_add("topups_rub", amount)

        xp_add = int((amount // 100) * XP_PER_TOPUP_100)
        if xp_add > 0:
            await add_xp(uid, xp_add)

        await notify_user(uid, f"<b>💎 Пополнение подтверждено!</b>\n\nБаланс пополнен на <b>{amount:.2f} ₽</b>. Теперь вы можете запускать новые задания и продвигать свои проекты. Удачного продвижения! 🚀", reply_markup=back_to_app_kb())
        try:
            until = await set_tbank_cooldown(uid)
            # optional notify about cooldown
            await notify_user(uid, "⏳ Следующее пополнение через Т-Банк будет доступно через 24 часа.")
        except Exception:
            pass
    else:
        await sb_update(T_PAY, {"id": payment_id}, {"status": "rejected"})
        await notify_user(uid, "❌ T-Bank пополнение отклонено администратором.")

    return web.json_response({"ok": True})

async def api_admin_stars_pay_set(req: web.Request):
    admin = await require_main_admin(req)
    body = await safe_json(req)

    raw_enabled = body.get("enabled")
    if isinstance(raw_enabled, bool):
        enabled = raw_enabled
    elif isinstance(raw_enabled, (int, float)):
        enabled = bool(raw_enabled)
    else:
        enabled = str(raw_enabled).strip().lower() in ("1", "true", "yes", "y", "on", "enable", "enabled")

    enabled = await set_stars_payments_enabled(enabled, int(admin["id"]))
    status_text = "включена" if enabled else "выключена"
    try:
        await notify_admin(f"⭐ Оплата Stars {status_text} главным админом")
    except Exception:
        pass

    return web.json_response({"ok": True, "enabled": enabled})

async def api_admin_toggle_commission(req: web.Request):
    await require_main_admin(req)
    body = await safe_json(req)
    enabled = bool(body.get("enabled", True))
    await set_commission_enabled(enabled)
    return web.json_response({"ok": True, "commission_enabled": enabled})

async def api_admin_toggle_maintenance(req: web.Request):
    await require_main_admin(req)
    body = await safe_json(req)
    on = bool(body.get("enabled", False))
    await set_maintenance_mode(on)
    return web.json_response({"ok": True, "maintenance_mode": on})

# -------------------------
# Proof upload (Supabase Storage)
# -------------------------

async def api_admin_summary(req: web.Request):
    user = await require_admin(req)

    proofs = await sb_select(T_COMP, {"status": "pending"}, limit=1000)
    wds = await sb_select(T_WD, {"status": "pending"}, limit=1000)

    def _f():
        return sb.table(T_PAY).select("id").eq("provider", "tbank").eq("status", "pending").execute()
    tp = await sb_exec(_f)

    tasks = await sb_select(T_TASKS, {"status": "active"}, limit=2000)
    tasks_active = [t for t in (tasks.data or []) if int(t.get("qty_left") or 0) > 0]

    return web.json_response({
        "ok": True,
        "is_main_admin": int(MAIN_ADMIN_ID or 0) == int(user["id"]),
        "features": {
            "stars_payments_enabled": await is_stars_payments_enabled(),
            "commission_enabled": await is_commission_enabled(),
            "maintenance_enabled": await is_maintenance_mode(),
        },
        "counts": {
            "proofs": len(proofs.data or []),
            "withdrawals": len(wds.data or []),
            "tbank": len(tp.data or []),
            "tasks": len(tasks_active),
        }
    })

async def api_admin_proof_list(req: web.Request):
    await require_admin(req)
    # Join with users to get username
    def _f():
        return sb.table(T_COMP).select("*, user:users(username)").eq("status", "pending").order("created_at", desc=True).limit(200).execute()
    
    r = await sb_exec(_f)
    data = r.data or []
    for item in data:
        user_obj = item.pop("user", {}) or {}
        item["username"] = user_obj.get("username")
    return web.json_response({"ok": True, "proofs": data})

async def api_admin_task_list(req: web.Request):
    user = await require_admin(req)

    sel = await sb_select(T_TASKS, match={"status": "active"}, order="created_at", desc=True, limit=200)
    raw = sel.data or []
    tasks = [t for t in raw if int(t.get("qty_left") or 0) > 0]
    return web.json_response({"ok": True, "tasks": tasks, "is_main_admin": int(MAIN_ADMIN_ID or 0) == int(user["id"])})

async def api_admin_user_search(req: web.Request):
    admin = await require_admin(req)
    body = await safe_json(req)
    query = str(body.get("query") or "").strip()
    if not query:
        return web.json_response({"ok": False, "error": "Введите ID или ник"}, status=400)

    uid = await resolve_user_id(query)
    if not uid:
        return web.json_response({"ok": False, "error": f"Пользователь '{query}' не найден"}, status=404)

    # 1. User basic info
    u_res = await sb_select(T_USERS, {"user_id": uid}, limit=1)
    user = u_res.data[0] if u_res.data else {"user_id": uid}
    
    # 2. Balance
    bal = await get_balance(uid)
    
    # 3. Task Stats
    def _comp():
        return sb.table(T_COMP).select("status").eq("user_id", uid).execute()
    c_res = await sb_exec(_comp)
    comps = c_res.data or []
    total_tasks = len(comps)
    paid_tasks = len([c for c in comps if c.get("status") == "paid"])
    rejected_tasks = len([c for c in comps if c.get("status") == "rejected"])
    rejection_rate = round((rejected_tasks / total_tasks * 100), 1) if total_tasks > 0 else 0
    
    # 4. Withdrawal Stats
    def _wd():
        return sb.table(T_WD).select("amount_rub, status, created_at").eq("user_id", uid).execute()
    w_res = await sb_exec(_wd)
    wds = w_res.data or []
    total_withdrawals = len(wds)
    paid_withdrawals = len([w for w in wds if w.get("status") == "paid"])
    sum_withdrawals = sum([float(w.get("amount_rub") or 0) for w in wds if w.get("status") == "paid"])
    
    # 5. Multi-account check (Linked Accounts)
    def _dev():
        return sb.table(T_DEV).select("device_hash").eq("tg_user_id", uid).execute()
    d_res = await sb_exec(_dev)
    hashes = [d.get("device_hash") for d in (d_res.data or []) if d.get("device_hash")]
    
    linked_users = []
    if hashes:
        def _linked():
            return sb.table(T_DEV).select("tg_user_id").in_("device_hash", hashes).execute()
        l_res = await sb_exec(_linked)
        l_uids = {row["tg_user_id"] for row in (l_res.data or []) if row.get("tg_user_id") != uid}
        if l_uids:
            def _lu():
                return sb.table(T_USERS).select("user_id, username").in_("user_id", list(l_uids)).execute()
            lu_res = await sb_exec(_lu)
            linked_users = lu_res.data or []

    # 6. VIP
    vip_until = await get_vip_until(uid)

    return web.json_response({
        "ok": True,
        "user": {
            "id": uid,
            "username": user.get("username"),
            "first_name": user.get("first_name"),
            "is_banned": bool(user.get("is_banned")),
            "vip_until": vip_until.isoformat() if vip_until else None,
            "balance": {
                "rub": bal.get("rub_balance", 0),
                "stars": bal.get("stars_balance", 0),
                "xp": bal.get("xp", 0),
                "level": bal.get("level", 1)
            },
            "stats": {
                "total_tasks": total_tasks,
                "paid_tasks": paid_tasks,
                "rejected_tasks": rejected_tasks,
                "rejection_rate": rejection_rate,
                "total_withdrawals": total_withdrawals,
                "paid_withdrawals": paid_withdrawals,
                "sum_withdrawals": sum_withdrawals
            },
            "linked_accounts": linked_users
        }
    })

async def api_admin_tg_audit(req: web.Request):
    # This action modifies tasks, so only main admin.
    await require_main_admin(req)

    # fetch active tasks (up to 500), filter tg here
    sel = await sb_select(T_TASKS, match={"status": "active"}, order="created_at", desc=True, limit=500)
    raw = sel.data or []
    tg_tasks = [t for t in raw if t.get("type") == "tg" and int(t.get("qty_left") or 0) > 0]

    changed = 0
    set_auto = 0
    set_manual = 0
    problems = 0

    for t in tg_tasks:
        task_id = t.get("id")
        tg_chat = (t.get("tg_chat") or "").strip()
        target_url = str(t.get("target_url") or "")
        if not tg_chat:
            continue

        try:
            desired_check_type, desired_kind, reason = await tg_calc_check_type(tg_chat, target_url)
        except Exception:
            problems += 1
            continue

        upd = {}
        if (t.get("check_type") or "manual") != desired_check_type:
            upd["check_type"] = desired_check_type
        if (t.get("tg_kind") or "") != desired_kind:
            upd["tg_kind"] = desired_kind

        if upd:
            try:
                await sb_update(T_TASKS, {"id": task_id_db}, upd)
                changed += 1
                if desired_check_type == "auto":
                    set_auto += 1
                else:
                    set_manual += 1
            except Exception:
                problems += 1

    return web.json_response({
        "ok": True,
        "total_tg": len(tg_tasks),
        "changed": changed,
        "set_auto": set_auto,
        "set_manual": set_manual,
        "problems": problems,
    })



async def api_admin_proof_decision(req: web.Request):
    admin = await require_admin(req)
    body = await safe_json(req)

    proof_id = body.get("proof_id")
    approved_raw = body.get("approved")
    if isinstance(approved_raw, bool):
        approved = approved_raw
    elif isinstance(approved_raw, (int, float)):
        approved = bool(approved_raw)
    else:
        approved = str(approved_raw).strip().lower() in ("1", "true", "yes", "y", "on")

    fake = bool(body.get("fake"))
    rework = bool(body.get("rework"))
    comment = str(body.get("comment") or body.get("rework_comment") or "").strip()

    if proof_id is None:
        raise web.HTTPBadRequest(text="Missing proof_id")

    r = await sb_select(T_COMP, {"id": cast_id(proof_id)}, limit=1)
    if not r.data:
        return web.json_response({"ok": False, "error": "Proof not found"}, status=404)
    proof = r.data[0]

    if proof.get("status") != "pending":
        return web.json_response({"ok": True, "status": proof.get("status")})

    task_id = proof.get("task_id")
    task_id_db = cast_id(task_id)
    user_id = int(proof.get("user_id") or 0)

    t = await sb_select(T_TASKS, {"id": task_id_db}, limit=1)
    task = (t.data or [{}])[0]
    reward = float(task.get("reward_rub") or 0)
    task_type = str(task.get("type") or "").lower()

    if rework:
        if task_type not in ("ya", "gm"):
            return web.json_response({"ok": False, "error": "Доработка доступна только для Яндекс/Google отзывов"}, status=400)
        moderated_at = _now()
        await sb_update(T_COMP, {"id": cast_id(proof_id)}, {
            "status": "rework",
            "moderated_by": int(admin["id"]),
            "moderated_at": moderated_at.isoformat(),
        })
        deadline = moderated_at + timedelta(days=REWORK_GRACE_DAYS)
        msg = "🛠 Отчёт отправлен на доработку."
        if comment:
            msg += f"\n\nКомментарий: {comment}"
        msg += f"\n\nНа исправление есть {REWORK_GRACE_DAYS} дня — до {deadline.strftime('%d.%m %H:%M UTC')}."
        msg += "\nПосле этого отчёт обнулится, и задание снова станет доступно другим исполнителям. Исправь отзыв/скрин и отправь отчёт заново."
        await notify_user(user_id, msg)
        return web.json_response({"ok": True, "status": "rework"})

    if approved:
        vip_until_dt = await get_vip_until(user_id)
        if vip_until_dt:
            reward = round(reward * VIP_INCOME_MULT, 2)

        try:
            await add_rub(user_id, reward)
        except Exception as e:
            log.exception("approve proof failed: add_rub uid=%s reward=%s err=%s", user_id, reward, e)
            return web.json_response({
                "ok": False,
                "code": "PAYOUT_FAILED",
                "message": "Не удалось принять отчёт: ошибка начисления. Проверь таблицу balances (rub_balance) и права Supabase."
            }, status=200)

        await stats_add("payouts_rub", reward)
        try:
            xp_added = task_xp(task)
            if vip_until_dt:
                xp_added = int(round(xp_added * VIP_XP_MULT))
            await add_xp(user_id, xp_added)
        except Exception as e:
            log.warning("add_xp skipped: %s", e)

        await maybe_pay_referral_bonus(user_id)

        await sb_update(T_COMP, {"id": cast_id(proof_id)}, {
            "status": "paid",
            "moderated_by": int(admin["id"]),
            "moderated_at": _now().isoformat(),
        })

        try:
            left = int(task.get("qty_left") or 0)
            if left > 0:
                new_left = max(0, left - 1)
                upd = {"qty_left": new_left}
                if new_left <= 0:
                    upd["status"] = "closed"
                await sb_update(T_TASKS, {"id": task_id_db}, upd)
        except Exception:
            pass

        try:
            xp_txt = f" +{int(xp_added)} XP" if "xp_added" in locals() and int(xp_added) > 0 else ""
        except Exception:
            xp_txt = ""
            
        success_msg = (
            f"<b>✨ Отчёт принят!</b>\n\n"
            f"💰 Начислено: <b>+{reward:.2f} ₽</b>\n"
            f"🚀 Опыт: <b>{xp_txt}</b>\n\n"
            f"Спасибо за качественную работу! Продолжай в том же духе 🔥"
        )
        await notify_user(user_id, success_msg, reply_markup=back_to_app_kb())
    else:
        new_status = "fake" if fake else "rejected"
        await sb_update(T_COMP, {"id": cast_id(proof_id)}, {
            "status": new_status,
            "moderated_by": int(admin["id"]),
            "moderated_at": _now().isoformat(),
        })
        if fake:
            try:
                until = await set_task_ban(user_id, days=3)
            except Exception:
                until = None
            txt = "🚫 Отчёт отмечен как фейк. Доступ к заданиям ограничен на 3 дня.\n\n⚠️ Предупреждение: за фейки применяются штрафы — блокировки, заморозка выплат и возможное снятие бонусов."
            if until:
                txt += f"\n\nБлокировка до: {until.strftime('%d.%m %H:%M')}"
            await notify_user(user_id, txt)
        else:
            msg = "❌ Отчёт отклонён модератором."
            if comment:
                msg += f"\n\nКомментарий: {comment}"
            if task_type in ("ya", "gm"):
                msg += "\n\n🗑 Удали свой отзыв как можно скорее. Если отклонённый отзыв не удалить, аккаунт могут забанить и применить штраф."
            await notify_user(user_id, msg)

    try:
        resp_extra = {"xp_added": int(xp_added)} if "xp_added" in locals() else {}
    except Exception:
        resp_extra = {}
    return web.json_response({"ok": True, **resp_extra})

