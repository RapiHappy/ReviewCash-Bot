import asyncio
import logging
from aiohttp import ClientSession, ClientTimeout
from supabase import create_client, Client
from config import SUPABASE_URL, SUPABASE_SERVICE_ROLE

log = logging.getLogger("reviewcash.db")

# Supabase client initialization
sb: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE)

async def sb_retry(fn, retries=3, delay=1.0, backoff=2.0):
    """Retry logic for Supabase operations with exponential backoff and jitter."""
    import random
    from services.metrics import track_success, track_failure
    last_err = None
    for i in range(retries):
        try:
            res = await fn()
            await track_success("database")
            return res
        except Exception as e:
            last_err = e
            err_str = str(e).lower()
            # Only retry on transient errors
            is_transient = any(x in err_str for x in ["timeout", "connection", "429", "500", "502", "503", "504"])
            
            if not is_transient:
                log.error(f"Permanent DB error: {e}")
                await track_failure("database_permanent")
                raise e
                
            if i < retries - 1:
                sleep_time = (delay * (backoff ** i)) + random.uniform(0, 1)
                log.warning(f"Transient DB error (retry {i+1}/{retries}): {e}")
                await track_failure("database_transient")
                await asyncio.sleep(sleep_time)
            else:
                log.error(f"DB operation failed after {retries} retries: {e}")
                await track_failure("database_final")
                raise e
    raise last_err

async def sb_exec(fn):
    return await sb_retry(lambda: asyncio.to_thread(fn))

async def sb_upsert(table: str, row: dict, on_conflict: str | None = None):
    def _f():
        return sb.table(table).upsert(row, on_conflict=on_conflict).execute()
    return await sb_exec(_f)

async def sb_insert(table: str, row: dict):
    def _f():
        return sb.table(table).insert(row).execute()
    return await sb_exec(_f)

async def sb_update(table: str, match: dict, updates: dict):
    def _f():
        q = sb.table(table).update(updates)
        for k, v in match.items():
            q = q.eq(k, v)
        return q.execute()
    return await sb_exec(_f)

async def sb_delete(table: str, match: dict):
    def _f():
        q = sb.table(table).delete()
        for k, v in match.items():
            q = q.eq(k, v)
        return q.execute()
    return await sb_exec(_f)

async def sb_select(
    table: str,
    match: dict | None = None,
    columns: str = "*",
    limit: int | None = None,
    order: str | None = None,
    desc: bool = True
):
    def _f():
        q = sb.table(table).select(columns)
        if match:
            for k, v in match.items():
                q = q.eq(k, v)
        if order:
            q = q.order(order, desc=desc)
        if limit:
            q = q.limit(limit)
        return q.execute()
    return await sb_exec(_f)

async def sb_select_in(
    table: str,
    column: str,
    values: list,
    match: dict | None = None,
    columns: str = "*",
    limit: int | None = None
):
    def _f():
        q = sb.table(table).select(columns).in_(column, values)
        if match:
            for k, v in match.items():
                q = q.eq(k, v)
        if limit:
            q = q.limit(limit)
        return q.execute()
    return await sb_exec(_f)

async def sb_count(
    table: str,
    match: dict | None = None,
    gte: dict | None = None,
    lte: dict | None = None,
):
    def _f():
        q = sb.table(table).select("*", count="exact", head=True)
        if match:
            for k, v in match.items():
                q = q.eq(k, v)
        if gte:
            for k, v in gte.items():
                q = q.gte(k, v)
        if lte:
            for k, v in lte.items():
                q = q.lte(k, v)
        res = q.execute()
        return int(getattr(res, "count", 0) or 0)
    try:
        return await sb_exec(_f)
    except Exception as e:
        log.exception(f"sb_count failed table={table}: {e}")
        return 0

async def sb_distinct_count(
    table: str,
    column: str,
    match: dict | None = None,
    batch: int = 1000,
    max_rows: int = 100000,
):
    def _f():
        seen = set()
        start = 0
        while True:
            q = sb.table(table).select(column)
            if match:
                for k, v in match.items():
                    q = q.eq(k, v)
            q = q.order(column, desc=False).range(start, start + batch - 1)
            res = q.execute()
            rows = res.data or []
            if not rows:
                break
            for row in rows:
                val = row.get(column)
                if val is not None and val != "":
                    seen.add(val)
            start += len(rows)
            if len(rows) < batch or start >= max_rows:
                break
        return len(seen)
    try:
        return await sb_exec(_f)
    except Exception as e:
        log.warning(f"sb_distinct_count failed table={table} column={column}: {e}")
        return 0

async def sb_rpc(fn_name: str, params: dict):
    def _f():
        return sb.rpc(fn_name, params).execute()
    return await sb_exec(_f)

async def sb_rpc_safe(fn_name: str, params: dict, timeout: float = 12.0) -> any:
    """Hardened RPC call with timeout and built-in retries (via sb_exec)."""
    try:
        return await asyncio.wait_for(sb_rpc(fn_name, params), timeout=timeout)
    except asyncio.TimeoutError:
        log.error(f"RPC TIMEOUT: {fn_name} after {timeout}s", extra={"rpc_name": fn_name})
        raise
    except Exception as e:
        log.error(f"RPC ERROR: {fn_name}: {e}", extra={"rpc_name": fn_name})
        raise

async def ping() -> tuple[bool, float]:
    import time
    start = time.time()
    try:
        await sb_select("users", limit=1)
        latency = (time.time() - start) * 1000
        return True, round(latency, 2)
    except Exception as e:
        log.error(f"Database ping failed: {e}")
        return False, 0.0
