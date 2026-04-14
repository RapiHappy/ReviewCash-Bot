import asyncio
import logging
from supabase import create_client, Client

from config import SUPABASE_URL, SUPABASE_SERVICE_ROLE

log = logging.getLogger("reviewcash")

sb: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE)

async def sb_exec(fn):
    return await asyncio.to_thread(fn)

async def sb_upsert(table: str, row: dict, on_conflict: str | None = None):
    def _f():
        q = sb.table(table).upsert(row, on_conflict=on_conflict)
        return q.execute()
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
    col: str,
    values: list,
    columns: str = "*",
    order: str | None = None,
    desc: bool = True,
    limit: int | None = None
):
    def _f():
        q = sb.table(table).select(columns).in_(col, values)
        if order:
            q = q.order(order, desc=desc)
        if limit:
            q = q.limit(limit)
        return q.execute()
    return await sb_exec(_f)

async def sb_count(
    table: str,
    match: dict | None = None,
    neq: dict | None = None,
    gt: dict | None = None,
    gte: dict | None = None,
    lt: dict | None = None,
    lte: dict | None = None,
):
    def _f():
        q = sb.table(table).select("*", count="exact", head=True)
        if match:
            for k, v in match.items():
                q = q.eq(k, v)
        if neq:
            for k, v in neq.items():
                q = q.neq(k, v)
        if gt:
            for k, v in gt.items():
                q = q.gt(k, v)
        if gte:
            for k, v in gte.items():
                q = q.gte(k, v)
        if lt:
            for k, v in lt.items():
                q = q.lt(k, v)
        if lte:
            for k, v in lte.items():
                q = q.lte(k, v)
        res = q.execute()
        return int(getattr(res, "count", 0) or 0)
    try:
        return await sb_exec(_f)
    except Exception as e:
        log.warning("sb_count failed table=%s: %s", table, e)
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
        log.warning("sb_distinct_count failed table=%s column=%s: %s", table, column, e)
        return 0
