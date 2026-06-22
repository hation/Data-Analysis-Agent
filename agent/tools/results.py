# -*- coding: utf-8 -*-
"""Structured tool result envelopes.

Tool messages are still sent to the LLM as strings for provider compatibility,
but the string now carries a compact JSON envelope with a readable text body.
This gives logs/UI/tests a stable contract without forcing every tool
implementation to return a new object type.
"""
from __future__ import annotations

import logging
import hashlib
import os
import uuid
import re
from datetime import datetime
from pathlib import Path
from infrastructure.paths import data_path

log = logging.getLogger(__name__)

import json
from dataclasses import dataclass, field
from typing import Any

TOOL_RESULT_CHAR_BUDGET = 12_000
TOOL_RESULT_PREVIEW_CHARS = 6_000
TOOL_RESULT_PREVIEW_LINES = 40
_GLOBAL_RESULT_ROOT = data_path("outputs", "tool_results")


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


def _json_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    return json.dumps(content, ensure_ascii=False, default=str, indent=2)


def _preview_text(text: str) -> str:
    lines = text.splitlines()
    preview = "\n".join(lines[:TOOL_RESULT_PREVIEW_LINES])
    if len(preview) > TOOL_RESULT_PREVIEW_CHARS:
        preview = preview[:TOOL_RESULT_PREVIEW_CHARS]
    omitted_lines = max(0, len(lines) - TOOL_RESULT_PREVIEW_LINES)
    omitted_chars = max(0, len(text) - len(preview))
    suffix = (
        f"\n…[full result persisted; omitted {omitted_lines} lines / "
        f"{omitted_chars:,} chars]"
    )
    return preview + suffix


def _result_root(runtime: Any = None) -> Path:
    if runtime is not None and getattr(runtime, "cache_dir", None):
        return Path(runtime.cache_dir) / "tool_results"
    return _GLOBAL_RESULT_ROOT


def persist_large_tool_result(
    session_id: str,
    tool: str,
    raw: Any,
    *,
    runtime: Any = None,
    threshold: int = TOOL_RESULT_CHAR_BUDGET,
    deduplicate: bool = False,
) -> tuple[Any, dict | None, dict]:
    """Persist oversized tool data and return a bounded model preview.

    The artifact file is self-describing and content-address-verified. The
    opaque artifact id is used for lookup; local filesystem paths never enter
    the model-visible envelope.
    """
    text = _json_text(raw)
    encoded = text.encode("utf-8")
    if len(text) <= max(1, int(threshold)):
        return raw, None, {"persisted": False, "chars": len(text)}

    digest = hashlib.sha256(encoded).hexdigest()
    artifact_id = f"tr_{digest[:32]}" if deduplicate else f"tr_{uuid.uuid4().hex}"
    root = _result_root(runtime)
    root.mkdir(parents=True, exist_ok=True)
    target = root / f"{artifact_id}.json"
    temp = root / f".{artifact_id}.{os.getpid()}.tmp"
    record = {
        "version": 1,
        "artifact_id": artifact_id,
        "session_id": session_id,
        "workspace_id": str(getattr(runtime, "workspace_id", "") or ""),
        "tool": tool,
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "size_bytes": len(encoded),
        "sha256": digest,
        "content_type": "text/plain; charset=utf-8",
        "data": text,
    }
    if not target.exists():
        temp.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
        temp.replace(target)
    artifact = {
        "type": "tool_result",
        "artifact_id": artifact_id,
        "name": f"{tool} 完整结果",
        "uri": f"artifact://tool-result/{artifact_id}",
        "url": f"/api/session/{session_id}/tool-results/{artifact_id}",
        "size_bytes": len(encoded),
        "sha256": digest,
        "workspace_id": str(getattr(runtime, "workspace_id", "") or ""),
    }
    debug = {
        "persisted": True,
        "artifact_id": artifact_id,
        "original_chars": len(text),
        "preview_chars": min(len(text), TOOL_RESULT_PREVIEW_CHARS),
    }
    return _preview_text(text), artifact, debug


def load_tool_result_artifact(
    artifact_id: str, *, runtime: Any = None, workspace_root: Path | None = None,
) -> dict | None:
    """Load and verify an artifact from the active workspace or global store."""
    if not artifact_id.startswith("tr_") or not artifact_id[3:].isalnum():
        return None
    roots = []
    if runtime is not None and getattr(runtime, "cache_dir", None):
        roots.append(Path(runtime.cache_dir) / "tool_results")
    elif workspace_root is not None:
        roots.append(Path(workspace_root) / ".baa_cache" / "tool_results")
    roots.append(_GLOBAL_RESULT_ROOT)
    for root in roots:
        path = root / f"{artifact_id}.json"
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
            text = str(record.get("data", ""))
            digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
            if record.get("artifact_id") == artifact_id and digest == record.get("sha256"):
                return record
        except (OSError, json.JSONDecodeError, TypeError):
            continue
    return None


def extract_tool_result_references(text: str) -> list[str]:
    """Extract stable artifact URIs from a model-facing tool envelope."""
    refs = re.findall(r"artifact://tool-result/tr_[a-fA-F0-9]+", text or "")
    return list(dict.fromkeys(refs))


def truncate_tool_result_preserving_refs(text: str, cap: int) -> str:
    """Bound a tool message without discarding its recoverable artifact ids."""
    if len(text) <= cap:
        return text
    refs = extract_tool_result_references(text)
    suffix = f"\n…[result truncated for history, {len(text):,} chars total]"
    if refs:
        suffix += "\n[RECOVERABLE_ARTIFACTS] " + ", ".join(refs)
    return text[:cap] + suffix


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
    session_id: str = "",
    runtime: Any = None,
    result_char_budget: int = TOOL_RESULT_CHAR_BUDGET,
) -> ToolResultEnvelope:
    error = error or classify_tool_error(raw, tool=tool)
    if ok is None:
        ok = not bool(error)
    model_data = raw
    result_artifact = None
    budget_debug = {}
    if session_id and ok:
        try:
            model_data, result_artifact, budget_debug = persist_large_tool_result(
                session_id, tool, raw, runtime=runtime, threshold=result_char_budget,
                deduplicate=tool == "get_schema",
            )
        except Exception as exc:
            log.warning("[tool-result] persist failed tool=%s: %s", tool, exc)
            budget_debug = {"persisted": False, "error": str(exc)}
    result_artifacts = list(artifacts or [])
    if result_artifact is not None:
        result_artifacts.append(result_artifact)
    result_debug = dict(debug or {})
    if budget_debug:
        result_debug["result_budget"] = budget_debug
    return ToolResultEnvelope(
        tool=tool,
        ok=ok,
        error=error,
        summary=summary or _summarize_content(raw),
        data=model_data,
        sources=list(sources or []),
        artifacts=result_artifacts,
        debug=result_debug,
    )
