# -*- coding: utf-8 -*-
"""Dynamic tool exposure for each conversation turn."""
from __future__ import annotations

from copy import deepcopy

from .registry import BUILTIN_TOOL_REGISTRY


def _tool_name(schema: dict) -> str:
    return ((schema.get("function") or {}).get("name") or "").strip()


def filter_tools_for_turn(
    tools: list[dict],
    *,
    command: str = "",
    has_data_source: bool = False,
    has_workspace: bool = False,
    include_mcp: bool = True,
) -> list[dict]:
    """Return only tools useful for the current turn.

    Output-generation tools stay hidden unless their slash command is active.
    Data tools are hidden when no data source is connected, while knowledge,
    clarification, and confirm tools can still work.
    """
    allowed = BUILTIN_TOOL_REGISTRY.exposed_names(
        command=command or "",
        has_data_source=has_data_source,
        has_workspace=has_workspace,
    )

    filtered: list[dict] = []
    for schema in tools:
        name = _tool_name(schema)
        if not name:
            continue
        if name.startswith("mcp__"):
            if include_mcp:
                filtered.append(schema)
            continue
        if name in allowed:
            filtered.append(schema)

    # Copy so callers can safely tweak descriptions later without mutating the
    # global AGENT_TOOLS list.
    return deepcopy(filtered)
