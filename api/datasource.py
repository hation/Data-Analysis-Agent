"""Blueprint: data source management — upload Excel/CSV, connect SQL DB."""
import logging
import traceback
import uuid
import os
import re
import threading
from pathlib import Path
from urllib.parse import quote

from flask import Blueprint, request, jsonify
from werkzeug.utils import secure_filename

from .state import session_manager, datasource_config_manager
from data.connector import ExcelDataSource, CSVDataSource, SQLDataSource, GoogleSheetsDataSource, HTTPAPIDataSource
from data.sources.excel import excel_requires_job, parse_excel_job
from infrastructure.paths import data_path

log = logging.getLogger(__name__)

bp = Blueprint("datasource", __name__)

# Source mode retains <project>/uploads; frozen/override mode uses user data.
UPLOAD_DIR = data_path("uploads")

UPLOAD_DIR.mkdir(exist_ok=True)
PARSED_EXCEL_DIR = UPLOAD_DIR / ".parsed_excel"
PARSED_EXCEL_DIR.mkdir(exist_ok=True)
ALLOWED_EXTS = {".xlsx", ".xls", ".csv"}
_finalize_lock = threading.RLock()


def _allowed(filename: str) -> bool:
    return Path(filename).suffix.lower() in ALLOWED_EXTS


def _friendly_conn_error(exc: Exception, service: str) -> str:
    """Translate a low-level connection exception into a user-readable message.

    `service` is a short label like 'Google Sheets' / '外部 API' / '数据库'.
    Falls back to the raw message when the error is not a known network case.
    """
    # Walk the exception cause chain so a wrapped error is still recognised.
    chain = []
    cur: BaseException | None = exc
    seen = set()
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        chain.append(cur)
        cur = cur.__cause__ or cur.__context__
    text = "  ".join(f"{type(c).__name__}: {c}" for c in chain).lower()

    # — Network unreachable / connection reset (proxy, GFW, offline) —
    if any(k in text for k in (
        "10054", "connection aborted", "connection reset", "connectionreseterror",
        "connection refused", "10061", "max retries", "failed to establish",
        "name or service not known", "getaddrinfo failed", "11001",
        "transporterror", "ssl", "handshake", "timed out", "timeout",
        "remotedisconnected", "connectionerror",
    )):
        return (
            f"无法连接「{service}」：网络请求被中断或超时。"
            f"请检查网络是否可正常访问目标服务"
            + ("（Google 服务在部分网络下需要代理）" if "google" in service.lower() else "")
            + "，确认代理 / VPN 已开启且 Python 进程已走代理后重试。"
        )
    # — Authentication / authorization —
    if any(k in text for k in (
        "401", "403", "unauthorized", "forbidden", "permission",
        "invalid_grant", "invalid_client", "authentication",
        "access_denied", "credential",
    )):
        return (
            f"{service} 认证失败：凭证无效或没有访问权限。"
            "请检查服务账号 / 密钥是否正确，以及该账号是否已被授权访问目标资源。"
        )
    # — Not found —
    if any(k in text for k in ("404", "not found", "does not exist")):
        return f"{service} 目标资源不存在：请检查 URL / ID / 表名是否正确。"

    # — Unknown — keep the raw message but keep it short —
    raw = str(exc).strip() or type(exc).__name__
    if len(raw) > 200:
        raw = raw[:200] + "…"
    return f"{service} 连接失败：{raw}"


def _encode_db_password(conn_str: str) -> str:
    """对连接字符串中的密码部分做 URL 编码，处理 @ # 等特殊字符。"""
    # 匹配 scheme://user:password@host 格式，密码可能含多个 @
    # 贪婪匹配密码部分（.+），确保最后一个 @ 才是 host 分隔符
    m = re.match(r'^([a-zA-Z][a-zA-Z0-9+\-.]*://[^:@/]+):(.+)@([^@].*)', conn_str)
    if not m:
        return conn_str
    prefix, password, rest = m.group(1), m.group(2), m.group(3)
    # 若密码已含 % 编码则跳过，避免二次编码
    if re.search(r'%[0-9A-Fa-f]{2}', password):
        return conn_str
    encoded = quote(password, safe='-._~!*')
    return f"{prefix}:{encoded}@{rest}"


