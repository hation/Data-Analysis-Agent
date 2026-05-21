# -*- coding: utf-8 -*-
"""
Conversation history compaction — LLM-based semantic summarization.

Inspired by Claude Code's compact.ts / prompt.ts:
  - When history exceeds a token threshold, summarize the oldest portion
    via a lightweight LLM call, keeping the most-recent turns verbatim.
  - The summary is injected as a single system message so the agent
    retains full semantic context without bloating the prompt.
  - Images and large tool results are stripped before summarization
    to keep the compaction request itself small.

Usage:
    from agent.compaction import maybe_compact_history

    history, compacted = maybe_compact_history(
        history=history,
        client=self.client,
        model=self.model,
        context_window=self._get_context_window(),
        chars_per_token=self._CHARS_PER_TOKEN,
    )
    # compacted=True means a summary was injected at history[0]
"""
import json
import logging
import time
from typing import List, Dict, Any, Tuple

log = logging.getLogger(__name__)

# ── Thresholds ────────────────────────────────────────────────────────────────

# Trigger compaction when history alone exceeds this fraction of the context window
_COMPACT_TRIGGER_RATIO = 0.55

# Keep this many recent turns verbatim (never summarized)
_KEEP_RECENT_TURNS = 6

# Hard cap on chars fed to the summarizer to keep the compaction call cheap
_MAX_SUMMARY_INPUT_CHARS = 40_000

# Max tokens the summary itself may use
_SUMMARY_MAX_TOKENS = 1200

# Minimum history turns before we even attempt compaction
_MIN_TURNS_FOR_COMPACT = 10

# ── Summarization prompt (adapted from Claude Code prompt.ts) ─────────────────

_COMPACT_SYSTEM = (
    "You are a helpful assistant. Your only task is to produce a concise structured "
    "summary of a conversation. Output ONLY the summary — no preamble, no commentary."
)

_COMPACT_PROMPT_TEMPLATE = """\
Below is a segment of a business-analytics conversation that needs to be summarized.
The user is interacting with an AI analytics agent that can query data, generate charts,
and produce reports.

<conversation_to_summarize>
{conversation_text}
</conversation_to_summarize>

Write a structured summary covering ALL of the following sections.
Use the exact headings shown. Omit a section only if there is truly nothing to report.

## 1. User Goals
What the user explicitly asked for or is trying to accomplish.

## 2. Data & Schema
Tables, columns, and data sources that were discussed or queried.
Include key facts: row counts, date ranges, important fields.

## 3. Queries & Results
SQL queries that were run and their key results (top values, totals, trends).
Preserve actual numbers where they matter.

## 4. Analysis & Charts
Analyses that were executed and charts that were generated.
Note the chart type, axes, and key insight shown.

## 5. Outputs Produced
Reports, PPT files, Excel exports, or dashboards that were created.
Include filenames if mentioned.

## 6. Errors & Fixes
Any errors encountered and how they were resolved.

## 7. Pending / In-Progress
Tasks explicitly requested by the user that have NOT been completed yet.

## 8. Current State
Precise description of where the conversation left off — what was the last thing done,
what tool was called last, what the agent was about to do next.
"""


# ── Helpers ───────────────────────────────────────────────────────────────────

def _estimate_tokens(text: str, chars_per_token: float = 3.5) -> int:
    return max(1, int(len(text) / chars_per_token))


def _strip_heavy_content(msg: Dict[str, Any]) -> Dict[str, Any]:
    """Return a copy of msg with images and oversized tool results stripped."""
    content = msg.get("content")
    if content is None:
        return msg

    # String content: truncate very long tool results
    if isinstance(content, str):
        if len(content) > 3000:
            content = content[:2800] + "\n…[truncated]"
        return {**msg, "content": content}

    # List content (multimodal): remove image blocks, truncate text blocks
    if isinstance(content, list):
        cleaned = []
        for block in content:
            if isinstance(block, dict):
                if block.get("type") == "image":
                    cleaned.append({"type": "text", "text": "[image removed]"})
                elif block.get("type") == "text":
                    text = block.get("text", "")
                    if len(text) > 3000:
                        text = text[:2800] + "\n…[truncated]"
                    cleaned.append({**block, "text": text})
                else:
                    cleaned.append(block)
            else:
                cleaned.append(block)
        return {**msg, "content": cleaned}

    return msg


def _messages_to_text(messages: List[Dict]) -> str:
    """Render messages to a readable text block for the summarizer."""
    parts = []
    for m in messages:
        role = m.get("role", "unknown")
        content = m.get("content") or ""

        if isinstance(content, list):
            text_parts = []
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    text_parts.append(block.get("text", ""))
                elif isinstance(block, dict) and block.get("type") == "tool_result":
                    text_parts.append(f"[tool_result: {str(block)[:200]}]")
            content = " ".join(text_parts)

        if role == "assistant" and m.get("tool_calls"):
            tool_names = [tc.get("function", {}).get("name", "?")
                          for tc in m.get("tool_calls", [])]
            content = f"{content} [calls: {', '.join(tool_names)}]".strip()

        if role == "tool":
            content = f"[tool_result] {content[:500]}"

        if content.strip():
            parts.append(f"[{role.upper()}]: {content.strip()}")

    return "\n\n".join(parts)


