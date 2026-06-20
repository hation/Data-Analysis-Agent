#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Automatic cleanup of runtime artifacts (uploads/ and outputs/).

Why this exists
---------------
Without TTL pruning, `uploads/` grows unbounded with every uploaded
spreadsheet (users routinely upload 50+ MB Excel files), and
`outputs/charts/` collects an HTML file per chart generation.
Disk pressure aside, these directories also accumulate sensitive
user data (PII in source data, embedded credentials in chart titles, etc.).

Policy
------
Each rule is `(directory, max_age_days)`. A file older than `max_age_days`
(by mtime) is deleted on the next sweep. Sub-directories are walked.
Empty leaf directories are pruned after their files are.

Defaults are conservative — they keep enough history for normal workflows
(re-opening last week's analysis works fine) while bounding worst-case growth.

Overrides
---------
Set environment variables before `setup_cleanup` runs:
    BAA_CLEANUP_UPLOAD_DAYS=14   # default 30
    BAA_CLEANUP_OUTPUT_DAYS=30   # default 90
    BAA_CLEANUP_DISABLED=1       # skip cleanup entirely (e.g. dev work)
    BAA_CLEANUP_INTERVAL_HOURS=6 # default 24

Threading
---------
A daemon thread sleeps `interval_hours` between sweeps. It dies with the
process; no shutdown signal needed. The very first sweep runs synchronously
during `setup_cleanup()` so anything stale at boot disappears immediately.
"""
import logging
import os
import threading
import time
from pathlib import Path
from typing import Iterable, Tuple

log = logging.getLogger(__name__)

# (relative path, max age in days, "label for logs")
# Session/ and Dashboard/ are intentionally NOT swept — those are user-saved
# artifacts with their own UI delete buttons, and losing them silently would
# be a worse failure than disk growth.
DEFAULT_RULES: Tuple[Tuple[str, int, str], ...] = (
    ("uploads",          int(os.environ.get("BAA_CLEANUP_UPLOAD_DAYS", "30")), "uploads"),
    ("outputs/charts",   int(os.environ.get("BAA_CLEANUP_OUTPUT_DAYS", "90")), "outputs/charts"),
    ("outputs/exports",  int(os.environ.get("BAA_CLEANUP_OUTPUT_DAYS", "90")), "outputs/exports"),
)


def _sweep_one(root: Path, max_age_days: int, label: str) -> Tuple[int, int]:
    """Delete files older than max_age_days under root. Returns (n_files_removed, bytes_freed)."""
    if not root.exists() or not root.is_dir():
        return 0, 0
    cutoff = time.time() - (max_age_days * 86400)
    removed = 0
    freed = 0
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        try:
            mtime = path.stat().st_mtime
            if mtime < cutoff:
                size = path.stat().st_size
                path.unlink()
                removed += 1
                freed += size
        except OSError as exc:
            log.warning("[cleanup] cannot remove %s: %s", path, exc)
    # Prune empty directories (deepest first)
    for path in sorted(root.rglob("*"), key=lambda p: -len(p.parts)):
        if path.is_dir():
            try:
                path.rmdir()  # only succeeds when empty
            except OSError:
                pass
    if removed:
        log.info("[cleanup] %s: removed %d file(s), freed %.1f MB (>%d days old)",
                 label, removed, freed / 1024 / 1024, max_age_days)
    return removed, freed


def run_cleanup(base_dir: Path, rules: Iterable[Tuple[str, int, str]] = DEFAULT_RULES) -> None:
    """Run one sweep across all rules. Safe to call repeatedly."""
    total_removed = 0
    total_freed = 0
    for rel, days, label in rules:
        n, b = _sweep_one(base_dir / rel, days, label)
        total_removed += n
        total_freed += b
    if total_removed == 0:
        log.debug("[cleanup] sweep complete — nothing to remove")


def _cleanup_loop(base_dir: Path, interval_hours: int, rules) -> None:
    """Daemon-thread entry: sleep, sweep, repeat."""
    interval_sec = interval_hours * 3600
    while True:
        time.sleep(interval_sec)
        try:
            run_cleanup(base_dir, rules)
        except Exception as exc:  # never let cleanup crash kill the thread
            log.exception("[cleanup] sweep raised: %s", exc)


def setup_cleanup(base_dir: Path | None = None) -> None:
    """Install the cleanup daemon. Call once at app startup.

    Performs one synchronous sweep before returning, then spawns a daemon
    thread to repeat every `BAA_CLEANUP_INTERVAL_HOURS` (default 24).
    Honors `BAA_CLEANUP_DISABLED=1` for opting out entirely.
    """
    if os.environ.get("BAA_CLEANUP_DISABLED") == "1":
        log.info("[cleanup] disabled via BAA_CLEANUP_DISABLED=1")
        return

    base = base_dir or Path(__file__).parent
    rules = DEFAULT_RULES
    interval = int(os.environ.get("BAA_CLEANUP_INTERVAL_HOURS", "24"))

    log.info("[cleanup] policies: %s", ", ".join(f"{r[2]}>{r[1]}d" for r in rules))

    # First sweep runs now so boot-time disk pressure is addressed immediately.
    try:
        run_cleanup(base, rules)
    except Exception as exc:
        log.exception("[cleanup] startup sweep failed: %s", exc)

    t = threading.Thread(
        target=_cleanup_loop, args=(base, interval, rules),
        name="baa-cleanup", daemon=True,
    )
    t.start()
    log.info("[cleanup] daemon started (re-sweeps every %dh)", interval)
