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
from typing import Iterator, List, Dict, Any, Optional

from .prompts      import SYSTEM_PROMPT, COMMAND_HINTS
from .tools_schema import AGENT_TOOLS
from .tools_data   import DataToolsMixin
from .tools_export import ExportToolsMixin

log = logging.getLogger(__name__)


class BusinessAgent(DataToolsMixin, ExportToolsMixin):
    MAX_ITERATIONS = 100

    def __init__(
        self,
        client,
        model: str,
        data_source=None,
        enable_thinking: bool = False,
        chart_store: Optional[dict] = None,
        session_chart_ids: Optional[List[str]] = None,
        color_scheme: str = "mckinsey",
    ):
        self.client = client
        self.model = model
        self.data_source = data_source
        self.enable_thinking = enable_thinking
        self._schema_cache: Optional[str] = None
        self._chart_store: dict = chart_store if chart_store is not None else {}
        self._session_chart_ids: List[str] = session_chart_ids if session_chart_ids is not None else []
        self.ppt_color_scheme: str = color_scheme

    def set_data_source(self, source):
        self.data_source = source
        self._schema_cache = None

    # ── Agent loop ────────────────────────────────────────────────────────────

    def run(
        self,
        user_message: str,
        history: List[Dict],
        command: str = "",
        ppt_title: str = "",
        ppt_slides: Optional[List] = None,
        excel_tables: Optional[List] = None,
        excel_filename: str = "",
        report_title: str = "",
        report_sections: Optional[List] = None,
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

        _NO_DATASOURCE_OK = (
            "ppt", "ppt_confirm", "ppt_revise",
            "excel_confirm", "excel_revise",
            "report_confirm", "report_revise",
        )
        if not self.data_source and command not in _NO_DATASOURCE_OK:
            yield {
                "type": "text",
                "content": (
                    "请先连接数据源（上传 Excel 文件或连接 SQL 数据库），然后再开始分析。\n\n"
                    "Please connect a data source (upload Excel or connect to a SQL database) first."
                ),
            }
            yield {"type": "done"}
            return

        system = SYSTEM_PROMPT
        if command and command in COMMAND_HINTS:
            system += f"\n\n[ACTIVE COMMAND: /{command}]\n{COMMAND_HINTS[command]}"

        messages: List[Dict] = [
            {"role": "system", "content": system},
            *history[-20:],
            {"role": "user", "content": user_message},
        ]

        pending_charts: List[str] = []
        all_reasoning: List[str] = []

        _PROPOSE_FLOW_CMDS = ("ppt", "ppt_revise", "export", "excel_revise",
                              "report", "report_revise")

        _force_propose = False
        for _ in range(self.MAX_ITERATIONS):
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
                else:
                    nudge = (
                        "Compose the report outline from the conversation above and call "
                        "propose_report_outline with title and sections. "
                        "Output ONLY the tool call — no surrounding text."
                    )
                messages.append({"role": "user", "content": nudge})
                _force_propose = False
                _max_tokens = 16384
            else:
                _max_tokens = 8192 if command in _PROPOSE_FLOW_CMDS else 2048

            call_kwargs: Dict[str, Any] = dict(
                model=self.model,
                messages=messages,
                tools=AGENT_TOOLS,
                tool_choice="auto",
                temperature=0.1,
                max_tokens=_max_tokens,
            )

            use_stream = True
            if self.enable_thinking and self.model.startswith("claude"):
                use_stream = False
                call_kwargs["temperature"] = 1
                call_kwargs["extra_body"] = {
                    "thinking": {"type": "enabled", "budget_tokens": 8000}
                }

            # ── Streaming path ────────────────────────────────────────────────
            if use_stream:
                call_kwargs["stream"] = True
                call_kwargs["stream_options"] = {"include_usage": True}
                _t0 = time.monotonic()
                try:
                    stream = self.client.chat.completions.create(**call_kwargs)
                except Exception as exc:
                    log.error("[llm] API call failed: %s", exc)
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
                        _PROPOSE_CMDS = ("ppt", "ppt_revise", "export", "excel_revise",
                                         "report", "report_revise")
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

            # ── Non-streaming path (thinking mode) ────────────────────────────
            else:
                _t0 = time.monotonic()
                try:
                    resp = self.client.chat.completions.create(**call_kwargs)
                except Exception as exc:
                    log.error("[llm] API call failed (non-stream): %s", exc)
                    yield {"type": "error", "message": f"LLM 调用失败: {exc}"}
                    yield {"type": "done"}
                    return

                if resp.usage:
                    _elapsed = time.monotonic() - _t0
                    log.info(
                        "[llm] done (thinking)  in=%.0f out=%.0f  %.2fs",
                        resp.usage.prompt_tokens,
                        resp.usage.completion_tokens,
                        _elapsed,
                    )
                    yield {
                        "type": "usage",
                        "prompt_tokens": resp.usage.prompt_tokens,
                        "completion_tokens": resp.usage.completion_tokens,
                        "total_tokens": resp.usage.total_tokens,
                    }

                choice = resp.choices[0]
                msg = choice.message
                full_content = msg.content or ""
                tc_objects = msg.tool_calls or []
                has_tool_calls = bool(tc_objects) and choice.finish_reason == "tool_calls"
                reasoning_content = getattr(msg, "reasoning_content", None)

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

                _parsed_tools = []
                for tc in tc_objects:
                    name = tc.function.name
                    try:
                        args: Dict[str, Any] = json.loads(tc.function.arguments or "{}")
                    except json.JSONDecodeError:
                        args = {}
                    display_map = {
                        "get_schema":            "读取数据结构...",
                        "create_analysis_table": f"提取字段 → {args.get('table_name', 'analysis_data')}...",
                        "query_data":            f"执行查询: {args.get('sql', '')[:60]}...",
                        "run_analysis":          f"运行分析: {args.get('analysis_name', '?')} · 目标列: {args.get('target_column', '?')}...",
                        "generate_chart":        f"生成 {args.get('chart_type', '?')} 图表...",
                        "profile_data":          f"分析数据概况: {args.get('table_name', '自动检测')}...",
                        "clean_data":            f"数据清洗 [{args.get('operation', '?')}]: {args.get('table_name', '自动检测')}...",
                        "export_excel":          f"导出 Excel → {', '.join(args.get('tables', []))[:50]}...",
                        "export_report":         f"生成 Word 报告: {args.get('title', '?')[:40]}...",
                        "propose_excel_export":  f"预览 Excel 导出：{', '.join(args.get('tables', ['*']))[:40]}...",
                        "propose_report_outline": f"生成报告大纲：{args.get('title', '?')[:40]}（{len(args.get('sections', []))} 章节）...",
                        "propose_ppt_outline":   f"生成 PPT 大纲：{args.get('title', '?')[:40]} ({len(args.get('slides', []))} 张)...",
                        "generate_ppt":          f"生成 PPT: {args.get('title', '?')[:40]} ({len(args.get('slides', []))} 张)...",
                        "set_ppt_color_scheme":  f"切换配色方案 → {args.get('scheme', '?')}...",
                    }
                    yield {
                        "type": "tool_start",
                        "tool": name,
                        "display": display_map.get(name, name),
                    }
                    _parsed_tools.append((tc, name, args))

                for tc, name, args in _parsed_tools:
                    _args_preview = {k: str(v)[:80] for k, v in args.items() if k != "slides"}
                    log.info("[tool] %s  args=%s", name, _args_preview)
                    _tool_t0 = time.monotonic()

                    try:
                        if name == "get_schema":
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
                        else:
                            tool_result = f"Unknown tool: {name}"

                    except Exception as exc:
                        tool_result = f"工具执行错误 [{name}]: {exc}"
                        log.error("[tool] %s FAILED (%.2fs): %s", name, time.monotonic() - _tool_t0, exc)
                    else:
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
