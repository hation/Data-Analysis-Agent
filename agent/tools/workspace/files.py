# -*- coding: utf-8 -*-
"""Workspace-scoped versions of MewCode's file and command tools."""
from __future__ import annotations

import fnmatch
import hashlib
import json
import os
import re
import subprocess
import sys
import threading
import zipfile
from pathlib import Path
from typing import Any

from data.workspace import workspace_manager
from data.system_workspace import MAX_INDEXED_FILES, MAX_LIST_CHARS, MAX_LIST_LIMIT, MAX_SEARCH_LIMIT

MAX_READ_BYTES = 512_000
MAX_READ_LINES = 400
MAX_READ_CHARS = 12_000
MAX_WRITE_BYTES = 2_000_000
MAX_RESULTS = 100
MAX_SEARCH_FILES = 200
MAX_SEARCH_FILE_CHARS = 200_000
MAX_COMMAND_OUTPUT = 20_000
MAX_CHECKPOINT_BYTES = 20_000_000
TEXT_SUFFIXES = {
    ".txt", ".md", ".csv", ".tsv", ".json", ".jsonl", ".yaml", ".yml",
    ".sql", ".py", ".js", ".css", ".html", ".xml", ".toml", ".ini",
}
SKIP_DIRS = {".git", ".zhixi", ".baa_cache", "node_modules", "__pycache__", ".venv"}


class WorkspaceToolError(ValueError):
    pass


class WorkspaceFileState:
    """Read-before-write state with optimistic mtime checking per session."""

    def __init__(self) -> None:
        self._entries: dict[str, int] = {}
        self._lock = threading.Lock()

    def record(self, path: Path) -> None:
        with self._lock:
            self._entries[str(path)] = path.stat().st_mtime_ns

    def require_current(self, path: Path) -> None:
        with self._lock:
            prior = self._entries.get(str(path))
        if prior is None:
            raise WorkspaceToolError("existing file must be read before it can be changed")
        try:
            current = path.stat().st_mtime_ns
        except OSError as exc:
            raise WorkspaceToolError(f"cannot stat file: {exc}") from exc
        if current != prior:
            raise WorkspaceToolError("file changed after it was read; read it again before editing")


_STATE_BY_SESSION: dict[str, WorkspaceFileState] = {}
_STATE_LOCK = threading.Lock()


def _state_for(session_id: str) -> WorkspaceFileState:
    with _STATE_LOCK:
        return _STATE_BY_SESSION.setdefault(session_id, WorkspaceFileState())


