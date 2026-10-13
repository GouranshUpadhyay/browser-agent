"""Run manager: a database-backed job queue with a fixed pool of workers.

- POST /runs only creates a row and enqueues it, so the HTTP request returns at once.
- Workers (MAX_CONCURRENT_RUNS of them) run the agent in a thread and store every
  event in run_events. The DB is the source of truth; in-memory signals only wake up
  live subscribers, so a client can reconnect and resume from its last event id.
- On startup, runs that were queued are re-queued and runs that were mid-flight are
  marked failed (their browser died with the old process).
"""
import asyncio
import logging
import time
from collections.abc import Awaitable, Callable

from sqlalchemy import select

import agent_runner
import config
from db import Run, RunEvent, Session, utcnow

log = logging.getLogger("runs")

TERMINAL = {"done", "failed", "stopped"}
FinishHook = Callable[[Run], Awaitable[None]]


def _ms() -> int:
    return int(time.time() * 1000)


def run_summary(run: Run) -> dict:
    result = run.result or {}
    return {
        "id": run.id,
        "goal": run.goal,
        "source": run.source,
        "task_id": run.task_id,
        "status": run.status,
        "created_at": run.created_at.isoformat() if run.created_at else None,
        "started_at": run.started_at.isoformat() if run.started_at else None,
        "finished_at": run.finished_at.isoformat() if run.finished_at else None,
        "summary": result.get("summary") or result.get("error") or None,
    }


