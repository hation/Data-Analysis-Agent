"""Stable WF0 contracts for deterministic workflow execution."""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any, Mapping


class WorkflowErrorCode(str, Enum):
    GRAPH_INVALID = "workflow_graph_invalid"
    INVALID_TRANSITION = "workflow_invalid_transition"
    RESOURCE_NOT_FOUND = "workflow_resource_not_found"
    WORKSPACE_MISMATCH = "workflow_workspace_mismatch"
    VERSION_CONFLICT = "workflow_version_conflict"
    IDEMPOTENCY_CONFLICT = "workflow_idempotency_conflict"
    PERMISSION_DENIED = "workflow_permission_denied"
    RUN_NOT_RECOVERABLE = "workflow_run_not_recoverable"
    ITERATION_LIMIT_REACHED = "workflow_iteration_limit_reached"
    CONCURRENCY_LIMIT_REACHED = "workflow_concurrency_limit_reached"
    OUTPUT_CONTRACT_VIOLATION = "workflow_output_contract_violation"
    APPROVAL_ALREADY_DECIDED = "workflow_approval_already_decided"


class WorkflowContractError(ValueError):
    """A stable machine-readable workflow contract failure."""

    def __init__(self, code: WorkflowErrorCode, message: str):
        super().__init__(message)
        self.code = code


class RunStatus(str, Enum):
    CREATED = "created"
    RUNNING = "running"
    WAITING_APPROVAL = "waiting_approval"
    PAUSED = "paused"
    CANCELING = "canceling"
    CANCELED = "canceled"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


class NodeRunStatus(str, Enum):
    PENDING = "pending"
    READY = "ready"
    QUEUED = "queued"
    RUNNING = "running"
    OUTPUT_READY = "output_ready"
    WAITING_APPROVAL = "waiting_approval"
    SUCCEEDED = "succeeded"
    REJECTED = "rejected"
    SKIPPED = "skipped"
    FAILED = "failed"
    CANCELED = "canceled"


class ApprovalStatus(str, Enum):
    PENDING = "pending"
    DECIDED = "decided"
    CANCELED = "canceled"


class EdgeType(str, Enum):
    AUTO = "auto"
    APPROVAL = "approval"
    RETRY_LOOP = "retry_loop"


class WorkflowRunMode(str, Enum):
    FULL_AUTO = "full_auto"
    KEY_APPROVAL = "key_approval"
    EXCEPTION_REVIEW = "exception_review"


RUN_TERMINAL_STATUSES = frozenset({
    RunStatus.CANCELED,
    RunStatus.SUCCEEDED,
    RunStatus.FAILED,
})

NODE_RUN_TERMINAL_STATUSES = frozenset({
    NodeRunStatus.SUCCEEDED,
    NodeRunStatus.REJECTED,
    NodeRunStatus.SKIPPED,
    NodeRunStatus.FAILED,
    NodeRunStatus.CANCELED,
})

APPROVAL_TERMINAL_STATUSES = frozenset({
    ApprovalStatus.DECIDED,
    ApprovalStatus.CANCELED,
})

RUN_TRANSITIONS = {
    RunStatus.CREATED: frozenset({
        RunStatus.RUNNING,
        RunStatus.CANCELING,
        RunStatus.CANCELED,
        RunStatus.FAILED,
    }),
    RunStatus.RUNNING: frozenset({
        RunStatus.WAITING_APPROVAL,
        RunStatus.PAUSED,
        RunStatus.CANCELING,
        RunStatus.SUCCEEDED,
        RunStatus.FAILED,
    }),
    RunStatus.WAITING_APPROVAL: frozenset({
        RunStatus.RUNNING,
        RunStatus.PAUSED,
        RunStatus.CANCELING,
        RunStatus.FAILED,
    }),
    RunStatus.PAUSED: frozenset({
        RunStatus.RUNNING,
        RunStatus.CANCELING,
        RunStatus.CANCELED,
        RunStatus.FAILED,
    }),
    RunStatus.CANCELING: frozenset({
        RunStatus.CANCELED,
        RunStatus.FAILED,
    }),
    RunStatus.CANCELED: frozenset(),
    RunStatus.SUCCEEDED: frozenset(),
    # A failed Run may only be reopened by the explicit manual retry path.
    # The scheduler validates that a latest failed NodeRun is selected first.
    RunStatus.FAILED: frozenset({RunStatus.RUNNING}),
}

