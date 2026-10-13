"""Schedule logic for tasks: validation, next run times, and plain-English descriptions.

Two kinds of schedule:
- "once": run_at_local ("YYYY-MM-DDTHH:MM") in the task's timezone.
- "cron": a 5-field cron expression evaluated in the task's timezone (so 09:00 stays 09:00 across DST).
"""
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from croniter import croniter

MIN_INTERVAL = timedelta(minutes=5)  # cost guard: no automation may run more often than this

DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]


class ScheduleError(ValueError):
    """A schedule the user must fix; the message is shown as-is."""


def zone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        raise ScheduleError(f"Unknown timezone '{name}'. Use a name like Asia/Kolkata or Europe/London.")


def parse_local(value: str, tz: str) -> datetime:
    """'2026-10-14T09:00' in `tz` -> aware UTC datetime."""
    try:
        naive = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        raise ScheduleError("Pick a valid date and time.")
    if naive.tzinfo is not None:
        naive = naive.astimezone(zone(tz)).replace(tzinfo=None)
    return naive.replace(tzinfo=zone(tz)).astimezone(timezone.utc)


def validate(kind: str, run_at_local: str | None, cron: str | None, tz: str, now: datetime | None = None) -> dict:
    """Check a schedule and return {run_at, cron} normalized. Raises ScheduleError."""
    now = now or datetime.now(timezone.utc)
    zone(tz)
    if kind == "once":
        if not run_at_local:
            raise ScheduleError("Choose when the task should run.")
        run_at = parse_local(run_at_local, tz)
        if run_at <= now:
            raise ScheduleError("That time is in the past. Choose a future time.")
        return {"run_at": run_at, "cron": None}
    if kind == "cron":
        expr = " ".join((cron or "").split())
        if len(expr.split()) != 5 or not croniter.is_valid(expr):
            raise ScheduleError("That repeat pattern isn't valid. Use 5-field cron, e.g. '0 9 * * 1-5'.")
        first, second = next_runs("cron", None, expr, tz, count=2, after=now)
        if second - first < MIN_INTERVAL:
            raise ScheduleError("Automations can run at most once every 5 minutes.")
        return {"run_at": None, "cron": expr}
    raise ScheduleError("Schedule must be 'once' or 'cron'.")


def next_runs(kind: str, run_at: datetime | None, cron: str | None, tz: str, count: int = 3,
              after: datetime | None = None) -> list[datetime]:
    """Upcoming run times (UTC) strictly after `after`."""
    after = after or datetime.now(timezone.utc)
    if kind == "once":
        return [run_at] if run_at and run_at > after else []
    it = croniter(cron, after.astimezone(zone(tz)))
    return [it.get_next(datetime).astimezone(timezone.utc) for _ in range(count)]


def next_run(kind: str, run_at: datetime | None, cron: str | None, tz: str, after: datetime | None = None) -> datetime | None:
    runs = next_runs(kind, run_at, cron, tz, count=1, after=after)
    return runs[0] if runs else None


def _time(minute: str, hour: str) -> str | None:
    if minute.isdigit() and hour.isdigit():
        return f"{int(hour):02d}:{int(minute):02d}"
    return None


def _days(dow: str) -> str | None:
    names = {**{str(i): d for i, d in enumerate(DAYS)}, "7": "Sunday"}
    if dow in ("1-5", "MON-FRI", "mon-fri"):
        return "every weekday"
    if dow in ("0,6", "6,0", "SAT,SUN", "sat,sun"):
        return "every weekend day"
    parts = dow.split(",")
    if all(p in names for p in parts):
        return "every " + ", ".join(names[p] for p in parts)
    return None


def describe(kind: str, run_at: datetime | None, cron: str | None, tz: str) -> str:
    """Short human description, e.g. 'Every weekday at 09:00 (Asia/Kolkata)'."""
    if kind == "once":
        local = run_at.astimezone(zone(tz)) if run_at else None
        return f"Once on {local:%a %d %b %Y at %H:%M} ({tz})" if local else "Once"
    minute, hour, dom, month, dow = cron.split()
    at = _time(minute, hour)
    if minute.startswith("*/") and hour == "*" and dom == month == dow == "*":
        return f"Every {minute[2:]} minutes"
    if minute.isdigit() and hour.startswith("*/") and dom == month == dow == "*":
        return f"Every {hour[2:]} hours at :{int(minute):02d}"
    if at and dom == "*" and month == "*":
        if dow == "*":
            return f"Every day at {at} ({tz})"
        days = _days(dow)
        if days:
            return f"{days[0].upper() + days[1:]} at {at} ({tz})"
    if at and dom.isdigit() and month == "*" and dow == "*":
        return f"Monthly on day {dom} at {at} ({tz})"
    return f"Cron '{cron}' ({tz})"
