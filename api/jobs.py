#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Blueprint: job management — 任务列表/详情/取消（A6 骨架）。

路由：
  GET   /api/session/<sid>/jobs              — 列出会话内的任务（?active=true 只看运行中）
  GET   /api/session/<sid>/jobs/<jid>        — 查询单个任务状态
  POST  /api/session/<sid>/jobs/<jid>/cancel — 请求取消任务
  POST  /api/session/<sid>/jobs/test         — A6 骨架验证：提交一个空任务（B 阶段移除）

B 阶段接入后，job 的创建由 Agent 工具层触发（Excel 解析 / PPT 生成 / Prophet），
不再需要 /test 端点。前端通过 SSE 或轮询 /jobs 接口获取进度。
"""
import logging
from flask import Blueprint, request, jsonify

from .state import session_manager

log = logging.getLogger(__name__)

bp = Blueprint("jobs", __name__)


def _job_to_dict(job) -> dict:
    """把 JobsStore 返回的 row dict 标准化为 JSON 响应。"""
    return {
        "id": job["id"],
        "session_id": job["session_id"],
        "type": job["type"],
        "status": job["status"],
        "progress": job.get("progress", 0),
        "result": job.get("result"),
        "error": job.get("error"),
        "created_at": job.get("created_at"),
        "started_at": job.get("started_at"),
        "finished_at": job.get("finished_at"),
    }


@bp.get("/api/session/<sid>/jobs")
def list_jobs(sid: str):
    """列出会话内的任务。?active=true 只返回未完成的。"""
    sess = session_manager.get_or_create(sid)
    active_only = request.args.get("active", "").lower() in ("1", "true", "yes")
    jobs = sess.job_runner.list_jobs(active_only=active_only)
    return jsonify({"jobs": [_job_to_dict(j) for j in jobs]})


@bp.get("/api/session/<sid>/jobs/<jid>")
def get_job(sid: str, jid: str):
    """查询单个任务状态。"""
    sess = session_manager.get_or_create(sid)
    job = sess.job_runner.get_status(jid)
    if job is None:
        return jsonify({"error": "job not found", "id": jid}), 404
    return jsonify({"job": _job_to_dict(job)})


@bp.post("/api/session/<sid>/jobs/<jid>/cancel")
def cancel_job(sid: str, jid: str):
    """请求取消任务。返回 accepted=true 表示请求已受理。

    注意：Python 无法强行中断运行中的线程，job 函数需协作式检查 ctx.check_canceled()。
    若 job 已是终态（done/error/canceled），返回 409。
    """
    sess = session_manager.get_or_create(sid)
    job = sess.job_runner.get_status(jid)
    if job is None:
        return jsonify({"error": "job not found", "id": jid}), 404

    accepted = sess.job_runner.cancel(jid)
    if not accepted:
        return jsonify({
            "error": "cannot cancel terminal job",
            "id": jid,
            "status": job["status"],
        }), 409

    return jsonify({"id": jid, "accepted": True, "status": "canceled"})


@bp.post("/api/session/<sid>/jobs/test")
def create_test_job(sid: str):
    """A6 骨架验证：提交一个空任务，验证线程池 + 状态流转 + 进度上报。

    B 阶段接入真实业务后移除此端点。
    可选 body: {"duration": 0.5} 控制空任务时长。
    """
    sess = session_manager.get_or_create(sid)
    body = request.get_json(silent=True) or {}
    duration = float(body.get("duration", 0.3))

    from agent.jobs import empty_job

    # 用 partial 把 duration 绑定到 empty_job 的第二参数
    from functools import partial

    jid = sess.job_runner.create(
        lambda ctx, d=duration: empty_job(ctx, d),
        job_type="test_empty",
    )
    return jsonify({"id": jid, "type": "test_empty", "status": "queued"})
