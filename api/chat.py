"""Blueprint: conversation (SSE streaming) and chart serving."""
import json
import logging
import time
import uuid

from flask import Blueprint, request, Response, jsonify

from .state import session_manager, config_manager, chart_store
from agent.agent import BusinessAgent

log = logging.getLogger(__name__)
bp = Blueprint("chat", __name__)


def _build_agent(sess) -> BusinessAgent:
    provider = sess.model_provider or config_manager.get_default_provider()
    if not provider:
        raise ValueError("未配置任何 LLM 模型，请先在「模型设置」中添加模型。")
    from LLM.llm_config_manager import get_llm_client
    client = get_llm_client(provider)
    cfg = config_manager.get_config(provider)
    # Use cached schema when available; recompute only after data source changes
    # (cache is invalidated by add_source / remove_source / toggle_source / data_source setter).
    if hasattr(sess, "get_combined_schema"):
        if not getattr(sess, "_combined_schema_cache", None):
            sess._combined_schema_cache = sess.get_combined_schema()
        combined_schema = sess._combined_schema_cache
    else:
        combined_schema = None
    active_sources = [e["source"] for e in sess._active_entries()] \
        if hasattr(sess, "_active_entries") else []
    if not active_sources and sess.data_source:
        active_sources = [sess.data_source]

    src_names = [getattr(s, "name", "?") for s in active_sources]
    log.debug("[chat] build_agent  provider=%s  model=%s  active_sources=%s",
              provider, cfg.model, src_names)

    return BusinessAgent(
        client=client, model=cfg.model, data_source=sess.data_source,
        combined_schema=combined_schema,
        all_sources=active_sources,
        enable_thinking=cfg.enable_thinking,
        thinking_budget=cfg.thinking_budget,
        chart_store=chart_store,
        session_chart_ids=list(getattr(sess, "chart_ids", [])),
        color_scheme=getattr(sess, "ppt_color_scheme", "mckinsey"),
        session_id=sess.session_id,
        context_window=getattr(cfg, "context_window", None),
        max_output_tokens=getattr(cfg, "max_output_tokens", None),
    )


# ── Session lifecycle ──────────────────────────────────────────────────────

@bp.post("/api/session/new")
def new_session():
    sess = session_manager.create()
    log.info("[session] created  sid=%s", sess.session_id)
    return jsonify({"session_id": sess.session_id})


@bp.get("/api/session/<sid>/ping")
def ping_session(sid: str):
    sess = session_manager.get(sid)
    if not sess:
        log.debug("[session] ping  sid=%s  alive=False", sid)
        return jsonify({"alive": False}), 404
    from api.saved_sessions import _visible_msg_count
    cnt = _visible_msg_count(sess.history)
    log.debug("[session] ping  sid=%s  alive=True  msg_count=%d", sid, cnt)
    return jsonify({"alive": True, "msg_count": cnt})


@bp.get("/api/session/<sid>/load-current")
def load_current_session(sid: str):
    sess = session_manager.get(sid)
    if not sess:
        log.warning("[session] load-current  sid=%s  not found", sid)
        return jsonify({"error": "session not found"}), 404
    from api.saved_sessions import _visible_msg_count
    cnt = _visible_msg_count(sess.history)
    log.info("[session] load-current  sid=%s  msg_count=%d", sid, cnt)
    return jsonify({
        "history":      sess.history,
        "total_input":  sess.total_input_tokens,
        "total_output": sess.total_output_tokens,
        "msg_count":    cnt,
    })


@bp.post("/api/session/<sid>/clear")
def clear_history(sid: str):
    sess = session_manager.get_or_create(sid)
    old_count = len(sess.history)
    sess.clear_history()
    log.info("[session] clear  sid=%s  cleared=%d entries", sid, old_count)
    return jsonify({"ok": True})


# ── Chart serving ──────────────────────────────────────────────────────────

@bp.get("/api/chart/<chart_id>")
def serve_chart(chart_id: str):
    html = chart_store.get(chart_id)
    if not html:
        log.warning("[chart] not found  chart_id=%s", chart_id)
        return "Chart not found", 404
    return Response(html, mimetype="text/html")


# ── Stop ───────────────────────────────────────────────────────────────────

@bp.post("/api/session/<sid>/stop")
def stop_session(sid: str):
    sess = session_manager.get(sid)
    if sess:
        sess.cancel_requested = True
        log.info("[session] stop requested  sid=%s", sid)
    return jsonify({"ok": True})


# ── Chat SSE ───────────────────────────────────────────────────────────────