@bp.post("/api/session/<sid>/upload")
def upload_file(sid: str):
    """Upload one or more files; each is appended as a new data source."""
    files = request.files.getlist("file")
    if not files or all(not f.filename for f in files):
        return jsonify({"error": "未选择文件"}), 400

    sess = session_manager.get_or_create(sid)
    added = []
    pending_jobs = []
    errors = []

    for f in files:
        if not f.filename or not _allowed(f.filename):
            errors.append(f"{f.filename}: 仅支持 .xlsx / .xls / .csv 文件")
            continue

        display_name = f.filename
        ext = Path(f.filename).suffix.lower()
        safe_stem = secure_filename(f.filename)
        safe_name = safe_stem if safe_stem else f"upload_{uuid.uuid4().hex[:8]}{ext}"
        save_path = UPLOAD_DIR / f"{sid[:8]}_{uuid.uuid4().hex[:6]}_{safe_name}"
        f.save(str(save_path))
        log.info("[upload] saved → %s  (display: %s)", save_path, display_name)

        try:
            if ext != ".csv" and excel_requires_job(str(save_path)):
                db_path = PARSED_EXCEL_DIR / f"{sid[:8]}_{uuid.uuid4().hex}.duckdb"
                job_id = sess.job_runner.create(
                    lambda ctx, source_path=str(save_path), target=str(db_path), name=display_name:
                        parse_excel_job(ctx, source_path, target, name),
                    job_type="excel_parse",
                    label=display_name,
                )
                pending_jobs.append({
                    "id": job_id,
                    "type": "excel_parse",
                    "source_name": display_name,
                    "status": "queued",
                })
                continue

            source = CSVDataSource(str(save_path), display_name) if ext == ".csv" else ExcelDataSource(str(save_path), display_name)
            schema = source.get_schema()
            source_id = sess.add_source(source)
            added.append({"source_id": source_id, "source_name": display_name,
                          "schema_preview": schema})
        except Exception as exc:
            log.error("[upload] FAILED %s: %s\n%s", f.filename, exc, traceback.format_exc())
            errors.append(f"{f.filename}: {exc}")

    if not added and not pending_jobs:
        return jsonify({"error": "; ".join(errors) or "文件解析失败"}), 400

    payload = {
        "ok": True,
        "added": added,
        "pending_jobs": pending_jobs,
        "sources": sess.list_sources(),
        # convenience: first added file's info (backward-compat for old frontend)
        "source_name": added[0]["source_name"] if added else pending_jobs[0]["source_name"],
        "schema_preview": added[0]["schema_preview"] if added else "",
        "errors": errors,
    }
    return jsonify(payload), (202 if pending_jobs else 200)


@bp.post("/api/session/<sid>/upload-jobs/<jid>/finalize")
def finalize_upload_job(sid: str, jid: str):
    """Attach a completed Excel parse job to the session exactly once."""
    sess = session_manager.get_or_create(sid)
    job = sess.job_runner.get_status(jid)
    if job is None or job.get("type") != "excel_parse":
        return jsonify({"error": "Excel 解析任务不存在"}), 404
    if job.get("status") != "succeeded":
        return jsonify({
            "error": "Excel 解析任务尚未完成",
            "status": job.get("status"),
        }), 409

    result = job.get("result") or {}
    try:
        db_path = Path(result["db_path"]).resolve()
        db_path.relative_to(PARSED_EXCEL_DIR.resolve())
    except (KeyError, OSError, RuntimeError, ValueError):
        return jsonify({"error": "解析任务产物路径无效"}), 500
    if not db_path.is_file():
        return jsonify({"error": "解析任务产物已不存在"}), 410

    with _finalize_lock:
        existing = next(
            (entry for entry in sess._sources
             if getattr(entry.get("source"), "_excel_job_id", None) == jid),
            None,
        )
        if existing is None:
            try:
                source = ExcelDataSource.from_database(
                    result["file_path"], result["filename"], str(db_path)
                )
                source._excel_job_id = jid
                source_id = sess.add_source(source)
                existing = {"id": source_id, "source": source}
            except Exception as exc:
                log.error("[upload] finalize FAILED job=%s: %s\n%s", jid, exc, traceback.format_exc())
                return jsonify({"error": f"挂载解析结果失败：{exc}"}), 500

    source = existing["source"]
    schema = source.get_schema()
    added = [{
        "source_id": existing["id"],
        "source_name": source.name,
        "schema_preview": schema,
    }]
    return jsonify({
        "ok": True,
        "added": added,
        "sources": sess.list_sources(),
        "source_name": source.name,
        "schema_preview": schema,
    })