# ── Core compaction logic ─────────────────────────────────────────────────────

def _call_summarizer(
    client,
    model: str,
    conversation_text: str,
) -> str:
    """Call the LLM to produce a summary. Returns summary string or raises."""
    prompt = _COMPACT_PROMPT_TEMPLATE.format(conversation_text=conversation_text)

    # Prefer a cheap fast model for summarization when possible.
    # Fall back to the session model if we can't determine a lighter one.
    summary_model = _pick_summary_model(model)

    response = client.chat.completions.create(
        model=summary_model,
        messages=[
            {"role": "system", "content": _COMPACT_SYSTEM},
            {"role": "user",   "content": prompt},
        ],
        temperature=0.1,
        max_tokens=_SUMMARY_MAX_TOKENS,
        stream=False,
    )
    return response.choices[0].message.content or ""


def _pick_summary_model(session_model: str) -> str:
    """Choose a cheap model for summarization."""
    m = session_model.lower()
    # Already on a cheap model — use as-is
    if any(k in m for k in ("haiku", "flash", "mini", "deepseek-chat", "v3")):
        return session_model
    # Downgrade expensive models to a lighter sibling
    if "claude" in m:
        return "claude-haiku-4-5-20251001"
    if "gpt-4" in m:
        return "gpt-4o-mini"
    # DeepSeek reasoning → DeepSeek chat
    if "deepseek" in m:
        return "deepseek-chat"
    return session_model


def compact_history(
    history: List[Dict],
    client,
    model: str,
    chars_per_token: float = 3.5,
) -> Tuple[List[Dict], bool]:
    """
    Summarize the oldest portion of history, keeping the most recent turns verbatim.

    Returns:
        (new_history, did_compact)
        new_history[0] will be a system message containing the summary if compacted.
    """
    if len(history) < _MIN_TURNS_FOR_COMPACT:
        return history, False

    # Split: summarize the head, keep the tail verbatim
    keep_count = min(_KEEP_RECENT_TURNS, len(history) // 2)
    to_summarize = history[:-keep_count] if keep_count > 0 else history
    to_keep      = history[-keep_count:] if keep_count > 0 else []

    if not to_summarize:
        return history, False

    # Strip heavy content and build text
    stripped = [_strip_heavy_content(m) for m in to_summarize]
    conversation_text = _messages_to_text(stripped)

    # Truncate input if still too large
    if len(conversation_text) > _MAX_SUMMARY_INPUT_CHARS:
        conversation_text = conversation_text[:_MAX_SUMMARY_INPUT_CHARS] + "\n…[earlier context truncated]"

    t0 = time.monotonic()
    try:
        summary = _call_summarizer(client, model, conversation_text)
    except Exception as exc:
        log.warning("[compaction] summarization failed: %s — falling back to simple prune", exc)
        return history, False

    elapsed = time.monotonic() - t0
    log.info(
        "[compaction] summarized %d→1 messages in %.1fs (kept %d recent turns)",
        len(to_summarize), elapsed, len(to_keep),
    )

    summary_msg: Dict[str, Any] = {
        "role": "system",
        "content": (
            "[CONVERSATION SUMMARY — earlier context compressed]\n\n"
            + summary.strip()
            + "\n\n[End of summary. Continue from the current state described above.]"
        ),
    }

    new_history = [summary_msg] + to_keep
    return new_history, True


def should_compact_history(
    history: List[Dict],
    context_window: int,
    chars_per_token: float = 3.5,
    reserve: int = 12000,
) -> bool:
    """
    Return True if history is large enough to warrant semantic compaction.
    Call this first so the agent loop can yield a UI event before the
    (potentially slow) LLM summarization call.
    """
    if len(history) < _MIN_TURNS_FOR_COMPACT:
        return False

    total_chars = sum(len(json.dumps(m)) for m in history)
    total_tokens = _estimate_tokens(str(total_chars), chars_per_token)
    available = context_window - reserve
    trigger = int(available * _COMPACT_TRIGGER_RATIO)
    return total_tokens >= trigger


def maybe_compact_history(
    history: List[Dict],
    client,
    model: str,
    context_window: int,
    chars_per_token: float = 3.5,
    reserve: int = 12000,
) -> Tuple[List[Dict], bool]:
    """
    Compact history only when it exceeds the trigger threshold.
    Returns (history, did_compact).
    """
    if not should_compact_history(history, context_window, chars_per_token, reserve):
        return history, False

    log.info(
        "[compaction] triggering compaction (window=%d reserve=%d)",
        context_window, reserve,
    )
    return compact_history(history, client, model, chars_per_token)
