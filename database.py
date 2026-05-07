import asyncio
import logging
from aiohttp import ClientSession, ClientTimeout, ClientError
from supabase import create_client, Client
from config import SUPABASE_URL, SUPABASE_SERVICE_ROLE

log = logging.getLogger("reviewcash.db")

# Centralized session with timeouts
_session: ClientSession | None = None

async def get_session() -> ClientSession:
    global _session
    if _session is None or _session.closed:
        _session = ClientSession(timeout=ClientTimeout(total=10, connect=2))
    return _session

sb: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE)

async def sb_retry(fn, retries=3, delay=1, backoff=2):
    last_err = None
    for i in range(retries):
        try:
            return await fn()
        except Exception as e:
            last_err = e
            # Retry on transient errors (timeouts, network, 429, 5xx)
            err_str = str(e).lower()
            is_transient = any(x in err_str for x in ["timeout", "connection", "429", "500", "502", "503", "504"])
            
            if not is_transient and i < (retries - 1):
                # If not explicitly transient but could be, log and retry anyway
                log.warning(f"Potential transient DB error {i+1}/{retries}: {e}")
            elif not is_transient:
                raise e
                
            log.warning(f"DB Retry {i+1}/{retries} failed (transient): {e}")
            await asyncio.sleep(delay * (backoff ** i))
    raise last_err

async def sb_exec(fn):
    return await sb_retry(lambda: asyncio.to_thread(fn))

# ... (Existing sb_* functions remain same, but call sb_exec)
# To save space, I will only show the changed/new logic here.
# But for the final file, I should ensure all functions are present.

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
        for k, v in match.items(): q = q.eq(k, v)
        return q.execute()
    return await sb_exec(_f)

async def sb_delete(table: str, match: dict):
    def _f():
        q = sb.table(table).delete()
        for k, v in match.items(): q = q.eq(k, v)
        return q.execute()
    return await sb_exec(_f)

async def sb_select(table: str, match: dict = None, columns: str = "*", limit: int = None, order: str = None, desc: bool = True):
    def _f():
        q = sb.table(table).select(columns)
        if match:
            for k, v in match.items(): q = q.eq(k, v)
        if order: q = q.order(order, desc=desc)
        if limit: q = q.limit(limit)
        return q.execute()
    return await sb_exec(_f)

async def sb_count(table: str, match: dict = None, gte: dict = None, lte: dict = None):
    def _f():
        q = sb.table(table).select("*", count="exact", head=True)
        if match:
            for k, v in match.items(): q = q.eq(k, v)
        if gte:
            for k, v in gte.items(): q = q.gte(k, v)
        if lte:
            for k, v in lte.items(): q = q.lte(k, v)
        res = q.execute()
        return int(getattr(res, "count", 0) or 0)
    try: return await sb_exec(_f)
    except: return 0

async def ping() -> bool:
    try:
        await sb_select("users", limit=1)
        return True
    except Exception as e:
        log.error(f"Database ping failed: {e}")
        return False
