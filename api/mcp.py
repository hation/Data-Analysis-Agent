#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MCP server configuration API — Flask Blueprint."""
import os
import re
import threading
from flask import Blueprint, request, jsonify

bp = Blueprint("mcp", __name__)

# Shell metacharacters that must not appear in stdio args
_SHELL_META_RE = re.compile(r'[;&|`$<>()\n]|\|\||&&')

# Env keys that could hijack subprocess execution
_BLOCKED_ENV_KEYS = frozenset({
    "PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH", "PYTHONPATH",
})

# Mirrored from mcp_manager — validated at API layer before reaching transport
from agent.mcp_manager import STDIO_ALLOWED_COMMANDS


def _validate_stdio(command: str, args: list, env: dict) -> tuple[bool, str]:
    basename = os.path.basename(command or "")
    if basename not in STDIO_ALLOWED_COMMANDS:
        return False, f"命令 '{command}' 不在安全白名单中（允许: {', '.join(sorted(STDIO_ALLOWED_COMMANDS))}）"
    for arg in args:
        if _SHELL_META_RE.search(str(arg)):
            return False, f"参数包含不允许的 shell 特殊字符: {arg!r}"
    for key in env:
        if key in _BLOCKED_ENV_KEYS:
            return False, f"不允许覆盖环境变量: {key}"
    return True, ""


def _get_managers():
    from LLM.mcp_config_manager import get_mcp_config_manager
    from agent.mcp_manager import get_mcp_manager
    return get_mcp_config_manager(), get_mcp_manager()


@bp.get("/api/mcp/servers")
def list_servers():
    cfg_mgr, mcp_mgr = _get_managers()
    servers = cfg_mgr.list_servers()
    runtime = {s["server_id"]: s for s in mcp_mgr.get_all_status()}
    result = []
    for sid, cfg in servers.items():
        entry = dict(cfg)
        rt = runtime.get(sid, {})
        entry["status"] = rt.get("status", "disconnected")
        entry["last_error"] = rt.get("last_error", "")
        entry["tool_count"] = rt.get("tool_count", 0)
        result.append(entry)
    return jsonify({"servers": result})


@bp.post("/api/mcp/servers")
def add_server():
    data = request.get_json(force=True) or {}
    server_id = (data.get("server_id") or "").strip()
    label     = (data.get("label") or server_id).strip()
    transport = (data.get("transport") or "").strip()
    description = (data.get("description") or "").strip()

    if not server_id:
        return jsonify({"error": "server_id 不能为空"}), 400
    if transport not in ("stdio", "sse"):
        return jsonify({"error": "transport 必须是 'stdio' 或 'sse'"}), 400

    if transport == "stdio":
        command = (data.get("command") or "").strip()
        args    = data.get("args", [])
        env     = data.get("env", {})
        if not isinstance(args, list):
            return jsonify({"error": "args 必须是数组"}), 400
        if not isinstance(env, dict):
            return jsonify({"error": "env 必须是对象"}), 400
        ok, err = _validate_stdio(command, args, env)
        if not ok:
            return jsonify({"error": err}), 400
        url = ""
        headers = {}
    else:
        url = (data.get("url") or "").strip()
        headers = data.get("headers", {})
        if not url:
            return jsonify({"error": "SSE transport 需要 url"}), 400
        if not isinstance(headers, dict):
            return jsonify({"error": "headers 必须是对象"}), 400
        command, args, env = "", [], {}

    from LLM.mcp_config_manager import MCPServerConfig, get_mcp_config_manager
    from agent.mcp_manager import get_mcp_manager

    cfg = MCPServerConfig(
        server_id=server_id, label=label, transport=transport,
        description=description, enabled=True,
        command=command, args=args, env=env,
        url=url, headers=headers,
    )
    cfg_mgr = get_mcp_config_manager()
    ok, msg = cfg_mgr.add_server(cfg)
    if not ok:
        return jsonify({"error": msg}), 400

    mcp_mgr = get_mcp_manager()
    mcp_mgr.add_server(cfg)

    # Trigger lazy connect in background — non-blocking response
    def _connect_bg():
        mcp_mgr.connect_server(server_id)

    threading.Thread(target=_connect_bg, daemon=True, name=f"mcp-connect-{server_id}").start()

    return jsonify({"ok": True, "message": msg, "server_id": server_id}), 201


