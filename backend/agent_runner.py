"""
Runs the Browser-Use agent for one goal and returns a clean, structured result.

Why this file looks the way it does:
- On Windows, uvicorn's event loop cannot launch Chrome (NotImplementedError).
  So the agent runs in its own thread with its own Proactor loop.
- The agent is asked to answer in JSON so the frontend can show nice cards
  with real links. If it answers in plain text anyway, we fall back to that.
- Live progress: browser-use hooks (step start / model decision / step end)
  are turned into small event dicts and handed to an `emit` callback, which
  the streaming endpoint forwards to the browser as Server-Sent Events.
"""
from dotenv import load_dotenv

load_dotenv()

import asyncio
import json
import os
import re
import sys
import threading
from collections.abc import Callable
from urllib.parse import urlparse

from browser_use import Agent, ChatGoogle
from pydantic import BaseModel, Field

MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")


class AnswerItem(BaseModel):
    title: str = Field(description="Product or result name exactly as shown on the page")
    price: str | None = Field(default=None, description="Price exactly as shown, e.g. '₹54,990', or null")
    details: str | None = Field(default=None, description="Short specs/notes, or null")
    url: str | None = Field(default=None, description="Full https link to this item's own page, or null")
    source: str | None = Field(default=None, description="Site name, e.g. 'Flipkart'")


class AgentAnswer(BaseModel):
    summary: str = Field(description="1-3 sentence answer to the goal")
    items: list[AnswerItem] = Field(
        default_factory=list,
        description="One entry per product/result the goal asks for. Empty only for a simple factual question.",
    )


# The done action is forced into AgentAnswer's shape (output_model_schema); these rules guide its content.
JSON_INSTRUCTIONS = """

RULES FOR YOUR FINAL ANSWER:
- Only report information EXACTLY as shown on the pages you visited. Never guess or estimate.
- Before calling done, read the results page (use extract) to get each item's real name, price and link.
  Never fill items from memory. If a filter or dropdown fails, scroll the listing and check prices yourself.
- When the goal asks for products, listings or results, put EACH one in "items" (title, price, details, url, source).
  Do not only describe them in "summary".
- Use real, full URLs that you actually saw. If an item has no link, use null.
- If the goal is a simple question, "items" may be an empty list and "summary" holds the answer.
"""


def _get_api_key():
    key = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
    return key.strip() if key else None


def parse_answer(raw: str) -> dict:
    """Turn the agent's final text into {summary, items}. Never raises."""
    text = (raw or "").strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.IGNORECASE).strip()
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        try:
            data = json.loads(text[start : end + 1])
            items = []
            for it in data.get("items") or []:
                if isinstance(it, dict):
                    items.append(
                        {
                            "title": str(it.get("title") or "Untitled"),
                            "price": it.get("price"),
                            "details": it.get("details"),
                            "url": it.get("url") if str(it.get("url") or "").startswith("http") else None,
                            "source": it.get("source"),
                        }
                    )
            return {"summary": str(data.get("summary") or ""), "items": items}
        except (json.JSONDecodeError, AttributeError):
            pass
    # Fallback: the model answered in plain text
    return {"summary": text, "items": []}


def friendly_error(raw: str) -> str:
    low = (raw or "").lower()
    if "429" in low or "resource_exhausted" in low or "quota" in low:
        return "The free Gemini quota for this model is used up for now. Wait a bit (or until tomorrow), or set GEMINI_MODEL in backend/.env to another model."
    if "404" in low and "model" in low:
        return "This Gemini model name is no longer available. Set GEMINI_MODEL in backend/.env to a current model name."
    if "api key" in low or "api_key" in low or "permission_denied" in low or "401" in low or "403" in low:
        return "The Gemini API key is missing or invalid. Check GOOGLE_API_KEY in backend/.env."
    return raw or "Unknown error"


def _sources(history) -> list:
    out, seen = [], set()
    try:
        urls = history.urls() or []
    except Exception:
        urls = []
    for u in urls:
        if not u or not str(u).startswith("http") or u in seen:
            continue
        seen.add(u)
        out.append({"url": u, "domain": urlparse(u).netloc.replace("www.", "")})
    return out


Emit = Callable[[dict], None]

# Params worth showing for an action, in order of preference
_PARAM_KEYS = ("url", "query", "text", "goal", "index", "direction", "keys", "value")


