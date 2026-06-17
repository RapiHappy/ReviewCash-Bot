from datetime import datetime, timezone
import math
import random
import json
import logging
from aiohttp import web

from config import T_BAL, T_USERS, T_PAY
from database import sb_select, sb_update, sb_insert
from services.balances import add_rub, add_xp
from services.limits import check_limit, touch_limit
from services.web_utils import safe_json, require_init
from services.redis_client import redis_client

log = logging.getLogger("reviewcash.games")

# Helper combinatorics function
def math_comb(n, k):
    if k < 0 or k > n:
        return 0
    return math.comb(n, k)

# Multiplier calculation for Mines with 4% house edge
def calc_mines_mult(mines_count, gems_found):
    total_cells = 16
    safe_cells = total_cells - mines_count
    if gems_found <= 0 or gems_found > safe_cells:
        return 0.0
    p = math_comb(safe_cells, gems_found) / math_comb(total_cells, gems_found)
    if p <= 0:
        return 0.0
    mult = (1.0 / p) * 0.96
    return round(mult, 2)

# --------------------
# 1. Wheel of Fortune
# --------------------
async def api_game_wheel(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])

    # Check daily free spin cooldown
    free_available, wait_sec = await check_limit(uid, "wheel_spin", 24 * 3600)
    
    cost = 0.0
    is_free = False
    
    if free_available:
        is_free = True
        await touch_limit(uid, "wheel_spin")
    else:
        # Paid spin: check balance and deduct 5₽
        cost = 5.0
        bal_res = await sb_select(T_BAL, {"user_id": uid}, columns="rub_balance")
        if not bal_res.data:
            return web.json_response({"ok": False, "error": "Пользователь не найден"}, status=400)
        
        balance = float(bal_res.data[0].get("rub_balance") or 0.0)
        if balance < cost:
            return web.json_response({"ok": False, "error": "Недостаточно средств. Стоимость прокрута: 5 ₽"}, status=400)
        
        # Deduct paid spin cost
        await add_rub(uid, -cost)
        # Record payment log for audit
        await sb_insert(T_PAY, {
            "user_id": uid,
            "amount_rub": -cost,
            "provider": "game_wheel",
            "status": "paid",
            "meta": {"cost": cost}
        })

    # Weighted random rewards
    rewards = [
        {"type": "rub", "value": 0.5, "weight": 35, "label": "0.5 ₽"},
        {"type": "rub", "value": 1.0, "weight": 25, "label": "1.0 ₽"},
        {"type": "rub", "value": 2.0, "weight": 15, "label": "2.0 ₽"},
        {"type": "rub", "value": 5.0, "weight": 5, "label": "5.0 ₽"},
        {"type": "rub", "value": 10.0, "weight": 2, "label": "10.0 ₽"},
        {"type": "xp", "value": 10, "weight": 13, "label": "10 XP"},
        {"type": "xp", "value": 30, "weight": 4, "label": "30 XP"},
        {"type": "xp", "value": 100, "weight": 1, "label": "100 XP"},
    ]
    
    choices = []
    for r in rewards:
        choices.extend([r] * r["weight"])
        
    reward = random.choice(choices)
    
    # Apply rewards
    if reward["type"] == "rub":
        await add_rub(uid, reward["value"])
    elif reward["type"] == "xp":
        await add_xp(uid, reward["value"])
        
    # Get final balances
    bal_res = await sb_select(T_BAL, {"user_id": uid}, columns="rub_balance,xp,level")
    final_bal = bal_res.data[0] if (bal_res.data) else {}
        
    return web.json_response({
        "ok": True,
        "is_free": is_free,
        "reward": {
            "type": reward["type"],
            "value": reward["value"],
            "label": reward["label"]
        },
        "balance": {
            "rub_balance": float(final_bal.get("rub_balance") or 0.0),
            "xp": int(final_bal.get("xp") or 0),
            "level": int(final_bal.get("level") or 1)
        }
    })

