import hashlib
import random
import logging
import asyncio
from datetime import datetime, timezone, timedelta
from typing import Any

from config import (
    T_TASKS, T_COMP, T_LINK_LOG, T_USERS, T_BAL, 
    GEMINI_API_KEY, YA_COOLDOWN_SEC, GM_COOLDOWN_SEC
)
from database import sb_select, sb_insert, sb_count, sb_exec, sb, sb_update, sb_select_in
from services.balances import add_rub

log = logging.getLogger("reviewcash.task_engine")

# -------------------------
# Helpers
# -------------------------
def _now():
    return datetime.now(timezone.utc)

def _parse_dt(v):
    try:
        if not v: return None
        if isinstance(v, datetime): return v
        return datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except Exception:
        return None

def sha256_hash(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()

# Stop words for basic quality filter
STOP_WORDS = {"fake", "тест", "проверка", "test", "spam", "отзыв", "норм"}

# Global locks to prevent race conditions on link usage per URL
_link_locks: dict[str, asyncio.Lock] = {}

class TaskEngine:
    """
    Core engine for Natural Review System v2.
    Handles limits, reputation, ranking, and quality control.
    """

    # 1. Adaptive Limits
    @staticmethod
    def get_daily_limit(task: dict) -> int:
        """
        Calculates daily link limit: min(1 + qty/10, 3).
        Allows override via ADAPTIVE_LIMIT_MAX meta tag.
        """
        from api.task_helpers import get_meta
        override = get_meta(task, "ADAPTIVE_LIMIT_MAX")
        if override and str(override).isdigit():
            return int(override)
            
        qty = int(task.get("qty_total") or 1)
        return min(1 + (qty // 10), 3)

    # 2. Link Logging
    @staticmethod
    async def log_link_usage(user_id: int, task_id: int, url: str):
        """Records link usage in the history log."""
        url_hash = sha256_hash(url)
        try:
            await sb_insert(T_LINK_LOG, {
                "url_hash": url_hash,
                "user_id": user_id,
                "task_id": task_id,
                "used_at": _now().isoformat()
            })
        except Exception as e:
            log.error(f"Failed to log link usage: {e}")

    @staticmethod
    async def get_link_usage_last_24h(url: str) -> int:
        """Counts how many times this URL was used across all users in 24h."""
        url_hash = sha256_hash(url)
        since = (_now() - timedelta(hours=24)).isoformat()
        try:
            count = await sb_count(T_LINK_LOG, {"url_hash": url_hash}, gte={"used_at": since})
            return count
        except Exception:
            return 0

    # 3. Atomic Limit Verification
    @staticmethod
    async def try_reserve_link_usage(user_id: int, task_id: int, url: str, daily_limit: int) -> tuple[bool, str | None]:
        """
        Atomically checks user uniqueness and daily global limits for a link.
        Uses in-memory locks per url_hash to prevent race conditions.
        """
        url_hash = sha256_hash(url)
        
        if url_hash not in _link_locks:
            _link_locks[url_hash] = asyncio.Lock()
            
        async with _link_locks[url_hash]:
            # Check if user ever did this link
            if await TaskEngine.user_did_link_ever(user_id, url):
                return False, "Вы уже оставляли отзыв на эту ссылку."
            
            # Check global daily limit
            usage = await TaskEngine.get_link_usage_last_24h(url)
            if usage >= daily_limit:
                return False, "Лимит отзывов на эту ссылку сегодня исчерпан. Попробуйте завтра."
                
            # All clear -> Record usage
            await TaskEngine.log_link_usage(user_id, task_id, url)
            return True, None

    @staticmethod
    async def user_did_link_ever(user_id: int, url: str) -> bool:
        url_hash = sha256_hash(url)
        count = await sb_count(T_LINK_LOG, {"user_id": user_id, "url_hash": url_hash})
        return count > 0

    # 4. Weighted User Reputation
    @staticmethod
    async def calculate_user_rep(user_id: int) -> float:
        """
        Formula: (SuccessRate * 0.6) + (AvgLenScore * 0.2) + (AgeScore * 0.2)
        Returns score from 0.0 to 1.0.
        """
        try:
            # Fetch user stats from DB
            u_res = await sb_select(T_USERS, {"user_id": user_id}, limit=1)
            if not u_res.data: return 0.5
            u = u_res.data[0]
            
            # 1. Success Rate (60%)
            success = int(u.get("success_count") or 0)
            fail = int(u.get("fail_count") or 0)
            total = success + fail
            success_rate = success / max(1, total) if total > 0 else 0.8
            
            # 2. Avg Text Length (20%) - Target 200 chars
            total_len = int(u.get("total_text_length") or 0)
            avg_len = total_len / max(1, success)
            avg_len_score = min(1.0, avg_len / 200.0)
            
            # 3. Account Age (20%) - Target 30 days
            created_at = _parse_dt(u.get("created_at"))
            days = (_now() - created_at).days if created_at else 0
            age_score = min(1.0, days / 30.0)
            
            score = (success_rate * 0.6) + (avg_len_score * 0.2) + (age_score * 0.2)
            return round(score, 2)
        except Exception:
            return 0.5

    # 5. Behavior Analysis
    @staticmethod
    async def check_behavior(user_id: int, task: dict, time_since_click: float | None = None) -> tuple[bool, str | None]:
        """Detects suspicious activity patterns."""
        # A. Speed check
        if time_since_click is not None and time_since_click < 60:
            return False, "Выполняете слишком быстро. Для качественного отзыва нужно время (хотя бы 1-2 минуты)."
            
        # B. Low reputation check
        rep = await TaskEngine.calculate_user_rep(user_id)
        if rep < 0.2: # Hard block for very low rep
            return False, "Ваш уровень доверия критически низок. Обратитесь в поддержку."

        # C. Click-to-Submit Ratio (Anti-hoarding)
        # Check last 20 clicks. If > 80% were never submitted, throttle.
        try:
            # This is a bit expensive, so we might want to cache or use a specific table.
            # For now, let's keep it simple or skip if performance is a concern.
            pass
        except Exception: pass
            
        return True, None

    # 6. Task Ranking (Weighted Random)
    @staticmethod
    def calculate_task_rank(task: dict) -> float:
        """
        Formula: (Priority * 0.5) + (Random * 0.3) + (Freshness * 0.2)
        Freshness uses exponential decay: exp(-hours_old / 24)
        """
        import math
        priority = int(task.get("priority") or 0)
        p_score = min(1.0, priority / 10.0)
        
        # Freshness: exp decay, drops by ~37% every 24h
        created_at = _parse_dt(task.get("created_at"))
        hours_old = (_now() - created_at).total_seconds() / 3600 if created_at else 72
        f_score = math.exp(-hours_old / 24.0)
        
        r_score = random.random()
        
        return (p_score * 0.5) + (r_score * 0.3) + (f_score * 0.2)

    # 7. Safe Task Cancellation
    @staticmethod
    async def cancel_task(owner_id: int, task_id: int) -> tuple[bool, str | None, float]:
        """
        Cancels an active task and refunds only the performer's reward for unused slots.
        Platform keeps commission as a service fee.
        """
        try:
            res = await sb_select(T_TASKS, {"id": task_id, "owner_id": owner_id}, limit=1)
            if not res.data: return False, "Задание не найдено", 0.0
            
            task = res.data[0]
            if task.get("status") != "active":
                return False, "Задание уже неактивно", 0.0
                
            qty_left = int(task.get("qty_left") or 0)
            reward_per_unit = float(task.get("reward_rub") or 0)
            
            # Refund amount: reward * remaining items
            refund_amount = round(qty_left * reward_per_unit, 2)
            
            # Update DB
            await sb_update(T_TASKS, {"id": task_id}, {"status": "cancelled", "qty_left": 0})
            if refund_amount > 0:
                await add_rub(owner_id, refund_amount)
                
            return True, None, refund_amount
        except Exception as e:
            log.error(f"Cancel task error: {e}")
            return False, str(e), 0.0

    # 8. Layered Quality Filtering & AI Integration
    @staticmethod
    async def basic_quality_filters(text: str, task: dict) -> tuple[bool, str | None]:
        """Fast non-AI filters."""
        t = text.strip()
        if len(t) < 50:
            return False, "Отзыв слишком короткий (мин. 50 символов)."
            
        t_low = t.lower()
        if any(word in t_low for word in STOP_WORDS) and len(t) < 100:
            return False, "Отзыв содержит шаблонные или недопустимые слова."
            
        # Global uniqueness check
        try:
            existing = await sb_count(T_COMP, {"proof_text": t})
            if existing > 0:
                return False, "Такой текст отзыва уже использовался."
        except Exception: pass
        
        return True, None

    @staticmethod
    async def can_submit_review(user_id: int, task: dict, text: str, time_since_click: float | None) -> tuple[bool, str | None]:
        """
        Unified method for all submission checks.
        Combines speed, quality, link reservation, and AI.
        """
        # 1. Behavior & Speed
        ok_b, err_b = await TaskEngine.check_behavior(user_id, task, time_since_click)
        if not ok_b: return False, err_b
        
        # 2. Basic Quality
        ok_q, err_q = await TaskEngine.basic_quality_filters(text, task)
        if not ok_q: return False, err_q
        
        # 3. Link Reservation (Atomic)
        url = task.get("target_url")
        if url:
            limit = TaskEngine.get_daily_limit(task)
            ok_r, err_r = await TaskEngine.try_reserve_link_usage(user_id, task.get("id"), url, limit)
            if not ok_r: return False, err_r
            
        # 4. AI Moderation (Final Layer)
        if GEMINI_API_KEY:
            from services.ai_moderation import analyze_review_quality
            ai_res = await analyze_review_quality(text, task.get("instructions", ""))
            if not ai_res["is_ok"] and ai_res["score"] < 0.4:
                return False, f"AI-фильтр: {ai_res['reason']}"
                
        return True, None

    # 9. Eligibility Check (Integration method)
    @staticmethod
    async def can_user_take_task(user_id: int, task: dict) -> tuple[bool, str | None]:
        """Checks if a user is eligible to see/pick this task."""
        # 1. Behavior
        ok, reason = await TaskEngine.check_behavior(user_id, task)
        if not ok: return False, reason
        
        # 2. URL Limits
        url = task.get("target_url")
        if url:
            limit = TaskEngine.get_daily_limit(task)
            usage = await TaskEngine.get_link_usage_last_24h(url)
            if usage >= limit:
                return False, "Лимит ссылок на сегодня исчерпан."
            if await TaskEngine.user_did_link_ever(user_id, url):
                return False, "Вы уже выполняли это задание."
                
        # 3. Reputation min requirements
        from api.task_helpers import get_meta
        min_rep = get_meta(task, "MIN_REP")
        if min_rep:
            user_rep = await TaskEngine.calculate_user_rep(user_id)
            if user_rep < float(min_rep):
                return False, f"Требуется рейтинг {min_rep}, у вас {user_rep}"
                
        return True, None
