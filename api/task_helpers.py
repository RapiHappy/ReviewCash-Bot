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

from urllib.parse import urlparse
import logging

log = logging.getLogger("reviewcash")

YA_ALLOWED_HOST = ("yandex.ru", "yandex.com", "yandex.kz", "yandex.by", "yandex.uz")
GM_ALLOWED_HOST = ("google.com", "google.ru", "google.kz", "google.by", "google.com.ua", "maps.app.goo.gl", "goo.gl")
DG_ALLOWED_HOST = ("2gis.ru", "2gis.kz", "2gis.com", "go.2gis.com", "2gis.by")

def _norm_url(raw: str) -> str:
    s = (raw or "").strip()
    if not s:
        return ""
    if not s.lower().startswith(("http://", "https://")):
        s = "https://" + s
    return s

def _host_allowed(host: str, allowed: tuple[str, ...]) -> bool:
    h = (host or "").lower()
    return any(h == a or h.endswith("." + a) for a in allowed)

def validate_target_url(ttype: str, raw: str) -> tuple[bool, str, str]:
    """Return (ok, normalized_url, error_message)."""
    url = _norm_url(raw)
    if not url:
        return False, "", "Нужна ссылка"
    try:
        u = urlparse(url)
        if u.scheme not in ("http", "https") or not u.netloc:
            return False, "", "Некорректная ссылка"
        if any(ch.isspace() for ch in url):
            return False, "", "Ссылка не должна содержать пробелы"
        host = (u.hostname or "").lower()
        path = (u.path or "").lower()

        if ttype == "ya":
            if "yandex" not in host:
                return False, "", "Ссылка не похожа на Яндекс. Нужна ссылка на Яндекс Карты"
            if not _host_allowed(host, YA_ALLOWED_HOST):
                return False, "", "Разрешены только ссылки Яндекс (yandex.*)"
            if ("/maps" not in path) and ("/profile" not in path) and ("maps" not in host):
                return False, "", "Нужна ссылка именно на Яндекс Карты (место/организация)"
        elif ttype == "gm":
            if host in ("maps.app.goo.gl", "goo.gl"):
                return True, url, ""
            if "google" not in host:
                return False, "", "Ссылка не похожа на Google. Нужна ссылка на Google Maps"
            if not _host_allowed(host, GM_ALLOWED_HOST):
                return False, "", "Разрешены только ссылки Google Maps"
            if ("/maps" not in path) and (not host.startswith("maps.")):
                return False, "", "Нужна ссылка именно на Google Maps (место/организация)"
        elif ttype == "dg":
            if "2gis" not in host and host != "go.2gis.com":
                return False, "", "Ссылка не похожа на 2GIS. Нужна ссылка на 2GIS"
            if not _host_allowed(host, DG_ALLOWED_HOST):
                return False, "", "Разрешены только ссылки 2GIS"
        return True, url, ""
    except Exception:
        return False, "", "Некорректная ссылка"

def cast_id(v):
    s = str(v or "").strip()
    if s.isdigit():
        try:
            return int(s)
        except Exception:
            return s
    return s

async def check_url_alive(url: str) -> tuple[bool, str]:
    try:
        import aiohttp
        timeout = aiohttp.ClientTimeout(total=10)
        headers = {
            "User-Agent": "Mozilla/5.0 (compatible; ReviewCashBot/1.0; +https://t.me/ReviewCashOrg_Bot)"
        }
        async with aiohttp.ClientSession(timeout=timeout, headers=headers) as session:
            def _ok_status(st: int) -> bool:
                return (st < 400) or (st in (401, 403, 429))

            try:
                async with session.head(url, allow_redirects=True) as r:
                    if _ok_status(r.status):
                        return True, ""
                    return False, f"HTTP {r.status}"
            except Exception:
                async with session.get(url, allow_redirects=True) as r:
                    if _ok_status(r.status):
                        return True, ""
                    return False, f"HTTP {r.status}"
    except Exception:
        return False, "не удалось открыть ссылку"

def is_rework_active(comp: dict | None) -> bool:
    if not comp: return False
    return str(comp.get("status") or "").lower() == "rework"