@bp.put("/api/mcp/servers/<server_id>")
def update_server(server_id: str):
    data = request.get_json(force=True) or {}
    cfg_mgr, mcp_mgr = _get_managers()
    existing = cfg_mgr.get_server(server_id)
    if not existing:
        return jsonify({"error": "服务器不存在"}), 404

    transport = (data.get("transport") or existing.transport).strip()
    label       = (data.get("label") or existing.label).strip()
    description = data.get("description", existing.description)

    updates = {"label": label, "description": description, "transport": transport}

    if transport == "stdio":
        command = (data.get("command") or existing.command).strip()
        args    = data.get("args", existing.args)
        env     = data.get("env", existing.env)
        if not isinstance(args, list):
            return jsonify({"error": "args 必须是数组"}), 400
        if not isinstance(env, dict):
            return jsonify({"error": "env 必须是对象"}), 400
        ok, err = _validate_stdio(command, args, env)
        if not ok:
            return jsonify({"error": err}), 400
        updates.update(command=command, args=args, env=env, url="", headers={})
    else:
        url     = (data.get("url") or existing.url).strip()
        headers = data.get("headers", existing.headers)
        if not url:
            return jsonify({"error": "SSE transport 需要 url"}), 400
        if not isinstance(headers, dict):
            return jsonify({"error": "headers 必须是对象"}), 400
        updates.update(url=url, headers=headers, command="", args=[], env={})

    ok, msg = cfg_mgr.update_server(server_id, **updates)
    if not ok:
        return jsonify({"error": msg}), 400

    # Re-register updated config and reconnect
    mcp_mgr.remove_server(server_id)
    mcp_mgr.add_server(cfg_mgr.get_server(server_id))
    def _bg():
        mcp_mgr.connect_server(server_id)
    threading.Thread(target=_bg, daemon=True, name=f"mcp-reconnect-{server_id}").start()

    return jsonify({"ok": True, "message": msg})


@bp.delete("/api/mcp/servers/<server_id>")
def remove_server(server_id: str):
    cfg_mgr, mcp_mgr = _get_managers()
    mcp_mgr.remove_server(server_id)
    ok, msg = cfg_mgr.remove_server(server_id)
    if not ok:
        return jsonify({"error": msg}), 404
    return jsonify({"ok": True, "message": msg})


@bp.post("/api/mcp/servers/<server_id>/enable")
def enable_server(server_id: str):
    cfg_mgr, _ = _get_managers()
    ok, msg = cfg_mgr.set_enabled(server_id, True)
    if not ok:
        return jsonify({"error": msg}), 404
    return jsonify({"ok": True, "message": msg})


@bp.post("/api/mcp/servers/<server_id>/disable")
def disable_server(server_id: str):
    cfg_mgr, _ = _get_managers()
    ok, msg = cfg_mgr.set_enabled(server_id, False)
    if not ok:
        return jsonify({"error": msg}), 404
    return jsonify({"ok": True, "message": msg})


@bp.post("/api/mcp/servers/<server_id>/connect")
def connect_server(server_id: str):
    _, mcp_mgr = _get_managers()

    def _bg():
        mcp_mgr.connect_server(server_id)

    threading.Thread(target=_bg, daemon=True, name=f"mcp-connect-{server_id}").start()
    return jsonify({"ok": True, "message": f"正在连接 {server_id}…"})


@bp.get("/api/mcp/servers/<server_id>/tools")
def server_tools(server_id: str):
    _, mcp_mgr = _get_managers()
    status = mcp_mgr.get_server_status(server_id)
    if not status:
        return jsonify({"error": "服务器不存在"}), 404
    tools = mcp_mgr.get_server_tools(server_id)
    return jsonify({"server_id": server_id, "tools": tools})
