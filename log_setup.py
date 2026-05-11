"""Centralised logging configuration for Business Analyst Agent.

Call setup_logging() once at startup (app.py).  Every module that does
  import logging; log = logging.getLogger(__name__)
will automatically write to both the console and the daily rotating file.

Log directory: outputs/Log/
File pattern:  baa_YYYY-MM-DD.log   (one file per day, kept 30 days)
Active file is always named after today's date — no plain "baa.log".
"""
import datetime
import logging
import logging.handlers
import os
from pathlib import Path


class _DailyFileHandler(logging.handlers.TimedRotatingFileHandler):
    """TimedRotatingFileHandler variant where the *active* file is already
    named baa_YYYY-MM-DD.log instead of the base name baa.log."""

    def __init__(self, log_dir: Path, backup_count: int = 30, encoding: str = "utf-8"):
        self._log_dir = log_dir
        today = datetime.date.today().strftime("%Y-%m-%d")
        filename = str(log_dir / f"baa_{today}.log")
        super().__init__(
            filename=filename,
            when="midnight",
            interval=1,
            backupCount=backup_count,
            encoding=encoding,
            delay=False,
        )
        self.suffix = "%Y-%m-%d.log"
        self.namer = self._namer

    def _namer(self, default_name: str) -> str:
        # default_name = "<dir>/baa_OLD-DATE.log.YYYY-MM-DD"
        # We strip the trailing ".YYYY-MM-DD" and rename based on the date suffix
        # so the rotated file becomes baa_YYYY-MM-DD.log (the *new* day).
        # Actually TimedRotatingFileHandler calls namer with the rotation target,
        # so we just use the date part from the suffix.
        parts = default_name.rsplit(".", 1)
        # parts[-1] is the YYYY-MM-DD from the suffix
        date_str = parts[-1] if len(parts) == 2 else datetime.date.today().strftime("%Y-%m-%d")
        return str(self._log_dir / f"baa_{date_str}.log")

    def doRollover(self):
        # Update baseFilename to tomorrow's date before rotating
        tomorrow = datetime.date.today().strftime("%Y-%m-%d")
        self.baseFilename = str(self._log_dir / f"baa_{tomorrow}.log")
        super().doRollover()


def setup_logging(level: int = logging.INFO) -> None:
    log_dir = Path(__file__).parent / "outputs" / "Log"
    log_dir.mkdir(parents=True, exist_ok=True)

    fmt = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    file_handler = _DailyFileHandler(log_dir)
    file_handler.setFormatter(fmt)

    console_handler = logging.StreamHandler()
    console_handler.setFormatter(fmt)

    root = logging.getLogger()
    root.setLevel(level)

    # Avoid adding duplicate handlers on reload (Flask debug mode re-imports)
    if not any(isinstance(h, _DailyFileHandler) for h in root.handlers):
        root.addHandler(file_handler)

    # Replace any existing StreamHandlers with ours so format is consistent
    root.handlers = [h for h in root.handlers
                     if not isinstance(h, logging.StreamHandler)
                     or isinstance(h, _DailyFileHandler)]
    root.addHandler(console_handler)
