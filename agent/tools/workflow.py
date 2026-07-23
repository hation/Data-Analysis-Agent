"""Conversation-facing tools for published Workflows and durable Runs."""
from __future__ import annotations

import re
import time
from typing import Any, Mapping

from agent.workflows.models import WorkflowContractError, WorkflowErrorCode
from agent.workflows.runtime import workflow_runtime_manager
from agent.workflows.service import WorkflowService


_CREATE_VERBS = ("创建", "新建", "生成", "搭建", "create", "build")


def parse_workflow_create_request(message: str) -> dict[str, str] | None:
    """Return deterministic create arguments for an explicit chat request."""
    text = str(message or "").strip()
    lowered = text.lower()
    if not text or ("workflow" not in lowered and "工作流" not in text):
        return None
    if any(token in text for token in ("不要创建", "别创建", "无需创建")):
        return None
    if any(token in text for token in ("如何创建", "怎么创建", "怎样创建", "为什么创建")):
        return None
    verb = next((item for item in _CREATE_VERBS if item in lowered), "")
    if not verb:
        return None

    mode = "full_auto"
    if any(token in lowered for token in ("key_approval", "关键审批", "审批模式")):
        mode = "key_approval"
    elif any(token in lowered for token in ("exception_review", "异常复核", "异常审核")):
        mode = "exception_review"

    workflow_pos = lowered.find("workflow")
    if workflow_pos < 0:
        workflow_pos = text.find("工作流")
    verb_pos = lowered.find(verb)
    candidate = text[verb_pos + len(verb):workflow_pos].strip(" ：:，,。")
    candidate = re.sub(r"^(?:一个|一套|新的?)\s*", "", candidate).strip()
    name = f"{candidate} Workflow" if candidate else "经营分析 Workflow"
    return {
        "name": name,
        "mode": mode,
        "source_key": "source_snapshot",
    }


def _workflow_mode(value: str) -> str:
    mode = str(value or "full_auto").strip() or "full_auto"
    aliases = {
        "auto": "full_auto",
        "自动": "full_auto",
        "全自动": "full_auto",
        "approval": "key_approval",
        "审批": "key_approval",
        "关键审批": "key_approval",
        "exception": "exception_review",
        "异常": "exception_review",
        "异常复核": "exception_review",
    }
    mode = aliases.get(mode, mode)
    if mode not in {"full_auto", "key_approval", "exception_review"}:
        raise WorkflowContractError(
            WorkflowErrorCode.GRAPH_INVALID,
            "workflow mode must be full_auto, key_approval, or exception_review",
        )
    return mode


def _create_template_graph(profile_ids: Mapping[str, str], *, mode: str, source_key: str) -> dict[str, Any]:
    approval_edge_type = "approval" if mode == "key_approval" else "auto"
    return {
        "run_policy": {"mode": mode},
        "entry_node_ids": ["inspect_data"],
        "nodes": [
            {
                "node_id": "inspect_data",
                "type": "agent",
                "agent_profile_id": profile_ids["inspect"],
                "input_contract": [source_key],
                "output_contract": ["data_quality_report", "metric_scope"],
            },
            {
                "node_id": "analyze_metrics",
                "type": "agent",
                "agent_profile_id": profile_ids["metrics"],
                "input_contract": ["metric_scope"],
                "output_contract": ["metric_analysis"],
            },
            {
                "node_id": "analyze_anomalies",
                "type": "agent",
                "agent_profile_id": profile_ids["anomalies"],
                "input_contract": ["metric_scope"],
                "output_contract": ["anomaly_analysis"],
            },
            {
                "node_id": "verify_findings",
                "type": "agent",
                "agent_profile_id": profile_ids["reviewer"],
                "join_policy": "all_success",
                "input_contract": ["metric_analysis", "anomaly_analysis"],
                "output_contract": ["verification_report"],
            },
            {
                "node_id": "generate_report",
                "type": "agent",
                "agent_profile_id": profile_ids["reporter"],
                "input_contract": ["verification_report"],
                "output_contract": ["operating_report"],
            },
        ],
        "edges": [
            {"edge_id": "inspect-to-metrics", "from_node": "inspect_data", "to_node": "analyze_metrics", "type": "auto"},
            {"edge_id": "inspect-to-anomalies", "from_node": "inspect_data", "to_node": "analyze_anomalies", "type": "auto"},
            {"edge_id": "metrics-to-verify", "from_node": "analyze_metrics", "to_node": "verify_findings", "type": "auto"},
            {"edge_id": "anomalies-to-verify", "from_node": "analyze_anomalies", "to_node": "verify_findings", "type": "auto"},
            {"edge_id": "verify-to-report", "from_node": "verify_findings", "to_node": "generate_report", "type": approval_edge_type},
            {"edge_id": "verify-retry", "from_node": "verify_findings", "to_node": "analyze_metrics", "type": "retry_loop", "max_iterations": 2},
        ],
        "limits": {
            "max_run_minutes": 120,
            "max_total_node_runs": 30,
        },
    }


