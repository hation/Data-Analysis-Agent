#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Blueprint: workspace management — 挂载/卸载工作目录。

用户侧模型（与上传并行，非替代）：
  - 上传：保留现有 /api/session/<sid>/upload 流程
  - 工作目录：挂载本地项目文件夹后，**自动把目录内数据文件注册为 DataSource**，
    和上传走同一套逻辑。Agent 可直接 get_schema / query_data，无需特殊流程。

A4 修复（2026-06-18）：
  之前挂载只挂了路径，没创建 DataSource，导致 create_analysis_table /
  query_data 返回 "No data source connected"。现在挂载时自动遍历目录内
  数据文件（csv/xlsx/parquet/json），每个文件创建一个 DataSource 注册到
  session，行为和上传完全一致。
"""
import logging
import traceback
from pathlib import Path
from flask import Blueprint, request, jsonify

from .state import session_manager, workspace_manager

log = logging.getLogger(__name__)

bp = Blueprint("workspace", __name__)

# 可注册为 DataSource 的文件后缀
_REGISTERABLE_SUFFIXES = {".csv", ".xlsx", ".xls"}


def _register_workdir_files(sid: str, runtime) -> dict:
    """把工作目录内的数据文件注册为**持久化** DataSource（A5+）。

    A5+ 核心改进：
      - 使用 WorkspacePersistentSource（持久化 DuckDB 连接到 .zhixi/workspace.duckdb）
      - 文件 sha256 记录在 registry.json，下次挂载时未变则跳过解析（大 Excel 秒开）
      - 关闭软件后 .duckdb 文件保留，下次挂载表已就绪
      - 新增/变更文件增量注册，已注册且未变的表直接复用

    返回 {"added": [...], "errors": [...], "skipped": int, "reused": int}。
    """
    from data.sources.workspace_persistent import WorkspacePersistentSource

    sess = session_manager.get_or_create(sid)
    added = []
    errors = []
    reused = 0

    # ── 1. 创建/打开持久化 DataSource ──────────────────────────────────────
    source_name = f"📁 {runtime.workdir.name}" if hasattr(runtime, 'workdir') else "工作目录"
    try:
        source = WorkspacePersistentSource(str(runtime.db_path), source_name)
    except Exception as exc:
        log.error("[workspace] failed to open persistent source: %s", exc)
        return {"added": [], "errors": [f"持久化数据库打开失败：{exc}"], "skipped": 0, "reused": 0}

    # ── 2. 读取注册快照，检测文件变化 ──────────────────────────────────────
    registry = runtime.load_registry()
    files = runtime.list_data_files(max_files=50)

    for f in files:
        name = f["name"]
        suffix = f["suffix"]

        if suffix not in _REGISTERABLE_SUFFIXES:
            continue

        file_path = str(runtime.workdir / name)
        file_key = name  # registry 用文件名作 key（工作目录内唯一）

        # 算 sha256 检测变化
        current_hash = runtime.compute_file_hash(Path(file_path))
        if not current_hash:
            errors.append(f"{name}: 无法读取文件")
            continue

        old_entry = registry.get(file_key)
        if old_entry and old_entry.get("sha256") == current_hash:
            # 文件未变化，表已在 .duckdb 里，跳过解析
            reused += 1
            log.debug("[workspace] reuse cached: %s (sha256 match)", name)
            continue

        # 新文件或内容变化，注册到持久化连接
        base_table = _safe_table_name(name)
        try:
            if suffix == ".csv":
                ok = source._register_csv(file_path, base_table)
                if ok:
                    tables = [base_table]
                else:
                    errors.append(f"{name}: CSV 注册失败")
                    continue
            else:
                tables = source._register_excel(file_path, base_table)
                if not tables:
                    errors.append(f"{name}: Excel 无可注册的 sheet")
                    continue

            # 更新 registry
            registry[file_key] = {
                "sha256": current_hash,
                "tables": tables,
                "source_type": suffix.lstrip("."),
                "file_path": file_path,
            }
            added.append({
                "source_name": name,
                "tables": tables,
            })
            log.info("[workspace] registered %s → tables=%s", name, tables)
        except Exception as exc:
            log.error("[workspace] FAILED to register %s: %s\n%s",
                      name, exc, traceback.format_exc())
            errors.append(f"{name}: {exc}")

    # ── 3. 保存更新后的 registry ────────────────────────────────────────────
    runtime.save_registry(registry)

    # ── 4. 把持久化 source 注册到 session ───────────────────────────────────
    # 检查是否已注册过这个持久化 source（按 db_path 去重）
    already_registered = any(
        getattr(entry.get("source"), "_db_path", None) == runtime.db_path
        for entry in sess._sources
    )
    if not already_registered:
        source_id = sess.add_source(source)
        log.info("[workspace] persistent source registered  sid=%s  source_id=%s  tables=%s",
                 sid, source_id, source.list_tables())

    # 获取 schema 给前端
    try:
        schema_preview = source.get_schema()[:500]
    except Exception:
        schema_preview = ""

    return {
        "added": added,
        "errors": errors,
        "skipped": len(files) - len(added) - len(errors) - reused,
        "reused": reused,
        "schema_preview": schema_preview,
        "source_name": source_name,
    }


def _safe_table_name(filename: str) -> str:
    """从文件名生成合法的 DuckDB 表名。"""
    import re
    # 去扩展名
    stem = re.sub(r'\.(csv|xlsx|xls)$', '', filename, flags=re.IGNORECASE)
    # 清理为合法标识符
    cleaned = re.sub(r'[^\w]', '_', stem)
    cleaned = re.sub(r'_+', '_', cleaned).strip('_')
    if cleaned and cleaned[0].isdigit():
        cleaned = '_' + cleaned
    return cleaned or 'data'


@bp.post("/api/session/<sid>/workspace/mount")
def mount_workspace(sid: str):
    """挂载工作目录并自动注册目录内数据文件为 DataSource。

    Body: {"path": "C:/Users/xxx/projects/财务分析"}
    返回: {
        "ok": true,
        "workspace": {...},
        "added": [{source_id, source_name, schema_preview}, ...],
        "errors": [...],
        "sources": sess.list_sources()
    }
    或 {"ok": false, "error": "..."}
    """
    session = session_manager.get(sid)
    if not session:
        return jsonify({"ok": False, "error": "会话不存在。"}), 404

    body = request.get_json(silent=True) or {}
    path = (body.get("path") or "").strip()
    if not path:
        return jsonify({"ok": False, "error": "缺少 path 参数。"}), 400

    ok, msg, runtime = workspace_manager.mount(sid, path)
    if not ok:
        return jsonify({"ok": False, "error": msg}), 400

    log.info("[api] workspace mounted  sid=%s  path=%s", sid, runtime.workdir)

    # 自动注册目录内数据文件为持久化 DataSource
    reg = _register_workdir_files(sid, runtime)

    sess = session_manager.get_or_create(sid)
    return jsonify({
        "ok": True,
        "workspace": runtime.to_dict(),
        "added": reg["added"],
        "errors": reg["errors"],
        "reused": reg.get("reused", 0),
        "schema_preview": reg.get("schema_preview", ""),
        "source_name": reg.get("source_name", ""),
        "sources": sess.list_sources(),
    })


@bp.post("/api/session/<sid>/workspace/unmount")
def unmount_workspace(sid: str):
    """卸载工作目录，并移除由工作目录注册的 DataSource。"""
    session = session_manager.get(sid)
    if not session:
        return jsonify({"ok": False, "error": "会话不存在。"}), 404

    runtime = workspace_manager.get(sid)
    removed = workspace_manager.unmount(sid)
    if not removed:
        return jsonify({"ok": False, "error": "未挂载工作目录。"}), 400

    # 移除由工作目录注册的 DataSource（持久化 source 的 _db_path 在 workdir 下，
    # 或旧式 source 的 file_path 在 workdir 下）
    if runtime:
        sess = session_manager.get_or_create(sid)
        workdir_resolved = str(runtime.workdir.resolve())
        db_path_resolved = str(runtime.db_path.resolve()) if hasattr(runtime, 'db_path') else None
        to_remove = []
        for entry in sess._sources:
            src = entry.get("source")
            # 检查持久化 source（_db_path 属性）
            db_p = getattr(src, "_db_path", None)
            if db_p is not None and db_path_resolved:
                try:
                    if str(Path(db_p).resolve()) == db_path_resolved:
                        to_remove.append(entry["id"])
                        # 关闭持久化连接（不删文件，下次挂载复用）
                        if hasattr(src, "close"):
                            src.close()
                        continue
                except (OSError, RuntimeError):
                    pass
            # 检查旧式 source（file_path 属性）
            fp = getattr(src, "file_path", None)
            if fp:
                try:
                    fp_resolved = str(Path(fp).resolve())
                    if fp_resolved.startswith(workdir_resolved):
                        to_remove.append(entry["id"])
                except (OSError, RuntimeError):
                    pass
        for source_id in to_remove:
            sess.remove_source(source_id)
        log.info("[api] workspace unmounted  sid=%s  sources_removed=%d", sid, len(to_remove))

    return jsonify({"ok": True, "sources": session_manager.get_or_create(sid).list_sources()})


@bp.get("/api/session/<sid>/workspace")
def get_workspace(sid: str):
    """查询当前工作目录挂载状态。"""
    session = session_manager.get(sid)
    if not session:
        return jsonify({"ok": False, "error": "会话不存在。"}), 404

    return jsonify({"ok": True, "workspace": workspace_manager.status(sid)})
