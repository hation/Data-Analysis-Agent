"""Single source of truth for slash-command names and aliases."""
from __future__ import annotations

from collections.abc import Iterable

from .models import CommandDef


class CommandRegistry:
    def __init__(self, commands: Iterable[CommandDef] = ()) -> None:
        self._commands: dict[str, CommandDef] = {}
        self._aliases: dict[str, str] = {}
        for command in commands:
            self.register(command)

    def register(self, command: CommandDef) -> None:
        occupied = set(self._commands) | set(self._aliases)
        if command.name in occupied:
            raise ValueError(f"command name conflicts with existing name/alias: {command.name}")
        for alias in command.aliases:
            if alias in occupied or alias in command.aliases[:command.aliases.index(alias)]:
                raise ValueError(f"command alias conflicts with existing name/alias: {alias}")
        self._commands[command.name] = command
        for alias in command.aliases:
            self._aliases[alias] = command.name

    def get(self, name_or_alias: str) -> CommandDef | None:
        canonical = self._aliases.get(name_or_alias, name_or_alias)
        return self._commands.get(canonical)

    def canonical_name(self, name_or_alias: str) -> str | None:
        command = self.get(name_or_alias)
        return command.name if command else None

    def all(self, *, include_hidden: bool = False) -> tuple[CommandDef, ...]:
        return tuple(
            command for command in self._commands.values()
            if include_hidden or not command.hidden
        )

