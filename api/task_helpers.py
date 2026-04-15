import json
import base64
from datetime import datetime
from config import TASK_GENDER_ANY

def get_meta(task_or_instr, key: str) -> str | None:
    if not task_or_instr: return None
    if isinstance(task_or_instr, dict):
        instr = str(task_or_instr.get("instructions") or "")
    else:
        instr = str(task_or_instr)
    for line in instr.split("\n"):
        line = line.strip()
        if line.startswith(f"{key}: "):
            return line.split(f"{key}: ", 1)[1].strip()
    return None

def get_task_target_gender(task: dict | None) -> str:
    return get_meta(task, "TARGET_GENDER") or TASK_GENDER_ANY

def get_top_meta(task: dict | None, key: str) -> str | None:
    return get_meta(task, key)

def get_retention_days(task: dict | None) -> int:
    try:
        return int(get_meta(task, "RETENTION_DAYS") or 0)
    except Exception:
        return 0

def get_custom_review_mode(task: dict | None) -> str:
    return get_meta(task, "CUSTOM_REVIEW_MODE") or "none"

def get_review_texts(task: dict | None) -> list[str]:
    v = get_meta(task, "CUSTOM_REVIEW_TEXTS")
    if not v: return []
    try:
        return json.loads(base64.b64decode(v).decode("utf-8"))
    except Exception:
        return []

def pick_review_text_for_task(task: dict | None, slot_index: int) -> str | None:
    texts = get_review_texts(task)
    if not texts: return None
    return texts[slot_index % len(texts)]

def strip_meta_tags(instructions: str) -> str:
    if not instructions: return ""
    lines = instructions.split("\n")
    out = []
    # known tags
    tags = ("TG_SUBTYPE:", "TARGET_GENDER:", "VIP_ONLY:", "RETENTION_DAYS:", "CUSTOM_REVIEW_MODE:", "CUSTOM_REVIEW_TEXTS:", "TOP_BOUGHT_AT:", "TOP_ACTIVE_UNTIL:", "TOP_PRICE_RUB:", "TG_CALLBACK_DATA:", "TG_EXPECT_TEXT:", "TG_REF_COUNT:", "TG_POLL_ID:")
    for line in lines:
        if not any(line.strip().startswith(t) for t in tags):
            out.append(line)
    return "\n".join(out).strip()

def _parse_dt(v):
    try:
        if not v: return None
        return datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except Exception:
        return None

def top_bought_at(task: dict | None) -> datetime | None:
    return _parse_dt(get_meta(task, "TOP_BOUGHT_AT"))

def is_top_active(task: dict | None) -> bool:
    from services.telegram_utils import _now
    until = _parse_dt(get_meta(task, "TOP_ACTIVE_UNTIL"))
    if not until: return False
    return until > _now()

def get_tg_meta(task: dict | None, key: str) -> str | None:
    return get_meta(task, key)

def get_tg_subtype(task: dict | None) -> str | None:
    return get_meta(task, "TG_SUBTYPE")

def is_rework_active(comp: dict | None) -> bool:
    if not comp: return False
    return str(comp.get("status") or "").lower() == "rework"
