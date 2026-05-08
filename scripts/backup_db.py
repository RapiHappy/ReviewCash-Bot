import asyncio
import json
import os
from datetime import datetime
from database import sb_exec, sb, T_USERS, T_TASKS, T_PAY, T_WD, T_COMP

BACKUP_DIR = "backups"

async def backup_table(table_name: str):
    """Export table content to JSON."""
    log_msg = f"Backing up table {table_name}..."
    print(log_msg)
    
    start = 0
    batch = 1000
    all_rows = []
    
    while True:
        def _f():
            return sb.table(table_name).select("*").range(start, start + batch - 1).execute()
        r = await sb_exec(_f)
        rows = r.data or []
        if not rows:
            break
        all_rows.extend(rows)
        if len(rows) < batch:
            break
        start += batch
        
    filename = f"{BACKUP_DIR}/{table_name}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    os.makedirs(BACKUP_DIR, exist_ok=True)
    with open(filename, "w", encoding="utf-8") as f:
        json.dump(all_rows, f, ensure_ascii=False, indent=2)
    print(f"Saved {len(all_rows)} rows to {filename}")

async def run_backup():
    tables = [T_USERS, T_TASKS, T_PAY, T_WD, T_COMP]
    for t in tables:
        await backup_table(t)
    print("Backup completed successfully.")

if __name__ == "__main__":
    asyncio.run(run_backup())
