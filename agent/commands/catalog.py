"""Protected built-in slash-command catalog.

Business analysis workflows live under ``skills/``.  This catalog contains
only MewCode-style application control commands.
"""
from __future__ import annotations

from pathlib import Path

from .models import CommandDef, CommandType
from .parser import CommandError, parse_command_file
from infrastructure.paths import resource_path

PROJECT_COMMANDS_DIR = resource_path("commands")

_FALLBACK = (
    ("help", "查看智析 Agent 可用命令及使用方法", "❓", "tools"),
    ("clear", "清除当前对话内容，保留数据源、模型和工作目录连接", "🧹", "session"),
    ("compact", "立即压缩当前对话上下文，保留关键结论和最近内容", "🗜️", "session"),
    ("instruction", "设置仅对当前分析对话生效的临时指令", "📝", "session"),
    ("sessions", "刷新已保存对话，或新建分析对话", "💬", "session"),
    ("mcp", "打开 MCP 连接与工具管理", "🔌", "tools"),
    ("knowledge", "打开业务知识库，管理指标口径、规则和参考资料", "🧠", "tools"),
    ("workspace", "连接工作目录并设置只读或可编辑权限", "📁", "tools"),
    ("checkpoint", "查看对话快照并回退文件、对话或两者", "⏪", "tools"),
    ("status", "查看当前模型、数据源和 Token 上下文状态", "📡", "tools"),
    ("skills", "查看、选择或刷新数据分析 Skill", "🧩", "tools"),
)

_FALLBACK_ACTIONS = {
    "instruction": "plan",
    "sessions": "session", "knowledge": "memory", "workspace": "permission",
    "checkpoint": "rewind", "skills": "skill",
}


def builtin_commands() -> tuple[CommandDef, ...]:
    if PROJECT_COMMANDS_DIR.is_dir():
        loaded: list[CommandDef] = []
        for path in sorted(PROJECT_COMMANDS_DIR.rglob("*.md")):
            try:
                command = parse_command_file(
                    PROJECT_COMMANDS_DIR, path,
                    source="builtin", allow_trusted_types=True,
                )
            except CommandError:
                continue
            loaded.append(command)
        if loaded:
            return tuple(loaded)

    # Packaging fallback for installations missing the command content folder.
    commands: list[CommandDef] = []
    for name, description, icon, category in _FALLBACK:
        commands.append(CommandDef(
            name=name, description=description, type=CommandType.LOCAL,
            icon=icon, category=category,
            handler_key=f"client:{_FALLBACK_ACTIONS.get(name, name)}",
            protected=True,
        ))
    return tuple(commands)
