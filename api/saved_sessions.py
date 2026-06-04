"""Blueprint: save / load / delete persistent sessions."""
import json
import logging
import os
import re
from datetime import datetime
from pathlib import Path

from flask import Blueprint, request, jsonify

from .state import session_manager, config_manager
from data.connector import ExcelDataSource, CSVDataSource

log = logging.getLogger(__name__)

bp = Blueprint("saved_sessions", __name__)

if os.environ.get("VERCEL"):
    SAVE_DIR = Path("/tmp/outputs/Session")
else:
    SAVE_DIR = Path(__file__).parent.parent / "outputs" / "Session"

SAVE_DIR.mkdir(parents=True, exist_ok=True)


def _visible_msg_count(history: list) -> int:
    """Count only user + assistant-with-text messages (exclude tool calls/results).

    sess.history now contains tool call chains (role=assistant with tool_calls,
    role=tool), but the user-facing "条数" should reflect actual conversation
    exchanges, not internal tool round-trips.
    """
    return sum(
        1 for m in history
        if m.get("role") in ("user", "assistant")
        and m.get("content")                       # has visible text content
        and not m.get("tool_calls")                # not an intermediate tool-call entry
    )


def _collect_chart_ids(history: list) -> list[str]:
    """Gather every chart_id referenced across the conversation history.

    Chart HTML itself is already written through to disk by _ChartStore
    (outputs/charts/<cid>.html), so it survives restarts on its own — we only
    need the id list (e.g. to keep sess.chart_ids in sync for export).
    """
    ids: list[str] = []
    for msg in history:
        for cid in (msg.get("chart_ids") or []):
            if cid not in ids:
                ids.append(cid)
    return ids


# ── helpers ────────────────────────────────────────────────────────────────

def _safe_stem(name: str) -> str:
    """Turn an arbitrary name into a filesystem-safe stem (keep CJK)."""
    name = re.sub(r'[\\/:*?"<>|]', "_", name).strip()
    return name or "session"


def _ds_info(sess) -> dict | None:
    """Serialize data source metadata for JSON storage."""
    ds = sess.data_source
    if ds is None:
        return None
    info: dict = {"display_name": ds.name, "ds_type": type(ds).__name__}
    if isinstance(ds, (ExcelDataSource, CSVDataSource)):
        info["file_path"] = ds.file_path
    return info


def _restore_ds(info: dict):
    """Re-instantiate a data source from saved metadata.

    Returns None when the source cannot be genuinely restored — the original
    file is missing, construction fails, or the rebuilt source has no usable
    table. The caller maps None → ds_lost so the frontend never shows a
    misleading "connected" state for a source that is not actually usable.
    """
    if not info:
        return None
    fp = info.get("file_path", "")
    if not fp or not Path(fp).exists():
        return None
    display = info.get("display_name", Path(fp).name)
    ext = Path(fp).suffix.lower()
    try:
        if info.get("ds_type") == "CSVDataSource" or ext == ".csv":
            ds = CSVDataSource(fp, display)
        else:
            ds = ExcelDataSource(fp, display)
    except Exception:
        return None
    # Verify the rebuilt source actually has at least one queryable table —
    # a file can exist on disk yet be empty/corrupt.
    try:
        if not ds.list_tables():
            return None
    except Exception:
        return None
    return ds


