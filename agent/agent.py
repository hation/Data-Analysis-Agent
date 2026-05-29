#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Business Analyst Agent — main entry point.

The heavy lifting is split across:
  prompts.py      — SYSTEM_PROMPT, COMMAND_HINTS, path setup
  tools_schema.py — AGENT_TOOLS (JSON schemas sent to the LLM)
  tools_data.py   — DataToolsMixin  (schema / query / analysis / chart / clean)
  tools_export.py — ExportToolsMixin (Excel / Word / PPT)
"""
import json
import logging
import time
from typing import Iterator, List, Dict, Any, Optional, Tuple

from .prompts      import get_system_prompt, COMMAND_HINTS
from .tools_schema import AGENT_TOOLS, get_tools_with_mcp
from .tools_data   import DataToolsMixin
from .tools_export import ExportToolsMixin
from .mcp_manager  import get_mcp_manager
from .compaction   import should_compact_history, compact_history
from .retry        import call_with_retry as _call_with_retry, is_retryable as _is_retryable
from .validate     import validate_tool_args as _validate_tool_args

log = logging.getLogger(__name__)


_PROPOSE_CMDS = (
    "ppt", "ppt_revise", "export", "excel_revise",
    "report", "report_revise", "dashboard", "dashboard_revise",
)


class BusinessAgent(DataToolsMixin, ExportToolsMixin):
    MAX_ITERATIONS = 100

    # Approximate chars-per-token ratio for fast estimation (conservative)
    _CHARS_PER_TOKEN = 3.5
    # Reserve headroom for the response + tools list (default for large windows)
    _CONTEXT_RESERVE = 12000

    def _context_reserve(self) -> int:
        """Headroom reserved for the response + tools list.

        For small context windows the fixed 12k reserve would exceed the whole
        window and drive the prune budget negative — scale it down to at most
        ~30% of the window so a usable budget always remains.
        """
        window = self._get_context_window()
        return min(self._CONTEXT_RESERVE, max(1000, int(window * 0.3)))

    def __init__(
        self,
        client,
        model: str,
        data_source=None,
        enable_thinking: bool = False,
        thinking_budget: int = 8000,
        chart_store: Optional[dict] = None,
        session_chart_ids: Optional[List[str]] = None,
        color_scheme: str = "mckinsey",
        session_id: str = "",
        context_window: Optional[int] = None,
    ):
        self.client = client
        self.model = model
        self.data_source = data_source
        self.enable_thinking = enable_thinking
        self.thinking_budget = thinking_budget
        # User-configured context window (from the model config). When set, it
        # overrides the model-name heuristic so the compaction trigger and the
        # frontend context bar use the exact same number.
        self._configured_context_window: Optional[int] = (
            context_window if context_window and context_window > 0 else None
        )
        self._schema_cache: Optional[str] = None
        self._chart_store: dict = chart_store if chart_store is not None else {}
        self._session_chart_ids: List[str] = session_chart_ids if session_chart_ids is not None else []
        self.ppt_color_scheme: str = color_scheme
        self._session_id: str = session_id
        self._mcp_manager = get_mcp_manager()

    # ── Context helpers ───────────────────────────────────────────────────────

    @staticmethod
    def _estimate_tokens(text: str) -> int:
        return max(1, int(len(text) / BusinessAgent._CHARS_PER_TOKEN))

    def _estimate_messages_tokens(self, messages: List[Dict]) -> int:
        total = 0
        for m in messages:
            content = m.get("content") or ""
            if isinstance(content, list):
                content = " ".join(str(c) for c in content)
            total += self._estimate_tokens(str(content))
            # tool_calls entries add overhead
            if m.get("tool_calls"):
                total += self._estimate_tokens(json.dumps(m["tool_calls"]))
        return total

    def _hard_prune(
        self, system_msgs: List[Dict], history: List[Dict], extra_msgs: List[Dict], context_window: int
    ) -> List[Dict]:
        """Hard truncation safety net: drop oldest messages until tokens fit.

        Two protections beyond a naive pop(0):
          1. A compaction summary message (tagged ``_compaction_summary``) is
             never dropped — it IS the compressed earlier context.
          2. After pruning, the surviving head is never an orphan ``role: tool``
             message; OpenAI requires every tool message to follow the
             assistant message that holds its tool_calls.
        """
        budget = context_window - self._context_reserve()
        fixed_tokens = self._estimate_messages_tokens(system_msgs + extra_msgs)
        available = budget - fixed_tokens

        pruned = list(history)
        before = len(pruned)

        # Pin a leading compaction-summary message so it survives pruning.
        pinned: List[Dict] = []
        if pruned and pruned[0].get("_compaction_summary"):
            pinned = [pruned.pop(0)]

        def _fits() -> bool:
            return self._estimate_messages_tokens(pinned + pruned) <= available

        while pruned and not _fits():
            pruned.pop(0)
            # Don't leave the head as an orphan tool message.
            while pruned and pruned[0].get("role") == "tool":
                pruned.pop(0)

        result = pinned + pruned
        if len(result) < before:
            log.info(
                "[context] hard-pruned %d→%d turns (budget=%d tokens)",
                before, len(result), available,
            )
        return result

    def _get_context_window(self) -> int:
        """Context window for the current model.

        Prefers the user-configured value (passed from the model config) so the
        compaction trigger matches the frontend context bar exactly. Falls back
        to a model-name heuristic when no value is configured.
        """
        if self._configured_context_window:
            return self._configured_context_window
        model = self.model.lower()
        if "claude" in model:
            return 190000
        if "deepseek" in model:
            return 60000
        if "gpt-4o" in model:
            return 120000
        if "gpt-4" in model:
            return 120000
        return 60000  # safe default

    def _adaptive_thinking_budget(self, remaining_tokens: int) -> int:
        """Scale thinking budget so it never exceeds ~40% of what's left."""
        cap = int(remaining_tokens * 0.4)
        return max(1000, min(self.thinking_budget, cap))

    def set_data_source(self, source):
        self.data_source = source
        self._schema_cache = None

    # ── Agent loop ────────────────────────────────────────────────────────────

    def run(
        self,
        user_message: str,
        history: List[Dict],
        command: str = "",
        last_reasoning: str = "",
        last_prompt_tokens: int = 0,
        ppt_title: str = "",
        ppt_slides: Optional[List] = None,
        excel_tables: Optional[List] = None,
        excel_filename: str = "",
        report_title: str = "",
        report_sections: Optional[List] = None,
        dashboard_name: str = "",
        dashboard_widgets: Optional[List] = None,
    ) -> Iterator[Dict]:
        """
        Yields event dicts consumed by the Flask SSE stream:
          {"type": "tool_start",    "tool": str, "display": str}
          {"type": "text_delta",    "content": str}
          {"type": "chart_html",    "html": str}
          {"type": "text",          "content": str}
          {"type": "ppt_outline",   "title": str, "slides": list, "markdown": str}
          {"type": "excel_outline", "tables": list, "filename": str, "markdown": str}
          {"type": "report_outline","title": str, "sections": list, "markdown": str}
          {"type": "dashboard_outline","name": str, "widgets": list, "markdown": str}
          {"type": "usage",         ...}
          {"type": "reasoning",     "content": str}
          {"type": "done"}
          {"type": "error",         "message": str}
        """
        _msg_preview = user_message[:120].replace("\n", " ")
        log.info("[run] command=%r  msg=%r  model=%s", command or "(none)", _msg_preview, self.model)

        # ── Confirm fast-paths: bypass LLM entirely ───────────────────────────
        if command == "ppt_confirm":
            slides = ppt_slides or []
            yield {"type": "tool_start", "tool": "generate_ppt",
                   "display": f"生成 PPT：{ppt_title}（{len(slides)} 张）..."}
            try:
                result = self._tool_generate_ppt(ppt_title, slides, "")
            except Exception as exc:
                yield {"type": "error", "message": f"PPT 生成失败: {exc}"}
                yield {"type": "done"}
                return
            yield {"type": "text", "content": result}
            yield {"type": "done"}
            return

        if command == "excel_confirm":
            tables = excel_tables or ["*"]
            yield {"type": "tool_start", "tool": "export_excel",
                   "display": f"导出 Excel → {', '.join(tables)[:50]}..."}
            try:
                result = self._tool_export_excel(tables=tables, filename=excel_filename)
            except Exception as exc:
                yield {"type": "error", "message": f"Excel 导出失败: {exc}"}
                yield {"type": "done"}
                return
            yield {"type": "text", "content": result}
            yield {"type": "done"}
            return

        if command == "report_confirm":
            sections = report_sections or []
            yield {"type": "tool_start", "tool": "export_report",
                   "display": f"生成报告：{report_title}（{len(sections)} 个章节）..."}
            try:
                result = self._tool_export_report(title=report_title, sections=sections)
            except Exception as exc:
                yield {"type": "error", "message": f"报告生成失败: {exc}"}
                yield {"type": "done"}
                return
            yield {"type": "text", "content": result}
            yield {"type": "done"}
            return

        if command == "dashboard_confirm":
            widgets = dashboard_widgets or []
            yield {"type": "tool_start", "tool": "generate_dashboard",
                   "display": f"生成看板：{dashboard_name}（{len(widgets)} 个组件）..."}
            try:
                result = self._tool_generate_dashboard(
                    name=dashboard_name, widgets=widgets
                )
            except Exception as exc:
                yield {"type": "error", "message": f"看板生成失败: {exc}"}
                yield {"type": "done"}
                return
            yield {"type": "text", "content": result}
            yield {"type": "done"}
            return


        system = get_system_prompt()
        if command and command in COMMAND_HINTS:
            system += f"\n\n[ACTIVE COMMAND: /{command}]\n{COMMAND_HINTS[command]}"

        prior_reasoning_msg: List[Dict] = []
        if last_reasoning:
            # Truncate reasoning to a reasonable cap but keep it meaningful
            summary = last_reasoning[:2000]
            prior_reasoning_msg = [{
                "role": "system",
                "content": (
                    f"[Prior turn reasoning summary]\n{summary}\n"
                    "[End of prior reasoning — use this context to inform your analysis "
                    "but do not repeat or reference it explicitly to the user.]"
                ),
            }]

        _system_msg = {"role": "system", "content": system}
        _user_msg = {"role": "user", "content": user_message}
        _ctx_window = self._get_context_window()

        # ── Semantic compaction (with frontend animation) ─────────────────────
        # Trigger口径与前端上下文条一致：用上一轮真实 prompt_tokens / context_window，
        # 达到 80% 即压缩。last_prompt_tokens 由 chat.py 从会话中传入。
        _needs_compact = should_compact_history(
            history=history,
            last_prompt_tokens=last_prompt_tokens,
            context_window=_ctx_window,
            chars_per_token=self._CHARS_PER_TOKEN,
        )
        if _needs_compact:
            # Report the larger of the two trigger signals for an honest %.
            from .compaction import _estimate_history_tokens
            _est = _estimate_history_tokens(history, self._CHARS_PER_TOKEN)
            _used = max(last_prompt_tokens or 0, _est)
            _pct = int(_used / _ctx_window * 100) if _ctx_window else 0
            yield {
                "type": "tool_start",
                "tool": "compaction",
                "display": "压缩对话历史…",
                "detail": f"上下文使用已达 {_pct}%，正在语义压缩以节省上下文空间",
            }
            _working_history, _compacted = compact_history(
                history=history,
                client=self.client,
                model=self.model,
            )
            yield {"type": "tool_end", "tool": "compaction"}
            log.info(
                "[compaction] trigger≈%d/%d tokens (%d%%) compacted=%s",
                _used, _ctx_window, _pct, _compacted,
            )
            # Push an immediate estimate so the frontend context bar reflects
            # the shrink right away — the precise value arrives later via the
            # real 'usage' event once this turn's LLM call returns.
            if _compacted:
                _est_after = _estimate_history_tokens(
                    _working_history, self._CHARS_PER_TOKEN
                ) + self._estimate_messages_tokens([_system_msg] + prior_reasoning_msg + [_user_msg])
                yield {
                    "type": "context_estimate",
                    "prompt_tokens": _est_after,
                    "context_window": _ctx_window,
                    "estimated": True,
                }
        else:
            _working_history = history

        # ── Hard truncation safety net ────────────────────────────────────────
        _pruned_history = self._hard_prune(
            system_msgs=[_system_msg],
            history=_working_history,
            extra_msgs=prior_reasoning_msg + [_user_msg],
            context_window=_ctx_window,
        )

        messages: List[Dict] = [
            _system_msg,
            *_pruned_history,
            *prior_reasoning_msg,
            _user_msg,
        ]

        pending_charts: List[str] = []
        all_reasoning: List[str] = []
        _consecutive_errors = 0
        _run_start = time.monotonic()
        _MAX_RUN_SECONDS = 300  # 5-minute hard ceiling
        _MAX_CONSECUTIVE_ERRORS = 3

        _PROPOSE_FLOW_CMDS = ("ppt", "ppt_revise", "export", "excel_revise",
                              "report", "report_revise", "dashboard", "dashboard_revise")

        _force_propose = False
        for _ in range(self.MAX_ITERATIONS):
            # ── Hard exit guards ──────────────────────────────────────────────
            if time.monotonic() - _run_start > _MAX_RUN_SECONDS:
                log.warning("[run] time limit reached (%.0fs)", _MAX_RUN_SECONDS)
                yield {"type": "text", "content": "分析超时，已终止。请尝试缩小问题范围后重试。"}
                yield {"type": "done"}
                return
            if _consecutive_errors >= _MAX_CONSECUTIVE_ERRORS:
                log.warning("[run] %d consecutive tool errors, aborting", _consecutive_errors)
                yield {"type": "text", "content": "连续工具调用失败，已终止。请检查数据源连接或简化查询。"}
                yield {"type": "done"}
                return

            if _force_propose:
                if command in ("ppt", "ppt_revise"):
                    nudge = (
                        "All data has been gathered in the tool results above. "
                        "Call propose_ppt_outline with a COMPLETE slides array (8–15 slides). "
                        "CRITICAL: use ONLY real numbers, labels, and values extracted from "
                        "the tool results in this conversation — do NOT fabricate or invent data. "
                        "Include: cover, toc, section_divider slides, at least 2 chart slides "
                        "(grouped_bar / donut / stacked_bar / timeline using the actual queried values), "
                        "and a closing slide. "
                        "Colors must be one of: NAVY, ACCENT_BLUE, ACCENT_GREEN, ACCENT_ORANGE, ACCENT_RED. "
                        "Output ONLY the tool call — no surrounding text."
                    )
                elif command in ("export", "excel_revise"):
                    nudge = (
                        "Call propose_excel_export now with the tables list and an optional filename. "
                        "Output ONLY the tool call — no surrounding text."
                    )
                elif command in ("dashboard", "dashboard_revise"):
                    nudge = (
                        "All data schema information has been gathered. "
                        "Call propose_dashboard_outline with a complete widgets array (2-6 widgets). "
                        "CRITICAL: use ONLY real table/column names from the schema — do NOT fabricate. "
                        "Each widget must have: title, chart_type, sql (valid SQL against the real tables), "
                        "field_mapping, and grid ({x,y,w,h}). "
                        "Output ONLY the tool call — no surrounding text."
                    )
                else:
                    nudge = (
                        "Compose the report outline from the conversation above and call "
                        "propose_report_outline with title and sections. "
                        "Output ONLY the tool call — no surrounding text."
                    )
                messages.append({"role": "user", "content": nudge})
                _force_propose = False
                _max_tokens = 131072
            else:
                _max_tokens = 131072

            call_kwargs: Dict[str, Any] = dict(
                model=self.model,
                messages=messages,
                tools=get_tools_with_mcp(self._mcp_manager),
                tool_choice="auto",
                temperature=0.1,
                max_tokens=_max_tokens,
            )

            if self.enable_thinking and self.model.startswith("claude"):
                _ctx = self._get_context_window()
                _used = self._estimate_messages_tokens(messages)
                _remaining = max(4000, _ctx - _used)
                _budget = self._adaptive_thinking_budget(_remaining)
                call_kwargs["temperature"] = 1
                call_kwargs["extra_body"] = {
                    "thinking": {"type": "enabled", "budget_tokens": _budget}
                }
                log.debug("[thinking] budget=%d (remaining≈%d tokens)", _budget, _remaining)

            # ── Streaming path ────────────────────────────────────────────────
            call_kwargs["stream"] = True
            call_kwargs["stream_options"] = {"include_usage": True}
            _t0 = time.monotonic()
            try:
                stream = _call_with_retry(self.client.chat.completions.create, **call_kwargs)
            except Exception as exc:
                log.error("[llm] API call failed after retries: %s", exc)
                retryable, _ = _is_retryable(exc)
                if retryable:
                    yield {"type": "error", "message": f"LLM 服务暂时不可用，请稍后重试: {exc}"}
                else:
                    yield {"type": "error", "message": f"LLM 调用失败: {exc}"}
                yield {"type": "done"}
                return

            tc_acc: Dict[int, Dict[str, str]] = {}
            content_parts: List[str] = []
            reasoning_parts: List[str] = []
            usage_data = None
            finish_reason = None

            for chunk in stream:
                if getattr(chunk, "usage", None):
                    usage_data = chunk.usage
                if not chunk.choices:
                    continue
                choice = chunk.choices[0]
                if choice.finish_reason:
                    finish_reason = choice.finish_reason
                delta = choice.delta

                if delta.content:
                    content_parts.append(delta.content)
                    if command not in _PROPOSE_CMDS:
                        yield {"type": "text_delta", "content": delta.content}

                rc = getattr(delta, "reasoning_content", None)
                if rc:
                    reasoning_parts.append(rc)

                if delta.tool_calls:
                    for tcd in delta.tool_calls:
                        idx = tcd.index
                        if idx not in tc_acc:
                            tc_acc[idx] = {"id": "", "name": "", "args": ""}
                        if tcd.id:
                            tc_acc[idx]["id"] = tcd.id
                        if tcd.function:
                            if tcd.function.name:
                                tc_acc[idx]["name"] += tcd.function.name
                            if tcd.function.arguments:
                                tc_acc[idx]["args"] += tcd.function.arguments

            full_content = "".join(content_parts)
            has_tool_calls = bool(tc_acc) and finish_reason == "tool_calls"
            reasoning_content = "".join(reasoning_parts) or None

            if usage_data:
                _elapsed = time.monotonic() - _t0
                log.info(
                    "[llm] stream done  finish=%s  in=%.0f out=%.0f  %.2fs",
                    finish_reason,
                    usage_data.prompt_tokens,
                    usage_data.completion_tokens,
                    _elapsed,
                )
                yield {
                    "type": "usage",
                    "prompt_tokens": usage_data.prompt_tokens,
                    "completion_tokens": usage_data.completion_tokens,
                    "total_tokens": usage_data.total_tokens,
                    # context_window lets the frontend draw the context bar and
                    # keeps the % shown there consistent with the compaction
                    # trigger (both use _get_context_window()).
                    "context_window": _ctx_window,
                }

            class _F:
                def __init__(self, name, arguments):
                    self.name = name
                    self.arguments = arguments

            class _TC:
                def __init__(self, id_, name, arguments):
                    self.id = id_
                    self.function = _F(name, arguments)

            tc_objects = [
                _TC(v["id"], v["name"], v["args"])
                for _, v in sorted(tc_acc.items())
            ]

            # ── Dispatch tool calls ───────────────────────────────────────────
            if has_tool_calls:
                asst_entry: Dict[str, Any] = {
                    "role": "assistant",
                    "content": full_content,
                    "tool_calls": [
                        {
                            "id": tc.id,
                            "type": "function",
                            "function": {
                                "name": tc.function.name,
                                "arguments": tc.function.arguments,
                            },
                        }
                        for tc in tc_objects
                    ],
                }
                if reasoning_content:
                    asst_entry["reasoning_content"] = reasoning_content
                    all_reasoning.append(reasoning_content)
                messages.append(asst_entry)

                _outline_proposed = False

                # Guard: if any tool call is a blocked output tool, cancel the whole
                # tool-call batch and instruct the model to reply with plain text.
                _OUTPUT_TOOL_GUARDS = {
                    "propose_ppt_outline":       {"ppt", "ppt_revise"},
                    "generate_ppt":              {"ppt_confirm"},
                    "propose_report_outline":    {"report", "report_revise"},
                    "export_report":             {"report_confirm"},
                    "propose_excel_export":      {"export", "excel_revise"},
                    "export_excel":              {"excel_confirm"},
                    "propose_dashboard_outline": {"dashboard", "dashboard_revise"},
                    "generate_dashboard":        {"dashboard_confirm"},
                }
                blocked = [
                    tc for tc in tc_objects
                    if tc.function.name in _OUTPUT_TOOL_GUARDS
                    and command not in _OUTPUT_TOOL_GUARDS[tc.function.name]
                ]
                if blocked:
                    blocked_names = ", ".join(tc.function.name for tc in blocked)
                    log.warning("[tool] blocked output tool(s): %s (command=%r)", blocked_names, command)
                    # asst_entry (with reasoning_content if present) was already appended at line 540.
                    # Only append fake tool results so the model can continue.
                    for tc in tc_objects:
                        if tc.function.name in _OUTPUT_TOOL_GUARDS:
                            content = (
                                f"[SYSTEM BLOCK] '{tc.function.name}' requires a slash command. "
                                "Do NOT call output tools in regular chat. "
                                "Reply to the user in plain text, and suggest the relevant slash command if appropriate."
                            )
                        else:
                            content = "ok"
                        messages.append({
                            "role": "tool",
                            "tool_call_id": tc.id,
                            "content": content,
                        })
                    continue  # next iteration — model will now reply in plain text

                _parsed_tools = []
                for tc in tc_objects:
                    name = tc.function.name
                    try:
                        args: Dict[str, Any] = json.loads(tc.function.arguments or "{}")
                    except json.JSONDecodeError:
                        log.warning("[tool] %s: invalid JSON args=%r, using {}", name, tc.function.arguments)
                        args = {}

                    # Pre-dispatch validation: catch obviously bad args early
                    _val_err = _validate_tool_args(name, args)
                    if _val_err:
                        log.warning("[tool] %s: arg validation failed: %s", name, _val_err)
                        # Inject as a synthetic tool result so the model can self-correct
                        messages.append({
                            "role": "tool",
                            "tool_call_id": tc.id,
                            "content": f"[ARG ERROR] {_val_err}",
                        })
                        yield {"type": "tool_end", "tool": name}
                        _consecutive_errors += 1
                        continue
                    display_map = {
                        "query_knowledge":       f"查询知识库: {args.get('question', '')}",
                        "get_schema":            "读取数据结构",
                        "create_analysis_table": f"提取字段 → {args.get('table_name', 'analysis_data')}",
                        "select_chart":          f"查询图表注册表: {args.get('user_intent', '?')[:40]}",
                        "query_data":            f"执行查询: {args.get('sql', '')}",
                        "run_analysis":          f"运行分析: {args.get('analysis_name', '?')} · 目标列: {args.get('target_column', '?')}",
                        "generate_chart":        f"生成 {args.get('chart_type', '?')} 图表",
                        "profile_data":          f"分析数据概况: {args.get('table_name', '自动检测')}",
                        "clean_data":            f"数据清洗 [{args.get('operation', '?')}]: {args.get('table_name', '自动检测')}",
                        "export_excel":          f"导出 Excel → {', '.join(args.get('tables', []))}",
                        "export_report":         f"生成 Word 报告: {args.get('title', '?')}",
                        "propose_excel_export":  f"预览 Excel 导出：{', '.join(args.get('tables', ['*']))}",
                        "propose_report_outline": f"生成报告大纲：{args.get('title', '?')}（{len(args.get('sections', []))} 章节）",
                        "propose_ppt_outline":   f"生成 PPT 大纲：{args.get('title', '?')} ({len(args.get('slides', []))} 张)",
                        "generate_ppt":          f"生成 PPT: {args.get('title', '?')} ({len(args.get('slides', []))} 张)",
                        "set_ppt_color_scheme":  f"切换配色方案 → {args.get('scheme', '?')}",
                        "propose_dashboard_outline": f"生成看板大纲：{args.get('name', '?')} ({len(args.get('widgets', []))} 个)",
                        "generate_dashboard":    f"生成看板：{args.get('name', '?')} ({len(args.get('widgets', []))} 个组件)",
                    }
                    full_display = display_map.get(name, name)
                    yield {
                        "type": "tool_start",
                        "tool": name,
                        "display": full_display[:60] + ("…" if len(full_display) > 60 else ""),
                        "detail": full_display,
                    }
                    _parsed_tools.append((tc, name, args))

                for tc, name, args in _parsed_tools:
                    _args_preview = {k: str(v)[:80] for k, v in args.items() if k != "slides"}
                    log.info("[tool] %s  args=%s", name, _args_preview)
                    _tool_t0 = time.monotonic()

                    try:
                        if name == "select_chart":
                            tool_result = self._tool_select_chart(
                                user_intent=args.get("user_intent", ""),
                                available_columns=args.get("available_columns", []),
                            )
                        elif name == "query_knowledge":
                            tool_result = self._tool_query_knowledge(
                                question=args.get("question", "")
                            )
                        elif name == "get_schema":
                            tool_result = self._tool_get_schema()
                        elif name == "create_analysis_table":
                            tool_result = self._tool_create_analysis_table(
                                sql=args.get("sql", ""),
                                table_name=args.get("table_name", "analysis_data"),
                            )
                        elif name == "query_data":
                            tool_result = self._tool_query_data(args.get("sql", ""))
                        elif name == "run_analysis":
                            tool_result = self._tool_run_analysis(
                                analysis_name=args.get("analysis_name", ""),
                                sql=args.get("sql", ""),
                                target_column=args.get("target_column", ""),
                                groupby_column=args.get("groupby_column", ""),
                                n_deciles=int(args.get("n_deciles", 10)),
                            )
                        elif name == "generate_chart":
                            chart = self._tool_generate_chart(
                                chart_type=args.get("chart_type", "Bar_Chart"),
                                sql=args.get("sql", ""),
                                field_mapping=args.get("field_mapping", {}),
                                title=args.get("title", ""),
                            )
                            if "html" in chart:
                                pending_charts.append(chart["html"])
                                yield {
                                    "type": "chart_placeholder",
                                    "index": len(pending_charts) - 1,
                                }
                                tool_result = (
                                    f"Chart generated ({args.get('chart_type')}). "
                                    "It is displayed to the user."
                                )
                            else:
                                tool_result = f"Chart failed: {chart.get('error', 'unknown')}"
                        elif name == "profile_data":
                            result = self._tool_profile_data(
                                table_name=args.get("table_name", ""),
                                columns=args.get("columns", []),
                            )
                            for html in result.get("charts", []):
                                pending_charts.append(html)
                                yield {
                                    "type": "chart_placeholder",
                                    "index": len(pending_charts) - 1,
                                }
                            tool_result = result.get("text", "数据概况生成失败。")
                        elif name == "clean_data":
                            tool_result = self._tool_clean_data(
                                operation=args.get("operation", ""),
                                table_name=args.get("table_name", ""),
                                columns=args.get("columns"),
                                fill_method=args.get("fill_method", "mean"),
                                lower_pct=float(args.get("lower_pct", 1)),
                                upper_pct=float(args.get("upper_pct", 99)),
                                trim_column=args.get("trim_column", ""),
                                min_val=args.get("min_val"),
                                max_val=args.get("max_val"),
                                output_table=args.get("output_table", "cleaned_data"),
                            )
                        elif name == "export_excel":
                            tool_result = self._tool_export_excel(
                                tables=args.get("tables", []),
                                filename=args.get("filename", ""),
                            )
                        elif name == "export_report":
                            tool_result = self._tool_export_report(
                                title=args.get("title", "分析报告"),
                                sections=args.get("sections", []),
                            )
                        elif name == "propose_excel_export":
                            result = self._tool_propose_excel_export(
                                tables=args.get("tables", ["*"]),
                                filename=args.get("filename", ""),
                                summary=args.get("summary", ""),
                            )
                            yield {
                                "type": "excel_outline",
                                "tables": result["tables"],
                                "filename": result["filename"],
                                "markdown": result["markdown"],
                            }
                            tool_result = "导出计划已展示给用户，等待其通过按钮确认或修改。请不要输出任何文字。"
                            _outline_proposed = True
                        elif name == "propose_report_outline":
                            result = self._tool_propose_report_outline(
                                title=args.get("title", "分析报告"),
                                sections=args.get("sections", []),
                            )
                            yield {
                                "type": "report_outline",
                                "title": result["title"],
                                "sections": result["sections"],
                                "markdown": result["markdown"],
                            }
                            tool_result = "报告大纲已展示给用户，等待其通过按钮确认或修改。请不要输出任何文字。"
                            _outline_proposed = True
                        elif name == "set_ppt_color_scheme":
                            tool_result = self._tool_set_ppt_color_scheme(
                                scheme=args.get("scheme", "mckinsey"),
                            )
                            yield {
                                "type": "ppt_scheme",
                                "scheme": self.ppt_color_scheme,
                            }
                        elif name == "propose_ppt_outline":
                            _ppt_slides = args.get("slides", [])
                            if not _ppt_slides:
                                tool_result = (
                                    "ERROR: slides array is empty. You MUST provide a "
                                    "slides array with 8-15 slide objects. Re-read the "
                                    "query results above and call propose_ppt_outline "
                                    "again with a complete slides list."
                                )
                            else:
                                result = self._tool_propose_ppt_outline(
                                    title=args.get("title", "演示文稿"),
                                    slides=_ppt_slides,
                                )
                                yield {
                                    "type": "ppt_outline",
                                    "title": result["title"],
                                    "slides": result["slides"],
                                    "markdown": result["markdown"],
                                }
                                tool_result = "大纲已展示给用户，等待其通过按钮确认或修改。"
                                _outline_proposed = True
                        elif name == "generate_ppt":
                            tool_result = self._tool_generate_ppt(
                                title=args.get("title", "Presentation"),
                                slides=args.get("slides", []),
                                filename=args.get("filename", ""),
                            )
                        elif name == "propose_dashboard_outline":
                            _dash_widgets = args.get("widgets", [])
                            if not _dash_widgets:
                                tool_result = (
                                    "ERROR: widgets array is empty. You MUST provide a "
                                    "widgets array with at least 1 widget object. Re-read "
                                    "the data schema and call propose_dashboard_outline "
                                    "again with a complete widgets list."
                                )
                            elif self.data_source is None:
                                result = self._tool_propose_dashboard_outline(
                                    name=args.get("name", "数据看板"),
                                    widgets=_dash_widgets,
                                )
                                yield {
                                    "type": "dashboard_outline",
                                    "name": result["name"],
                                    "widgets": result["widgets"],
                                    "markdown": result["markdown"],
                                }
                                tool_result = "看板大纲已展示给用户，等待其通过按钮确认或修改。请不要输出任何文字。"
                                _outline_proposed = True
                            else:
                                # Validate every widget SQL before showing outline
                                _sql_errors = []
                                for _w in _dash_widgets:
                                    _wsql = _w.get("sql", "").strip()
                                    if not _wsql:
                                        _sql_errors.append(
                                            f"Widget '{_w.get('title', '?')}' has empty SQL."
                                        )
                                        continue
                                    # Wrap in a subquery with LIMIT 1 to keep validation cheap
                                    _test_sql = (
                                        f"SELECT * FROM ({_wsql}) AS __val__ LIMIT 1"
                                    )
                                    try:
                                        _df, _err = self.data_source.execute_query(_test_sql)
                                    except Exception as _exc:
                                        _err = str(_exc)
                                    if _err:
                                        _sql_errors.append(
                                            f"Widget '{_w.get('title', '?')}': {_err}"
                                        )
                                if _sql_errors:
                                    _real_schema = self._tool_get_schema() if hasattr(self, "_tool_get_schema") else ""
                                    tool_result = (
                                        "ERROR: The following widget SQL queries are invalid — "
                                        "they reference tables or columns that do NOT exist in "
                                        "the actual data source. You MUST fix them and call "
                                        "propose_dashboard_outline again.\n\n"
                                        "FAILED QUERIES:\n"
                                        + "\n".join(f"  - {e}" for e in _sql_errors)
                                        + (f"\n\nREAL SCHEMA:\n{_real_schema}" if _real_schema else "")
                                    )
                                else:
                                    result = self._tool_propose_dashboard_outline(
                                        name=args.get("name", "数据看板"),
                                        widgets=_dash_widgets,
                                    )
                                    yield {
                                        "type": "dashboard_outline",
                                        "name": result["name"],
                                        "widgets": result["widgets"],
                                        "markdown": result["markdown"],
                                    }
                                    tool_result = "看板大纲已展示给用户，等待其通过按钮确认或修改。请不要输出任何文字。"
                                    _outline_proposed = True
                        elif name == "generate_dashboard":
                            tool_result = self._tool_generate_dashboard(
                                name=args.get("name", "数据看板"),
                                widgets=args.get("widgets", []),
                                color_scheme=args.get("color_scheme", ""),
                            )
                        elif name.startswith("mcp__"):
                            tool_result = self._mcp_manager.call_tool(name, args)
                        else:
                            tool_result = f"Unknown tool: {name}"

                    except Exception as exc:
                        tool_result = f"工具执行错误 [{name}]: {exc}"
                        log.error("[tool] %s FAILED (%.2fs): %s", name, time.monotonic() - _tool_t0, exc)
                        _consecutive_errors += 1
                    else:
                        _consecutive_errors = 0
                        _result_preview = str(tool_result)[:120].replace("\n", " ")
                        log.info("[tool] %s OK  %.2fs  result=%r", name, time.monotonic() - _tool_t0, _result_preview)

                    messages.append(
                        {"role": "tool", "tool_call_id": tc.id, "content": str(tool_result)}
                    )
                    yield {"type": "tool_end", "tool": name}

                if _outline_proposed:
                    for html in pending_charts:
                        yield {"type": "chart_html", "html": html}
                    pending_charts.clear()
                    yield {"type": "done"}
                    return

            # ── Final text response ───────────────────────────────────────────
            else:
                if reasoning_content:
                    all_reasoning.append(reasoning_content)

                if command in _PROPOSE_FLOW_CMDS:
                    messages.append({"role": "assistant", "content": full_content})
                    _force_propose = True
                    continue

                if all_reasoning:
                    yield {"type": "reasoning", "content": "\n\n---\n\n".join(all_reasoning)}

                for html in pending_charts:
                    yield {"type": "chart_html", "html": html}

                yield {"type": "text", "content": full_content}
                log.info("[run] finished normally  model=%s", self.model)
                yield {"type": "done"}
                return

        log.warning("[run] max iterations reached  model=%s", self.model)
        yield {
            "type": "text",
            "content": "分析完成（已达到最大工具调用次数）。Analysis complete (max iterations reached).",
        }
        yield {"type": "done"}
