# -*- coding: utf-8 -*-
"""
Conversation history compaction — LLM-based semantic summarization.

Inspired by Claude Code's compact.ts / prompt.ts:
  - When the *real* prompt-token usage of the previous turn exceeds a fraction
    of the model context window, summarize the oldest portion of history via a
    lightweight LLM call, keeping the most-recent turns verbatim.
  - The summary is injected as a single system message so the agent retains
    full semantic context without bloating the prompt.
  - Images and large tool results are stripped before summarization to keep
    the compaction request itself small.

Trigger口径与前端上下文条一致:
  前端显示 prompt_tokens / context_window；compaction 用上一轮真实
  prompt_tokens 判定，达到 _COMPACT_TRIGGER_RATIO (80%) 即触发。

Usage (in agent.run):
    if should_compact_history(history, last_prompt_tokens, ctx_window):
        yield {"type": "tool_start", "tool": "compaction", ...}
        history, ok = compact_history(history, client, model, summary_model=...)
        yield {"type": "tool_end", "tool": "compaction"}
"""
import logging
import time
from typing import List, Dict, Any, Tuple, Optional

log = logging.getLogger(__name__)

# ── Thresholds ────────────────────────────────────────────────────────────────

# Trigger compaction when the previous turn's real prompt tokens reach this
# fraction of the context window. Matches the frontend context-bar semantics.
_COMPACT_TRIGGER_RATIO = 0.80

# Keep this many recent turns verbatim (never summarized)
_KEEP_RECENT_TURNS = 6

# Hard cap on chars fed to the summarizer to keep the compaction call cheap
_MAX_SUMMARY_INPUT_CHARS = 40_000

# Max tokens the summary itself may use
_SUMMARY_MAX_TOKENS = 1200

# Minimum history messages before compaction is worthwhile. Kept low so that
# small context windows (where a single turn can already exceed the limit)
# still get compacted — the trigger is the token ratio, not the turn count.
_MIN_TURNS_FOR_COMPACT = 4

# Marker used to tag the injected summary message so downstream pruning logic
# can recognise and protect it.
COMPACTION_SUMMARY_MARKER = "[CONVERSATION SUMMARY — earlier context compressed]"

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
            content = f"[tool_result] {str(content)[:500]}"

        if isinstance(content, str) and content.strip():
            parts.append(f"[{role.upper()}]: {content.strip()}")

    return "\n\n".join(parts)


def _safe_tail_start(history: List[Dict], desired_keep: int) -> int:
    """Return the index where the verbatim tail should start.

    Adjusts `len(history) - desired_keep` so the tail never begins with an
    orphan `role: tool` message — OpenAI requires every tool message to
    immediately follow the assistant message that contains its tool_calls.
    Walks the cut point earlier until it lands on a non-tool message.
    """
    if desired_keep <= 0:
        return len(history)
    idx = max(0, len(history) - desired_keep)
    # If the tail would start with a tool message, move the cut earlier so the
    # preceding assistant(tool_calls) message is kept together with it.
    while idx > 0 and history[idx].get("role") == "tool":
        idx -= 1
    return idx


# ── Core compaction logic ─────────────────────────────────────────────────────

def _call_summarizer(
    client,
    summary_model: str,
    conversation_text: str,
) -> str:
    """Call the LLM to produce a summary. Returns summary string or raises."""
    prompt = _COMPACT_PROMPT_TEMPLATE.format(conversation_text=conversation_text)

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


