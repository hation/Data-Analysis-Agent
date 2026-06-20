#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""JobRunner — 长任务的线程池执行器（A6 骨架）。

职责边界（见 conventions.md A7）：
  - 持有 ThreadPoolExecutor，提交并执行 job 函数
  - 调用 JobsStore 做状态流转（created → queued → started → progress → done/error/canceled）
  - 提供 JobContext 给 job 函数，让它能上报进度 + 检查取消
  - 不直接被 API 层使用，由 ChatSession 持有

A6 阶段只跑空任务（_empty_job）验证骨架；B 阶段接入 Excel 解析 / PPT 生成 / Prophet 预测。

线程模型（遵守 conventions.md 运行环境约定）：
  - 禁 multiprocessing（Windows fork 雷区）
  - 用 threading + ThreadPoolExecutor(max_workers=2)
  - DuckDB 跨线程访问必须用 conn.cursor()（B 阶段注意）

取消语义：
  - Python 无法强行中断一个运行中的线程
  - cancel() 只是标记 + 取消尚未启动的 future
  - job 函数必须主动调用 ctx.check_canceled() 协作式退出
"""
from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any, Callable, Dict, List, Optional

from data.jobs_store import (
    JobsStore,
    STATUS_CANCELED,
    STATUS_CREATED,
    STATUS_DONE,
    STATUS_ERROR,
    STATUS_QUEUED,
    STATUS_STARTED,
    _TERMINAL,
)

log = logging.getLogger(__name__)

# Job 函数签名：第一个参数永远是 JobContext，其余由调用方传入
JobFn = Callable[["JobContext"], Any]


class JobCanceled(Exception):
    """job 函数检测到取消请求时抛出，由 JobRunner 捕获并标记 canceled。"""


class JobContext:
    """传给 job 函数的上下文，用于上报进度 + 协作式取消检查。

    B 阶段的 job 函数（Excel 解析 / PPT 生成 / Prophet）应：
      1. 在耗时循环里定期调用 ctx.check_canceled()
      2. 在阶段性完成时调用 ctx.set_progress(pct, message)
    """

    def __init__(self, job_id: str, store: JobsStore,
                 is_canceled_fn: Callable[[str], bool]):
        self.job_id = job_id
        self._store = store
        self._is_canceled = is_canceled_fn

    def set_progress(self, pct: int, message: str = "") -> None:
        """上报进度（0-100）。message 暂不入库，预留给 SSE 事件。"""
        self._store.set_progress(self.job_id, pct)
        if message:
            log.debug("[job %s] progress %d%%: %s", self.job_id, pct, message)

    def is_canceled(self) -> bool:
        """是否被请求取消。job 函数应在循环里轮询。"""
        return self._is_canceled(self.job_id)

    def check_canceled(self) -> None:
        """检查取消，若已请求则抛 JobCanceled。"""
        if self._is_canceled(self.job_id):
            raise JobCanceled(self.job_id)


class JobRunner:
    """每个 ChatSession 持有一个 JobRunner 实例。

    生命周期：
      - ChatSession 初始化时创建（max_workers=2）
      - 会话销毁时调用 shutdown()
      - JobsStore 是全局单例（由 SessionManager 持有），跨会话共享
    """

    def __init__(self, session_id: str, store: JobsStore,
                 max_workers: int = 2):
        self._sid = session_id
        self._store = store
        self._pool = ThreadPoolExecutor(
            max_workers=max_workers,
            thread_name_prefix=f"job-{session_id[:8]}",
        )
        # jid -> Future（运行中的任务）
        self._futures: Dict[str, Future] = {}
        # 已请求取消的 jid 集合（协作式取消标记）
        self._canceled: set = set()
        self._lock = threading.Lock()

    # ── 提交任务 ────────────────────────────────────────────────────────────

    def create(self, fn: JobFn, job_type: str) -> str:
        """提交一个 job，返回 job_id。

        fn 签名：fn(ctx: JobContext) -> Any
        返回值会被 JSON 序列化存入 jobs.result。
        """
        job = self._store.create(self._sid, job_type)
        jid = job["id"]
        self._store.mark_queued(jid)
        log.info("[job %s] queued (type=%s, session=%s)", jid, job_type, self._sid)

        future = self._pool.submit(self._run, jid, fn)
        with self._lock:
            self._futures[jid] = future
        return jid

    def _run(self, jid: str, fn: JobFn) -> None:
        """worker 线程入口：状态流转 + 异常捕获 + 清理 future。"""
        self._store.mark_started(jid)
        log.info("[job %s] started", jid)
        ctx = JobContext(jid, self._store, self._is_canceled)
        try:
            result = fn(ctx)
            # 执行完毕后再次检查取消（fn 可能在最后才被 cancel）
            if jid in self._canceled:
                self._store.mark_canceled(jid)
                log.info("[job %s] canceled after completion", jid)
                return
            self._store.mark_done(jid, result)
            log.info("[job %s] done", jid)
        except JobCanceled:
            self._store.mark_canceled(jid)
            log.info("[job %s] canceled via check_canceled()", jid)
        except Exception as e:
            self._store.mark_error(jid, f"{type(e).__name__}: {e}")
            log.exception("[job %s] error", jid)
        finally:
            with self._lock:
                self._futures.pop(jid, None)

    def _is_canceled(self, jid: str) -> bool:
        with self._lock:
            return jid in self._canceled

    # ── 取消 ────────────────────────────────────────────────────────────────

    def cancel(self, jid: str) -> bool:
        """请求取消一个 job。

        - 若 job 尚未启动（还在队列里）：future.cancel() 成功，直接标记 canceled
        - 若 job 已在运行：仅打标记，依赖 fn 协作式检查 ctx.check_canceled()
        - 若 job 已是终态：忽略，返回 False

        返回 True 表示取消请求被接受（不代表已停止）。
        """
        job = self._store.get(jid)
        if job is None:
            return False
        if job["status"] in _TERMINAL:
            return False

        with self._lock:
            self._canceled.add(jid)
            fut = self._futures.get(jid)

        if fut is not None:
            # 尝试取消尚未启动的 future（已启动的返回 False，不影响）
            fut.cancel()

        # 若还在 created/queued（未启动），直接标记 canceled
        if job["status"] in (STATUS_CREATED, STATUS_QUEUED):
            self._store.mark_canceled(jid)
            log.info("[job %s] canceled before start", jid)

        return True

    # ── 查询 ────────────────────────────────────────────────────────────────

    def get_status(self, jid: str) -> Optional[Dict[str, Any]]:
        return self._store.get(jid)

    def list_jobs(self, active_only: bool = False) -> List[Dict[str, Any]]:
        if active_only:
            return self._store.list_active(self._sid)
        return self._store.list_by_session(self._sid)

    @property
    def session_id(self) -> str:
        return self._sid

    # ── 生命周期 ─────────────────────────────────────────────────────────────

    def shutdown(self, wait: bool = True) -> None:
        """会话销毁时调用。取消所有排队中的任务，等待运行中的完成。"""
        try:
            self._pool.shutdown(wait=wait, cancel_futures=True)
            log.info("[job] runner shutdown (session=%s)", self._sid)
        except Exception:
            log.exception("[job] shutdown error")


# ── A6 骨架验证用的空任务 ──────────────────────────────────────────────────
# B 阶段会替换为真实的 Excel 解析 / PPT 生成 / Prophet 预测

def empty_job(ctx: JobContext, duration: float = 0.3) -> Dict[str, Any]:
    """A6 骨架验证任务：模拟一个会报进度的短任务。

    - duration: 总时长（秒）
    - 每 0.05s 上报一次进度，期间检查取消
    - 返回 {"duration": ..., "ticks": N}
    """
    ticks = 0
    steps = max(1, int(duration / 0.05))
    for i in range(steps + 1):
        ctx.check_canceled()
        pct = int(i * 100 / steps)
        ctx.set_progress(pct)
        ticks += 1
        time.sleep(0.05)
    return {"duration": duration, "ticks": ticks}
