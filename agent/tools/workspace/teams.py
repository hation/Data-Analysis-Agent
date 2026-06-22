"""Workspace-scoped team definitions and mailbox."""
from __future__ import annotations

import json
import logging
log = logging.getLogger(__name__)
import re
import threading
from datetime import datetime

from data.workspace import workspace_manager

_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
_LOCK = threading.RLock()


class WorkspaceTeamError(ValueError):
    pass


class WorkspaceTeamStore:
    def __init__(self, session_id: str, *, workspace_id: str | None = None) -> None:
        fixed_id = (
            str(workspace_manager.workspace_id_for_session(session_id) or "")
            if workspace_id is None else str(workspace_id or "")
        )
        runtime = workspace_manager.get_by_workspace(fixed_id) if fixed_id else None
        if runtime is None:
            raise WorkspaceTeamError("no workspace is mounted for this session")
        self._path = runtime.meta_dir / "agent_teams.json"

    def _load(self) -> dict:
        if not self._path.exists():
            return {"teams": {}}
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            log.debug("[teams] team store load failed: %s", exc)
            raise WorkspaceTeamError(f"team store is unreadable: {exc}") from exc
        return data if isinstance(data, dict) else {"teams": {}}

    def _save(self, data: dict) -> None:
        temp = self._path.with_suffix(".tmp")
        temp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        temp.replace(self._path)

    @staticmethod
    def _validate_name(name: str, label: str) -> str:
        name = (name or "").strip()
        if not _NAME_RE.fullmatch(name):
            raise WorkspaceTeamError(f"invalid {label} name")
        return name

    def create(self, name: str, description: str, members: list[dict]) -> dict:
        name = self._validate_name(name, "team")
        normalized = []
        seen = set()
        for member in members or []:
            member_name = self._validate_name(str(member.get("name", "")), "member")
            if member_name in seen:
                raise WorkspaceTeamError(f"duplicate member: {member_name}")
            seen.add(member_name)
            normalized.append({
                "name": member_name,
                "role": str(member.get("role", "analyst"))[:100],
                "instructions": str(member.get("instructions", ""))[:4000],
            })
        if not normalized:
            raise WorkspaceTeamError("at least one member is required")
        with _LOCK:
            data = self._load()
            teams = data.setdefault("teams", {})
            if name in teams:
                raise WorkspaceTeamError(f"team already exists: {name}")
            teams[name] = {
                "name": name, "description": (description or "")[:1000],
                "members": normalized, "messages": [],
                "created_at": datetime.now().isoformat(timespec="seconds"),
            }
            self._save(data)
            return teams[name]

    def delete(self, name: str) -> dict:
        name = self._validate_name(name, "team")
        with _LOCK:
            data = self._load()
            team = data.setdefault("teams", {}).pop(name, None)
            if team is None:
                raise WorkspaceTeamError(f"team not found: {name}")
            self._save(data)
        return {"deleted": name}

    def get(self, name: str) -> dict:
        name = self._validate_name(name, "team")
        with _LOCK:
            team = self._load().get("teams", {}).get(name)
        if team is None:
            raise WorkspaceTeamError(f"team not found: {name}")
        return team

    def send_message(self, team_name: str, recipient: str, message: str, sender: str = "lead") -> dict:
        team_name = self._validate_name(team_name, "team")
        recipient = self._validate_name(recipient, "member")
        with _LOCK:
            data = self._load()
            team = data.get("teams", {}).get(team_name)
            if team is None:
                raise WorkspaceTeamError(f"team not found: {team_name}")
            if recipient not in {member["name"] for member in team.get("members", [])}:
                raise WorkspaceTeamError(f"member not found: {recipient}")
            item = {
                "sender": sender, "recipient": recipient, "message": (message or "")[:10_000],
                "created_at": datetime.now().isoformat(timespec="seconds"),
            }
            team.setdefault("messages", []).append(item)
            team["messages"] = team["messages"][-500:]
            self._save(data)
            return item

    def member(self, team_name: str, member_name: str) -> dict:
        team = self.get(team_name)
        member = next((item for item in team.get("members", []) if item.get("name") == member_name), None)
        if member is None:
            raise WorkspaceTeamError(f"member not found: {member_name}")
        return member