@bp.post("/api/session/<sid>/chat")
def chat_stream(sid: str):
    d = request.json or {}
    message = (d.get("message") or "").strip()
    command = (d.get("command") or "").strip()
    if not message:
        return jsonify({"error": "消息不能为空"}), 400

    sess = session_manager.get_or_create(sid)
    sess.cancel_requested = False

    from api.saved_sessions import _visible_msg_count
    _turn_start = time.monotonic()
    log.info("[chat] turn start  sid=%s  command=%r  history=%d msgs  msg=%.80r",
             sid, command or "(none)", _visible_msg_count(sess.history), message)

    def _sse(obj) -> str:
        return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"

    def generate():
        try:
            agent = _build_agent(sess)
        except ValueError as exc:
            log.error("[chat] build_agent failed  sid=%s  error=%s", sid, exc)
            yield _sse({"type": "error", "message": str(exc)})
            yield _sse({"type": "done"})
            return

        collected: list[str] = []
        collected_reasoning: list[str] = []
        turn_chart_ids: list[str] = []
        completed_normally = False
        tool_calls_in_turn: list[str] = []

        ppt_title       = d.get("ppt_title", "")
        ppt_slides      = d.get("ppt_slides") or []
        excel_tables    = d.get("excel_tables") or []
        excel_filename  = d.get("excel_filename", "")
        report_title    = d.get("report_title", "")
        report_sections = d.get("report_sections") or []
        dashboard_name    = d.get("dashboard_name", "")
        dashboard_widgets = d.get("dashboard_widgets") or []

        try:
            for event in agent.run(
                message, list(sess.history), command=command,
                last_reasoning=getattr(sess, "last_reasoning", ""),
                last_prompt_tokens=getattr(sess, "last_prompt_tokens", 0),
                ppt_title=ppt_title, ppt_slides=ppt_slides,
                excel_tables=excel_tables, excel_filename=excel_filename,
                report_title=report_title, report_sections=report_sections,
                dashboard_name=dashboard_name, dashboard_widgets=dashboard_widgets,
            ):
                if sess.cancel_requested:
                    sess.cancel_requested = False
                    log.info("[chat] cancelled by user  sid=%s", sid)
                    yield _sse({"type": "stopped"})
                    return

                etype = event.get("type")

                if etype == "chart_html":
                    cid = uuid.uuid4().hex
                    chart_store[cid] = event["html"]
                    if not hasattr(sess, "chart_ids"):
                        sess.chart_ids = []
                    sess.chart_ids.append(cid)
                    turn_chart_ids.append(cid)
                    log.info("[chat] chart generated  sid=%s  chart_id=%s", sid, cid)
                    yield _sse({"type": "chart_ref", "chart_id": cid})
                elif etype == "chart_placeholder":
                    pass
                elif etype == "ppt_scheme":
                    sess.ppt_color_scheme = event.get("scheme", "mckinsey")
                elif etype == "usage":
                    sess.record_usage(
                        event.get("prompt_tokens", 0),
                        event.get("completion_tokens", 0),
                    )
                    cfg = config_manager.get_config(sess.model_provider)
                    enriched = {
                        **event,
                        "max_output_tokens": cfg.max_output_tokens if cfg else None,
                        "session_total_input":  sess.total_input_tokens,
                        "session_total_output": sess.total_output_tokens,
                    }
                    if not enriched.get("context_window"):
                        enriched["context_window"] = cfg.context_window if cfg else None
                    yield _sse(enriched)
                else:
                    yield _sse(event)

                if etype == "text":
                    collected.append(event.get("content", ""))
                elif etype == "reasoning":
                    collected_reasoning.append(event.get("content", ""))
                elif etype == "tool_history":
                    msgs = event.get("messages", [])
                    sess.add_tool_messages(msgs)
                    names = [m.get("tool_calls", [{}])[0].get("function", {}).get("name", "")
                             for m in msgs if m.get("role") == "assistant" and m.get("tool_calls")]
                    tool_calls_in_turn.extend(n for n in names if n)
                elif etype == "tool_start":
                    pass  # already logged by agent.py

            completed_normally = True
            sess.add_user(message)
            sess.add_assistant(
                "".join(collected),
                reasoning="".join(collected_reasoning),
                chart_ids=turn_chart_ids,
            )

            elapsed = time.monotonic() - _turn_start
            reply_preview = "".join(collected)[:120].replace("\n", " ")
            log.info(
                "[chat] turn done  sid=%s  elapsed=%.2fs  tools=%s  charts=%d  "
                "total_in=%d  total_out=%d  reply=%.120r",
                sid, elapsed, tool_calls_in_turn or "none",
                len(turn_chart_ids), sess.total_input_tokens, sess.total_output_tokens,
                reply_preview,
            )

        except Exception as exc:
            log.exception("[chat] unhandled agent error  sid=%s", sid)
            yield _sse({"type": "error", "message": f"内部错误：{exc}"})

        finally:
            yield _sse({"type": "done"})

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
    )
