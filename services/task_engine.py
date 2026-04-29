import hashlib
import random
import math
import logging
import asyncio
from datetime import datetime, timezone, timedelta
from urllib.parse import urlparse, urlunparse

from config import T_COMP, T_LINK_LOG, T_USERS, T_TASKS
from database import sb_select, sb_insert, sb_count, sb, sb_update
from services.balances import add_rub
from api.task_helpers import get_meta, _parse_dt   # используем общую реализацию

log = logging.getLogger("reviewcash.task_engine")

STOP_WORDS = {"fake", "тест", "проверка", "test", "spam", "отзыв", "норм", "хорошо", "отлично"}

_link_locks: dict[str, asyncio.Lock] = {}


def _now():
    return datetime.now(timezone.utc)


class TaskEngine:
    """
    TaskEngine V3 — центральный узел принятия всех решений по заданиям.
    Единственная точка правды для фильтрации, проверок и ранжирования.
    """

    @staticmethod
    def get_daily_limit(task: dict) -> int:
        """Адаптивный дневной лимит отзывов на одну ссылку."""
        override = get_meta(task, "ADAPTIVE_LIMIT_MAX")
        if override and str(override).isdigit():
            return int(override)
        qty = int(task.get("qty_total") or 1)
        return min(1 + (qty // 10), 3)

    @staticmethod
    async def get_current_task(user_id: int) -> dict | None:
        """Находит последнее задание, по которому кликнул пользователь в Mini App."""
        from services.limits import CLICK_PREFIX
        try:
            # Ищем в T_LIMITS ключи clicked_task:
            def _f():
                return sb.table(T_LIMITS).select("limit_key").eq("user_id", int(user_id)).like("limit_key", f"{CLICK_PREFIX}%").order("last_at", desc=True).limit(1).execute()
            res = await sb_exec(_f)
            if not res.data:
                return None
            
            key = res.data[0]["limit_key"]
            task_id_str = key.replace(CLICK_PREFIX, "")
            
            # Проверяем, существует ли такое задание и активно ли оно
            t_res = await sb_select(T_TASKS, {"id": task_id_str, "status": "active"}, limit=1)
            return t_res.data[0] if t_res.data else None
        except Exception as e:
            log.error(f"get_current_task failed for {user_id}: {e}")
            return None

    # ====================== LINK USAGE ======================
    @staticmethod
    def normalize_url(url: str) -> str:
        """Robust URL normalization: strips all query parameters and fragments."""
        try:
            parsed = urlparse(url)
            # Reconstruct URL without query and fragment
            return urlunparse((parsed.scheme, parsed.netloc, parsed.path, "", "", ""))
        except Exception:
            return url

    @staticmethod
    async def log_link_usage(user_id: int, task_id: int | str, url: str):
        norm_url = TaskEngine.normalize_url(url)
        url_hash = hashlib.sha256(norm_url.encode("utf-8")).hexdigest()
        try:
            await sb_insert(T_LINK_LOG, {
                "url_hash": url_hash,
                "user_id": int(user_id),
                "task_id": str(task_id),
                "used_at": _now().isoformat()
            })
        except Exception as e:
            log.error(f"Failed to log link usage: {e}")

    @staticmethod
    async def get_link_usage_last_24h(url: str) -> int:
        norm_url = TaskEngine.normalize_url(url)
        url_hash = hashlib.sha256(norm_url.encode("utf-8")).hexdigest()
        since = (_now() - timedelta(hours=24)).isoformat()
        try:
            return await sb_count(T_LINK_LOG, {"url_hash": url_hash}, gte={"used_at": since})
        except Exception:
            return 0

    @staticmethod
    async def try_reserve_link_usage(user_id: int, task_id: int | str, url: str, daily_limit: int) -> tuple[bool, str | None]:
        """Атомарное резервирование слота по ссылке с защитой от гонок."""
        norm_url = TaskEngine.normalize_url(url)
        url_hash = hashlib.sha256(norm_url.encode("utf-8")).hexdigest()

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
        norm_url = TaskEngine.normalize_url(url)
        url_hash = hashlib.sha256(norm_url.encode("utf-8")).hexdigest()
        try:
            count = await sb_count(T_LINK_LOG, {"user_id": user_id, "url_hash": url_hash})
            return count > 0
        except Exception:
            return False

    # ====================== REPUTATION ======================
    @staticmethod
    async def calculate_user_rep(user_id: int) -> float:
        """Рассчитывает репутацию пользователя (0.0 — 1.0)."""
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
            avg_len = total_len / max(1, success) if success > 0 else 0
            avg_len_score = min(1.0, avg_len / 200.0)

            created_at = _parse_dt(u.get("created_at"))
            days = (datetime.now(timezone.utc) - created_at).days if created_at else 0
            age_score = min(1.0, days / 30.0)

            score = (success_rate * 0.6) + (avg_len_score * 0.2) + (age_score * 0.2)
            return round(max(0.0, score), 2)
        except Exception:
            return 0.5

    @staticmethod
    async def check_behavior(user_id: int, task: dict, time_since_click: float | None = None, user_rep: float | None = None) -> tuple[bool, str | None]:
        """Проверка скорости и общей репутации."""
        if time_since_click is not None and time_since_click < 60:
            return False, "Выполняете слишком быстро. Для качественного отзыва нужно хотя бы 1-2 минуты."

        rep = user_rep if user_rep is not None else await TaskEngine.calculate_user_rep(user_id)
        if rep < 0.25:
            return False, "Ваш рейтинг слишком низкий. Выполните несколько простых заданий."

        return True, None

    # ====================== QUALITY FILTERS ======================
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

    # ====================== MAIN ENTRY POINTS ======================
    @staticmethod
    async def can_submit_review(
        user_id: int, 
        task: dict, 
        proof_text: str, 
        time_since_click: float | None = None
    ) -> tuple[bool, str | None]:
        """Единая точка проверки при отправке отзыва."""
        try:
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

            # 4. Репутация для дорогих заданий
            reward = float(task.get("reward_rub", 0))
            if reward >= 50:
                rep = await TaskEngine.calculate_user_rep(user_id)
                min_rep = float(get_meta(task, "MIN_REP") or 0.4)
                if rep < min_rep:
                    return False, f"Ваш рейтинг ({rep:.2f}) недостаточен для этого задания (минимум {min_rep})."

            return True, None
        except Exception as e:
            log.error(f"can_submit_review critical failure for user {user_id}: {e}")
            return False, "Внутренняя ошибка проверки. Попробуйте позже."

    @staticmethod
    async def can_user_take_task(
        user_id: int, 
        task: dict, 
        user_rep: float | None = None
    ) -> tuple[bool, str | None]:
        """Проверка видимости и возможности взять задание (используется в api_sync)."""
        rep = user_rep if user_rep is not None else await TaskEngine.calculate_user_rep(user_id)

        # 1. Поведение и общая репутация
        ok, reason = await TaskEngine.check_behavior(user_id, task, user_rep=rep)
        if not ok:
            return False, reason

        # 2. Лимиты по ссылке
        url = task.get("target_url")
        if url:
            limit = TaskEngine.get_daily_limit(task)
            usage = await TaskEngine.get_link_usage_last_24h(url)
            if usage >= limit:
                return False, "Лимит отзывов на эту ссылку сегодня исчерпан."

            if await TaskEngine.user_did_link_ever(user_id, url):
                return False, "Вы уже выполняли задание с этой ссылкой."

        # 3. Остаток мест в задании
        qty_left = int(task.get("qty_left") or 0)
        if qty_left <= 0:
            return False, "Задание уже закрыто."

        try:
            pending = await sb_count(
                T_COMP,
                {"task_id": task.get("id")},
                in_={"status": ["pending", "pending_hold", "rework"]}
            )
            if pending >= qty_left:
                return False, "Свободных мест в задании нет."
        except Exception:
            pass

        # 4. Репутационный порог
        reward = float(task.get("reward_rub", 0))
        min_rep = float(get_meta(task, "MIN_REP") or 0.0)
        threshold = min_rep if min_rep > 0 else (0.4 if reward >= 50 else 0.0)

        if threshold > 0 and rep < threshold:
            return False, f"Требуется рейтинг минимум {threshold:.2f} (у вас {rep:.2f})."

        return True, None

    @staticmethod
    async def cancel_task(owner_id: int, task_id: int) -> tuple[bool, str | None, float]:
        """Отмена задания с возвратом средств рекламодателю (RPC атомарно)."""
        try:
            # 1. Выполняем атомарную отмену через Supabase RPC
            rpc_res = await sb.rpc("cancel_task_atomic", {
                "p_owner_id": int(owner_id),
                "p_task_id": str(task_id)
            }).execute()

            if not rpc_res.data or not rpc_res.data.get("ok"):
                err = (rpc_res.data or {}).get("error") or "Не удалось отменить задание."
                return False, err, 0.0

            refund_amount = float(rpc_res.data.get("refund_amount") or 0)

            # 2. Очистка контекста: удаляем статус 'clicked' для этого задания у всех пользователей
            from services.limits import clear_task_click_globally
            try:
                await clear_task_click_globally(task_id)
            except Exception:
                pass

            return True, None, refund_amount
        except Exception as e:
            log.error(f"Cancel task error: {e}")
            return False, "Внутренняя ошибка при отмене.", 0.0

    @staticmethod
    def calculate_task_rank(task: dict) -> float:
        """Ранжирование заданий: приоритет + свежесть + случайность."""
        priority = int(task.get("priority") or 0)
        p_score = min(1.0, priority / 10.0)

        created_at = _parse_dt(task.get("created_at"))
        hours_old = (_now() - created_at).total_seconds() / 3600 if created_at else 72
        f_score = math.exp(-hours_old / 12.0)   # агрессивное затухание

        r_score = random.random()
        return (p_score * 0.5) + (r_score * 0.3) + (f_score * 0.2)
