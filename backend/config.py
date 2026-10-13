"""All settings come from environment variables (backend/.env). Nothing secret is hard-coded."""
import os

from dotenv import load_dotenv

load_dotenv()


def _list(name: str, default: str = "") -> list[str]:
    return [v.strip() for v in os.getenv(name, default).split(",") if v.strip()]


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except ValueError:
        return default


# --- Model ---
MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")


def api_key() -> str | None:
    key = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
    return key.strip() if key else None


# --- API security ---
# Only these browser origins may call the API (comma-separated).
CORS_ORIGINS = _list("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")
# If set, every API call must send "Authorization: Bearer <API_TOKEN>".
API_TOKEN = (os.getenv("API_TOKEN") or "").strip() or None

# --- Storage ---
# SQLite by default; any SQLAlchemy URL works (e.g. postgresql+psycopg://user:pass@host/db).
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./agent.db")

# --- Runs ---
MAX_CONCURRENT_RUNS = max(1, _int("MAX_CONCURRENT_RUNS", 2))
MAX_STEPS = max(1, _int("MAX_STEPS", 25))

# --- Agent safety ---
# If set, the agent may only open these domains, e.g. "*.flipkart.com,*.amazon.in,*.google.com".
ALLOWED_DOMAINS = _list("ALLOWED_DOMAINS") or None

# --- Scheduler ---
DEFAULT_TIMEZONE = os.getenv("DEFAULT_TIMEZONE", "Asia/Kolkata")
SCHEDULER_INTERVAL_SECONDS = max(5, _int("SCHEDULER_INTERVAL_SECONDS", 15))
# A one-time or repeating run missed while the server was down still runs if it is at most this late.
MISSED_RUN_GRACE_MINUTES = max(0, _int("MISSED_RUN_GRACE_MINUTES", 60))

# --- Notifications ---
TELEGRAM_BOT_TOKEN = (os.getenv("TELEGRAM_BOT_TOKEN") or "").strip() or None
TELEGRAM_CHAT_ID = (os.getenv("TELEGRAM_CHAT_ID") or "").strip() or None
# Used to put a "view run" link in notifications.
APP_URL = os.getenv("APP_URL", "http://localhost:5173").rstrip("/")
