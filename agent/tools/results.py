# -*- coding: utf-8 -*-
"""Structured tool result envelopes.

Tool messages are still sent to the LLM as strings for provider compatibility,
but the string now carries a compact JSON envelope with a readable text body.
This gives logs/UI/tests a stable contract without forcing every tool
implementation to return a new object type.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any


def classify_tool_error(raw: Any, tool: str = "") -> str:
    """Best-effort error taxonomy for tool outputs."""
    text = str(raw or "").strip()
    lower = text.lower()
    if not text:
        return ""
    if text.startswith("[ARG ERROR]"):
        return "argument_error"
    if "sql validation failed" in lower:
        return "sql_validation_error"
    if text.startswith("SQL Error:"):
        if "no such column" in lower or "column" in lower and "not found" in lower:
            return "field_not_found"
        if "no such table" in lower or "table" in lower and "not found" in lower:
            return "table_not_found"
        if "syntax" in lower or "parser" in lower:
            return "sql_syntax_error"
        return "sql_execution_error"
    if "no data source" in lower or "连接已断开" in text:
        return "datasource_disconnected"
    if "permission" in lower or "权限" in text:
        return "permission_error"
    if tool == "get_schema":
        if text.startswith("ERROR:") or text.startswith("工具执行错误"):
            return "tool_error"
        return ""
    if (
        lower.startswith("query returned no rows")
        or lower.startswith("empty result")
        or lower.startswith("no rows returned")
    ):
        return "empty_result"
    if text.startswith("[MCP ERROR]"):
        return "mcp_error"
    if text.startswith("ERROR:") or text.startswith("工具执行错误"):
        return "tool_error"
    return ""


@dataclass
class ToolResultEnvelope:
    tool: str
    ok: bool = True
    error: str = ""
    summary: str = ""
    data: Any = ""
    sources: list[dict] = field(default_factory=list)
    artifacts: list[dict] = field(default_factory=list)
    debug: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "type": "tool_result",
            "tool": self.tool,
            "ok": self.ok,
            "error": self.error,
            "summary": self.summary,
            "data": self.data,
            "sources": self.sources,
            "artifacts": self.artifacts,
            "debug": self.debug,
        }

    def to_model_text(self) -> str:
        """Provider-safe tool content.

        The first line is intentionally human-readable so older prompt habits
        still work; the JSON block gives future code a stable structure.
        """
        data = self.to_dict()
        readable = self.summary or str(self.data)[:240]
        return (
            f"[TOOL_RESULT] {self.tool} {'OK' if self.ok else 'ERROR'}: {readable}\n"
            + json.dumps(data, ensure_ascii=False, default=str)
        )


def _summarize_content(content: Any, max_chars: int = 220) -> str:
    if isinstance(content, str):
        text = content.strip()
    else:
        text = json.dumps(content, ensure_ascii=False, default=str)
    text = " ".join(text.split())
    return text[:max_chars] + ("..." if len(text) > max_chars else "")


def make_tool_result(
    tool: str,
    raw: Any,
    *,
    ok: bool | None = None,
    error: str = "",
    summary: str = "",
    sources: list[dict] | None = None,
    artifacts: list[dict] | None = None,
    debug: dict | None = None,
) -> ToolResultEnvelope:
    error = error or classify_tool_error(raw, tool=tool)
    if ok is None:
        ok = not bool(error)
    return ToolResultEnvelope(
        tool=tool,
        ok=ok,
        error=error,
        summary=summary or _summarize_content(raw),
        data=raw,
        sources=list(sources or []),
        artifacts=list(artifacts or []),
        debug=dict(debug or {}),
    )
