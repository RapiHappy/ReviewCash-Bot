import hashlib
import random
import logging
from datetime import datetime, timezone, timedelta
from typing import Any

from config import T_TASKS, T_COMP, T_LINK_LOG, T_USERS, T_BAL
from database import sb_select, sb_insert, sb_count, sb_exec, sb, sb_select_in

log = logging.getLogger("reviewcash.task_engine")

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

import asyncio

_link_locks: dict[str, asyncio.Lock] = {}

class TaskEngine:
    @staticmethod
    def get_daily_limit(task: dict) -> int:
        """Adaptive limit: min(1 + qty/10, 3)."""
        qty = int(task.get("qty_total") or 1)
        # Custom override if present in instructions/meta
        from api.task_helpers import get_meta
        override = get_meta(task, "ADAPTIVE_LIMIT_MAX")
        if override and override.isdigit():
            return int(override)
            
        return min(1 + (qty // 10), 3)

    @staticmethod
    async def get_link_usage_last_24h(url: str) -> int:
        """Count how many times this URL was used in the last 24h across all users."""
        url_hash = sha256_hash(url)
        since = (_now() - timedelta(hours=24)).isoformat()
        try:
            # We use sb_count with a custom filter for used_at
            def _f():
                return sb.table(T_LINK_LOG).select("*", count="exact", head=True).eq("url_hash", url_hash).gte("used_at", since).execute()
            res = await sb_exec(_f)
            return int(getattr(res, "count", 0) or 0)
        except Exception as e:
            log.error(f"Error getting link usage for {url}: {e}")
            return 0

    @staticmethod
    async def log_link_usage(user_id: int, task_id: int, url: str):
        """Log that a user completed a task for this link."""
        url_hash = sha256_hash(url)
        try:
            await sb_insert(T_LINK_LOG, {
                "url_hash": url_hash,
                "user_id": user_id,
                "task_id": task_id,
                "used_at": _now().isoformat()
            })
        except Exception as e:
            log.error(f"Error logging link usage: {e}")

    @staticmethod
    async def try_reserve_link_usage(user_id: int, task_id: int, url: str, daily_limit: int) -> tuple[bool, str | None]:
        """Atomically check limits and log usage to prevent race conditions."""
        url_hash = sha256_hash(url)
        
        # Get or create lock for this specific URL
        if url_hash not in _link_locks:
            _link_locks[url_hash] = asyncio.Lock()
        
        async with _link_locks[url_hash]:
            # 1. User uniqueness check
            if await TaskEngine.user_did_link_ever(user_id, url):
                return False, "Вы уже оставляли отзыв на эту ссылку."
                
            # 2. Global daily limit check
            usage = await TaskEngine.get_link_usage_last_24h(url)
            if usage >= daily_limit:
                return False, "Лимит отзывов на эту ссылку сегодня исчерпан. Попробуй завтра."
            
            # 3. All clear -> Log usage (reserve)
            await TaskEngine.log_link_usage(user_id, task_id, url)
            return True, None

    @staticmethod
    async def user_did_link_ever(user_id: int, url: str) -> bool:
        """Check if this specific user has ever done this link."""
        url_hash = sha256_hash(url)
        try:
            count = await sb_count(T_LINK_LOG, {"user_id": user_id, "url_hash": url_hash})
            return count > 0
        except Exception:
            return False

    @staticmethod
    async def calculate_user_rep(user_id: int) -> float:
        """
        Weighted Reputation Score (0.0 - 1.0).
        Formula: (success_rate * 0.6) + (avg_len_score * 0.2) + (age_score * 0.2)
        """
        try:
            # Get user and balance/stats
            u_res = await sb_select(T_USERS, {"user_id": user_id}, limit=1)
            b_res = await sb_select(T_BAL, {"user_id": user_id}, limit=1)
            
            if not u_res.data or not b_res.data:
                return 0.5 # Default for new/unknown
                
            u = u_res.data[0]
            b = b_res.data[0]
            
            # 1. Success Rate
            success = int(u.get("success_count") or 0)
            fail = int(u.get("fail_count") or 0)
            total = success + fail
            success_rate = success / max(1, total) if total > 0 else 0.8 # Assume 80% for new users? or 0.5?
            
            # 2. Avg Text Length
            total_len = int(u.get("total_text_length") or 0)
            avg_len = total_len / max(1, success)
            avg_len_score = min(1.0, avg_len / 200.0) # 200 chars is "perfect" 1.0
            
            # 3. Account Age
            created_at = _parse_dt(u.get("created_at"))
            if not created_at:
                age_score = 0.0
            else:
                days = (_now() - created_at).days
                age_score = min(1.0, days / 30.0) # 30 days is "mature" 1.0
                
            score = (success_rate * 0.6) + (avg_len_score * 0.2) + (age_score * 0.2)
            return round(score, 2)
        except Exception as e:
            log.error(f"Error calculating reputation for {user_id}: {e}")
            return 0.5

    @staticmethod
    def calculate_task_rank(task: dict) -> float:
        """
        Weighted Priority Score.
        Formula: (priority * 0.5) + (random * 0.3) + (freshness * 0.2)
        """
        priority = int(task.get("priority") or 0)
        # Normalize priority (assume 0-10 range for now, or just use as is)
        p_score = min(1.0, priority / 10.0)
        
        # Freshness
        created_at = _parse_dt(task.get("created_at"))
        if not created_at:
            f_score = 0.0
        else:
            hours_old = (_now() - created_at).total_seconds() / 3600
            f_score = max(0.0, 1.0 - (hours_old / 72.0)) # 0 score after 3 days
            
        r_score = random.random()
        
        return (p_score * 0.5) + (r_score * 0.3) + (f_score * 0.2)

    @staticmethod
    async def can_user_take_task(user_id: int, task: dict) -> tuple[bool, str | None]:
        """Final check before showing or allowing task pick."""
        # 1. Global Link Daily Limit
        url = task.get("target_url")
        if url:
            usage_today = await TaskEngine.get_link_usage_last_24h(url)
            daily_limit = TaskEngine.get_daily_limit(task)
            if usage_today >= daily_limit:
                return False, "Лимит отзывов на эту ссылку сегодня исчерпан. Попробуй завтра."
            
            # 2. User-Link History
            if await TaskEngine.user_did_link_ever(user_id, url):
                return False, "Вы уже оставляли отзыв на эту ссылку."

        # 3. Reputation check
        # Some tasks might have "MIN_REP: 0.7" in meta
        from api.task_helpers import get_meta
        min_rep = get_meta(task, "MIN_REP")
        if min_rep:
            try:
                min_rep_val = float(min_rep)
                user_rep = await TaskEngine.calculate_user_rep(user_id)
                if user_rep < min_rep_val:
                    return False, f"Ваш рейтинг ({user_rep}) слишком низок. Нужно минимум {min_rep_val}."
            except Exception:
                pass
                
        return True, None
