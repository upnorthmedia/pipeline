"""Export the parity oracle the TypeScript `recrawl-check` port needs.

`check_recrawl_schedules` in `api/src/worker.py` decides, per profile, whether
a re-crawl is due. The decision is pure once the row is loaded, so it is
exported as an input/output table rather than a scenario.

The branch under test is copied verbatim from the job rather than
reimplemented, so the oracle cannot drift from what the job actually does:

    if not profile.last_crawled_at:
        enqueue
    delta = now - profile.last_crawled_at
    if profile.recrawl_interval == "weekly" and delta.days >= 7: enqueue
    elif ... "biweekly" and delta.days >= 14: enqueue
    elif ... "monthly" and delta.days >= 30: enqueue

Cases cover each interval either side of its boundary, the never-crawled
short-circuit (including with an interval the job does not recognise), an
unrecognised interval, and a `last_crawled_at` in the future, which is where
`timedelta.days` flooring toward negative infinity is observable.

Usage:
    uv run python scripts/export_recrawl_parity.py
"""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

OUT = (
    Path(__file__).resolve().parents[2]
    / "web"
    / "src"
    / "mastra"
    / "steps"
    / "data"
    / "recrawl-due-parity.json"
)

# The reference "now". Fixed rather than `datetime.now(UTC)` so re-running the
# export produces a byte-identical file.
NOW = datetime(2026, 8, 22, 12, 0, 0, tzinfo=UTC)


def enqueues(recrawl_interval: str, last_crawled_at: datetime | None) -> bool:
    """The per-profile branch of `check_recrawl_schedules`, verbatim."""
    if not last_crawled_at:
        return True

    delta = NOW - last_crawled_at
    if recrawl_interval == "weekly" and delta.days >= 7:
        return True
    elif recrawl_interval == "biweekly" and delta.days >= 14:
        return True
    elif recrawl_interval == "monthly" and delta.days >= 30:
        return True
    return False


CASES: list[tuple[str, str, timedelta | None]] = [
    ("never crawled, weekly", "weekly", None),
    ("never crawled, unrecognised interval", "quarterly", None),
    ("never crawled, empty interval", "", None),
    ("weekly, one second short of 7 days", "weekly", timedelta(days=7, seconds=-1)),
    ("weekly, exactly 7 days", "weekly", timedelta(days=7)),
    ("weekly, 30 days", "weekly", timedelta(days=30)),
    ("biweekly, 13 days 23h", "biweekly", timedelta(days=13, hours=23)),
    ("biweekly, exactly 14 days", "biweekly", timedelta(days=14)),
    ("biweekly, 7 days", "biweekly", timedelta(days=7)),
    ("monthly, 29 days 23h59m", "monthly", timedelta(days=29, hours=23, minutes=59)),
    ("monthly, exactly 30 days", "monthly", timedelta(days=30)),
    ("monthly, 14 days", "monthly", timedelta(days=14)),
    ("unrecognised interval, long overdue", "quarterly", timedelta(days=400)),
    ("weekly, crawled one second in the future", "weekly", timedelta(seconds=-1)),
    ("weekly, crawled 400 days in the future", "weekly", timedelta(days=-400)),
    ("weekly, crawled at exactly now", "weekly", timedelta(0)),
]


def main() -> int:
    cases = []
    for name, interval, ago in CASES:
        last = None if ago is None else NOW - ago
        cases.append(
            {
                "name": name,
                "recrawl_interval": interval,
                "last_crawled_at": None if last is None else last.isoformat(),
                "enqueues": enqueues(interval, last),
            }
        )

    payload = {
        "python_version": sys.version.split()[0],
        "now": NOW.isoformat(),
        "cases": cases,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"wrote {len(cases)} cases to {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
