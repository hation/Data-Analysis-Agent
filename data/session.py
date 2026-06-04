#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""In-memory session management for the business analyst agent."""
import logging
import uuid
from dataclasses import dataclass, field, fields, MISSING
from datetime import datetime
from typing import List, Dict, Any, Optional

log = logging.getLogger(__name__)


@dataclass
class ChatSession:
    session_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    history: List[Dict[str, str]] = field(default_factory=list)
    # ── Multi-source support ───────────────────────────────────────────────────
    # Each entry: {"id": str, "source": DataSource}
    # Multiple sources can be active simultaneously; `_active_ids` is a set.
    _sources: List[Dict[str, Any]] = field(default_factory=list)
    _active_ids: List[str] = field(default_factory=list)   # ordered, all active
    model_provider: str = ""         # Selected LLM provider key
    # Token usage tracking
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    last_prompt_tokens: int = 0      # most recent call's prompt size (for context bar)
    # Cancellation flag — set by POST /api/session/<sid>/stop
    cancel_requested: bool = False
    # IDs of every chart generated in this session (appended by api/chat.py)
    chart_ids: List[str] = field(default_factory=list)
    # PPT color scheme — persisted so it survives multiple PPT requests
    ppt_color_scheme: str = "mckinsey"
    # TTL tracking — updated on every access
    last_accessed: datetime = field(default_factory=datetime.now)
    # Last turn's reasoning chain summary — injected into the next turn's messages
    last_reasoning: str = ""
    # Cached merged schema string — cleared whenever data sources change so we
    # don't serve a stale schema after upload/connect/disconnect.
    _combined_schema_cache: Optional[str] = None

    # ── Multi-source API ───────────────────────────────────────────────────────

    @property
    def data_source(self):
        """Backward-compat: return first active DataSource (or None)."""
        active = self._active_entries()
        return active[0]["source"] if active else None

    @data_source.setter
    def data_source(self, source):
        """Backward-compat setter: replaces entire list with one source (old code)."""
        if source is None:
            self._sources = []
            self._active_ids = []
        else:
            sid = str(uuid.uuid4())[:8]
            self._sources = [{"id": sid, "source": source}]
            self._active_ids = [sid]
        self._combined_schema_cache = None

    def _active_entries(self) -> List[Dict[str, Any]]:
        """Ordered list of active source entries."""
        id_set = set(self._active_ids)
        return [e for e in self._sources if e["id"] in id_set]

    def add_source(self, source) -> str:
        """Append a new data source and activate it. Returns its internal ID."""
        sid = str(uuid.uuid4())[:8]
        self._sources.append({"id": sid, "source": source})
        if sid not in self._active_ids:
            self._active_ids.append(sid)
        self._combined_schema_cache = None
        log.info("[session] source added  session=%s  source=%s  id=%s  total=%d",
                 self.session_id, getattr(source, "name", "?"), sid, len(self._sources))
        return sid

    def remove_source(self, source_id: str) -> bool:
        before = len(self._sources)
        removed = next((e for e in self._sources if e["id"] == source_id), None)
        self._sources = [e for e in self._sources if e["id"] != source_id]
        self._active_ids = [i for i in self._active_ids if i != source_id]
        removed_ok = len(self._sources) < before
        if removed_ok:
            name = getattr(removed["source"], "name", "?") if removed else "?"
            self._combined_schema_cache = None
            log.info("[session] source removed  session=%s  source=%s  id=%s  remaining=%d",
                     self.session_id, name, source_id, len(self._sources))
        return removed_ok

    def toggle_source(self, source_id: str) -> bool:
        """Toggle a source's active state. Returns new active state."""
        entry = next((e for e in self._sources if e["id"] == source_id), None)
        if not entry:
            return False
        if source_id in self._active_ids:
            self._active_ids = [i for i in self._active_ids if i != source_id]
            new_state = False
        else:
            self._active_ids.append(source_id)
            new_state = True
        self._combined_schema_cache = None
        log.info("[session] source toggled  session=%s  source=%s  id=%s  active=%s",
                 self.session_id, getattr(entry["source"], "name", "?"), source_id, new_state)
        return new_state

    def list_sources(self) -> List[Dict[str, Any]]:
        """Return [{id, name, type, active}] for the frontend."""
        active_set = set(self._active_ids)
        return [
            {
                "id": e["id"],
                "name": getattr(e["source"], "name", "未命名"),
                "type": type(e["source"]).__name__.replace("DataSource", "").lower(),
                "active": e["id"] in active_set,
            }
            for e in self._sources
        ]

    def get_combined_schema(self) -> str:
        """Merged schema from all ACTIVE sources."""
        active = self._active_entries()
        if not active:
            # Fallback: use all sources if none activated
            active = self._sources
        if not active:
            return ""
        if len(active) == 1:
            return active[0]["source"].get_schema()
        parts = []
        for entry in active:
            src = entry["source"]
            parts.append(f"=== 数据源: {getattr(src, 'name', '未命名')} ===\n{src.get_schema()}")
        return "\n\n".join(parts)

    def add_user(self, text: str):
        self.history.append({"role": "user", "content": text})

    # Maximum characters kept per tool result in history.
    # Large query results are truncated here so they don't bloat the prompt on
    # subsequent turns.  800 chars ≈ 230 tokens — enough for the Agent to know
    # what was queried and what the key values were.
    _TOOL_RESULT_HISTORY_CAP = 800

    def add_tool_messages(self, messages: list) -> None:
        """Store tool call / tool result messages from one agent turn.

        Tool results are truncated to _TOOL_RESULT_HISTORY_CAP chars so that
        large query outputs don't cause prompt bloat on subsequent turns.
        The Agent can always re-run the same query if it needs the full data.
        """
        _KEEP_ROLES = {"assistant", "tool"}
        for m in messages:
            if m.get("role") not in _KEEP_ROLES:
                continue
            if m.get("role") == "assistant":
                if not m.get("tool_calls"):
                    continue   # intermediate assistant text — skip
                entry = {"role": "assistant", "tool_calls": m["tool_calls"], "content": ""}
            else:
                # role == "tool" — truncate large results
                raw = m.get("content", "")
                cap = self._TOOL_RESULT_HISTORY_CAP
                if len(raw) > cap:
                    content = raw[:cap] + f"\n…[result truncated for history, {len(raw):,} chars total]"
                else:
                    content = raw
                entry = {
                    "role":         "tool",
                    "tool_call_id": m.get("tool_call_id", ""),
                    "content":      content,
                }
            self.history.append(entry)

    def add_assistant(self, text: str, reasoning: str = "", chart_ids: list = None):
        msg = {"role": "assistant", "content": text}
        # Record the charts produced in this turn so they can be restored when
        # the conversation is reloaded from disk.
        if chart_ids:
            msg["chart_ids"] = list(chart_ids)
        self.history.append(msg)
        self.last_reasoning = reasoning

    def clear_history(self):
        self.history.clear()
        self.last_reasoning = ""
        self.total_input_tokens = 0
        self.total_output_tokens = 0
        self.last_prompt_tokens = 0

    def record_usage(self, prompt_tokens: int, completion_tokens: int):
        self.total_input_tokens += prompt_tokens
        self.total_output_tokens += completion_tokens
        self.last_prompt_tokens = prompt_tokens

    def _ensure_fields(self):
        """Backfill any dataclass field missing on objects created by an
        older code version (e.g. surviving a hot-reload). Keeps old in-memory
        sessions usable after a field is added to ChatSession."""
        for f in fields(self):
            if not hasattr(self, f.name):
                if f.default is not MISSING:
                    setattr(self, f.name, f.default)
                elif f.default_factory is not MISSING:  # type: ignore[misc]
                    setattr(self, f.name, f.default_factory())
                else:
                    setattr(self, f.name, None)
        # Migrate sessions that had old single-source _active_source_id field
        if hasattr(self, "_active_source_id") and not self._active_ids:
            old_id = getattr(self, "_active_source_id", "")
            if old_id and any(e["id"] == old_id for e in self._sources):
                self._active_ids = [old_id]


