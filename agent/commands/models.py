"""Data model for explicit slash commands."""
from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Literal


COMMAND_NAME_RE = re.compile(r"^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)*$")
CommandSource = Literal["builtin", "user", "workspace"]


class CommandType(str, Enum):
    LOCAL = "local"
    BACKEND = "backend"
    PROMPT = "prompt"


@dataclass(frozen=True)
class CommandDef:
    name: str
    description: str
    type: CommandType
    aliases: tuple[str, ...] = ()
    usage: str = ""
    argument_hint: str = ""
    icon: str = "⌘"
    category: str = "tools"
    prompt: str = ""
    handler_key: str = ""
    hidden: bool = False
    protected: bool = False
    source: CommandSource = "builtin"
    path: Path | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.type, CommandType):
            raise ValueError(f"invalid command type: {self.type!r}")
        if not COMMAND_NAME_RE.fullmatch(self.name):
            raise ValueError(f"invalid command name: {self.name!r}")
        if not self.description.strip():
            raise ValueError("command description is required")
        if len(set(self.aliases)) != len(self.aliases):
            raise ValueError(f"duplicate aliases for command {self.name!r}")
        for alias in self.aliases:
            if not COMMAND_NAME_RE.fullmatch(alias):
                raise ValueError(f"invalid command alias: {alias!r}")
            if alias == self.name:
                raise ValueError(f"command alias duplicates its name: {alias!r}")
        if self.type is CommandType.PROMPT and not self.prompt.strip():
            raise ValueError(f"prompt command {self.name!r} requires prompt text")
        if self.type in {CommandType.LOCAL, CommandType.BACKEND} and not self.handler_key.strip():
            raise ValueError(f"{self.type.value} command {self.name!r} requires handler_key")

    def to_public_dict(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "name": self.name,
            "description": self.description,
            "type": self.type.value,
            "aliases": list(self.aliases),
            "usage": self.usage,
            "argument_hint": self.argument_hint,
            "icon": self.icon,
            "category": self.category,
            "source": self.source,
            "available": True,
        }
        # Expose only audited client actions. Backend handler keys remain an
        # implementation detail and are never sent to the browser.
        if (
            self.type is CommandType.LOCAL
            and self.protected
            and self.handler_key.startswith("client:")
        ):
            payload["client_action"] = self.handler_key.removeprefix("client:")
        return payload