class WorkspaceToolService:
    def __init__(self, session_id: str) -> None:
        self.session_id = session_id

    def _runtime(self):
        runtime = workspace_manager.get(self.session_id)
        if runtime is None:
            raise WorkspaceToolError("no workspace is mounted for this session")
        return runtime

    def _path(self, value: str, *, write: bool = False) -> Path:
        return self._location(value, write=write)[0]

    def _location(self, value: str, *, write: bool = False) -> tuple[Path, str, Path]:
        system = workspace_manager.system_workspace
        virtual = system.parse_virtual_path(value)
        if virtual is not None:
            root_name, relative = virtual
            try:
                path = system.resolve(root_name, relative, write=write)
            except ValueError as exc:
                raise WorkspaceToolError(str(exc)) from exc
            return path, root_name, system.policy(root_name).path.resolve()
        try:
            runtime = self._runtime()
            return runtime.resolve_tool_path(value, write=write), "user", runtime.workdir
        except ValueError as exc:
            raise WorkspaceToolError(str(exc)) from exc

    def _display_path(self, path: Path) -> str:
        system = workspace_manager.system_workspace
        for name, policy in system.roots.items():
            try:
                return system.virtual_name(name, path)
            except ValueError:
                continue
        runtime = workspace_manager.get(self.session_id)
        if runtime is not None:
            try:
                return f"user/{path.resolve().relative_to(runtime.workdir.resolve()).as_posix()}"
            except ValueError:
                pass
        raise WorkspaceToolError("path is outside the workspace")

    @staticmethod
    def _skip(path: Path) -> bool:
        return any(part.lower() in SKIP_DIRS for part in path.parts)

    def glob(
        self, pattern: str, path: str = ".", max_results: int = 20, cursor: int = 0,
    ) -> dict:
        system = workspace_manager.system_workspace
        virtual = system.parse_virtual_path(path)
        if virtual is not None:
            root_name, relative = virtual
            return system.list_files(
                root_name, relative, pattern,
                limit=min(int(max_results), MAX_LIST_LIMIT), cursor=cursor,
            )
        base, _alias, root = self._location(path)
        if not base.is_dir():
            raise WorkspaceToolError("search path is not a directory")
        max_results = max(1, min(int(max_results), MAX_LIST_LIMIT))
        cursor = max(0, int(cursor))
        results = []
        scanned = 0
        for item in base.glob(pattern or "**/*"):
            scanned += 1
            if scanned > MAX_INDEXED_FILES:
                break
            if not item.is_file() or self._skip(item):
                continue
            try:
                safe = item.resolve()
                safe.relative_to(root.resolve())
                stat = safe.stat()
            except (ValueError, OSError):
                continue
            results.append({
                "path": self._display_path(safe),
                "size": stat.st_size,
                "modified_ns": stat.st_mtime_ns,
            })
        results.sort(key=lambda item: item["modified_ns"], reverse=True)
        page = []
        rendered_chars = 0
        for row in results[cursor:cursor + max_results]:
            row_chars = len(row["path"]) + 80
            if page and rendered_chars + row_chars > MAX_LIST_CHARS:
                break
            page.append(row)
            rendered_chars += row_chars
        next_cursor = cursor + len(page) if cursor + len(page) < len(results) else None
        return {
            "matches": page, "count": len(page), "total": len(results),
            "cursor": cursor, "next_cursor": next_cursor,
            "truncated": next_cursor is not None,
        }

    def grep(self, pattern: str, path: str = ".", include: str = "*", max_results: int = 20) -> dict:
        try:
            regex = re.compile(pattern)
        except re.error as exc:
            raise WorkspaceToolError(f"invalid regex: {exc}") from exc
        base, alias, root = self._location(path)
        if not base.is_dir():
            raise WorkspaceToolError("search path is not a directory")
        max_results = max(1, min(int(max_results), MAX_SEARCH_LIMIT))
        results = []
        system = workspace_manager.system_workspace
        virtual = system.parse_virtual_path(path)
        if virtual is not None:
            root_name, _relative = virtual
            candidates = (
                system.resolve(root_name, rel)
                for rel in system.entries(root_name)
            )
        else:
            candidates = base.rglob("*")
        searched_files = 0
        output_chars = 0
        for item in candidates:
            if len(results) >= max_results:
                break
            if not item.is_file() or self._skip(item) or not fnmatch.fnmatch(item.name, include or "*"):
                continue
            if item.suffix.lower() not in TEXT_SUFFIXES:
                continue
            try:
                item.resolve().relative_to(base.resolve())
            except ValueError:
                continue
            searched_files += 1
            if searched_files > MAX_SEARCH_FILES:
                break
            try:
                safe = item.resolve()
                safe.relative_to(root.resolve())
                if safe.stat().st_size > MAX_READ_BYTES:
                    continue
                text = safe.read_text(encoding="utf-8", errors="replace")[:MAX_SEARCH_FILE_CHARS]
                lines = text.splitlines()
            except (ValueError, OSError):
                continue
            for number, line in enumerate(lines, 1):
                if regex.search(line):
                    snippet = line[:500]
                    display_path = self._display_path(safe)
                    row_chars = len(display_path) + len(snippet) + 40
                    if results and output_chars + row_chars > MAX_READ_CHARS:
                        break
                    results.append({
                        "path": display_path,
                        "line": number,
                        "text": snippet,
                    })
                    output_chars += row_chars
                    if len(results) >= max_results:
                        break
        return {
            "matches": results,
            "count": len(results),
            "searched_files": min(searched_files, MAX_SEARCH_FILES),
            "truncated": len(results) >= max_results or searched_files > MAX_SEARCH_FILES,
        }

    def read_file(self, file_path: str, offset: int = 0, limit: int = 200) -> dict:
        path = self._path(file_path)
        if not path.is_file():
            raise WorkspaceToolError("file not found")
        size = path.stat().st_size
        if size > MAX_READ_BYTES:
            raise WorkspaceToolError(f"file exceeds {MAX_READ_BYTES} byte read limit")
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError as exc:
            raise WorkspaceToolError("file is not UTF-8 text") from exc
        lines = text.splitlines()
        offset = max(0, int(offset))
        limit = max(1, min(int(limit), MAX_READ_LINES))
        _state_for(self.session_id).record(path)
        selected = []
        chars = 0
        char_truncated = False
        for number, line in enumerate(lines[offset:offset + limit], offset + 1):
            rendered = f"{number}: {line}"
            if selected and chars + len(rendered) + 1 > MAX_READ_CHARS:
                char_truncated = True
                break
            clipped = rendered[:MAX_READ_CHARS]
            char_truncated = char_truncated or len(clipped) < len(rendered)
            selected.append(clipped)
            chars += len(selected[-1]) + 1
        consumed = len(selected)
        return {
            "path": self._display_path(path),
            "offset": offset,
            "total_lines": len(lines),
            "content": "\n".join(selected),
            "next_offset": offset + consumed if offset + consumed < len(lines) else None,
            "truncated": char_truncated or offset + consumed < len(lines),
            "character_limit_reached": char_truncated,
        }

    def write_file(self, file_path: str, content: str) -> dict:
        path = self._path(file_path, write=True)
        encoded = content.encode("utf-8")
        if len(encoded) > MAX_WRITE_BYTES:
            raise WorkspaceToolError(f"content exceeds {MAX_WRITE_BYTES} byte write limit")
        if path.exists():
            if not path.is_file():
                raise WorkspaceToolError("target is not a file")
            _state_for(self.session_id).require_current(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        _state_for(self.session_id).record(path)
        virtual = workspace_manager.system_workspace.parse_virtual_path(file_path)
        if virtual is not None:
            workspace_manager.system_workspace.invalidate(virtual[0])
        return {"path": self._display_path(path), "bytes": len(encoded)}

    def edit_file(self, file_path: str, old_string: str, new_string: str) -> dict:
        path = self._path(file_path, write=True)
        if not path.is_file():
            raise WorkspaceToolError("file not found")
        _state_for(self.session_id).require_current(path)
        text = path.read_text(encoding="utf-8")
        count = text.count(old_string)
        if count != 1:
            raise WorkspaceToolError(f"old_string must occur exactly once; found {count}")
        updated = text.replace(old_string, new_string, 1)
        if len(updated.encode("utf-8")) > MAX_WRITE_BYTES:
            raise WorkspaceToolError("edited content exceeds write limit")
        path.write_text(updated, encoding="utf-8")
        _state_for(self.session_id).record(path)
        virtual = workspace_manager.system_workspace.parse_virtual_path(file_path)
        if virtual is not None:
            workspace_manager.system_workspace.invalidate(virtual[0])
        return {"path": self._display_path(path), "replacements": 1}

    def command(self, operation: str, path: str = ".", pattern: str = "", timeout: int = 30) -> dict:
        """Run a fixed, shell-free operation. No user-provided executable exists."""
        target = self._path(path)
        timeout = max(1, min(int(timeout), 120))
        if operation == "checksum":
            if not target.is_file():
                raise WorkspaceToolError("checksum target must be a file")
            digest = hashlib.sha256(target.read_bytes()).hexdigest()
            return {"operation": operation, "sha256": digest, "path": self._display_path(target)}
        if operation == "json_validate":
            if not target.is_file():
                raise WorkspaceToolError("JSON target must be a file")
            json.loads(target.read_text(encoding="utf-8"))
            return {"operation": operation, "valid": True, "path": self._display_path(target)}

        runtime = self._runtime()

        git_base = [
            "git", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=NUL",
            "-c", "diff.external=", "-C", str(runtime.workdir),
        ]
        commands = {
            "git_status": [*git_base, "status", "--short"],
            "git_diff": [*git_base, "diff", "--no-ext-diff", "--", str(target)],
            "git_log": [*git_base, "log", "-n", "20", "--oneline"],
            "python_compile": [sys.executable, "-m", "compileall", "-q", str(target)],
        }
        argv = commands.get(operation)
        if argv is None:
            raise WorkspaceToolError("unsupported operation")
        command_env = os.environ.copy()
        command_env["GIT_CONFIG_NOSYSTEM"] = "1"
        command_env["GIT_CONFIG_GLOBAL"] = "NUL" if os.name == "nt" else "/dev/null"
        command_env["PYTHONPYCACHEPREFIX"] = str(runtime.cache_dir / "pycache")
        try:
            completed = subprocess.run(
                argv, cwd=str(runtime.workdir), capture_output=True, text=True,
                timeout=timeout, shell=False, check=False, env=command_env,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise WorkspaceToolError(f"operation failed: {exc}") from exc
        output = (completed.stdout or "") + (completed.stderr or "")
        return {
            "operation": operation,
            "exit_code": completed.returncode,
            "output": output[:MAX_COMMAND_OUTPUT],
            "truncated": len(output) > MAX_COMMAND_OUTPUT,
        }

    def checkpoint(
        self, action: str, name: str = "", patterns: list[str] | None = None, confirm: bool = False,
    ) -> dict:
        runtime = self._runtime()
        checkpoint_dir = runtime.meta_dir / "checkpoints"
        checkpoint_dir.mkdir(parents=True, exist_ok=True)
        if action == "list":
            items = []
            for path in sorted(checkpoint_dir.glob("*.zip"), key=lambda p: p.stat().st_mtime, reverse=True):
                items.append({"name": path.stem, "size": path.stat().st_size})
            return {"checkpoints": items}
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", name or ""):
            raise WorkspaceToolError("checkpoint name must use letters, digits, underscore, or dash")
        archive = checkpoint_dir / f"{name}.zip"
        if action == "create":
            selected_patterns = patterns or ["**/*"]
            files: dict[str, Path] = {}
            total = 0
            for glob_pattern in selected_patterns:
                for path in runtime.workdir.glob(glob_pattern):
                    if not path.is_file() or self._skip(path):
                        continue
                    try:
                        safe = runtime.resolve_tool_path(str(path))
                        rel = str(safe.relative_to(runtime.workdir))
                        size = safe.stat().st_size
                    except (ValueError, OSError):
                        continue
                    if total + size > MAX_CHECKPOINT_BYTES:
                        raise WorkspaceToolError("checkpoint exceeds 20 MB limit")
                    files[rel] = safe
                    total += size
                    if len(files) > MAX_RESULTS:
                        raise WorkspaceToolError("checkpoint exceeds 500 file limit")
            with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as zf:
                for rel, path in files.items():
                    zf.write(path, rel)
            return {"name": name, "files": len(files), "source_bytes": total}
        if action == "restore":
            if not confirm:
                raise WorkspaceToolError("checkpoint restore requires confirm=true")
            if not archive.is_file():
                raise WorkspaceToolError("checkpoint not found")
            restored = 0
            with zipfile.ZipFile(archive, "r") as zf:
                for member in zf.infolist():
                    target = runtime.resolve_tool_path(member.filename, write=True)
                    if member.is_dir():
                        continue
                    if member.file_size > MAX_WRITE_BYTES:
                        raise WorkspaceToolError("checkpoint member exceeds per-file write limit")
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(zf.read(member))
                    restored += 1
            return {"name": name, "restored_files": restored}
        raise WorkspaceToolError("unsupported checkpoint action")


def structured_output(output: Any, required_fields: list[str] | None = None) -> dict:
    if not isinstance(output, (dict, list, str)):
        raise WorkspaceToolError("output must be an object, array, or string")
    missing = []
    if required_fields:
        if not isinstance(output, dict):
            raise WorkspaceToolError("required_fields can only validate object output")
        missing = [field for field in required_fields if field not in output]
    if missing:
        raise WorkspaceToolError("missing required fields: " + ", ".join(missing))
    return {"output": output}