_SESSION_TTL = 7200      # seconds before an idle session is evicted
_CLEANUP_INTERVAL = 1800  # how often the daemon thread wakes to prune


class SessionManager:
    def __init__(self):
        self._store: Dict[str, ChatSession] = {}
        self._start_cleanup_daemon()

    def create(self) -> ChatSession:
        s = ChatSession()
        self._store[s.session_id] = s
        return s

    def get(self, sid: str) -> Optional[ChatSession]:
        s = self._store.get(sid)
        if s:
            s._ensure_fields()
            s.last_accessed = datetime.now()
        return s

    def get_or_create(self, sid: str) -> ChatSession:
        if sid and sid in self._store:
            s = self._store[sid]
            s._ensure_fields()
            s.last_accessed = datetime.now()
            return s
        s = ChatSession(session_id=sid) if sid else ChatSession()
        self._store[s.session_id] = s
        return s

    def remove(self, sid: str):
        self._store.pop(sid, None)

    def _cleanup_expired(self):
        cutoff = datetime.now()
        expired = [
            sid for sid, s in list(self._store.items())
            if (cutoff - s.last_accessed).total_seconds() > _SESSION_TTL
        ]
        for sid in expired:
            self._store.pop(sid, None)
        if expired:
            log.info("[session] TTL cleanup  removed=%d  remaining=%d",
                     len(expired), len(self._store))

    def _start_cleanup_daemon(self):
        import threading

        def _loop():
            import time
            while True:
                time.sleep(_CLEANUP_INTERVAL)
                try:
                    self._cleanup_expired()
                except Exception:
                    pass

        t = threading.Thread(target=_loop, daemon=True, name="session-cleanup")
        t.start()