def compact_history(
    history: List[Dict],
    client,
    model: str,
    summary_model: Optional[str] = None,
) -> Tuple[List[Dict], bool]:
    """
    Summarize the oldest portion of history, keeping the most recent turns verbatim.

    Args:
        history:       full conversation history (list of message dicts)
        client:        the LLM client (same one the session uses)
        model:         the session model — used as the summarizer model when
                       `summary_model` is not given (guarantees a valid model
                       for the active provider/endpoint).
        summary_model: optional explicit model id for the summary call. If the
                       caller does not provide one, `model` is used as-is so we
                       never request a model the provider does not host.

    Returns:
        (new_history, did_compact)
        new_history[0] is a system message containing the summary if compacted.
    """
    if len(history) < _MIN_TURNS_FOR_COMPACT:
        return history, False

    # Split: summarize the head, keep a tool-call-safe verbatim tail.
    desired_keep = min(_KEEP_RECENT_TURNS, len(history) // 2)
    tail_start = _safe_tail_start(history, desired_keep)
    to_summarize = history[:tail_start]
    to_keep      = history[tail_start:]

    if not to_summarize:
        return history, False

    # Strip heavy content and build text
    stripped = [_strip_heavy_content(m) for m in to_summarize]
    conversation_text = _messages_to_text(stripped)

    # Truncate input if still too large
    if len(conversation_text) > _MAX_SUMMARY_INPUT_CHARS:
        conversation_text = (
            conversation_text[:_MAX_SUMMARY_INPUT_CHARS]
            + "\n…[earlier context truncated]"
        )

    # Use the session model for summarization unless the caller supplied a
    # lighter one. Never hard-code a model id — a custom provider/endpoint may
    # not host it, which would 404 the whole compaction.
    use_model = summary_model or model

    t0 = time.monotonic()
    try:
        summary = _call_summarizer(client, use_model, conversation_text)
    except Exception as exc:
        log.warning("[compaction] summarization failed: %s — keeping history as-is", exc)
        return history, False

    if not summary.strip():
        log.warning("[compaction] summarizer returned empty output — keeping history as-is")
        return history, False

    elapsed = time.monotonic() - t0
    log.info(
        "[compaction] summarized %d→1 messages in %.1fs (kept %d recent turns)",
        len(to_summarize), elapsed, len(to_keep),
    )

    summary_msg: Dict[str, Any] = {
        "role": "system",
        # Tagged with COMPACTION_SUMMARY_MARKER so _hard_prune can protect it.
        "content": (
            COMPACTION_SUMMARY_MARKER + "\n\n"
            + summary.strip()
            + "\n\n[End of summary. Continue from the current state described above.]"
        ),
        "_compaction_summary": True,
    }

    new_history = [summary_msg] + to_keep
    return new_history, True


def _estimate_history_tokens(history: List[Dict], chars_per_token: float = 3.5) -> int:
    """Rough token estimate of the current history (chars / chars_per_token)."""
    import json as _json
    total_chars = 0
    for m in history:
        try:
            total_chars += len(_json.dumps(m, ensure_ascii=False))
        except Exception:
            total_chars += len(str(m))
    return max(1, int(total_chars / chars_per_token))


def should_compact_history(
    history: List[Dict],
    last_prompt_tokens: int,
    context_window: int,
    chars_per_token: float = 3.5,
) -> bool:
    """
    Decide whether to run semantic compaction.

    Triggers on EITHER of two signals reaching _COMPACT_TRIGGER_RATIO (80%) of
    the context window:

      1. last_prompt_tokens — the real prompt-token count the LLM reported on
         the previous turn (same measure the frontend context bar shows).
      2. an estimate of the CURRENT history size — covers the case where the
         previous turn stuffed huge tool results into history, or where usage
         data is missing (e.g. right after a server restart).

    Using the current-history estimate as a second signal means compaction is
    not blocked just because `last_prompt_tokens` happens to be 0/stale.

    Returns False when there is not enough history to bother, when the window
    is unknown, or when both signals are still below the threshold.
    """
    if len(history) < _MIN_TURNS_FOR_COMPACT:
        return False
    if not context_window or context_window <= 0:
        return False

    threshold = context_window * _COMPACT_TRIGGER_RATIO

    # Signal 1: real usage from the previous turn.
    if last_prompt_tokens and last_prompt_tokens >= threshold:
        return True

    # Signal 2: estimated size of the history we are about to send.
    est = _estimate_history_tokens(history, chars_per_token)
    return est >= threshold