class RunManager:
    def __init__(self) -> None:
        self._queue: asyncio.Queue[int] = asyncio.Queue()
        self._signals: dict[int, asyncio.Event] = {}
        self._cancelled: set[int] = set()  # read from agent threads; set ops are atomic
        self._loop: asyncio.AbstractEventLoop | None = None
        self._workers: list[asyncio.Task] = []
        self.finish_hooks: list[FinishHook] = []

    # ---------- lifecycle ----------

    async def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        requeue = await asyncio.to_thread(self._recover)
        for run_id in requeue:
            self._queue.put_nowait(run_id)
        self._workers = [asyncio.create_task(self._worker(i)) for i in range(config.MAX_CONCURRENT_RUNS)]
        log.info("Run manager started with %d worker(s); re-queued %d run(s)", len(self._workers), len(requeue))

    async def stop(self) -> None:
        for w in self._workers:
            w.cancel()
        # Ask in-flight agents to stop; their threads finish on their own.
        with Session() as s:
            self._cancelled.update(s.scalars(select(Run.id).where(Run.status == "running")).all())

    def _recover(self) -> list[int]:
        with Session() as s:
            for run in s.scalars(select(Run).where(Run.status == "running")).all():
                self._finish_row(s, run, "failed", {
                    "success": False, "error": "The server restarted while this run was in progress.",
                    "summary": "", "items": [], "sources": [],
                })
            s.commit()
            return list(s.scalars(select(Run.id).where(Run.status == "queued").order_by(Run.id)).all())

    # ---------- public API ----------

    async def submit(self, goal: str, source: str = "chat", task_id: int | None = None) -> Run:
        def create() -> Run:
            with Session() as s:
                run = Run(goal=goal, source=source, task_id=task_id, status="queued")
                s.add(run)
                s.commit()
                return run

        run = await asyncio.to_thread(create)
        self._queue.put_nowait(run.id)
        return run

    async def cancel(self, run_id: int) -> Run | None:
        def mark() -> Run | None:
            with Session() as s:
                run = s.get(Run, run_id)
                if not run or run.status in TERMINAL:
                    return run
                run.cancel_requested = True
                if run.status == "queued":  # never started: finish it right here
                    self._finish_row(s, run, "stopped", {
                        "success": False, "error": "You stopped this run.", "summary": "", "items": [], "sources": [],
                    })
                s.commit()
                return run

        self._cancelled.add(run_id)
        run = await asyncio.to_thread(mark)
        self._signal(run_id)
        return run

    def is_live(self, run_id: int) -> bool:
        with Session() as s:
            run = s.get(Run, run_id)
            return bool(run and run.status not in TERMINAL)

    async def events(self, run_id: int, after: int = 0):
        """Yield (event_id, data) for a run, starting after `after`, until its result event.

        Yields None as a keep-alive when nothing happened for a while.
        """
        while True:
            signal = self._signal_for(run_id)  # grab before reading so no wake-up is missed
            rows = await asyncio.to_thread(self.events_after, run_id, after)
            for event_id, data in rows:
                after = event_id
                yield event_id, data
                if data.get("type") == "result":
                    return
            if not rows:
                live = await asyncio.to_thread(self.is_live, run_id)
                if not live and not await asyncio.to_thread(self.events_after, run_id, after):
                    return
                try:
                    await asyncio.wait_for(signal.wait(), timeout=15)
                except TimeoutError:
                    yield None

    # ---------- workers ----------

    async def _worker(self, n: int) -> None:
        while True:
            run_id = await self._queue.get()
            try:
                await self._execute(run_id)
            except Exception:
                log.exception("Run %s crashed in worker %d", run_id, n)
                await asyncio.to_thread(self._fail_crashed, run_id)
            finally:
                self._cancelled.discard(run_id)
                self._signal(run_id)

    async def _execute(self, run_id: int) -> None:
        def begin() -> Run | None:
            with Session() as s:
                run = s.get(Run, run_id)
                if not run or run.status != "queued":
                    return None
                run.status = "running"
                run.started_at = utcnow()
                self._add_event(s, run_id, {
                    "type": "run_started", "goal": run.goal, "max_steps": config.MAX_STEPS, "model": config.MODEL,
                })
                s.commit()
                return run

        run = await asyncio.to_thread(begin)
        if run is None:
            return
        self._signal(run_id)

        def emit(event: dict) -> None:  # called from the agent's thread
            with Session() as s:
                self._add_event(s, run_id, event)
                s.commit()
            self._signal(run_id)

        result = await asyncio.to_thread(
            agent_runner.execute, run.goal, config.MAX_STEPS, emit, lambda: run_id in self._cancelled
        )

        def end() -> Run:
            with Session() as s:
                row = s.get(Run, run_id)
                if row.cancel_requested and not result.get("success"):
                    status, payload = "stopped", {**result, "error": "You stopped this run."}
                else:
                    status, payload = ("done" if result.get("success") else "failed"), result
                self._finish_row(s, row, status, payload)
                s.commit()
                return row

        finished = await asyncio.to_thread(end)
        self._signal(run_id)
        for hook in self.finish_hooks:
            try:
                await hook(finished)
            except Exception:
                log.exception("Finish hook failed for run %s", run_id)

    # ---------- helpers ----------

    def _fail_crashed(self, run_id: int) -> None:
        with Session() as s:
            run = s.get(Run, run_id)
            if run and run.status not in TERMINAL:
                self._finish_row(s, run, "failed", {
                    "success": False, "error": "Internal error while running the agent. See the backend log.",
                    "summary": "", "items": [], "sources": [],
                })
                s.commit()

    def _finish_row(self, s, run: Run, status: str, result: dict) -> None:
        run.status = status
        run.result = result
        run.finished_at = utcnow()
        self._add_event(s, run.id, {"type": "result", **result, "status": status})

    @staticmethod
    def _add_event(s, run_id: int, data: dict) -> None:
        s.add(RunEvent(run_id=run_id, data={**data, "ts": _ms()}))

    @staticmethod
    def events_after(run_id: int, after: int) -> list[tuple[int, dict]]:
        with Session() as s:
            rows = s.execute(
                select(RunEvent.id, RunEvent.data)
                .where(RunEvent.run_id == run_id, RunEvent.id > after)
                .order_by(RunEvent.id)
            ).all()
            return [(r.id, r.data) for r in rows]

    def _signal_for(self, run_id: int) -> asyncio.Event:
        return self._signals.setdefault(run_id, asyncio.Event())

    def _signal(self, run_id: int) -> None:
        """Wake everyone waiting on this run. Safe to call from any thread."""
        def fire():
            old = self._signals.pop(run_id, None)
            if old:
                old.set()

        if self._loop is None:
            return
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is self._loop:
            fire()
        else:
            self._loop.call_soon_threadsafe(fire)


manager = RunManager()