@bp.post("/api/session/<sid>/connect-db")
def connect_db(sid: str):
    d = request.json or {}
    conn_str     = (d.get("connection_string") or "").strip()
    display_name = (d.get("name") or "").strip()
    # Use saved config if field left blank
    if not conn_str:
        saved = datasource_config_manager.get("sql")
        conn_str = (saved or {}).get("connection_string", "")
    if not conn_str:
        return jsonify({"error": "连接字符串不能为空"}), 400
    conn_str = _encode_db_password(conn_str)
    try:
        source = SQLDataSource(conn_str, display_name)
        sess = session_manager.get_or_create(sid)
        source_id = sess.add_source(source)
        datasource_config_manager.save("sql", {
            "connection_string": conn_str, "name": display_name
        })
        schema = source.get_schema()
        log.info("[connect-db] OK  sid=%s  source=%s  source_id=%s  tables=%d",
                 sid, source.name, source_id,
                 schema.count("Table:"))
        return jsonify({"ok": True, "source_id": source_id,
                        "source_name": source.name,
                        "schema_preview": schema,
                        "sources": sess.list_sources()})
    except Exception as exc:
        log.error("[connect-db] FAILED  sid=%s: %s\n%s", sid, exc, traceback.format_exc())
        return jsonify({"error": _friendly_conn_error(exc, "数据库")}), 400


@bp.get("/api/session/<sid>/sources")
def list_sources(sid: str):
    """Return the list of all connected data sources for this session."""
    sess = session_manager.get(sid)
    if not sess:
        return jsonify({"sources": []})
    return jsonify({"sources": sess.list_sources()})


@bp.post("/api/session/<sid>/sources/<source_id>/analysis-tables")
def set_sql_analysis_tables(sid: str, source_id: str):
    """Persist the server-enforced analysis scope for one remote SQL source."""
    sess = session_manager.get(sid)
    if not sess:
        return jsonify({"error": "session not found"}), 404
    entry = next((item for item in sess._sources if item["id"] == source_id), None)
    if not entry:
        return jsonify({"error": "data source not found"}), 404
    source = entry["source"]
    if not isinstance(source, SQLDataSource):
        return jsonify({"error": "only SQL data sources support table selection"}), 400
    tables = (request.json or {}).get("tables", [])
    if not isinstance(tables, list):
        return jsonify({"error": "tables must be a list"}), 400
    try:
        selected = source.set_analysis_tables(tables)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    sess._combined_schema_cache = None
    sess._invalidate_merged_source()
    return jsonify({"ok": True, "source_id": source_id, "tables": selected})


@bp.post("/api/session/<sid>/sources/<source_id>/toggle")
def toggle_source(sid: str, source_id: str):
    """Toggle a data source active/inactive (multi-select)."""
    sess = session_manager.get(sid)
    if not sess:
        return jsonify({"error": "session not found"}), 404
    new_state = sess.toggle_source(source_id)
    return jsonify({"ok": True, "active": new_state, "sources": sess.list_sources()})


@bp.delete("/api/session/<sid>/sources/<source_id>")
def remove_source(sid: str, source_id: str):
    """Remove one data source from the session."""
    sess = session_manager.get(sid)
    if not sess:
        return jsonify({"error": "session not found"}), 404
    sess.remove_source(source_id)
    return jsonify({"ok": True, "sources": sess.list_sources()})


@bp.get("/api/session/<sid>/preview")
def preview_data(sid: str):
    """Return table metadata for all active sources. No row data — fast."""
    sess = session_manager.get(sid)
    if not sess:
        return jsonify({"error": "no data source"}), 404
    active = sess._active_entries() if hasattr(sess, "_active_entries") else []
    if not active and sess.data_source:
        active = [{"source": sess.data_source}]
    if not active:
        return jsonify({"error": "no data source"}), 404
    # Merge tables from all active sources; tag each with source_id + source_name
    all_tables = []
    requires_table_selection = False
    for entry in active:
        src = entry["source"]
        selectable = isinstance(src, SQLDataSource)
        selected_names = set(src.get_analysis_tables()) if selectable else set()
        requires_table_selection = requires_table_selection or selectable
        for tbl in src.get_preview():
            tbl["source_id"]   = entry["id"]
            tbl["source_name"] = getattr(src, "name", "")
            # Selecting an analysis scope only makes sense for remote SQL
            # catalogs, which may expose thousands of very large tables.
            # Uploaded/local files are already a deliberate bounded selection.
            tbl["selectable_for_analysis"] = selectable
            tbl["selected_for_analysis"] = (
                selectable and tbl.get("name") in selected_names
            )
            all_tables.append(tbl)
    primary = active[0]["source"]
    return jsonify({
        "source_name": getattr(primary, "name", ""),
        "tables": all_tables,
        "requires_table_selection": requires_table_selection,
    })


