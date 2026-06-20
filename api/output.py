"""Blueprint: file download endpoint for exported Excel / Word files.

A5 起：路由支持 ?sid=<session_id> 查询参数。
  - 带 sid：先查该 session 的 workspace artifacts_dir，找不到再查默认 outputs/exports
  - 不带 sid：只查默认 outputs/exports（向后兼容旧链接）
"""
import os
import re

from flask import Blueprint, send_file, abort, request

bp = Blueprint("output", __name__)

_EXPORT_DIR = os.path.join(
    os.path.dirname(os.path.dirname(__file__)), "outputs", "exports"
)


def _resolve_filepath(filename: str) -> str | None:
    """按优先级查找文件，返回存在的绝对路径或 None。

    查找顺序：
      1. session 的 workspace artifacts_dir（如有 sid 且已挂载）
      2. 默认 outputs/exports/
    """
    # 安全校验：禁止路径穿越
    if ".." in filename or re.search(r'[\\/\x00]', filename):
        return None

    # 1. 查 session workspace artifacts_dir
    sid = (request.args.get("sid") or "").strip()
    if sid:
        try:
            from data.workspace import workspace_manager
            runtime = workspace_manager.get(sid)
            if runtime is not None:
                artifacts_path = os.path.join(str(runtime.artifacts_dir), filename)
                # 二次校验：resolve 后必须在 artifacts_dir 内（防符号链接逃逸）
                try:
                    resolved = os.path.realpath(artifacts_path)
                    if resolved.startswith(str(runtime.artifacts_dir.resolve())):
                        if os.path.isfile(resolved):
                            return resolved
                except OSError:
                    pass
        except Exception:
            pass  # 静默失败，回退到默认目录

    # 2. 查默认 outputs/exports/
    default_path = os.path.join(_EXPORT_DIR, filename)
    if os.path.isfile(default_path):
        return default_path

    return None


@bp.get("/api/export/<path:filename>")
def download_export(filename: str):
    """Serve an exported file.

    查找顺序：session artifacts_dir（如有 ?sid=）→ outputs/exports/。
    Security: filename 经过路径穿越校验；artifacts_dir 路径 resolve 后必须在
    runtime.artifacts_dir 内。
    """
    filepath = _resolve_filepath(filename)
    if filepath is None:
        abort(404)

    return send_file(filepath, as_attachment=True, download_name=filename)