# --------------------
# 2. Coin Flip
# --------------------
async def api_game_coinflip(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    
    body = await safe_json(req)
    bet = float(body.get("bet") or 0.0)
    side = str(body.get("side") or "").lower().strip()
    
    if side not in ("heads", "tails"):
        return web.json_response({"ok": False, "error": "Выбери сторону (Орел или Решка)"}, status=400)
    if bet < 1.0:
        return web.json_response({"ok": False, "error": "Минимальная ставка: 1 ₽"}, status=400)
    if bet > 200.0:
        return web.json_response({"ok": False, "error": "Максимальная ставка: 200 ₽"}, status=400)

    # Check user balance
    bal_res = await sb_select(T_BAL, {"user_id": uid}, columns="rub_balance")
    if not bal_res.data:
         return web.json_response({"ok": False, "error": "Пользователь не найден"}, status=400)
         
    balance = float(bal_res.data[0].get("rub_balance") or 0.0)
    if balance < bet:
         return web.json_response({"ok": False, "error": f"Недостаточно средств. Ваш баланс: {balance:.2f} ₽"}, status=400)

    # Deduct bet
    await add_rub(uid, -bet)
    
    # Flip coin (0 = heads, 1 = tails)
    flip_val = random.randint(0, 1)
    flip_side = "heads" if flip_val == 0 else "tails"
    
    won = (side == flip_side)
    win_amount = 0.0
    mult = 0.0
    
    if won:
        mult = 1.95
        win_amount = round(bet * mult, 2)
        await add_rub(uid, win_amount)
        
    # Log payment log
    await sb_insert(T_PAY, {
        "user_id": uid,
        "amount_rub": -bet + win_amount,
        "provider": "game_coinflip",
        "status": "paid",
        "meta": {"bet": bet, "side": side, "flipped": flip_side, "won": won, "win_amount": win_amount}
    })

    # Get final balance
    bal_res = await sb_select(T_BAL, {"user_id": uid}, columns="rub_balance")
    final_bal = bal_res.data[0] if (bal_res.data) else {}

    return web.json_response({
        "ok": True,
        "won": won,
        "flipped": flip_side,
        "multiplier": mult,
        "win_amount": win_amount,
        "rub_balance": float(final_bal.get("rub_balance") or 0.0)
    })

# --------------------
# 3. Mines Game
# --------------------
async def api_game_mines_start(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    
    body = await safe_json(req)
    bet = float(body.get("bet") or 0.0)
    mines_count = int(body.get("mines_count") or 3)
    
    if mines_count < 1 or mines_count > 12:
        return web.json_response({"ok": False, "error": "Количество мин должно быть от 1 до 12"}, status=400)
    if bet < 1.0:
        return web.json_response({"ok": False, "error": "Минимальная ставка: 1 ₽"}, status=400)
    if bet > 200.0:
        return web.json_response({"ok": False, "error": "Максимальная ставка: 200 ₽"}, status=400)

    # Check if there is an active game in Redis
    redis_key = f"rc:mines:game:{uid}"
    active = await redis_client.get(redis_key)
    
    # Check balance
    bal_res = await sb_select(T_BAL, {"user_id": uid}, columns="rub_balance")
    if not bal_res.data:
         return web.json_response({"ok": False, "error": "Пользователь не найден"}, status=400)
         
    balance = float(bal_res.data[0].get("rub_balance") or 0.0)

    if active:
        game = json.loads(active)
        gems_found = len(game["uncovered"])
        next_mult = calc_mines_mult(game["mines_count"], gems_found + 1)
        return web.json_response({
            "ok": True,
            "bet": game["bet"],
            "mines_count": game["mines_count"],
            "uncovered": game["uncovered"],
            "status": "active",
            "multiplier": game["multiplier"],
            "next_multiplier": next_mult,
            "rub_balance": balance,
            "resumed": True
        })

    if balance < bet:
         return web.json_response({"ok": False, "error": f"Недостаточно средств. Ваш баланс: {balance:.2f} ₽"}, status=400)

    # Deduct bet
    await add_rub(uid, -bet)

    # Generate mines
    cell_indices = list(range(16))
    mines = random.sample(cell_indices, mines_count)
    
    state = {
        "bet": bet,
        "mines_count": mines_count,
        "mines": mines,
        "uncovered": [],
        "status": "active",
        "multiplier": 1.0
    }
    
    # Store game in Redis (expires in 30 minutes)
    await redis_client.set(redis_key, json.dumps(state), ex=1800)

    # First gem multiplier
    next_mult = calc_mines_mult(mines_count, 1)

    return web.json_response({
        "ok": True,
        "bet": bet,
        "mines_count": mines_count,
        "uncovered": [],
        "status": "active",
        "multiplier": 1.0,
        "next_multiplier": next_mult,
        "rub_balance": balance - bet
    })

async def api_game_mines_flip(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    
    body = await safe_json(req)
    cell_idx = int(body.get("cell_index") is not None and body.get("cell_index") if body.get("cell_index") is not None else -1)
    
    if cell_idx < 0 or cell_idx > 15:
        return web.json_response({"ok": False, "error": "Неверный индекс ячейки"}, status=400)

    redis_key = f"rc:mines:game:{uid}"
    game_raw = await redis_client.get(redis_key)
    if not game_raw:
        return web.json_response({"ok": False, "error": "Нет активной игры"}, status=400)
        
    game = json.loads(game_raw)
    if game["status"] != "active":
        return web.json_response({"ok": False, "error": "Игра уже завершена"}, status=400)
        
    if cell_idx in game["uncovered"]:
        return web.json_response({"ok": False, "error": "Ячейка уже открыта"}, status=400)

    # Check hit
    if cell_idx in game["mines"]:
        # Bomb hit! Lose bet, delete key
        await redis_client.delete(redis_key)
        
        # Log lost bet payment record
        await sb_insert(T_PAY, {
            "user_id": uid,
            "amount_rub": -game["bet"],
            "provider": "game_mines",
            "status": "paid",
            "meta": {"bet": game["bet"], "mines_count": game["mines_count"], "won": False, "win_amount": 0.0}
        })
        
        # Get final balance
        bal_res = await sb_select(T_BAL, {"user_id": uid}, columns="rub_balance")
        final_bal = bal_res.data[0] if (bal_res.data) else {}
        
        return web.json_response({
            "ok": True,
            "hit_bomb": True,
            "mines": game["mines"],
            "win_amount": 0.0,
            "rub_balance": float(final_bal.get("rub_balance") or 0.0)
        })

    # Gem! Add to uncovered
    game["uncovered"].append(cell_idx)
    gems_found = len(game["uncovered"])
    
    mult = calc_mines_mult(game["mines_count"], gems_found)
    game["multiplier"] = mult
    
    # Save back
    await redis_client.set(redis_key, json.dumps(game), ex=1800)
    
    # Calculate next multiplier
    next_mult = calc_mines_mult(game["mines_count"], gems_found + 1)
    
    return web.json_response({
        "ok": True,
        "hit_bomb": False,
        "uncovered": game["uncovered"],
        "multiplier": mult,
        "next_multiplier": next_mult,
        "potential_win": round(game["bet"] * mult, 2)
    })

async def api_game_mines_cashout(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    
    redis_key = f"rc:mines:game:{uid}"
    game_raw = await redis_client.get(redis_key)
    if not game_raw:
        return web.json_response({"ok": False, "error": "Нет активной игры"}, status=400)
        
    game = json.loads(game_raw)
    if game["status"] != "active":
        return web.json_response({"ok": False, "error": "Игра уже завершена"}, status=400)
        
    if not game["uncovered"]:
        return web.json_response({"ok": False, "error": "Откройте хотя бы один алмаз перед тем, как забрать деньги!"}, status=400)

    # Cashout winnings
    win_amount = round(game["bet"] * game["multiplier"], 2)
    await add_rub(uid, win_amount)
    
    # Log win
    await sb_insert(T_PAY, {
        "user_id": uid,
        "amount_rub": -game["bet"] + win_amount,
        "provider": "game_mines",
        "status": "paid",
        "meta": {"bet": game["bet"], "mines_count": game["mines_count"], "won": True, "win_amount": win_amount, "multiplier": game["multiplier"]}
    })
    
    # Delete from Redis
    await redis_client.delete(redis_key)
    
    # Get final balance
    bal_res = await sb_select(T_BAL, {"user_id": uid}, columns="rub_balance")
    final_bal = bal_res.data[0] if (bal_res.data) else {}
    
    return web.json_response({
        "ok": True,
        "win_amount": win_amount,
        "mines": game["mines"],
        "multiplier": game["multiplier"],
        "rub_balance": float(final_bal.get("rub_balance") or 0.0)
    })

async def api_game_mines_state(req: web.Request):
    _, user = await require_init(req)
    uid = int(user["id"])
    redis_key = f"rc:mines:game:{uid}"
    active = await redis_client.get(redis_key)
    if not active:
        return web.json_response({"ok": True, "active": False})
        
    game = json.loads(active)
    gems_found = len(game["uncovered"])
    next_mult = calc_mines_mult(game["mines_count"], gems_found + 1)
    
    bal_res = await sb_select(T_BAL, {"user_id": uid}, columns="rub_balance")
    balance = float(bal_res.data[0].get("rub_balance") or 0.0) if bal_res.data else 0.0

    return web.json_response({
        "ok": True,
        "active": True,
        "bet": game["bet"],
        "mines_count": game["mines_count"],
        "uncovered": game["uncovered"],
        "multiplier": game["multiplier"],
        "next_multiplier": next_mult,
        "rub_balance": balance
    })
