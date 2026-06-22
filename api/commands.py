"""Public catalog and trusted local-command endpoints."""
import logging

from flask import Blueprint, jsonify, request

from agent.commands import CommandLoader
from .state import config_manager, session_manager

bp = Blueprint("commands", __name__)
log = logging.getLogger(__name__)


@bp.get("/api/commands")
def list_commands():
    workspace_dir = None
    sid = (request.args.get("sid") or "").strip()
    if sid:
        from data.workspace import workspace_manager
        runtime = workspace_manager.get(sid)
        if runtime:
            workspace_dir = runtime.workdir / ".baa" / "commands"
    loader = CommandLoader(workspace_dir=workspace_dir)
    registry = loader.load()
    return jsonify({
        "commands": [item.to_public_dict() for item in registry.all()],
        "diagnostics": [item.to_dict() for item in loader.diagnostics()],
    })


@bp.post("/api/session/<sid>/commands/compact")
def compact_conversation(sid: str):
    """Immediately summarize older conversation history with the active model."""
    sess = session_manager.get_or_create(sid)
    if len(sess.history) < 4:
        return jsonify({
            "ok": False,
            "code": "not_enough_context",
            "error": "当前对话内容较少，暂时不需要压缩。",
        }), 409

    provider = sess.model_provider or config_manager.get_default_provider()
    if not provider:
        return jsonify({"ok": False, "error": "请先配置并选择模型。"}), 400
    try:
        from LLM.llm_config_manager import get_llm_client
        from agent.compaction import _estimate_history_tokens, compact_history

        cfg = config_manager.get_config(provider)
        client = get_llm_client(provider)
        before_messages = len(sess.history)
        before_tokens = _estimate_history_tokens(sess.history)
        compacted, changed = compact_history(sess.history, client, cfg.model)
        if not changed:
            return jsonify({
                "ok": False,
                "code": "compaction_failed",
                "error": "上下文压缩未完成，请检查当前模型连接后重试。",
            }), 502
        sess.history = compacted
        after_tokens = _estimate_history_tokens(compacted)
        sess.last_prompt_tokens = after_tokens
        return jsonify({
            "ok": True,
            "before_messages": before_messages,
            "after_messages": len(compacted),
            "before_tokens": before_tokens,
            "after_tokens": after_tokens,
        })
    except Exception as exc:
        log.exception("[commands] manual compaction failed sid=%s: %s", sid, exc)
        return jsonify({"ok": False, "error": "上下文压缩失败，请检查模型连接后重试。"}), 502