def _list_files() -> list[dict]:
    # Include both manual saves and autosave files; autosaves are flagged is_autosave=True
    files = sorted(SAVE_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    result = []
    for f in files:
        try:
            meta = json.loads(f.read_text(encoding="utf-8"))
            is_autosave = bool(meta.get("autosave")) or f.stem.startswith("autosave_")
            result.append({
                "filename":    f.name,
                "name":        meta.get("name", f.stem),
                "saved_at":    meta.get("saved_at", ""),
                "msg_count":   _visible_msg_count(meta.get("history", [])),
                "ds_name":     (meta.get("data_source") or {}).get("display_name", ""),
                "is_autosave": is_autosave,
                "session_id":  meta.get("session_id", ""),
            })
        except Exception:
            continue
    return result


# ── API endpoints ──────────────────────────────────────────────────────────

@bp.get("/api/saved-sessions")
def list_sessions():
    return jsonify(_list_files())


@bp.post("/api/session/<sid>/autosave")
def autosave_session(sid: str):
    """Silent auto-save — overwrites a single per-session autosave file.

    Unlike /save, this never returns an error for empty history (just skips)
    and uses a fixed filename so old autosaves are replaced rather than
    accumulated.
    """
    sess = session_manager.get(sid)
    if not sess or not sess.history:
        return jsonify({"ok": False, "reason": "empty"})

    body = request.json or {}
    req_name     = body.get("name", "").strip()
    target_file  = body.get("target_file", "").strip()   # filename to overwrite when loaded from a save

    ts_label  = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    auto_name = req_name if req_name else f"自动保存_{ts_label}"

    payload = {
        "name":               auto_name,
        "saved_at":           datetime.now().isoformat(timespec="seconds"),
        "autosave":           True,
        "session_id":         sid,
        "model_provider":     sess.model_provider,
        "history":            sess.history,
        "total_input_tokens": sess.total_input_tokens,
        "total_output_tokens":sess.total_output_tokens,
        "data_source":        _ds_info(sess),
    }

    # If the user loaded from an existing file, overwrite that file directly
    # so no new entry appears in the list.
    # Otherwise fall back to the per-session autosave file.
    if target_file:
        safe = Path(target_file).name          # strip any path traversal
        path = SAVE_DIR / safe
        if not path.exists():                  # guard: don't create arbitrary files
            path = SAVE_DIR / f"autosave_{sid}.json"
    else:
        path = SAVE_DIR / f"autosave_{sid}.json"

    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    log.debug("[session] autosave  sid=%s  file=%s  msg_count=%d",
              sid, path.name, _visible_msg_count(sess.history))
    return jsonify({"ok": True, "saved_at": payload["saved_at"], "filename": path.name})


@bp.get("/api/session/<sid>/autosave")
def get_autosave(sid: str):
    """Check whether an autosave exists for this session."""
    path = SAVE_DIR / f"autosave_{sid}.json"
    if not path.exists():
        return jsonify({"exists": False})
    try:
        meta = json.loads(path.read_text(encoding="utf-8"))
        return jsonify({
            "exists":    True,
            "saved_at":  meta.get("saved_at", ""),
            "msg_count": _visible_msg_count(meta.get("history", [])),
            "filename":  path.name,
        })
    except Exception:
        return jsonify({"exists": False})


@bp.post("/api/session/<sid>/save")
def save_session(sid: str):
    sess = session_manager.get(sid)
    if not sess:
        log.warning("[session] save  sid=%s  error=session not found", sid)
        return jsonify({"error": "会话不存在"}), 404
    if not sess.history:
        return jsonify({"error": "对话为空，无需保存"}), 400

    name = (request.json or {}).get("name", "").strip()
    if not name:
        name = datetime.now().strftime("对话_%Y%m%d_%H%M%S")

    payload = {
        "name":               name,
        "saved_at":           datetime.now().isoformat(timespec="seconds"),
        "model_provider":     sess.model_provider,
        "history":            sess.history,
        "total_input_tokens": sess.total_input_tokens,
        "total_output_tokens":sess.total_output_tokens,
        "data_source":        _ds_info(sess),
    }

    stem = _safe_stem(name)
    ts   = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = SAVE_DIR / f"{stem}_{ts}.json"
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    log.info("[session] saved  sid=%s  name=%r  file=%s  msg_count=%d",
             sid, name, path.name, _visible_msg_count(sess.history))
    return jsonify({"ok": True, "filename": path.name, "name": name})


@bp.post("/api/session/<sid>/load")
def load_session(sid: str):
    filename = (request.json or {}).get("filename", "").strip()
    if not filename:
        return jsonify({"error": "未指定文件名"}), 400

    path = SAVE_DIR / filename
    if not path.exists() or path.suffix != ".json":
        return jsonify({"error": "文件不存在"}), 404

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return jsonify({"error": f"读取失败: {exc}"}), 500

    sess = session_manager.get_or_create(sid)
    sess.history              = data.get("history", [])
    keep_provider = (request.json or {}).get("keep_provider", False)
    if not keep_provider:
        sess.model_provider = data.get("model_provider", "")
    sess.total_input_tokens   = data.get("total_input_tokens", 0)
    sess.total_output_tokens  = data.get("total_output_tokens", 0)
    sess.last_prompt_tokens   = 0

    sess.chart_ids = _collect_chart_ids(sess.history)

    ds_info = data.get("data_source")
    ds      = _restore_ds(ds_info)
    sess.data_source = ds

    ds_status = "connected" if ds else ("lost" if ds_info else "none")
    log.info("[session] loaded  sid=%s  file=%s  name=%r  msg_count=%d  ds=%s  "
             "in_tokens=%d  out_tokens=%d",
             sid, filename, data.get("name", ""), _visible_msg_count(sess.history),
             ds_status, sess.total_input_tokens, sess.total_output_tokens)

    return jsonify({
        "ok":              True,
        "name":            data.get("name", ""),
        "history":         sess.history,
        "model_provider":  sess.model_provider,   # 实际生效的模型（keep_provider 时为原值）
        "saved_provider":  data.get("model_provider", ""),  # 存档中记录的模型（仅供参考）
        "total_input":     sess.total_input_tokens,
        "total_output":    sess.total_output_tokens,
        "ds_connected":    ds is not None,
        "ds_name":         ds.name if ds else (ds_info or {}).get("display_name", ""),
        "ds_lost":         ds is None and ds_info is not None,
    })


@bp.delete("/api/saved-sessions/<filename>")
def delete_session(filename: str):
    path = SAVE_DIR / filename
    if not path.exists() or path.suffix != ".json":
        return jsonify({"error": "文件不存在"}), 404
    path.unlink()
    # Chart HTML in outputs/charts/ is intentionally NOT deleted — it is shared
    # storage and may still be referenced by other saved conversations.
    return jsonify({"ok": True})
