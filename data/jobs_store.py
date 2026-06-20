#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""JobsStore — SQLite 持久化的任务记录表（A6 骨架）。

职责边界（见 conventions.md A7）：
  - 只管持久化 jobs 表的 CRUD，不执行任务、不感知 ThreadPoolExecutor
  - 单连接 + WAL + check_same_thread=False（与 KnowledgeBase 同模式）
  - 由 JobRunner 调用，不直接被 API 层使用

表结构：
  jobs(
    id TEXT PRIMARY KEY,           -- uuid
    session_id TEXT NOT NULL,      -- 归属会话
    type TEXT NOT NULL,            -- 任务类型（excel_parse / ppt_gen / prophet / ...）
    status TEXT NOT NULL,          -- created/queued/started/progress/done/error/canceled
    progress INTEGER DEFAULT 0,    -- 0-100
    result TEXT,                   -- JSON 序列化的成功结果
    error TEXT,                    -- 错误信息（status=error 时）
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  )

状态机：
  created → queued → started → progress* → done
                                      ↘ error
                                      ↘ canceled
"""
from __future__ import annotations

import json
import logging
import sqlite3
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

log = logging.getLogger(__name__)

# 状态常量
STATUS_CREATED = "created"
STATUS_QUEUED = "queued"
STATUS_STARTED = "started"
STATUS_PROGRESS = "progress"
STATUS_DONE = "done"
STATUS_ERROR = "error"
STATUS_CANCELED = "canceled"

# 终态集合（不可再变更）
_TERMINAL = {STATUS_DONE, STATUS_ERROR, STATUS_CANCELED}

_SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    progress INTEGER DEFAULT 0,
    result TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_session ON jobs(session_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
"""


def _now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _row_to_dict(row: sqlite3.Row) -> Dict[str, Any]:
    d = dict(row)
    # 反序列化 result JSON
    if d.get("result"):
        try:
            d["result"] = json.loads(d["result"])
        except (json.JSONDecodeError, TypeError):
            pass
    return d


class JobsStore:
    """SQLite 持久化的 jobs 表 CRUD。线程安全靠 WAL + check_same_thread=False。"""

    def __init__(self, db_path: Optional[Path] = None):
        if db_path is None:
            db_path = Path(__file__).parent.parent / "outputs" / "jobs" / "jobs.db"
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._path = db_path
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript(_SCHEMA)
        self._conn.commit()
        log.info("[jobs] store opened at %s", db_path)

    # ── 创建 ────────────────────────────────────────────────────────────────

    def create(self, session_id: str, job_type: str) -> Dict[str, Any]:
        """新建一条 created 状态的 job 记录，返回完整 row dict。"""
        jid = str(uuid.uuid4())[:12]
        now = _now_iso()
        self._conn.execute(
            "INSERT INTO jobs (id, session_id, type, status, progress, created_at) "
            "VALUES (?, ?, ?, ?, 0, ?)",
            (jid, session_id, job_type, STATUS_CREATED, now),
        )
        self._conn.commit()
        return self.get(jid)  # type: ignore[return-value]

    # ── 状态流转 ─────────────────────────────────────────────────────────────

    def mark_queued(self, jid: str) -> None:
        self._transition(jid, STATUS_QUEUED)

    def mark_started(self, jid: str) -> None:
        self._transition(jid, STATUS_STARTED, started_at=_now_iso())

    def set_progress(self, jid: str, progress: int) -> None:
        """更新进度（0-100），status 变为 progress。终态 job 拒绝变更。"""
        progress = max(0, min(100, int(progress)))
        self._conn.execute(
            "UPDATE jobs SET progress = ?, status = ? WHERE id = ? AND status NOT IN (%s)"
            % ",".join(f"'{s}'" for s in _TERMINAL),
            (progress, STATUS_PROGRESS, jid),
        )
        self._conn.commit()

    def mark_done(self, jid: str, result: Any) -> None:
        result_json = json.dumps(result, ensure_ascii=False, default=str)
        self._transition(jid, STATUS_DONE, progress=100,
                         result=result_json, finished_at=_now_iso())

    def mark_error(self, jid: str, error: str) -> None:
        self._transition(jid, STATUS_ERROR, error=error, finished_at=_now_iso())

    def mark_canceled(self, jid: str) -> None:
        self._transition(jid, STATUS_CANCELED, finished_at=_now_iso())

    def _transition(self, jid: str, new_status: str, **extra) -> None:
        """更新状态。终态 job 拒绝变更（防止僵尸任务被覆盖）。"""
        cur = self._conn.execute(
            "SELECT status FROM jobs WHERE id = ?", (jid,)
        ).fetchone()
        if cur is None:
            log.warning("[jobs] transition on missing job %s", jid)
            return
        if cur["status"] in _TERMINAL and new_status not in _TERMINAL:
            log.warning("[jobs] reject transition %s: %s -> %s (terminal)",
                        jid, cur["status"], new_status)
            return
        sets = ["status = ?"]
        vals: List[Any] = [new_status]
        for k, v in extra.items():
            sets.append(f"{k} = ?")
            vals.append(v)
        vals.append(jid)
        self._conn.execute(
            f"UPDATE jobs SET {', '.join(sets)} WHERE id = ?", vals
        )
        self._conn.commit()

    # ── 查询 ────────────────────────────────────────────────────────────────

    def get(self, jid: str) -> Optional[Dict[str, Any]]:
        row = self._conn.execute(
            "SELECT * FROM jobs WHERE id = ?", (jid,)
        ).fetchone()
        return _row_to_dict(row) if row else None

    def list_by_session(self, session_id: str, limit: int = 50) -> List[Dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT * FROM jobs WHERE session_id = ? "
            "ORDER BY created_at DESC LIMIT ?",
            (session_id, limit),
        ).fetchall()
        return [_row_to_dict(r) for r in rows]

    def list_active(self, session_id: str) -> List[Dict[str, Any]]:
        """列出会话内未完成的 job（非终态）。"""
        rows = self._conn.execute(
            "SELECT * FROM jobs WHERE session_id = ? AND status NOT IN (%s) "
            "ORDER BY created_at ASC" % ",".join(f"'{s}'" for s in _TERMINAL),
            (session_id,),
        ).fetchall()
        return [_row_to_dict(r) for r in rows]

    # ── 生命周期 ─────────────────────────────────────────────────────────────

    def close(self) -> None:
        try:
            self._conn.close()
        except Exception:
            pass

    @property
    def path(self) -> Path:
        return self._path