@bp.get("/api/session/<sid>/preview-table")
def preview_table(sid: str):
    """Return row data for a single table. Requires source_id when multi-source."""
    from flask import request as _req
    sess = session_manager.get(sid)
    if not sess:
        return jsonify({"error": "no data source"}), 404
    table_name = _req.args.get("table", "")
    source_id  = _req.args.get("source_id", "")
    if not table_name:
        return jsonify({"error": "missing table parameter"}), 400

    # Find the right source: by source_id if provided, else first active, else any
    target_src = None
    if source_id and hasattr(sess, "_sources"):
        for entry in sess._sources:
            if entry["id"] == source_id:
                target_src = entry["source"]
                break
    if target_src is None:
        target_src = sess.data_source   # backward-compat fallback
    if target_src is None:
        return jsonify({"error": "no data source"}), 404

    data = target_src.get_preview_table(table_name, max_rows=100)
    return jsonify(data)


@bp.delete("/api/session/<sid>/datasource")
def disconnect_source(sid: str):
    """Disconnect ALL data sources (clear entire list)."""
    sess = session_manager.get_or_create(sid)
    sess.data_source = None   # setter clears _sources list
    return jsonify({"ok": True})


@bp.post("/api/session/<sid>/connect-gsheets")
def connect_gsheets(sid: str):
    import json as _json
    d = request.json or {}
    creds_raw = d.get("creds_json", "")
    spreadsheet = (d.get("spreadsheet") or "").strip()
    display_name = (d.get("name") or "").strip()

    # Use saved creds if field left blank
    if not creds_raw:
        saved = datasource_config_manager.get("gsheets")
        creds_raw = (saved or {}).get("creds_json", "")
    if not spreadsheet:
        saved = datasource_config_manager.get("gsheets")
        spreadsheet = (saved or {}).get("spreadsheet", "")

    if not creds_raw:
        return jsonify({"error": "服务账号 JSON 不能为空"}), 400
    if not spreadsheet:
        return jsonify({"error": "电子表格 URL 或 ID 不能为空"}), 400

    try:
        creds_dict = _json.loads(creds_raw) if isinstance(creds_raw, str) else creds_raw
    except Exception:
        return jsonify({"error": "服务账号 JSON 格式无效"}), 400

    try:
        source = GoogleSheetsDataSource(creds_dict, spreadsheet, display_name)
        sess = session_manager.get_or_create(sid)
        source_id = sess.add_source(source)
        datasource_config_manager.save("gsheets", {
            "creds_json": creds_raw if isinstance(creds_raw, str) else _json.dumps(creds_raw),
            "spreadsheet": spreadsheet, "name": display_name
        })
        return jsonify({"ok": True, "source_id": source_id,
                        "source_name": source.name,
                        "schema_preview": source.get_schema(),
                        "sources": sess.list_sources()})
    except Exception as exc:
        log.error("[connect-gsheets] FAILED: %s\n%s", exc, traceback.format_exc())
        return jsonify({"error": _friendly_conn_error(exc, "Google Sheets")}), 400


@bp.post("/api/session/<sid>/connect-api")
def connect_api(sid: str):
    d = request.json or {}
    url = (d.get("url") or "").strip()
    auth_type = (d.get("auth_type") or "none").strip()
    auth_value = (d.get("auth_value") or "").strip()
    display_name = (d.get("name") or "").strip()

    # Fall back to saved config for blank fields
    saved = datasource_config_manager.get("api") or {}
    if not url:
        url = saved.get("url", "")
    if not url:
        return jsonify({"error": "API URL 不能为空"}), 400
    if not auth_type or auth_type == "none":
        auth_type = saved.get("auth_type", "none")
    if not auth_value:
        auth_value = saved.get("auth_value", "")
    if auth_type not in ("none", "bearer", "api_key"):
        return jsonify({"error": "认证方式无效，支持: none / bearer / api_key"}), 400

    try:
        source = HTTPAPIDataSource(url, auth_type, auth_value, display_name)
        sess = session_manager.get_or_create(sid)
        source_id = sess.add_source(source)
        datasource_config_manager.save("api", {
            "url": url, "auth_type": auth_type,
            "auth_value": auth_value, "name": display_name
        })
        return jsonify({"ok": True, "source_id": source_id,
                        "source_name": source.name,
                        "schema_preview": source.get_schema(),
                        "sources": sess.list_sources()})
    except Exception as exc:
        log.error("[connect-api] FAILED: %s\n%s", exc, traceback.format_exc())
        return jsonify({"error": _friendly_conn_error(exc, "外部 API")}), 400


@bp.get("/api/datasource-configs")
def list_datasource_configs():
    return jsonify(datasource_config_manager.list_public())


@bp.delete("/api/datasource-configs/<ds_type>")
def delete_datasource_config(ds_type: str):
    datasource_config_manager.delete(ds_type)
    return jsonify({"ok": True})
