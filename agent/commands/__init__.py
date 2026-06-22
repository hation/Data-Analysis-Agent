"""Slash Command contracts and registry."""

from .catalog import builtin_commands
from .dispatcher import (
    CommandDispatcher, CommandDispatchError, CommandDispatchResult,
    ParsedCommand, parse_slash_command, render_command_prompt,
)
from .loader import CommandDiagnostic, CommandLoader
from .models import CommandDef, CommandType
from .parser import CommandError, parse_command_file
from .registry import CommandRegistry

__all__ = [
    "CommandDef", "CommandRegistry", "CommandType", "CommandLoader",
    "CommandDiagnostic", "CommandError", "CommandDispatcher",
    "CommandDispatchError", "CommandDispatchResult", "ParsedCommand",
    "builtin_commands", "parse_command_file", "parse_slash_command",
    "render_command_prompt",
]
