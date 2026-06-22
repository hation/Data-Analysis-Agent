"""Multi-source Command loader with protected built-in definitions."""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path

from .catalog import builtin_commands
from .models import CommandDef, CommandSource
from .parser import CommandError, parse_command_file
from .registry import CommandRegistry

log = logging.getLogger(__name__)
DEFAULT_USER_DIR = Path(os.getenv("BAA_COMMANDS_DIR", "~/.baa/commands")).expanduser()


@dataclass(frozen=True)
class CommandDiagnostic:
    path: str
    source: str
    error: str

    def to_dict(self) -> dict[str, str]:
        return {"path": self.path, "source": self.source, "error": self.error}


class CommandLoader:
    """Load protected built-ins plus Workspace > user Markdown commands."""

    def __init__(
        self,
        *,
        builtins: tuple[CommandDef, ...] | None = None,
        user_dir: Path | None = None,
        workspace_dir: Path | None = None,
    ) -> None:
        self.builtins = builtins if builtins is not None else builtin_commands()
        self.user_dir = user_dir if user_dir is not None else DEFAULT_USER_DIR
        self.workspace_dir = workspace_dir
        self._registry = CommandRegistry()
        self._diagnostics: list[CommandDiagnostic] = []

    def _scan(self, root: Path | None, source: CommandSource) -> list[CommandDef]:
        if root is None or not root.is_dir():
            return []
        found: list[CommandDef] = []
        for path in sorted(root.rglob("*.md"), key=lambda item: str(item).lower()):
            try:
                found.append(parse_command_file(root, path, source=source))
            except CommandError as exc:
                self._diagnostics.append(CommandDiagnostic(str(path), source, str(exc)))
                log.warning("[commands] skipping %s command %s: %s", source, path, exc)
        return found

    def load(self) -> CommandRegistry:
        self._diagnostics = []
        merged: dict[str, CommandDef] = {command.name: command for command in self.builtins}
        protected = {command.name for command in self.builtins if command.protected}
        for root, source in ((self.user_dir, "user"), (self.workspace_dir, "workspace")):
            for command in self._scan(root, source):
                if command.name in protected:
                    self._diagnostics.append(CommandDiagnostic(
                        str(command.path or ""), source,
                        f"cannot override protected built-in command: {command.name}",
                    ))
                    continue
                merged[command.name] = command

        registry = CommandRegistry()
        for command in merged.values():
            try:
                registry.register(command)
            except ValueError as exc:
                self._diagnostics.append(CommandDiagnostic(
                    str(command.path or "<builtin>"), command.source, str(exc),
                ))
        self._registry = registry
        return registry

    def diagnostics(self) -> tuple[CommandDiagnostic, ...]:
        return tuple(self._diagnostics)

    @property
    def registry(self) -> CommandRegistry:
        return self._registry