NODE_RUN_TRANSITIONS = {
    NodeRunStatus.PENDING: frozenset({
        NodeRunStatus.READY,
        NodeRunStatus.SKIPPED,
        NodeRunStatus.CANCELED,
    }),
    NodeRunStatus.READY: frozenset({
        NodeRunStatus.QUEUED,
        NodeRunStatus.SKIPPED,
        NodeRunStatus.FAILED,
        NodeRunStatus.SKIPPED,
        NodeRunStatus.CANCELED,
    }),
    NodeRunStatus.QUEUED: frozenset({
        NodeRunStatus.RUNNING,
        NodeRunStatus.FAILED,
        NodeRunStatus.CANCELED,
    }),
    NodeRunStatus.RUNNING: frozenset({
        NodeRunStatus.OUTPUT_READY,
        NodeRunStatus.FAILED,
        NodeRunStatus.CANCELED,
    }),
    NodeRunStatus.OUTPUT_READY: frozenset({
        NodeRunStatus.WAITING_APPROVAL,
        NodeRunStatus.SUCCEEDED,
        NodeRunStatus.FAILED,
        NodeRunStatus.CANCELED,
    }),
    NodeRunStatus.WAITING_APPROVAL: frozenset({
        NodeRunStatus.SUCCEEDED,
        NodeRunStatus.REJECTED,
        NodeRunStatus.FAILED,
        NodeRunStatus.SKIPPED,
        NodeRunStatus.CANCELED,
    }),
    NodeRunStatus.SUCCEEDED: frozenset(),
    NodeRunStatus.REJECTED: frozenset(),
    NodeRunStatus.SKIPPED: frozenset(),
    NodeRunStatus.FAILED: frozenset(),
    NodeRunStatus.CANCELED: frozenset(),
}

APPROVAL_TRANSITIONS = {
    ApprovalStatus.PENDING: frozenset({
        ApprovalStatus.DECIDED,
        ApprovalStatus.CANCELED,
    }),
    ApprovalStatus.DECIDED: frozenset(),
    ApprovalStatus.CANCELED: frozenset(),
}

ALLOWED_JOIN_POLICIES = frozenset({"all_success", "all_terminal"})
ALLOWED_REJECT_POLICIES = frozenset({"fail_run", "close_branch"})
ALLOWED_NODE_TYPES = frozenset({"agent"})


def _coerce_status(value: Any, enum_type: type[Enum], label: str):
    try:
        return enum_type(value)
    except (TypeError, ValueError) as exc:
        raise WorkflowContractError(
            WorkflowErrorCode.INVALID_TRANSITION,
            f"unknown {label} status: {value}",
        ) from exc


def can_transition_run(current: RunStatus | str, target: RunStatus | str) -> bool:
    source = _coerce_status(current, RunStatus, "run")
    destination = _coerce_status(target, RunStatus, "run")
    return destination in RUN_TRANSITIONS[source]


def can_transition_node_run(
    current: NodeRunStatus | str,
    target: NodeRunStatus | str,
) -> bool:
    source = _coerce_status(current, NodeRunStatus, "node run")
    destination = _coerce_status(target, NodeRunStatus, "node run")
    return destination in NODE_RUN_TRANSITIONS[source]


def can_transition_approval(
    current: ApprovalStatus | str,
    target: ApprovalStatus | str,
) -> bool:
    source = _coerce_status(current, ApprovalStatus, "approval")
    destination = _coerce_status(target, ApprovalStatus, "approval")
    return destination in APPROVAL_TRANSITIONS[source]


