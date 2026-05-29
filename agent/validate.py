#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Pre-flight validation of tool call arguments.

Runs BEFORE the tool dispatch, so dangerous inputs (write SQL,
malformed schemas) never reach the underlying executor.

Centralized here so:
  - The "what's blocked" policy lives in one place
  - Tests can exercise the rules without spinning up an LLM
  - Both BusinessAgent and any future bypass path (e.g. /sql fast path)
    can apply the same guards
"""
from typing import Any, Dict, Optional

# Tool names whose JSON args carry a `sql` field that runs against the data source.
SQL_TOOLS = {"create_analysis_table", "query_data", "generate_chart", "run_analysis"}

# Lowercase substring patterns blocked in any SQL_TOOLS call. The trailing space
# / "create_table" prefix avoids false positives on identifiers like "altered_at"
# or columns containing "update".
SQL_BLOCKED_WRITES = (
    "drop ", "delete ", "truncate ", "insert ", "update ", "alter ",
    "create table", "create index",
)


def validate_tool_args(name: str, args: Dict[str, Any]) -> Optional[str]:
    """Return an error string if args are obviously invalid, else None.

    Policy:
      - SQL_TOOLS: `sql` is required, must start with SELECT/WITH, no write keywords
      - run_analysis: analysis_name + target_column required
      - propose_ppt_outline / generate_ppt: `slides` (if present) must be a list
      - propose_dashboard_outline / generate_dashboard: `widgets` (if present) must be a list
    """
    if name in SQL_TOOLS:
        sql = args.get("sql", "").strip().lower()
        if not sql:
            return f"'{name}' requires a non-empty 'sql' argument."
        if not sql.startswith("select") and not sql.startswith("with"):
            return f"'{name}' only accepts SELECT/WITH queries. Got: {sql[:60]}"
        for kw in SQL_BLOCKED_WRITES:
            if kw in sql:
                return f"'{name}' blocked: write keyword '{kw.strip()}' detected in SQL."

    if name == "run_analysis":
        if not args.get("analysis_name"):
            return "'run_analysis' requires 'analysis_name'."
        if not args.get("target_column"):
            return "'run_analysis' requires 'target_column'."

    if name in ("propose_ppt_outline", "generate_ppt"):
        slides = args.get("slides")
        if slides is not None and not isinstance(slides, list):
            return f"'{name}': 'slides' must be a list."

    if name in ("propose_dashboard_outline", "generate_dashboard"):
        widgets = args.get("widgets")
        if widgets is not None and not isinstance(widgets, list):
            return f"'{name}': 'widgets' must be a list."

    return None