def workflow_create(
    session_id: str,
    *,
    name: str = "经营分析 Workflow",
    description: str = "",
    mode: str = "full_auto",
    source_key: str = "source_snapshot",
) -> dict[str, Any]:
    mode = _workflow_mode(mode)
    source_key = str(source_key or "source_snapshot").strip() or "source_snapshot"
    workflow_name = str(name or "经营分析 Workflow").strip() or "经营分析 Workflow"
    workflow_description = str(description or "").strip() or f"{mode} 模式的团队分析模板"
    suffix = f"{int(time.time() * 1000):x}"
    specs = [
        ("inspect", "数据检查员", "data_inspector", "识别数据表、字段质量、可用指标范围，输出 data_quality_report 与 metric_scope。", ["get_schema", "query_data", "read_tool_result"]),
        ("metrics", "指标分析师", "metric_analyst", "围绕业务目标执行 SQL/指标分析，输出 metric_analysis。", ["get_schema", "query_data", "read_tool_result"]),
        ("anomalies", "异常分析师", "anomaly_analyst", "发现波动、异常与可解释原因，输出 anomaly_analysis。", ["get_schema", "query_data", "read_tool_result"]),
        ("reviewer", "结论复核员", "finding_reviewer", "交叉检查指标分析与异常分析，输出 verification_report。", ["read_tool_result"]),
        ("reporter", "报告编辑", "report_editor", "把复核后的发现整理成可读经营报告，输出 operating_report。", ["read_tool_result"]),
    ]
    with WorkflowService.for_session(session_id) as service:
        profile_ids: dict[str, str] = {}
        for key, profile_name, role, instructions, allowed_tools in specs:
            profile = service.create_agent_profile(
                key=f"conversation_workflow_{key}_{suffix}",
                name=profile_name,
                role=role,
                instructions=instructions,
                allowed_tools=allowed_tools,
                model_policy="inherit",
                created_by="conversation",
            )
            profile_ids[key] = str(profile["id"])
        workflow = service.create_workflow(
            name=workflow_name,
            description=workflow_description,
            graph=_create_template_graph(profile_ids, mode=mode, source_key=source_key),
            input_schema={
                "type": "object",
                "properties": {source_key: {"type": "string"}},
                "required": [source_key],
            },
            output_schema={
                "type": "object",
                "properties": {"operating_report": {"type": "string"}},
                "required": ["operating_report"],
            },
            created_by="conversation",
        )
        validation = service.validate_draft(workflow["id"])
        published = service.publish(workflow["id"], published_by="conversation")
    return {
        "workflow": {
            "id": workflow["id"],
            "name": workflow["name"],
            "description": workflow["description"],
            "mode": mode,
            "source_key": source_key,
        },
        "version": published["version"],
        "validation": validation,
        "profile_ids": profile_ids,
        "next_actions": [
            "Use workflow_start with workflow_id or version_id to run it.",
            "Open the Teams panel Workflow tab to inspect the DAG, approvals, and materials.",
        ],
    }


def workflow_list(session_id: str) -> dict[str, Any]:
    workflows = []
    with WorkflowService.for_session(session_id) as service:
        for workflow in service.list_workflows():
            version_id = str(workflow.get("current_version_id") or "")
            if not version_id:
                continue
            version = service.store.get_version(version_id)
            workflows.append({
                "id": workflow["id"],
                "name": workflow["name"],
                "description": workflow["description"],
                "version_id": version_id,
                "version_number": version.get("version_number") if version else None,
            })
    return {"workflows": workflows, "count": len(workflows)}


def _resolve_version(runtime, workflow_ref: str) -> str:
    reference = str(workflow_ref or "").strip()
    if not reference:
        raise WorkflowContractError(
            WorkflowErrorCode.RESOURCE_NOT_FOUND,
            "workflow id, name, or version id is required",
        )
    version = runtime.workflow_store.get_version(reference)
    if version is not None:
        return version["id"]
    matches = [
        workflow
        for workflow in runtime.workflow_store.list_workflows()
        if workflow["id"] == reference or workflow["name"] == reference
    ]
    if len(matches) != 1 or not matches[0].get("current_version_id"):
        raise WorkflowContractError(
            WorkflowErrorCode.RESOURCE_NOT_FOUND,
            f"published workflow not found or ambiguous: {reference}",
        )
    return str(matches[0]["current_version_id"])


def workflow_start(
    session_id: str,
    workflow_ref: str,
    inputs: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    runtime = workflow_runtime_manager.get(session_id)
    return runtime.scheduler.start(
        workflow_version_id=_resolve_version(runtime, workflow_ref),
        session_id=session_id,
        inputs=inputs or {},
        started_by="conversation",
    )


def workflow_status(session_id: str, run_id: str) -> dict[str, Any]:
    runtime = workflow_runtime_manager.get(session_id)
    return runtime.scheduler.advance(str(run_id or "").strip())


def execute_workflow_tool(
    name: str,
    session_id: str,
    args: Mapping[str, Any],
) -> dict[str, Any]:
    if name == "workflow_create":
        return workflow_create(
            session_id,
            name=str(args.get("name") or "经营分析 Workflow"),
            description=str(args.get("description") or ""),
            mode=str(args.get("mode") or "full_auto"),
            source_key=str(args.get("source_key") or args.get("sourceKey") or "source_snapshot"),
        )
    if name == "workflow_list":
        return workflow_list(session_id)
    if name == "workflow_start":
        inputs = args.get("inputs")
        return workflow_start(
            session_id,
            str(
                args.get("workflow_version_id")
                or args.get("workflow_id")
                or args.get("name")
                or ""
            ),
            inputs if isinstance(inputs, Mapping) else {},
        )
    if name == "workflow_status":
        return workflow_status(session_id, str(args.get("run_id") or ""))
    raise ValueError(f"unknown workflow tool: {name}")
