# -*- coding: utf-8 -*-
"""Dynamic tool exposure for each conversation turn."""
from __future__ import annotations

import logging

log = logging.getLogger(__name__)

from copy import deepcopy

from agent.activation import ActivationContext

from .registry import BUILTIN_TOOL_REGISTRY


def _tool_name(schema: dict) -> str:
    return ((schema.get("function") or {}).get("name") or "").strip()


def filter_tools_for_turn(
    tools: list[dict],
    *,
    command: str = "",
    activation: ActivationContext | None = None,
    skill_allowed_tools: frozenset[str] | None = None,
    trusted_skill: str = "",
    has_data_source: bool = False,
    has_workspace: bool = False,
    include_mcp: bool = True,
) -> list[dict]:
    """Return only tools useful for the current turn.

    Output-generation tools stay hidden unless their slash command is active.
    Data tools are hidden when no data source is connected, while knowledge,
    clarification, and confirm tools can still work.
    """
    policy_command = command or ""
    if activation is not None:
        # Skills never unlock command/action-gated tools. Internal actions keep
        # the existing confirm/revise guards while using a separate namespace.
        policy_command = activation.command_name or activation.internal_action
    allowed = BUILTIN_TOOL_REGISTRY.exposed_names(
        command=policy_command,
        has_data_source=has_data_source,
        has_workspace=has_workspace,
        skill=trusted_skill,
    )
    if skill_allowed_tools:
        # Intersection happens after normal source/workspace/command policy, so
        # a Skill can only reduce an already authorized set.
        allowed &= set(skill_allowed_tools)

    filtered: list[dict] = []
    for schema in tools:
        name = _tool_name(schema)
        if not name:
            continue
        if name.startswith("mcp__"):
            if include_mcp and not skill_allowed_tools:
                filtered.append(schema)
            continue
        if name in allowed:
            filtered.append(schema)

    # Copy so callers can safely tweak descriptions later without mutating the
    # global AGENT_TOOLS list.
    return deepcopy(filtered)
