"""Scheduled tasks ("automations"): drafts, the scheduler loop, and plain-English parsing.

Flow: the user describes an automation -> parse_draft() turns it into a TaskDraft ->
the UI shows it back (with the next run times) for confirmation -> create_task().
The scheduler wakes every SCHEDULER_INTERVAL_SECONDS, claims due tasks, and submits
a run for each. A task never has two runs in flight: an occurrence that comes due
while the previous run is still going is skipped.
"""
import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Literal

from browser_use import ChatGoogle
from browser_use.llm.messages import SystemMessage, UserMessage
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import select, update

import config
import notify
import schedules
from db import Run, Session, Task, utcnow
from runs import TERMINAL, manager, run_summary

log = logging.getLogger("tasks")


class Schedule(BaseModel):
    schedule_kind: Literal["once", "cron"]
    run_at_local: str | None = None  # "YYYY-MM-DDTHH:MM" in `timezone`, for "once"
    cron: str | None = None  # 5-field cron in `timezone`, for "cron"
    timezone: str = config.DEFAULT_TIMEZONE


class TaskDraft(Schedule):
    name: str = Field(min_length=1, max_length=120)
    instruction: str = Field(min_length=3, max_length=1000)
    notify: Literal["app", "telegram"] = "app"


def preview(schedule: Schedule) -> dict:
    """Validate a schedule and describe it. Raises schedules.ScheduleError."""
    norm = schedules.validate(schedule.schedule_kind, schedule.run_at_local, schedule.cron, schedule.timezone)
    upcoming = schedules.next_runs(schedule.schedule_kind, norm["run_at"], norm["cron"], schedule.timezone)
    return {
        "schedule_text": schedules.describe(schedule.schedule_kind, norm["run_at"], norm["cron"], schedule.timezone),
        "next_runs": [t.isoformat() for t in upcoming],
    }


def task_view(task: Task, last_run: Run | None = None) -> dict:
    tz = schedules.zone(task.timezone)
    return {
        "id": task.id,
        "name": task.name,
        "instruction": task.instruction,
        "schedule_kind": task.schedule_kind,
        "run_at_local": task.run_at.astimezone(tz).strftime("%Y-%m-%dT%H:%M") if task.run_at else None,
        "cron": task.cron,
        "timezone": task.timezone,
        "notify": task.notify,
        "enabled": task.enabled,
        "schedule_text": schedules.describe(task.schedule_kind, task.run_at, task.cron, task.timezone),
        "next_run_at": task.next_run_at.isoformat() if task.next_run_at else None,
        "created_at": task.created_at.isoformat(),
        "last_run": run_summary(last_run) if last_run else None,
    }


# ---------- CRUD (sync; call via asyncio.to_thread) ----------

def create_task(draft: TaskDraft) -> dict:
    norm = schedules.validate(draft.schedule_kind, draft.run_at_local, draft.cron, draft.timezone)
    with Session() as s:
        task = Task(
            name=draft.name.strip(),
            instruction=draft.instruction.strip(),
            schedule_kind=draft.schedule_kind,
            run_at=norm["run_at"],
            cron=norm["cron"],
            timezone=draft.timezone,
            notify=draft.notify,
            enabled=True,
        )
        task.next_run_at = schedules.next_run(task.schedule_kind, task.run_at, task.cron, task.timezone)
        s.add(task)
        s.commit()
        return task_view(task)


def list_tasks() -> list[dict]:
    with Session() as s:
        tasks = s.scalars(select(Task).order_by(Task.created_at.desc())).all()
        runs = {r.id: r for r in s.scalars(select(Run).where(Run.id.in_([t.last_run_id for t in tasks if t.last_run_id]))).all()}
        return [task_view(t, runs.get(t.last_run_id)) for t in tasks]


def set_enabled(task_id: int, enabled: bool) -> dict | None:
    with Session() as s:
        task = s.get(Task, task_id)
        if not task:
            return None
        if enabled:
            nxt = schedules.next_run(task.schedule_kind, task.run_at, task.cron, task.timezone)
            if nxt is None:
                raise schedules.ScheduleError("This one-time task's time has passed. Create a new one instead.")
            task.next_run_at = nxt
        else:
            task.next_run_at = None
        task.enabled = enabled
        s.commit()
        return task_view(task, s.get(Run, task.last_run_id) if task.last_run_id else None)


def delete_task(task_id: int) -> bool:
    with Session() as s:
        task = s.get(Task, task_id)
        if not task:
            return False
        s.delete(task)
        s.commit()
        return True


def task_runs(task_id: int, limit: int = 20) -> list[dict]:
    with Session() as s:
        rows = s.scalars(select(Run).where(Run.task_id == task_id).order_by(Run.id.desc()).limit(limit)).all()
        return [run_summary(r) for r in rows]


def _get_task(task_id: int) -> Task | None:
    with Session() as s:
        return s.get(Task, task_id)


def _record_run(task_id: int, run_id: int) -> None:
    with Session() as s:
        s.execute(update(Task).where(Task.id == task_id).values(last_run_id=run_id))
        s.commit()


