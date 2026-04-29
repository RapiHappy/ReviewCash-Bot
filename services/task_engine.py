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
    TaskEngine V4 — Центральный узел принятия решений и безопасности.
    Реализует атомарные проверки, взвешенную репутацию и защиту от накруток.
    """

    @staticmethod
    def get_daily_limit(task: dict) -> int:
        """Адаптивный дневной лимит отзывов на одну ссылку."""
        override = get_meta(task, "ADAPTIVE_LIMIT_MAX")
        if override and str(override).isdigit():
            return int(override)
        qty = int(task.get("qty_total") or 1)
        return min(1 + (qty // 10), 3)

    # ====================== LINK USAGE (Status-based) ======================
    @staticmethod
    def normalize_url(url: str) -> str:
        try:
            parsed = urlparse(url)
            return urlunparse((parsed.scheme, parsed.netloc, parsed.path, "", "", ""))
        except Exception:
            return url

    @staticmethod
    async def log_link_usage(user_id: int, task_id: int | str, url: str, status: str = "reserved"):
        norm_url = TaskEngine.normalize_url(url)
        url_hash = hashlib.sha256(norm_url.encode("utf-8")).hexdigest()
        try:
            await sb_insert(T_LINK_LOG, {
                "url_hash": url_hash,
                "user_id": int(user_id),
                "task_id": str(task_id),
                "status": status,
                "used_at": _now().isoformat()
            })
        except Exception as e:
            log.error(f"Failed to log link usage: {e}")

    @staticmethod
    async def finalize_link_usage(user_id: int, task_id: int | str, url: str):
        norm_url = TaskEngine.normalize_url(url)
        url_hash = hashlib.sha256(norm_url.encode("utf-8")).hexdigest()
        try:
            await sb.table(T_LINK_LOG).update({"status": "used"}).match({
                "user_id": int(user_id), 
                "url_hash": url_hash, 
                "task_id": str(task_id),
                "status": "reserved"
            }).execute()
        except Exception as e:
            log.error(f"Failed to finalize link usage: {e}")

    @staticmethod
    async def rollback_link_usage(user_id: int, task_id: int | str, url: str):
        norm_url = TaskEngine.normalize_url(url)
        url_hash = hashlib.sha256(norm_url.encode("utf-8")).hexdigest()
        try:
            await sb.table(T_LINK_LOG).update({"status": "cancelled"}).match({
                "user_id": int(user_id), 
                "url_hash": url_hash, 
                "task_id": str(task_id),
                "status": "reserved"
            }).execute()
        except Exception as e:
            log.error(f"Failed to rollback link usage: {e}")

    @staticmethod
    async def user_did_link_recently(user_id: int, url: str, days: int = 30) -> bool:
        norm_url = TaskEngine.normalize_url(url)
        url_hash = hashlib.sha256(norm_url.encode("utf-8")).hexdigest()
        since = (_now() - timedelta(days=days)).isoformat()
        try:
            count = await sb_count(T_LINK_LOG, 
                {"user_id": int(user_id), "url_hash": url_hash}, 
                in_={"status": ["used", "reserved"]},
                gte={"used_at": since}
            )
            return count > 0
        except Exception:
            return False

    @staticmethod
    async def get_link_usage_count(url: str, hours: int = 24) -> int:
        norm_url = TaskEngine.normalize_url(url)
        url_hash = hashlib.sha256(norm_url.encode("utf-8")).hexdigest()
        since = (_now() - timedelta(hours=hours)).isoformat()
        try:
            return await sb_count(T_LINK_LOG, 
                {"url_hash": url_hash}, 
                in_={"status": ["used", "reserved"]},
                gte={"used_at": since}
            )
        except Exception:
            return 0

    # ====================== REPUTATION (Weighted) ======================
    @staticmethod
    async def calculate_user_rep(user_id: int) -> float:
        """Рассчитывает взвешенную репутацию пользователя (по сумме наград)."""
        try:
            from database import sb_exec
            def _f():
                return sb.table(T_COMP).select("reward_rub, status").eq("user_id", int(user_id)).in_("status", ["paid", "rejected", "fake"]).execute()
            res = await sb_exec(_f)
            data = res.data or []
            
            if not data:
                return 0.5

            w_success = 0.0
            w_fail = 0.0
            for row in data:
                reward = float(row.get("reward_rub") or 5.0)
                if row["status"] == "paid":
                    w_success += reward
                else:
                    w_fail += reward
            
            total = w_success + w_fail
            if total <= 0: return 0.5
            return round(max(0.1, min(1.0, w_success / total)), 2)
        except Exception:
            return 0.5

    # ====================== QUALITY & FILTERS ======================
    @staticmethod
    async def basic_quality_filters(text: str) -> tuple[bool, str | None]:
        t = (text or "").strip()
        if len(t) < 50:
            return False, "Отзыв слишком короткий (минимум 50 символов)."
        
        if len(t) < 80:
            # Short but technically allowed? Send to manual review via flag?
            # We'll just note it here; the AI logic will handle the 3-state.
            pass

        # 1. Uniqueness Ratio
        import re
        words = [w for w in re.split(r'\W+', t.lower()) if w]
        if words:
            unique_ratio = len(set(words)) / len(words)
            if unique_ratio < 0.6 and len(words) > 10:
                return False, "Текст слишком однообразный (низкая уникальность слов)."

        # 2. Stop Words
        t_low = t.lower()
        if any(word in t_low for word in STOP_WORDS) and len(t) < 120:
            return False, "Отзыв содержит шаблонные или недопустимые слова."

        # 3. Similarity Check (Prefix)
        try:
            prefix = t[:30].lower()
            from database import sb_exec
            def _f():
                return sb.table(T_COMP).select("id").ilike("proof_text", f"{prefix}%").limit(1).execute()
            sim = await sb_exec(_f)
            if sim.data:
                 return False, "Похожий текст отзыва уже отправлялся ранее."
        except Exception:
            pass

        return True, None

    # ====================== MAIN SUBMISSION ======================
    @staticmethod
    async def submit_review(
        user_id: int,
        task: dict,
        proof_text: str,
        proof_url: str | None = None,
        time_since_click: float | None = None,
        ip: str | None = None,
        device_hash: str | None = None
    ) -> dict:
        """
        CENTRALIZED SUBMISSION ENGINE.
        Handles all checks, AI states, and atomic DB updates.
        """
        uid = int(user_id)
        tid = task.get("id")
        url = task.get("target_url")
        reward = float(task.get("reward_rub", 0))

        try:
            # 1. ANTI-HOARDING (15 min TTL)
            if time_since_click is not None and time_since_click > 900:
                return {"ok": False, "error": "Время на выполнение вышло (15 мин). Возьмите задание снова."}

            # 2. RATE LIMIT (5 submits / 10 min)
            since_10m = (_now() - timedelta(minutes=10)).isoformat()
            sub_cnt = await sb_count(T_COMP, {"user_id": uid}, gte={"created_at": since_10m})
            if sub_cnt >= 5:
                return {"ok": False, "error": "Слишком много отчётов. Подождите 10 минут."}

            # 3. REPUTATION & BEHAVIOR
            rep = await TaskEngine.calculate_user_rep(uid)
            min_rep = float(get_meta(task, "MIN_REP") or (0.4 if reward >= 50 else 0.0))
            if rep < min_rep:
                return {"ok": False, "error": f"Ваш рейтинг ({rep:.2f}) ниже порога {min_rep}."}

            if time_since_click is not None and time_since_click < 45:
                return {"ok": False, "error": "Выполняете слишком быстро."}

            # 4. TEXT QUALITY
            ok_q, err_q = await TaskEngine.basic_quality_filters(proof_text)
            if not ok_q: return {"ok": False, "error": err_q}

            if url and await TaskEngine.user_did_link_recently(uid, url, days=30):
                return {"ok": False, "error": "Вы уже выполняли задание с этой ссылкой (30 дней)."}

            # 5. ATOMIC RESERVATION
            if url:
                limit = TaskEngine.get_daily_limit(task)
                if url not in _link_locks: _link_locks[url] = asyncio.Lock()
                async with _link_locks[url]:
                    usage = await TaskEngine.get_link_usage_count(url)
                    if usage >= limit:
                        return {"ok": False, "error": "Лимит на сегодня исчерпан."}
                    await TaskEngine.log_link_usage(uid, tid, url, status="reserved")

            # 6. AI MODERATION (3-State)
            from services.ai_moderation import analyze_review_quality
            ai_res = await analyze_review_quality(proof_text, task.get("instructions", ""))
            ai_score = int(ai_res.get("score", 0.5) * 100)
            
            # AI Logic: <50 reject, 50-70 review, >70 pass
            if ai_score < 50:
                ai_status = "reject"
            elif ai_score < 70 or len(proof_text) < 80:
                ai_status = "review"
            else:
                ai_status = "pass"

            if ai_status == "reject":
                if url: await TaskEngine.rollback_link_usage(uid, tid, url)
                return {"ok": False, "error": f"AI отклонил отзыв: {ai_res.get('reason')}"}

            # 7. ATOMIC DB COMMIT
            is_auto_tg = (task.get("check_type") == "auto") and (task.get("type") == "tg")
            final_status = "paid" if (is_auto_tg or ai_status == "pass") else "review"
            
            from services.balances import task_xp
            xp = task_xp(task)

            rpc_params = {
                "p_user_id": uid,
                "p_task_id": tid,
                "p_status": final_status,
                "p_proof_text": proof_text,
                "p_proof_url": proof_url,
                "p_reward_rub": reward if final_status == "paid" else 0,
                "p_xp_added": xp if final_status == "paid" else 0,
                "p_ai_score": ai_score
            }
            
            rpc_res = await sb.rpc("submit_task_atomic", rpc_params).execute()
            if not rpc_res.data or not rpc_res.data.get("ok"):
                if url: await TaskEngine.rollback_link_usage(uid, tid, url)
                return {"ok": False, "error": rpc_res.data.get("error") or "Ошибка БД."}

            # 8. FINALIZE & LOG
            if url: await TaskEngine.finalize_link_usage(uid, tid, url)
            
            try:
                await sb_insert("review_logs", {
                    "user_id": uid, "task_id": tid, "ai_score": ai_score,
                    "user_rep": rep, "task_reward": reward,
                    "status": ai_status, "reason": ai_res.get("reason")
                })
            except: pass

            return {"ok": True, "status": final_status, "reward": reward if final_status == "paid" else 0}

        except Exception as e:
            log.exception(f"Submit critical failure: {e}")
            if url: await TaskEngine.rollback_link_usage(uid, tid, url)
            return {"ok": False, "error": "Внутренняя ошибка."}

    @staticmethod
    async def can_user_take_task(
        user_id: int, 
        task: dict, 
        user_rep: float | None = None,
        is_vip: bool = False,
        user_gender: str = "any"
    ) -> tuple[bool, str | None]:
        """Мягкая проверка для UI."""
        rep = user_rep if user_rep is not None else await TaskEngine.calculate_user_rep(user_id)
        url = task.get("target_url")

        # 1. VIP Check
        is_vip_task = "VIP_ONLY: 1" in str(task.get("instructions") or "")
        if is_vip_task and not is_vip:
            return False, "Только для VIP"
        
        # 2. Gender Targeting
        from api.task_helpers import get_task_target_gender
        target_g = get_task_target_gender(task)
        if target_g != "any" and target_g != user_gender:
            return False, "Не подходит пол"

        # 3. Репутация
        reward = float(task.get("reward_rub", 0))
        min_rep = float(get_meta(task, "MIN_REP") or (0.4 if reward >= 50 else 0.0))
        if rep < min_rep: return False, f"Рейтинг < {min_rep}"

        # 4. Линк
        if url and await TaskEngine.user_did_link_recently(user_id, url, days=30):
            return False, "Уже выполняли (30д)"

        # 5. Свободные места (денормализовано)
        qty_left = int(task.get("qty_left") or 0)
        pending = int(task.get("pending_count") or 0)
        if (qty_left - pending) <= 0: return False, "Мест нет"

        return True, None

    @staticmethod
    async def cancel_task(owner_id: int, task_id: int) -> tuple[bool, str | None, float]:
        try:
            rpc_res = await sb.rpc("cancel_task_atomic", {
                "p_owner_id": int(owner_id), "p_task_id": str(task_id)
            }).execute()
            if not rpc_res.data or not rpc_res.data.get("ok"):
                return False, rpc_res.data.get("error") or "Ошибка", 0.0
            
            refund = float(rpc_res.data.get("refund_amount") or 0)
            from services.limits import clear_task_click_globally
            await clear_task_click_globally(task_id)
            return True, None, refund
        except Exception as e:
            log.error(f"Cancel task error: {e}")
            return False, "Ошибка сервера", 0.0

    @staticmethod
    def calculate_task_rank(task: dict) -> float:
        priority = int(task.get("priority") or 0)
        p_score = min(1.0, priority / 10.0)

        created_at = _parse_dt(task.get("created_at"))
        hours_old = (_now() - created_at).total_seconds() / 3600 if created_at else 72
        f_score = math.exp(-hours_old / 36.0) # Мягкое затухание

        # release_at logic
        release_at = _parse_dt(task.get("release_at"))
        if release_at and release_at > _now():
            return -1.0 # Hidden

        return (p_score * 0.5) + (random.random() * 0.3) + (f_score * 0.2)
