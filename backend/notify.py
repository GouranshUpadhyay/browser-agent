"""Delivers finished automation results. Telegram for now; failures are logged, never raised."""
import logging

import httpx

import config
from db import Run

log = logging.getLogger("notify")

MAX_TELEGRAM_CHARS = 4000  # Telegram's limit is 4096


def telegram_configured() -> bool:
    return bool(config.TELEGRAM_BOT_TOKEN and config.TELEGRAM_CHAT_ID)


def format_run(run: Run, task_name: str) -> str:
    result = run.result or {}
    icon = {"done": "✅", "failed": "⚠️", "stopped": "⏹"}.get(run.status, "•")
    lines = [f"{icon} {task_name}"]
    if result.get("success"):
        if result.get("verified") is False:
            lines.append("(Could not verify these results — check the links.)")
        if result.get("summary"):
            lines.append(result["summary"])
        for i, item in enumerate((result.get("items") or [])[:5], 1):
            price = f" — {item['price']}" if item.get("price") else ""
            lines.append(f"\n{i}. {item.get('title', 'Untitled')}{price}")
            if item.get("url"):
                lines.append(item["url"])
    else:
        lines.append(result.get("error") or "The run did not finish.")
    lines.append(f"\nView run: {config.APP_URL}/#/runs/{run.id}")
    text = "\n".join(lines)
    return text if len(text) <= MAX_TELEGRAM_CHARS else text[: MAX_TELEGRAM_CHARS - 1] + "…"


async def send_telegram(text: str) -> bool:
    if not telegram_configured():
        log.warning("Telegram notification skipped: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set")
        return False
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.post(
                f"https://api.telegram.org/bot{config.TELEGRAM_BOT_TOKEN}/sendMessage",
                json={"chat_id": config.TELEGRAM_CHAT_ID, "text": text, "disable_web_page_preview": True},
            )
        if r.status_code != 200:
            log.warning("Telegram returned %s: %s", r.status_code, r.text[:200])
            return False
        return True
    except httpx.HTTPError as e:
        log.warning("Telegram notification failed: %s", e.__class__.__name__)  # never log the URL: it holds the token
        return False
