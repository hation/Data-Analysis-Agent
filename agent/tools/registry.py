# -*- coding: utf-8 -*-
"""Single source of truth for built-in tool runtime policy.

JSON schemas remain in ``tools/schemas.py`` because they are prompt-facing and
comparatively large. Everything that controls *when and how* a tool runs lives
here: exposure, data requirements, concurrency, and future JobRunner policy.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Literal

ToolCategory = Literal["read", "analysis", "write", "output", "interaction"]
ExecutionMode = Literal["sync", "auto", "job"]


@dataclass(frozen=True)
class ToolSpec:
    name: str
    category: ToolCategory
    default_exposed: bool = True
    commands: frozenset[str] = frozenset()
    requires_data_source: bool = False
    concurrency_safe: bool = False
    execution_mode: ExecutionMode = "sync"
    job_threshold: str = ""
    requires_runtime: bool = False
    requires_workspace: bool = False

    def is_exposed(self, command: str, has_data_source: bool, has_workspace: bool = False) -> bool:
        if self.requires_data_source and not has_data_source:
            return False
        if self.requires_workspace and not has_workspace:
            return False
        return self.default_exposed or command in self.commands


class ToolRegistry:
    def __init__(self, specs: Iterable[ToolSpec]) -> None:
        self._specs: dict[str, ToolSpec] = {}
        for spec in specs:
            if not spec.name:
                raise ValueError("tool name cannot be empty")
            if spec.name in self._specs:
                raise ValueError(f"duplicate tool spec: {spec.name}")
            if spec.execution_mode == "auto" and not spec.job_threshold:
                raise ValueError(f"auto tool requires job_threshold: {spec.name}")
            self._specs[spec.name] = spec

    def get(self, name: str) -> ToolSpec | None:
        return self._specs.get(name)

    def all(self) -> tuple[ToolSpec, ...]:
        return tuple(self._specs.values())

    def names(self) -> frozenset[str]:
        return frozenset(self._specs)

    def exposed_names(
        self, command: str = "", has_data_source: bool = False, has_workspace: bool = False,
    ) -> set[str]:
        return {
            spec.name
            for spec in self._specs.values()
            if spec.is_exposed(command or "", has_data_source, has_workspace)
        }

    def validate_schema_names(self, schemas: Iterable[dict]) -> None:
        schema_names = {
            ((schema.get("function") or {}).get("name") or "").strip()
            for schema in schemas
        }
        schema_names.discard("")
        missing_specs = schema_names - self.names()
        missing_schemas = self.names() - schema_names
        if missing_specs or missing_schemas:
            details = []
            if missing_specs:
                details.append(f"missing specs={sorted(missing_specs)}")
            if missing_schemas:
                details.append(f"missing schemas={sorted(missing_schemas)}")
            raise ValueError("tool registry/schema mismatch: " + "; ".join(details))


def _spec(
    name: str,
    category: ToolCategory,
    *,
    commands: tuple[str, ...] = (),
    default_exposed: bool = True,
    requires_data_source: bool = False,
    concurrency_safe: bool = False,
    execution_mode: ExecutionMode = "sync",
    job_threshold: str = "",
    requires_runtime: bool = False,
    requires_workspace: bool = False,
) -> ToolSpec:
    return ToolSpec(
        name=name,
        category=category,
        default_exposed=default_exposed,
        commands=frozenset(commands),
        requires_data_source=requires_data_source,
        concurrency_safe=concurrency_safe,
        execution_mode=execution_mode,
        job_threshold=job_threshold,
        requires_runtime=requires_runtime,
        requires_workspace=requires_workspace,
    )


BUILTIN_TOOL_REGISTRY = ToolRegistry([
    _spec("workspace_status", "read", requires_runtime=True),
    _spec("query_knowledge", "read", concurrency_safe=True),
    _spec("get_schema", "read", requires_data_source=True),
    _spec("get_table_detail", "read", requires_data_source=True, concurrency_safe=True),
    _spec("create_analysis_table", "write", requires_data_source=True, requires_runtime=True),
    _spec("query_data", "read", requires_data_source=True, requires_runtime=True),
    _spec(
        "run_analysis", "analysis", requires_data_source=True,
        execution_mode="auto", job_threshold="analysis_rows_gte_1000", requires_runtime=True,
    ),
    _spec("select_chart", "analysis", requires_data_source=True, concurrency_safe=True),
    _spec("generate_chart", "output", requires_data_source=True, requires_runtime=True),
    _spec("profile_data", "analysis", requires_data_source=True),
    _spec("clean_data", "write", requires_data_source=True, requires_runtime=True),
    _spec(
        "export_excel", "output", default_exposed=False,
        commands=("excel_confirm",), execution_mode="auto",
        job_threshold="excel_bytes_gt_5mb", requires_runtime=True,
    ),
    _spec("export_report", "output", default_exposed=False, commands=("report_confirm",), requires_runtime=True),
    _spec(
        "propose_excel_export", "interaction", default_exposed=False,
        commands=("export", "excel_revise"),
    ),
    _spec(
        "propose_report_outline", "interaction", default_exposed=False,
        commands=("report", "report_revise"),
    ),
    _spec(
        "propose_ppt_outline", "interaction", default_exposed=False,
        commands=("ppt", "ppt_revise"),
    ),
    _spec(
        "generate_ppt", "output", default_exposed=False,
        commands=("ppt_confirm",), execution_mode="auto",
        job_threshold="ppt_slides_gt_5", requires_runtime=True,
    ),
    _spec("set_ppt_color_scheme", "write"),
    _spec(
        "propose_dashboard_outline", "interaction", default_exposed=False,
        commands=("dashboard", "dashboard_revise"),
    ),
    _spec(
        "generate_dashboard", "output", default_exposed=False,
        commands=("dashboard_confirm",), requires_runtime=True,
    ),
    _spec("ask_user", "interaction"),
    _spec("workspace_glob", "read", requires_runtime=True),
    _spec("workspace_grep", "read", requires_runtime=True),
    _spec("workspace_read_file", "read", requires_runtime=True),
    _spec("workspace_write_file", "write", requires_runtime=True),
    _spec("workspace_edit_file", "write", requires_runtime=True),
    _spec("workspace_command", "read", requires_runtime=True),
    _spec("structured_output", "interaction", default_exposed=False),
    _spec("load_analysis_skill", "read"),
    _spec("task_create", "write", requires_runtime=True, requires_workspace=True),
    _spec("task_get", "read", requires_runtime=True, requires_workspace=True),
    _spec("task_list", "read", requires_runtime=True, requires_workspace=True),
    _spec("task_update", "write", requires_runtime=True, requires_workspace=True),
    _spec("team_create", "write", requires_runtime=True, requires_workspace=True),
    _spec("team_delete", "write", requires_runtime=True, requires_workspace=True),
    _spec("send_message", "write", requires_runtime=True, requires_workspace=True),
    _spec("agent_delegate", "analysis", requires_runtime=True, requires_workspace=True),
    _spec("workspace_checkpoint", "write", requires_runtime=True, requires_workspace=True),
    _spec("plan_complete", "interaction", default_exposed=False),
])


def get_tool_spec(name: str) -> ToolSpec | None:
    return BUILTIN_TOOL_REGISTRY.get(name)


def is_job_eligible(name: str) -> bool:
    spec = get_tool_spec(name)
    return bool(spec and spec.execution_mode in {"auto", "job"})