@dataclass(frozen=True)
class AgentProfile:
    """An immutable workspace-scoped agent capability revision."""

    id: str
    workspace_id: str
    key: str
    revision: int
    name: str
    role: str
    instructions: str
    allowed_tools: tuple[str, ...]
    model_policy: str = "inherit"

    def __post_init__(self) -> None:
        for field_name in ("id", "workspace_id", "key", "name", "role"):
            if not str(getattr(self, field_name) or "").strip():
                raise ValueError(f"agent profile {field_name} is required")
        if self.revision < 1:
            raise ValueError("agent profile revision must be positive")
        normalized = tuple(dict.fromkeys(
            str(tool).strip() for tool in self.allowed_tools if str(tool).strip()
        ))
        if normalized != self.allowed_tools:
            object.__setattr__(self, "allowed_tools", normalized)


def _graph_error(message: str) -> WorkflowContractError:
    return WorkflowContractError(WorkflowErrorCode.GRAPH_INVALID, message)


def _required_text(item: Mapping[str, Any], key: str, label: str) -> str:
    value = str(item.get(key) or "").strip()
    if not value:
        raise _graph_error(f"{label} requires {key}")
    return value


def _validate_retry_edge(edge: Mapping[str, Any], edge_id: str) -> None:
    raw_limit = edge.get("max_iterations")
    if isinstance(raw_limit, bool) or not isinstance(raw_limit, int) or raw_limit < 1:
        raise _graph_error(
            f"retry_loop edge {edge_id} requires a positive max_iterations"
        )


def _validate_acyclic_forward_graph(
    node_ids: set[str],
    edges: list[Mapping[str, Any]],
) -> None:
    outgoing = {node_id: [] for node_id in node_ids}
    indegree = {node_id: 0 for node_id in node_ids}
    for edge in edges:
        if edge.get("type") == EdgeType.RETRY_LOOP.value:
            continue
        source = str(edge["from_node"])
        target = str(edge["to_node"])
        outgoing[source].append(target)
        indegree[target] += 1

    ready = [node_id for node_id, degree in indegree.items() if degree == 0]
    visited = 0
    while ready:
        current = ready.pop()
        visited += 1
        for target in outgoing[current]:
            indegree[target] -= 1
            if indegree[target] == 0:
                ready.append(target)
    if visited != len(node_ids):
        raise _graph_error("auto and approval edges must form an acyclic graph")


def _validate_reachable(
    node_ids: set[str],
    entries: list[str],
    edges: list[Mapping[str, Any]],
) -> None:
    outgoing = {node_id: [] for node_id in node_ids}
    for edge in edges:
        outgoing[str(edge["from_node"])].append(str(edge["to_node"]))
    reachable = set(entries)
    queue = list(entries)
    while queue:
        current = queue.pop()
        for target in outgoing[current]:
            if target not in reachable:
                reachable.add(target)
                queue.append(target)
    missing = sorted(node_ids - reachable)
    if missing:
        raise _graph_error(f"unreachable nodes: {', '.join(missing)}")