def _clip(value, limit: int = 80) -> str:
    text = " ".join(str(value).split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _describe_actions(model_output) -> list:
    """[{name, detail}] for each action the model chose, e.g. {'name': 'navigate', 'detail': 'https://…'}."""
    out = []
    for action in getattr(model_output, "action", None) or []:
        try:
            dumped = action.model_dump(exclude_unset=True)
        except Exception:
            continue
        for name, params in dumped.items():
            if params is None:
                continue
            detail = None
            if name != "done" and isinstance(params, dict):
                key = next((k for k in _PARAM_KEYS if params.get(k) not in (None, "")), None)
                if key == "index":
                    detail = f"element #{params[key]}"
                elif key:
                    detail = _clip(params[key])
            out.append({"name": name, "detail": detail})
    return out


def _step_results(results) -> list:
    return [
        {"ok": not r.error, "error": _clip(friendly_error(r.error), 200) if r.error else None, "done": bool(r.is_done)}
        for r in results or []
    ]


async def _run(goal: str, max_steps: int, emit: Emit, should_stop: Callable[[], bool]) -> dict:
    api_key = _get_api_key()
    if not api_key:
        return {"success": False, "error": "No API key found. Put GOOGLE_API_KEY=... inside backend/.env and restart the server.", "summary": "", "items": [], "sources": []}

    current = {"step": 0}

    async def on_step_start(agent):
        current["step"] = agent.state.n_steps
        emit({"type": "step_started", "step": current["step"]})

    def on_decision(state, model_output, step):
        emit(
            {
                "type": "step_planned",
                "step": step,
                "url": getattr(state, "url", None),
                "title": _clip(getattr(state, "title", "") or "", 100) or None,
                "goal": _clip(model_output.next_goal or "", 200) or None,
                "evaluation": _clip(model_output.evaluation_previous_goal or "", 200) or None,
                "actions": _describe_actions(model_output),
            }
        )

    async def on_step_end(agent):
        results = _step_results(agent.state.last_result)
        emit(
            {
                "type": "step_finished",
                "step": current["step"],
                "ok": bool(results) and all(r["ok"] for r in results),
                "results": results,
            }
        )
        if agent.history.is_done():
            emit({"type": "finalizing"})

    async def stop_requested():
        return should_stop()

    llm = ChatGoogle(model=MODEL, api_key=api_key)
    agent = Agent(
        task=goal + JSON_INSTRUCTIONS,
        llm=llm,
        max_steps=max_steps,
        enable_signal_handler=False,  # we run inside a worker thread
        register_new_step_callback=on_decision,
        register_should_stop_callback=stop_requested,
        output_model_schema=AgentAnswer,
    )

    try:
        history = await agent.run(max_steps=max_steps, on_step_start=on_step_start, on_step_end=on_step_end)
    except Exception as e:  # str(e) can be empty, so fall back to repr
        return {"success": False, "error": friendly_error(str(e) or repr(e)), "summary": "", "items": [], "sources": []}

    final = history.final_result()
    sources = _sources(history)

    if not final:
        if should_stop():
            reason = "Stopped before the agent finished."
        else:
            errs = [str(e) for e in (history.errors() or []) if e]
            reason = friendly_error(errs[-1]) if errs else "The agent stopped without giving an answer. Try a more specific goal."
        return {"success": False, "error": reason, "summary": "", "items": [], "sources": sources}

    parsed = parse_answer(final)
    # browser-use's judge re-reads the trace; surface a failed check instead of presenting the answer as verified
    judgement = history.judgement() or {}
    verified = judgement.get("verdict") if judgement else None
    warning = _clip(judgement.get("failure_reason") or "", 400) or None if verified is False else None
    return {"success": True, "error": None, "sources": sources, "verified": verified, "warning": warning, **parsed}


def _run_in_own_loop(goal: str, max_steps: int, emit: Emit, should_stop: Callable[[], bool]) -> dict:
    loop = asyncio.ProactorEventLoop() if sys.platform == "win32" else asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(_run(goal, max_steps, emit, should_stop))
    finally:
        loop.close()


async def run_agent_task(goal: str, max_steps: int = 25) -> dict:
    return await asyncio.to_thread(_run_in_own_loop, goal, max_steps, lambda _event: None, lambda: False)


async def stream_agent_task(goal: str, max_steps: int = 25):
    """Yield live event dicts while the agent works; the last one is {"type": "result", ...}.

    Closing the generator early (client disconnected / pressed Stop) asks the agent to stop.
    """
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()
    stop = threading.Event()

    def emit(event: dict) -> None:  # called from the agent's thread
        loop.call_soon_threadsafe(queue.put_nowait, event)

    async def worker():
        try:
            result = await asyncio.to_thread(_run_in_own_loop, goal, max_steps, emit, stop.is_set)
        except Exception as e:
            result = {"success": False, "error": friendly_error(str(e) or repr(e)), "summary": "", "items": [], "sources": []}
        queue.put_nowait({"type": "result", **result})

    yield {"type": "run_started", "goal": goal, "max_steps": max_steps, "model": MODEL}
    task = asyncio.create_task(worker())
    try:
        while True:
            event = await queue.get()
            yield event
            if event["type"] == "result":
                break
    finally:
        # No-op if the run already finished; otherwise the agent halts before its next step
        # and the worker thread closes its browser in the background.
        stop.set()
        task.add_done_callback(lambda t: None if t.cancelled() else t.exception())
