import asyncio
import json
import logging
import secrets
import sys

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

from contextlib import asynccontextmanager

from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select

import agent_runner
import config
import notify
import schedules
import tasks
from db import Run, Session, init_db
from runs import manager, run_summary

logging.basicConfig(level=logging.INFO, format="%(levelname)s [%(name)s] %(message)s")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    if tasks.on_run_finished not in manager.finish_hooks:
        manager.finish_hooks.append(tasks.on_run_finished)
    await manager.start()
    scheduler = asyncio.create_task(tasks.scheduler_loop())
    yield
    scheduler.cancel()
    await manager.stop()


app = FastAPI(title="Browser Agent API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["Authorization", "Content-Type", "Last-Event-ID"],
)


def require_token(authorization: str | None = Header(default=None)) -> None:
    """If API_TOKEN is set, every API call must carry it as a Bearer token."""
    if not config.API_TOKEN:
        return
    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not secrets.compare_digest(token.strip(), config.API_TOKEN):
        raise HTTPException(status_code=401, detail="Missing or invalid API token")


api = APIRouter(dependencies=[Depends(require_token)])


class GoalRequest(BaseModel):
    goal: str = Field(min_length=3, max_length=1000)


class ParseRequest(BaseModel):
    text: str = Field(min_length=3, max_length=1000)
    timezone: str | None = None


class TaskPatch(BaseModel):
    enabled: bool


def _schedule_error(e: schedules.ScheduleError) -> HTTPException:
    return HTTPException(status_code=422, detail=str(e))


@app.get("/")
@app.get("/health")
def health():
    # Only reports WHETHER things are configured, never the values.
    return {
        "status": "ok",
        "api_key_loaded": bool(config.api_key()),
        "model": config.MODEL,
        "auth_required": bool(config.API_TOKEN),
        "telegram_configured": notify.telegram_configured(),
        "default_timezone": config.DEFAULT_TIMEZONE,
    }


# ---------- runs ----------

@api.post("/run")
async def run_task(request: GoalRequest):
    """Blocking: runs one goal and returns the result (kept for scripts like test_agent.py)."""
    return await agent_runner.run_agent_task(request.goal.strip())


@api.post("/runs", status_code=201)
async def create_run(request: GoalRequest):
    run = await manager.submit(request.goal.strip(), source="chat")
    return run_summary(run)


@api.get("/runs")
async def list_runs(source: str | None = None, limit: int = Query(20, ge=1, le=100)):
    def load():
        with Session() as s:
            q = select(Run).order_by(Run.id.desc()).limit(limit)
            if source:
                q = q.where(Run.source == source)
            return [run_summary(r) for r in s.scalars(q).all()]

    return await asyncio.to_thread(load)


@api.get("/runs/{run_id}")
async def get_run(run_id: int):
    def load():
        with Session() as s:
            run = s.get(Run, run_id)
            return run_summary(run) if run else None

    run = await asyncio.to_thread(load)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    run["events"] = [{"id": i, **d} for i, d in await asyncio.to_thread(manager.events_after, run_id, 0)]
    return run


@api.get("/runs/{run_id}/events")
async def stream_run_events(
    run_id: int,
    request: Request,
    after: int = Query(0, ge=0),
    last_event_id: str | None = Header(default=None),
):
    """Server-Sent Events for one run. Resumes after Last-Event-ID (or ?after=), ends after the result."""
    def exists() -> bool:
        with Session() as s:
            return s.get(Run, run_id) is not None

    if not await asyncio.to_thread(exists):
        raise HTTPException(status_code=404, detail="Run not found")
    if last_event_id and last_event_id.isdigit():
        after = max(after, int(last_event_id))

    async def stream():
        yield "retry: 2000\n\n"
        async for item in manager.events(run_id, after):
            if await request.is_disconnected():
                return
            if item is None:
                yield ": keep-alive\n\n"
                continue
            event_id, data = item
            yield f"id: {event_id}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    )


@api.post("/runs/{run_id}/cancel")
async def cancel_run(run_id: int):
    run = await manager.cancel(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    return run_summary(run)


# ---------- tasks (automations) ----------

@api.get("/tasks")
async def list_tasks():
    return await asyncio.to_thread(tasks.list_tasks)


@api.post("/tasks/parse")
async def parse_task(request: ParseRequest):
    try:
        return await tasks.parse_draft(request.text.strip(), request.timezone)
    except schedules.ScheduleError as e:
        raise _schedule_error(e)


@api.post("/tasks/preview")
async def preview_task(schedule: tasks.Schedule):
    try:
        return tasks.preview(schedule)
    except schedules.ScheduleError as e:
        raise _schedule_error(e)


@api.post("/tasks", status_code=201)
async def create_task(draft: tasks.TaskDraft):
    try:
        return await asyncio.to_thread(tasks.create_task, draft)
    except schedules.ScheduleError as e:
        raise _schedule_error(e)


@api.patch("/tasks/{task_id}")
async def update_task(task_id: int, patch: TaskPatch):
    try:
        task = await asyncio.to_thread(tasks.set_enabled, task_id, patch.enabled)
    except schedules.ScheduleError as e:
        raise _schedule_error(e)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


@api.delete("/tasks/{task_id}", status_code=204)
async def delete_task(task_id: int):
    if not await asyncio.to_thread(tasks.delete_task, task_id):
        raise HTTPException(status_code=404, detail="Task not found")


@api.post("/tasks/{task_id}/run", status_code=201)
async def run_task_now(task_id: int):
    run = await tasks.run_now(task_id)
    if not run:
        raise HTTPException(status_code=404, detail="Task not found")
    return run_summary(run)


@api.get("/tasks/{task_id}/runs")
async def list_task_runs(task_id: int, limit: int = Query(20, ge=1, le=100)):
    return await asyncio.to_thread(tasks.task_runs, task_id, limit)


app.include_router(api)