async def run_now(task_id: int) -> Run | None:
    task = await asyncio.to_thread(_get_task, task_id)
    if not task:
        return None
    run = await manager.submit(task.instruction, source="task", task_id=task.id)
    await asyncio.to_thread(_record_run, task.id, run.id)
    return run


# ---------- scheduler ----------

def _claim_due(now: datetime) -> list[tuple[Task, bool]]:
    """Advance every due task to its next occurrence; return (task, should_run) pairs.

    The UPDATE is conditional on the old next_run_at, so even two scheduler processes
    sharing a database can't both fire the same occurrence.
    """
    grace = timedelta(minutes=config.MISSED_RUN_GRACE_MINUTES)
    claimed = []
    with Session() as s:
        due = s.scalars(select(Task).where(Task.enabled.is_(True), Task.next_run_at <= now)).all()
        for task in due:
            due_at = task.next_run_at
            if task.schedule_kind == "once":
                values = {"next_run_at": None, "enabled": False}
            else:
                values = {"next_run_at": schedules.next_run("cron", None, task.cron, task.timezone, after=now)}
            won = s.execute(
                update(Task).where(Task.id == task.id, Task.next_run_at == due_at).values(**values)
            ).rowcount
            if not won:
                continue
            last = s.get(Run, task.last_run_id) if task.last_run_id else None
            busy = last is not None and last.status not in TERMINAL
            late = now - due_at > grace
            if late:
                log.info("Task %s: skipped occurrence at %s (server was down too long)", task.id, due_at)
            elif busy:
                log.info("Task %s: skipped occurrence at %s (previous run still going)", task.id, due_at)
            claimed.append((task, not late and not busy))
        s.commit()
    return claimed


async def scheduler_loop() -> None:
    log.info("Scheduler started (every %ss)", config.SCHEDULER_INTERVAL_SECONDS)
    while True:
        try:
            for task, should_run in await asyncio.to_thread(_claim_due, utcnow()):
                if should_run:
                    run = await manager.submit(task.instruction, source="task", task_id=task.id)
                    await asyncio.to_thread(_record_run, task.id, run.id)
                    log.info("Task %s: started run %s", task.id, run.id)
        except Exception:
            log.exception("Scheduler tick failed")
        await asyncio.sleep(config.SCHEDULER_INTERVAL_SECONDS)


async def on_run_finished(run: Run) -> None:
    """Deliver task results to the task's chosen channel."""
    if run.source != "task" or not run.task_id:
        return
    task = await asyncio.to_thread(_get_task, run.task_id)
    if task and task.notify == "telegram":
        await notify.send_telegram(notify.format_run(run, task.name))


# ---------- plain-English -> draft ----------

class _ParsedTask(BaseModel):
    name: str = Field(description="Short title for the automation, max 6 words")
    instruction: str = Field(description="What the browser agent should do each time, as a self-contained goal. Exclude the timing.")
    schedule_kind: Literal["once", "cron"] = Field(description="'once' for a single future time, 'cron' for anything repeating")
    run_at_local: str | None = Field(default=None, description="For 'once': local date-time 'YYYY-MM-DDTHH:MM'")
    cron: str | None = Field(default=None, description="For 'cron': standard 5-field cron (minute hour day-of-month month day-of-week; 0=Sunday)")
    timezone: str | None = Field(default=None, description="IANA timezone only if the user named one, else null")


async def parse_draft(text: str, tz: str | None = None) -> dict:
    """Turn 'every weekday at 9am check X' into a draft + preview. Raises ScheduleError."""
    if not config.api_key():
        raise schedules.ScheduleError("No API key found, so plain-English parsing is unavailable. Fill the schedule in manually.")
    tz = tz or config.DEFAULT_TIMEZONE
    now_local = datetime.now(timezone.utc).astimezone(schedules.zone(tz))
    llm = ChatGoogle(model=config.MODEL, api_key=config.api_key())
    system = (
        "You convert a user's request into a scheduled browser-automation task. "
        f"The current local time is {now_local:%A %Y-%m-%d %H:%M} in {tz}. "
        "Resolve relative times ('tomorrow at 9', 'in 2 hours') against it. "
        "If no time of day is given for a repeating task, use 09:00. Never invent a schedule faster than every 5 minutes."
    )
    try:
        out = await llm.ainvoke([SystemMessage(content=system), UserMessage(content=text)], output_format=_ParsedTask)
    except Exception as e:
        from agent_runner import friendly_error

        raise schedules.ScheduleError(f"Could not read that schedule: {friendly_error(str(e) or repr(e))}")
    p = out.completion
    try:
        draft = TaskDraft(
            name=p.name[:120] or "Automation",
            instruction=p.instruction,
            schedule_kind=p.schedule_kind,
            run_at_local=p.run_at_local,
            cron=p.cron,
            timezone=p.timezone or tz,
        )
    except ValidationError:
        raise schedules.ScheduleError("Couldn't work out what to do from that. Say what the agent should do, and when.")
    return {"draft": draft.model_dump(), **preview(draft)}
