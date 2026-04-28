import hashlib
import random
import math
import logging
import asyncio
from datetime import datetime, timezone, timedelta

from config import T_COMP, T_LINK_LOG, T_USERS, T_TASKS
from database import sb_select, sb_insert, sb_count, sb_exec, sb, sb_update
from services.balances import add_rub
from api.task_helpers import get_meta

log = logging.getLogger("reviewcash.task_engine")

STOP_WORDS = {"fake", "тест", "проверка", "test", "spam", "отзыв", "норм", "хорошо", "отлично"}

_link_locks: dict[str, asyncio.Lock] = {}

def _now():
    return datetime.now(timezone.utc)

def _parse_dt(v):
    try:
        if not v: return None
        if isinstance(v, datetime): return v
        return datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except Exception:
        return None

class TaskEngine:

    @staticmethod
    def get_daily_limit(task: dict) -> int:
        override = get_meta(task, "ADAPTIVE_LIMIT_MAX")
        if override and str(override).isdigit():
            return int(override)
        qty = int(task.get("qty_total") or 1)
        return min(1 + (qty // 10), 3)

    @staticmethod
    async def log_link_usage(user_id: int, task_id: int | str, url: str):
        url_hash = hashlib.sha256(url.encode("utf-8")).hexdigest()
        try:
            await sb_insert(T_LINK_LOG, {
                "url_hash": url_hash,
                "user_id": user_id,
                "task_id": str(task_id),
                "used_at": datetime.now(timezone.utc).isoformat()
            })
        except Exception as e:
            log.error(f"Failed to log link usage: {e}")

    @staticmethod
    async def get_link_usage_last_24h(url: str) -> int:
        url_hash = hashlib.sha256(url.encode("utf-8")).hexdigest()
        since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
        try:
            return await sb_count(T_LINK_LOG, {"url_hash": url_hash}, gte={"used_at": since})
        except Exception:
            return 0

    @staticmethod
    async def try_reserve_link_usage(user_id: int, task_id: int | str, url: str, daily_limit: int) -> tuple[bool, str | None]:
        url_hash = hashlib.sha256(url.encode("utf-8")).hexdigest()

        if url_hash not in _link_locks:
            _link_locks[url_hash] = asyncio.Lock()

        async with _link_locks[url_hash]:
            if await TaskEngine.user_did_link_ever(user_id, url):
                return False, "Вы уже оставляли отзыв на эту ссылку."

            usage = await TaskEngine.get_link_usage_last_24h(url)
            if usage >= daily_limit:
                return False, "Лимит отзывов на эту ссылку сегодня исчерпан. Попробуйте завтра."

            await TaskEngine.log_link_usage(user_id, task_id, url)
            return True, None

    @staticmethod
    async def user_did_link_ever(user_id: int, url: str) -> bool:
        url_hash = hashlib.sha256(url.encode("utf-8")).hexdigest()
        try:
            count = await sb_count(T_LINK_LOG, {"user_id": user_id, "url_hash": url_hash})
            return count > 0
        except Exception:
            return False

    @staticmethod
    async def calculate_user_rep(user_id: int) -> float:
        try:
            u_res = await sb_select(T_USERS, {"user_id": user_id}, limit=1)
            if not u_res.data:
                return 0.5
            u = u_res.data[0]

            success = int(u.get("success_count") or 0)
            fail = int(u.get("fail_count") or 0)
            total = success + fail
            success_rate = success / max(1, total) if total > 0 else 0.8

            total_len = int(u.get("total_text_length") or 0)
            avg_len = total_len / max(1, success)
            avg_len_score = min(1.0, avg_len / 200.0)

            created_at = _parse_dt(u.get("created_at"))
            days = (datetime.now(timezone.utc) - created_at).days if created_at else 0
            age_score = min(1.0, days / 30.0)

            score = (success_rate * 0.6) + (avg_len_score * 0.2) + (age_score * 0.2)
            return round(score, 2)
        except Exception:
            return 0.5

    @staticmethod
    async def check_behavior(user_id: int, task: dict, time_since_click: float | None = None) -> tuple[bool, str | None]:
        if time_since_click is not None and time_since_click < 60:
            return False, "Выполняете слишком быстро. Для качественного отзыва нужно хотя бы 1-2 минуты."

        rep = await TaskEngine.calculate_user_rep(user_id)
        if rep < 0.25:
            return False, "Ваш рейтинг слишком низкий. Выполните несколько простых заданий для повышения доверия."

        return True, None

    @staticmethod
    async def basic_quality_filters(text: str, task: dict | None = None) -> tuple[bool, str | None]:
        t = (text or "").strip()
        if len(t) < 50:
            return False, "Отзыв слишком короткий (минимум 50 символов)."

        t_low = t.lower()
        if any(word in t_low for word in STOP_WORDS) and len(t) < 120:
            return False, "Отзыв содержит шаблонные или недопустимые слова."

        try:
            if await sb_count(T_COMP, {"proof_text": t}) > 0:
                return False, "Такой текст отзыва уже использовался ранее."
        except Exception:
            pass

        return True, None

    @staticmethod
    async def can_submit_review(
        user_id: int, 
        task: dict, 
        proof_text: str, 
        time_since_click: float | None = None
    ) -> tuple[bool, str | None]:
        """Единая точка всех проверок при отправке отзыва"""

        # 1. Поведение
        ok, err = await TaskEngine.check_behavior(user_id, task, time_since_click)
        if not ok:
            return False, err

        # 2. Базовое качество текста
        ok, err = await TaskEngine.basic_quality_filters(proof_text, task)
        if not ok:
            return False, err

        # 3. Лимит по ссылке (атомарно)
        url = task.get("target_url")
        if url:
            limit = TaskEngine.get_daily_limit(task)
            ok, err = await TaskEngine.try_reserve_link_usage(user_id, task.get("id"), url, limit)
            if not ok:
                return False, err

        # 4. Репутация (мягкий фильтр)
        rep = await TaskEngine.calculate_user_rep(user_id)
        min_rep = float(get_meta(task, "MIN_REP") or 0.0)
        if rep < min_rep and float(task.get("reward_rub", 0)) >= 50:
            return False, f"Ваш рейтинг ({rep:.2f}) недостаточен для этого задания."

        return True, None

    @staticmethod
    async def cancel_task(owner_id: int, task_id: int) -> tuple[bool, str | None, float]:
        """
        Cancels an active task and refunds only the performer's reward for unused slots.
        """
        try:
            res = await sb_select(T_TASKS, {"id": task_id, "owner_id": owner_id}, limit=1)
            if not res.data: return False, "Задание не найдено", 0.0
            
            task = res.data[0]
            if task.get("status") != "active":
                return False, "Задание уже неактивно", 0.0
                
            qty_left = int(task.get("qty_left") or 0)
            reward_per_unit = float(task.get("reward_rub") or 0)
            
            refund_amount = round(qty_left * reward_per_unit, 2)
            
            await sb_update(T_TASKS, {"id": task_id}, {"status": "cancelled", "qty_left": 0})
            if refund_amount > 0:
                await add_rub(owner_id, refund_amount)
                
            return True, None, refund_amount
        except Exception as e:
            log.error(f"Cancel task error: {e}")
            return False, str(e), 0.0

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
        min_rep = get_meta(task, "MIN_REP")
        if min_rep:
            user_rep = await TaskEngine.calculate_user_rep(user_id)
            if user_rep < float(min_rep):
                return False, f"Требуется рейтинг {min_rep}, у вас {user_rep:.2f}"
                
        return True, None

    @staticmethod
    def calculate_task_rank(task: dict) -> float:
        """
        Formula: (Priority * 0.5) + (Random * 0.3) + (Freshness * 0.2)
        Freshness uses exponential decay: exp(-hours_old / 24)
        """
        priority = int(task.get("priority") or 0)
        p_score = min(1.0, priority / 10.0)
        
        created_at = _parse_dt(task.get("created_at"))
        hours_old = (datetime.now(timezone.utc) - created_at).total_seconds() / 3600 if created_at else 72
        f_score = math.exp(-hours_old / 24.0)
        
        r_score = random.random()
        return (p_score * 0.5) + (r_score * 0.3) + (f_score * 0.2)
