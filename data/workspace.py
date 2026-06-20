#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Workspace Runtime — 工作目录资源容器层。

用户侧模型（与上传并行，非替代）：
  - 上传：文件落 uploads/，适合临时分析。
  - 工作目录：用户挂载一个本地项目文件夹为可读根，Agent 可直接
    read_csv('销售.xlsx') 读目录内文件，无需上传。产出物写到该目录下
    的 artifacts/。
  - 两者注册到同一个 DuckDB 连接，可跨源 JOIN。

本模块只做后端骨架：
  - WorkspaceRuntime：路径容器 + fs 鉴权方法（is_path_allowed）
  - WorkspaceManager：按 session_id 管理 runtime 的单例
  - 挂载/卸载/查询

不涉及：
  - DuckDB 连接级沙箱改造（A4）
  - Python 工具层 fs 鉴权接入（A5）
  - 前端入口（A3）
"""
from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Optional, List

from .system_workspace import SystemWorkspace

log = logging.getLogger(__name__)

# ── 始终黑名单（无论是否在工作目录内，一律拒绝）─────────────────────────────
# 路径片段匹配，resolve 后的路径包含这些片段则拒绝。
_BLOCKED_PATH_FRAGMENTS = (
    ".env",           # 环境变量文件
    ".ssh",           # SSH 密钥
    ".git",           # Git 元数据
    "__pycache__",    # Python 缓存
)

# 文件名后缀黑名单（敏感密钥/证书）
_BLOCKED_SUFFIXES = (
    ".key", ".pem", ".crt", ".pfx", ".keystore",
)


def _detect_blocked_system_dirs() -> List[Path]:
    """收集各 OS 的系统目录，resolve 后用于黑名单校验。"""
    dirs: List[Path] = []
    home = Path.home()
    # 用户目录下的敏感子目录
    for sub in (".ssh", ".gnupg", ".aws", ".config"):
        p = home / sub
        if p.exists():
            dirs.append(p)
    # Windows 系统目录
    for env_var in ("SystemRoot", "windir"):
        val = os.environ.get(env_var)
        if val:
            dirs.append(Path(val))
    # Unix 系统目录
    for sys_dir in ("/etc", "/boot", "/proc", "/sys", "/dev", "/var/log"):
        try:
            p = Path(sys_dir)
            if p.exists():
                dirs.append(p)
        except Exception:
            pass
    return dirs


# 系统目录黑名单（挂载这些目录或其子目录一律拒绝）
_BLOCKED_SYSTEM_DIRS = _detect_blocked_system_dirs()


def _is_blocked_path(resolved: Path) -> bool:
    """检查 resolve 后的路径是否命中始终黑名单。"""
    # 路径片段
    parts = {p.lower() for p in resolved.parts}
    for frag in _BLOCKED_PATH_FRAGMENTS:
        if frag.lower() in parts:
            return True
    # 后缀
    if resolved.suffix.lower() in _BLOCKED_SUFFIXES:
        return True
    # 系统目录：路径本身是系统目录，或在系统目录下
    for sys_dir in _BLOCKED_SYSTEM_DIRS:
        try:
            resolved.relative_to(sys_dir)
            return True  # resolved 在 sys_dir 下
        except ValueError:
            continue
    return False


def validate_workdir(path_str: str) -> tuple[bool, str, Optional[Path]]:
    """校验工作目录路径。

    返回 (ok, message, resolved_path)：
      - ok=False 时 message 是拒绝原因，resolved_path 为 None
      - ok=True 时 message 为空，resolved_path 是 resolve 后的绝对路径
    """
    if not path_str or not path_str.strip():
        return False, "工作目录路径不能为空。", None

    try:
        candidate = Path(path_str).expanduser().resolve(strict=True)
    except FileNotFoundError:
        return False, f"路径不存在：{path_str}", None
    except (OSError, RuntimeError) as e:
        return False, f"路径解析失败：{e}", None

    # 必须是目录
    if not candidate.is_dir():
        return False, f"路径不是目录：{candidate}", None

    # 必须可读
    if not os.access(candidate, os.R_OK):
        return False, f"目录不可读：{candidate}", None

    # 命中始终黑名单（系统目录等）
    if _is_blocked_path(candidate):
        return False, f"安全限制：不允许挂载系统/敏感目录：{candidate}", None

    # 不允许挂载项目根目录自身（避免 Agent 读写源码）
    proj_root = Path(__file__).parent.parent.resolve()
    try:
        candidate.relative_to(proj_root)
        return False, f"不允许挂载项目根目录：{candidate}", None
    except ValueError:
        pass

    return True, "", candidate


# ── WorkspaceRuntime ──────────────────────────────────────────────────────

@dataclass
class WorkspaceRuntime:
    """单个工作目录的资源容器。

    A5+ 起：持持久化 DuckDB 路径 + 注册快照路径，实现"关闭后保留、下次秒开"。
    连接本身仍在 DataSource 层管理，Runtime 只提供路径和注册快照读写。
    """
    workspace_id: str                    # 通常等于 session_id
    workdir: Path                        # 挂载的工作目录（resolve 后的绝对路径）
    artifacts_dir: Path = field(init=False)   # 产出物目录（workdir/artifacts）
    cache_dir: Path = field(init=False)       # Parquet 缓存目录（workdir/.baa_cache）
    meta_dir: Path = field(init=False)        # 元数据目录（workdir/.zhixi）—— 持久化 DB + registry
    db_path: Path = field(init=False)         # 持久化 DuckDB 文件（meta_dir/workspace.duckdb）
    registry_path: Path = field(init=False)   # 文件注册快照（meta_dir/registry.json）
    mounted_at: float = field(default_factory=lambda: __import__("time").time())

    # 允许读取的额外根目录（uploads/knowledge 等，由 manager 注入）
    extra_roots: List[Path] = field(default_factory=list)

    def __post_init__(self):
        # artifacts 和 cache 在工作目录下创建
        self.artifacts_dir = self.workdir / "artifacts"
        self.cache_dir = self.workdir / ".baa_cache"
        self.meta_dir = self.workdir / ".zhixi"
        self.db_path = self.meta_dir / "workspace.duckdb"
        self.registry_path = self.meta_dir / "registry.json"
        self.artifacts_dir.mkdir(parents=True, exist_ok=True)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.meta_dir.mkdir(parents=True, exist_ok=True)

    # ── fs 鉴权 ────────────────────────────────────────────────────────────

    def _allowed_roots(self) -> List[Path]:
        """所有允许的根目录列表（工作目录 + 额外根）。"""
        return [self.workdir] + list(self.extra_roots)

    def is_path_allowed(self, path: Path, *, write: bool = False) -> bool:
        """检查路径是否允许读/写。

        规则：
          1. resolve 后必须在某个允许根目录下（白名单）
          2. resolve 后不能命中始终黑名单（.env/.ssh/.git/系统目录等）
          3. write=True 时，路径必须在 artifacts_dir 或 cache_dir 下
             （工作目录本身只读，产出物只能写 artifacts/）
        """
        try:
            resolved = path.expanduser().resolve()
        except (OSError, RuntimeError):
            return False

        # 始终黑名单
        if _is_blocked_path(resolved):
            return False

        # 白名单：必须在某个根目录下
        in_allowed_root = False
        for root in self._allowed_roots():
            try:
                resolved.relative_to(root)
                in_allowed_root = True
                break
            except ValueError:
                continue
        if not in_allowed_root:
            return False

        # 写权限：只能写 artifacts_dir / cache_dir / meta_dir
        if write:
            for writable in (self.artifacts_dir, self.cache_dir, self.meta_dir):
                try:
                    resolved.relative_to(writable)
                    return True
                except ValueError:
                    continue
            return False

        return True

    def resolve_tool_path(self, path_value: str, *, write: bool = False) -> Path:
        """Resolve a path for interactive workspace tools.

        Unlike export/data writers, explicit workspace file tools may modify
        ordinary files anywhere under the mounted workdir. They still cannot
        cross the workdir boundary or touch internal/sensitive paths.
        """
        if not isinstance(path_value, str) or not path_value.strip():
            raise ValueError("path is required")
        raw = Path(path_value.strip())
        candidate = raw if raw.is_absolute() else self.workdir / raw
        try:
            resolved = candidate.expanduser().resolve(strict=False)
            resolved.relative_to(self.workdir)
        except (OSError, RuntimeError, ValueError) as exc:
            raise ValueError("path must stay inside the mounted workspace") from exc
        if _is_blocked_path(resolved):
            raise ValueError("path is blocked by workspace security policy")
        # Runtime metadata/cache are implementation details, not user files.
        for internal in (self.meta_dir, self.cache_dir):
            try:
                resolved.relative_to(internal)
            except ValueError:
                continue
            raise ValueError("internal workspace metadata cannot be accessed")
        if write and resolved == self.workdir:
            raise ValueError("workspace root cannot be overwritten")
        return resolved

    # ── 目录浏览（A3：让 Agent 看见工作目录内容）──────────────────────────

    # Agent 可识别的数据文件后缀（小写）
    _DATA_SUFFIXES = {
        ".csv", ".tsv", ".parquet", ".json", ".jsonl",
        ".xlsx", ".xls",
        ".txt",  # 纯文本，可能是数据
    }

    def list_data_files(self, max_files: int = 50) -> List[dict]:
        """列出工作目录内（浅层，不递归进子目录）的数据文件。

        返回 [{"name": "销售.xlsx", "size": 12345, "suffix": ".xlsx"}, ...]
        跳过 artifacts/、.baa_cache/、隐藏文件、黑名单路径。
        """
        results: List[dict] = []
        try:
            for entry in sorted(self.workdir.iterdir(), key=lambda p: p.name.lower()):
                if entry.is_dir():
                    continue
                name = entry.name
                # 跳过隐藏文件和缓存目录产物
                if name.startswith(".") or name.startswith("~"):
                    continue
                suffix = entry.suffix.lower()
                if suffix not in self._DATA_SUFFIXES:
                    continue
                # 黑名单二次校验（保险）
                if _is_blocked_path(entry):
                    continue
                try:
                    size = entry.stat().st_size
                except OSError:
                    size = 0
                results.append({
                    "name": name,
                    "size": size,
                    "suffix": suffix,
                })
                if len(results) >= max_files:
                    break
        except (OSError, PermissionError) as e:
            log.warning("[workspace] list_data_files failed: %s", e)
        return results

    def allowed_roots_for_sql(self) -> List[Path]:
        """返回 SQL 路径白名单的根目录列表（A4：给 validate.py 用）。

        顺序很重要：workdir 在最前，让相对路径优先相对 workdir 解析。
        包含：workdir / artifacts_dir / cache_dir / meta_dir / uploads / Information。
        """
        return [self.workdir, self.artifacts_dir, self.cache_dir, self.meta_dir] + list(self.extra_roots)

    # ── 持久化注册快照（A5+）──────────────────────────────────────────────

    def load_registry(self) -> dict:
        """读取 registry.json。返回 {file_path: {sha256, tables, source_type, registered_at}}。

        文件不存在或损坏返回空 dict。
        """
        import json
        if not self.registry_path.exists():
            return {}
        try:
            return json.loads(self.registry_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as e:
            log.warning("[workspace] registry.json corrupted: %s", e)
            return {}

    def save_registry(self, registry: dict) -> None:
        """写入 registry.json。"""
        import json
        try:
            self.registry_path.write_text(
                json.dumps(registry, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except OSError as e:
            log.warning("[workspace] save_registry failed: %s", e)

    @staticmethod
    def compute_file_hash(path: Path) -> str:
        """计算文件 sha256，用于检测内容变化。"""
        import hashlib
        h = hashlib.sha256()
        try:
            with open(path, "rb") as f:
                for chunk in iter(lambda: f.read(65536), b""):
                    h.update(chunk)
            return h.hexdigest()
        except OSError:
            return ""

    def to_dict(self) -> dict:
        """序列化给前端（A3 用）。"""
        return {
            "workspace_id": self.workspace_id,
            "workdir": str(self.workdir),
            "artifacts_dir": str(self.artifacts_dir),
            "mounted_at": self.mounted_at,
            "extra_roots": [str(r) for r in self.extra_roots],
        }


# ── WorkspaceManager ──────────────────────────────────────────────────────

class WorkspaceManager:
    """按 session_id 管理 WorkspaceRuntime 的单例。

    一个 session 最多挂载一个工作目录（A 阶段）；C 阶段扩展为多 workspace。
    """

    def __init__(self):
        self._runtimes: Dict[str, WorkspaceRuntime] = {}
        # 默认额外根目录（uploads/knowledge，项目级）
        proj_root = Path(__file__).parent.parent.resolve()
        self._default_extra_roots: List[Path] = [
            proj_root / "uploads",
            proj_root / "Information",   # knowledge 文件
        ]
        # Always-available logical roots. These paths are not moved and are
        # exposed through workspace:// aliases with per-root policies.
        self.system_workspace = SystemWorkspace(proj_root)

    def system_status(self) -> dict:
        """Return a bounded metadata summary for the logical system Workspace."""
        return self.system_workspace.summary()

    def mount(self, session_id: str, workdir_path: str) -> tuple[bool, str, Optional[WorkspaceRuntime]]:
        """为 session 挂载工作目录。

        返回 (ok, message, runtime)。
        如果该 session 已挂载，先卸载旧的再挂载新的。
        """
        ok, msg, resolved = validate_workdir(workdir_path)
        if not ok:
            return False, msg, None

        # 已有挂载则先卸载
        if session_id in self._runtimes:
            self.unmount(session_id)

        try:
            runtime = WorkspaceRuntime(
                workspace_id=session_id,
                workdir=resolved,
                extra_roots=list(self._default_extra_roots),
            )
        except OSError as e:
            # mkdir artifacts/.baa_cache 失败：路径不可写、父级是文件、跨盘符根等
            return False, f"无法在工作目录下创建 artifacts/.baa_cache：{e}", None
        self._runtimes[session_id] = runtime
        log.info("[workspace] mounted  session=%s  workdir=%s", session_id, resolved)
        return True, "", runtime

    def unmount(self, session_id: str) -> bool:
        """卸载 session 的工作目录。返回是否曾挂载。"""
        runtime = self._runtimes.pop(session_id, None)
        if runtime:
            log.info("[workspace] unmounted  session=%s  workdir=%s", session_id, runtime.workdir)
            return True
        return False

    def get(self, session_id: str) -> Optional[WorkspaceRuntime]:
        """获取 session 的 runtime，未挂载返回 None。"""
        return self._runtimes.get(session_id)

    def is_mounted(self, session_id: str) -> bool:
        return session_id in self._runtimes

    def status(self, session_id: str) -> dict:
        """返回挂载状态（给前端用）。"""
        runtime = self._runtimes.get(session_id)
        if runtime:
            return {"mounted": True, **runtime.to_dict()}
        return {"mounted": False}


# 模块级单例（由 api/state.py 导入）
workspace_manager = WorkspaceManager()
