import os
from datetime import datetime

# Build/version string used for cache-busting in Telegram WebView
APP_BUILD = (
    os.getenv("APP_BUILD")
    or os.getenv("RENDER_GIT_COMMIT")
    or os.getenv("GIT_COMMIT")
    or datetime.utcnow().strftime("rc_%Y%m%d_%H%M%S")
)

# -------------------------
# ENV
# -------------------------
BOT_TOKEN = os.getenv("BOT_TOKEN", "").strip()
SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip()
SUPABASE_SERVICE_ROLE = os.getenv("SUPABASE_SERVICE_ROLE", "").strip()

ADMIN_IDS = [int(x) for x in os.getenv("ADMIN_IDS", "").split(",") if x.strip().isdigit()]

MAIN_ADMIN_ID = int(os.getenv("MAIN_ADMIN_ID", "0") or 0)
if not MAIN_ADMIN_ID and ADMIN_IDS:
    MAIN_ADMIN_ID = int(ADMIN_IDS[0])

MINIAPP_URL = os.getenv("MINIAPP_URL", "").strip()
BOT_USERNAME = os.getenv("BOT_USERNAME", "ReviewCashOrg_Bot").strip()
MANDATORY_SUB_CHANNEL = os.getenv("MANDATORY_SUB_CHANNEL", "").strip()

# WebApp session
WEBAPP_SESSION_SECRET = os.getenv("WEBAPP_SESSION_SECRET", "").strip()
WEBAPP_SESSION_TTL_SEC = int(os.getenv("WEBAPP_SESSION_TTL_SEC", "2592000"))
SERVER_BASE_URL = os.getenv("SERVER_BASE_URL", "").strip()
BASE_URL = os.getenv("BASE_URL", "").strip()
PORT = int(os.getenv("PORT", "10000").strip())
USE_WEBHOOK = os.getenv("USE_WEBHOOK", "1").strip() == "1"
WEBHOOK_PATH = os.getenv("WEBHOOK_PATH", "/tg/webhook").strip()

# CORS
CORS_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()]

# anti-fraud
MAX_ACCOUNTS_PER_DEVICE = int(os.getenv("MAX_ACCOUNTS_PER_DEVICE", "2").strip())
MAX_SUBMITS_10M = int(os.getenv("MAX_SUBMITS_10M", "10").strip())
SUBMIT_WINDOW_SEC = int(os.getenv("SUBMIT_WINDOW_SEC", "600").strip())
SUBMIT_WINDOW_BLOCK_SEC = int(os.getenv("SUBMIT_WINDOW_BLOCK_SEC", "1800").strip())
MIN_TASK_SUBMIT_SEC = int(os.getenv("MIN_TASK_SUBMIT_SEC", "8").strip())
EXPENSIVE_TASK_REWARD_RUB = float(os.getenv("EXPENSIVE_TASK_REWARD_RUB", "25").strip())
NEW_ACCOUNT_EXPENSIVE_LOCK_DAYS = int(os.getenv("NEW_ACCOUNT_EXPENSIVE_LOCK_DAYS", "3").strip())
FIRST_WITHDRAW_MIN_PAID_TASKS = int(os.getenv("FIRST_WITHDRAW_MIN_PAID_TASKS", "3").strip())

# limits
YA_COOLDOWN_SEC = int(os.getenv("YA_COOLDOWN_SEC", str(3 * 24 * 3600)).strip())
GM_COOLDOWN_SEC = int(os.getenv("GM_COOLDOWN_SEC", str(1 * 24 * 3600)).strip())

# topup minimum
MIN_TOPUP_RUB = float(os.getenv("MIN_TOPUP_RUB", "100").strip())
MIN_STARS_TOPUP_RUB = float(os.getenv("MIN_STARS_TOPUP_RUB", "100").strip())

# Stars rate
STARS_RUB_RATE = float(os.getenv("STARS_RUB_RATE", "1.0").strip())

# Debug bypass
DISABLE_INITDATA = os.getenv("DISABLE_INITDATA", "0").strip() == "1"

# Gemini AI for reviews
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
PAYOUT_REVIEWS_CHANNEL = "@ReviewCashPayout"
PAYOUT_CHANNEL = os.getenv("PAYOUT_CHANNEL", "@ReviewCashPayout").strip()
NEWS_CHANNEL = os.getenv("NEWS_CHANNEL", "").strip()
BOT_NAME = os.getenv("BOT_NAME", "ReviewCash").strip()