def validate_workflow_graph(graph: Mapping[str, Any]) -> dict[str, Any]:
    """Validate and return the graph without mutating caller-owned data."""
    if not isinstance(graph, Mapping):
        raise _graph_error("workflow graph must be an object")

    raw_nodes = graph.get("nodes")
    raw_edges = graph.get("edges")
    raw_entries = graph.get("entry_node_ids")
    if not isinstance(raw_nodes, list) or not raw_nodes:
        raise _graph_error("workflow graph requires at least one node")
    if not isinstance(raw_edges, list):
        raise _graph_error("workflow graph edges must be an array")
    if not isinstance(raw_entries, list) or not raw_entries:
        raise _graph_error("workflow graph requires at least one entry node")

    nodes: list[Mapping[str, Any]] = []
    node_ids: set[str] = set()
    for raw_node in raw_nodes:
        if not isinstance(raw_node, Mapping):
            raise _graph_error("each workflow node must be an object")
        node_id = _required_text(raw_node, "node_id", "workflow node")
        if node_id in node_ids:
            raise _graph_error(f"duplicate node_id: {node_id}")
        node_type = str(raw_node.get("type") or "agent")
        if node_type not in ALLOWED_NODE_TYPES:
            raise _graph_error(f"unsupported node type for {node_id}: {node_type}")
        _required_text(raw_node, "agent_profile_id", f"agent node {node_id}")
        join_policy = str(raw_node.get("join_policy") or "all_success")
        if join_policy not in ALLOWED_JOIN_POLICIES:
            raise _graph_error(f"unsupported join_policy for {node_id}: {join_policy}")
        on_reject = str(raw_node.get("on_reject") or "fail_run")
        if on_reject not in ALLOWED_REJECT_POLICIES:
            raise _graph_error(f"unsupported on_reject for {node_id}: {on_reject}")
        for contract_key in ("input_contract", "output_contract"):
            contract = raw_node.get(contract_key, [])
            if not isinstance(contract, list) or any(
                not isinstance(item, str) or not item.strip() for item in contract
            ):
                raise _graph_error(f"{node_id} {contract_key} must be a string array")
        node_ids.add(node_id)
        nodes.append(raw_node)

    entries: list[str] = []
    for value in raw_entries:
        node_id = str(value or "").strip()
        if not node_id or node_id not in node_ids:
            raise _graph_error(f"unknown entry node: {value}")
        if node_id not in entries:
            entries.append(node_id)

    edges: list[Mapping[str, Any]] = []
    edge_ids: set[str] = set()
    for raw_edge in raw_edges:
        if not isinstance(raw_edge, Mapping):
            raise _graph_error("each workflow edge must be an object")
        edge_id = _required_text(raw_edge, "edge_id", "workflow edge")
        if edge_id in edge_ids:
            raise _graph_error(f"duplicate edge_id: {edge_id}")
        source = _required_text(raw_edge, "from_node", f"edge {edge_id}")
        target = _required_text(raw_edge, "to_node", f"edge {edge_id}")
        if source not in node_ids or target not in node_ids:
            raise _graph_error(f"edge {edge_id} references an unknown node")
        try:
            edge_type = EdgeType(str(raw_edge.get("type") or EdgeType.AUTO.value))
        except ValueError as exc:
            raise _graph_error(f"unsupported edge type for {edge_id}") from exc
        if source == target:
            raise _graph_error(f"self edge is not allowed: {edge_id}")
        if edge_type is EdgeType.RETRY_LOOP:
            _validate_retry_edge(raw_edge, edge_id)
        edge_ids.add(edge_id)
        edges.append(raw_edge)

    _validate_acyclic_forward_graph(node_ids, edges)
    _validate_reachable(node_ids, entries, edges)

    for raw_node in nodes:
        max_attempts = raw_node.get("max_attempts")
        if max_attempts is not None and (
            isinstance(max_attempts, bool)
            or not isinstance(max_attempts, int)
            or max_attempts < 1
        ):
            raise _graph_error(
                f"{raw_node['node_id']} max_attempts must be a positive integer"
            )

    run_policy = graph.get("run_policy", {})
    if not isinstance(run_policy, Mapping):
        raise _graph_error("workflow run_policy must be an object")
    raw_mode = run_policy.get("mode")
    if raw_mode is not None:
        try:
            WorkflowRunMode(str(raw_mode))
        except ValueError as exc:
            raise _graph_error(
                "run_policy.mode must be full_auto, key_approval, or exception_review"
            ) from exc

    limits = graph.get("limits", {})
    if not isinstance(limits, Mapping):
        raise _graph_error("workflow limits must be an object")
    for key in ("max_run_minutes", "max_total_node_runs"):
        value = limits.get(key)
        if value is not None and (
            isinstance(value, bool) or not isinstance(value, int) or value < 1
        ):
            raise _graph_error(f"{key} must be a positive integer")

    return dict(graph)
