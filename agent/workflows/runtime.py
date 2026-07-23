"""Process-local owner for durable Workflow schedulers and node executors."""
from __future__ import annotations

import json
import threading
from typing import Any, Mapping

from data.workflow_run_store import WorkflowRunStore, WorkflowRunStoreError
from data.workflow_store import WorkflowStore, WorkflowStoreError
from data.workspace import workspace_manager

from .models import WorkflowContractError, WorkflowErrorCode
from .scheduler import WorkflowScheduler


def _bounded_materials(materials: Mapping[str, Any], limit: int = 12000) -> str:
    text = json.dumps(materials, ensure_ascii=False, default=str, indent=2)
    if len(text) <= limit:
        return text
    return text[:limit] + "\n[materials truncated]"


class WorkflowRuntime:
    def __init__(self, session_id: str):
        from api.state import session_manager

        runtime = workspace_manager.get(session_id)
        if runtime is None:
            raise WorkflowContractError(
                WorkflowErrorCode.RESOURCE_NOT_FOUND,
                "no workspace is mounted for this session",
            )
        self.session_id = session_id
        self.workspace = runtime
        self.session = session_manager.get_or_create(session_id)
        db_path = runtime.meta_dir / "workflows.sqlite3"
        self.workflow_store = WorkflowStore(db_path, runtime.workspace_id)
        self.run_store = WorkflowRunStore(db_path, runtime.workspace_id)
        self.scheduler = WorkflowScheduler(
            workflow_store=self.workflow_store,
            run_store=self.run_store,
            job_runner=self.session.job_runner,
            executor=self._execute_node,
        )

    def _execute_node(self, node: dict, materials: dict, _ctx) -> dict[str, Any]:
        from api.chat import _build_agent

        profile = self.workflow_store.get_agent_profile(node["agent_profile_id"])
        if profile is None:
            raise RuntimeError(f"agent profile not found: {node['agent_profile_id']}")
        agent = _build_agent(
            self.session,
            workspace_id=self.workspace.workspace_id,
        )
        output_names = list(node.get("output_contract") or [])
        prompt = (
            f"Workflow node: {node['node_id']}\n"
            f"Required outputs: {', '.join(output_names) or 'result'}\n\n"
            "Complete only this workflow node using the supplied materials. "
            "Return a concise, evidence-based result. Do not change the workflow.\n\n"
            "Materials:\n"
            + _bounded_materials(materials)
        )
        result = agent._run_delegated_llm(
            member={
                "role": profile["role"],
                "instructions": profile["instructions"],
            },
            prompt=prompt,
            timeout_seconds=300,
            max_tokens=2000,
        )
        content = str(result.get("content") or "").strip()
        outputs = {
            output_name: content
            for output_name in output_names
        } or {"result": content}
        usage = result.get("usage")
        if isinstance(usage, Mapping):
            outputs["__workflow_usage__"] = dict(usage)
        return outputs

    def delete_run(self, run_id: str) -> dict[str, Any]:
        if self.workspace.permission != "read_write":
            raise WorkflowContractError(
                WorkflowErrorCode.PERMISSION_DENIED,
                "workspace is mounted read-only",
            )
        run = self.run_store.get_run(run_id)
        if run is None:
            raise WorkflowContractError(
                WorkflowErrorCode.RESOURCE_NOT_FOUND,
                f"workflow run not found: {run_id}",
            )
        if run["status"] not in {"canceled", "succeeded", "failed"}:
            raise WorkflowContractError(
                WorkflowErrorCode.VERSION_CONFLICT,
                "请先取消仍在运行的 Workflow Run",
            )
        job_ids = [
            str(node.get("job_id") or "")
            for node in self.run_store.list_node_runs(run_id)
            if str(node.get("job_id") or "")
        ]
        active_jobs = [
            job_id for job_id in job_ids
            if (self.session.job_runner.get_status_for_session(
                str(run["session_id"]), job_id
            ) or {}).get("status") not in {None, "succeeded", "failed", "canceled"}
        ]
        if active_jobs:
            raise WorkflowContractError(
                WorkflowErrorCode.VERSION_CONFLICT,
                "请等待节点 Job 结束后再删除：" + ", ".join(active_jobs),
            )
        for job_id in job_ids:
            if str(run["session_id"]) == self.session_id:
                self.session.job_runner.remove_terminal_listeners(job_id)
        try:
            result = self.run_store.delete_run_cascade(run_id)
        except WorkflowRunStoreError as exc:
            raise WorkflowContractError(
                WorkflowErrorCode.VERSION_CONFLICT, str(exc),
            ) from exc
        if result is None:
            raise WorkflowContractError(
                WorkflowErrorCode.RESOURCE_NOT_FOUND,
                f"workflow run not found: {run_id}",
            )
        deleted_jobs = self.session.job_runner.purge_terminal_for_session(
            result.pop("session_id"), result.pop("job_ids"),
        )
        result["deleted"]["jobs"] = deleted_jobs
        return result

    def delete_workflow(self, workflow_id: str) -> dict[str, Any]:
        if self.workspace.permission != "read_write":
            raise WorkflowContractError(
                WorkflowErrorCode.PERMISSION_DENIED,
                "workspace is mounted read-only",
            )
        plan = self.workflow_store.workflow_delete_plan(workflow_id)
        if plan is None:
            raise WorkflowContractError(
                WorkflowErrorCode.RESOURCE_NOT_FOUND,
                f"workflow not found: {workflow_id}",
            )
        if plan["active_run_ids"]:
            raise WorkflowContractError(
                WorkflowErrorCode.VERSION_CONFLICT,
                "请先取消仍在运行的 Workflow Run："
                + ", ".join(plan["active_run_ids"]),
            )
        active_jobs = []
        for session_id, job_ids in plan["jobs_by_session"].items():
            for job_id in job_ids:
                job = self.session.job_runner.get_status_for_session(session_id, job_id)
                if job and job.get("status") not in {"succeeded", "failed", "canceled"}:
                    active_jobs.append(job_id)
        if active_jobs:
            raise WorkflowContractError(
                WorkflowErrorCode.VERSION_CONFLICT,
                "请等待节点 Job 结束后再删除：" + ", ".join(active_jobs),
            )
        for job_id in plan["jobs_by_session"].get(self.session_id, []):
            self.session.job_runner.remove_terminal_listeners(job_id)
        try:
            result = self.workflow_store.delete_workflow_cascade(workflow_id)
        except WorkflowStoreError as exc:
            raise WorkflowContractError(
                WorkflowErrorCode.VERSION_CONFLICT, str(exc),
            ) from exc
        if result is None:
            raise WorkflowContractError(
                WorkflowErrorCode.RESOURCE_NOT_FOUND,
                f"workflow not found: {workflow_id}",
            )
        deleted_jobs = 0
        for session_id, job_ids in result.pop("jobs_by_session", {}).items():
            deleted_jobs += self.session.job_runner.purge_terminal_for_session(
                session_id, job_ids,
            )
        result["deleted"]["jobs"] = deleted_jobs
        return result

    def close(self) -> None:
        self.run_store.close()
        self.workflow_store.close()


class WorkflowRuntimeManager:
    """Keep callback-owning schedulers alive while their process is running."""

    def __init__(self):
        self._by_session: dict[str, WorkflowRuntime] = {}
        self._lock = threading.RLock()

    def get(self, session_id: str) -> WorkflowRuntime:
        with self._lock:
            current = self._by_session.get(session_id)
            workspace_id = workspace_manager.workspace_id_for_session(session_id)
            if current is not None and current.workspace.workspace_id == workspace_id:
                return current
            if current is not None:
                current.close()
            created = WorkflowRuntime(session_id)
            self._by_session[session_id] = created
            return created

    def close_session(self, session_id: str) -> None:
        with self._lock:
            runtime = self._by_session.pop(session_id, None)
        if runtime is not None:
            runtime.close()


workflow_runtime_manager = WorkflowRuntimeManager()