# Proof upload (Supabase Storage)
PROOF_BUCKET = os.getenv("PROOF_BUCKET", "proofs").strip() or "proofs"
MAX_PROOF_MB = int(os.getenv("MAX_PROOF_MB", "8").strip())

# Levels / XP
VIP_PRICE_RUB = float(os.getenv("VIP_PRICE_RUB", "299").strip())
VIP_PRICE_STARS = int(os.getenv("VIP_PRICE_STARS", "150").strip())
VIP_INCOME_MULT = float(os.getenv("VIP_INCOME_MULT", "1.1").strip())
VIP_XP_MULT = float(os.getenv("VIP_XP_MULT", "1.5").strip())

XP_PER_LEVEL = int(os.getenv("XP_PER_LEVEL", "100").strip())
XP_LEVEL_STEP = int(os.getenv("XP_LEVEL_STEP", "2").strip())
XP_PER_TASK_PAID = int(os.getenv("XP_PER_TASK_PAID", "10").strip())
XP_PER_TOPUP_100 = int(os.getenv("XP_PER_TOPUP_100", "2").strip())

XP_EASY = int(os.getenv("XP_EASY", "5").strip())
XP_MEDIUM = int(os.getenv("XP_MEDIUM", "12").strip())
XP_HARD = int(os.getenv("XP_HARD", "22").strip())
XP_MANUAL_BONUS = int(os.getenv("XP_MANUAL_BONUS", "3").strip())
XP_REVIEW_BONUS = int(os.getenv("XP_REVIEW_BONUS", "3").strip())
XP_MAX_PER_TASK = int(os.getenv("XP_MAX_PER_TASK", "60").strip())

# Referral
REF_BONUS_RUB = float(os.getenv("REF_BONUS_RUB", "50").strip())
REF_REVIEWS_REQUIRED = int(os.getenv("REF_REVIEWS_REQUIRED", "2").strip())

# CryptoBot
CRYPTO_PAY_TOKEN = os.getenv("CRYPTO_PAY_TOKEN", "").strip()
CRYPTO_PAY_NETWORK = os.getenv("CRYPTO_PAY_NETWORK", "MAIN_NET").strip()
CRYPTO_WEBHOOK_PATH = os.getenv("CRYPTO_WEBHOOK_PATH", "/cryptobot/webhook").strip()
CRYPTO_RUB_PER_USDT = float(os.getenv("CRYPTO_RUB_PER_USDT", "100").strip())

# Hosts logic
YA_ALLOWED_HOST = ("yandex.ru", "yandex.com", "yandex.kz", "yandex.by", "yandex.uz")
GM_ALLOWED_HOST = ("google.com", "google.ru", "google.kz", "google.by", "google.com.ua", "maps.app.goo.gl", "goo.gl")
DG_ALLOWED_HOST = ("2gis.ru", "2gis.kz", "2gis.com", "go.2gis.com", "2gis.by")

# DB table names
T_USERS = "users"
T_BAL = "balances"
T_TASKS = "tasks"
T_COMP = "task_completions"
T_DEV = "user_devices"
T_PAY = "payments"
T_WD = "withdrawals"
T_LIMITS = "user_limits"
T_STATS = "stats_daily"
T_REF = "referral_events"

# Misc Consts
BUILD_TAG = 'rc_backend_release5_lvldouble'
REWORK_GRACE_DAYS = 3
ACTIVE_REWORK_STATUSES = {"rework"}
TG_MEMBER_SUBTYPES = {"channel", "group", "bot"}
TASK_GENDER_ANY = "any"
TASK_GENDER_MALE = "male"
TASK_GENDER_FEMALE = "female"

# TG prefixes
TG_EVT_PREFIX = "tge:"
TG_HOLD_PREFIX = "tgh:"

# TG subtypes
TG_SUB_24H_KEY = "sub_24h"
TG_SUB_48H_KEY = "sub_48h"
TG_SUB_72H_KEY = "sub_72h"
TG_JOIN_GROUP_24H_KEY = "jg_24h"
TG_JOIN_GROUP_48H_KEY = "jg_48h"
TG_JOIN_GROUP_72H_KEY = "jg_72h"

TG_SUB_CHANNEL_KEY = "sub_24h"
TG_JOIN_GROUP_KEY = "jg_24h"
TG_START_BOT_KEY = "start_bot"

# Gender keys (user_limits)
USER_GENDER_MALE_KEY = "gender_m"
USER_GENDER_FEMALE_KEY = "gender_f"

# Rewards
DAILY_BONUS_RUB = 0.5

# Assets
WELCOME_BANNER_PATH = "assets/welcome_banner.png"
