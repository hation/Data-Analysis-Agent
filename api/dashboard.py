# -*- coding: utf-8 -*-
"""Blueprint: dashboard CRUD + refresh endpoints."""
import json
import os
import re
import datetime
import uuid

from flask import Blueprint, request, jsonify, render_template, abort

bp = Blueprint("dashboard", __name__)

_PROJ_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_DASHBOARD_DIR = os.path.join(_PROJ_ROOT, "outputs", "Dashboard")

_SCHEMA_VERSION = 1


def _dashboard_path(dashboard_id: str) -> str:
    safe = re.sub(r'[^\w\-]', '_', dashboard_id)
    return os.path.join(_DASHBOARD_DIR, f"{safe}.json")


def _load_dashboard(dashboard_id: str) -> dict:
    path = _dashboard_path(dashboard_id)
    if not os.path.isfile(path):
        abort(404, description=f"Dashboard '{dashboard_id}' not found")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _save_dashboard(data: dict, dashboard_id: str) -> None:
    os.makedirs(_DASHBOARD_DIR, exist_ok=True)
    path = _dashboard_path(dashboard_id)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


_CHART_TYPE_ALIASES = {
    "Scatter_Chart": "Scatter_Plot",
    "Heatmap_Chart": "Heatmap",
    "Donut_Chart": "Pie_Chart",
    "Table_Chart": "Bar_Chart",
    "Grouped_Bar": "Grouped_Bar_Chart",
    "Stacked_Bar": "Stacked_Bar_Chart",
}


def _render_widget(data_source, chart_store, color_scheme: str, spec: dict) -> tuple[str | None, str | None]:
    """Execute SQL and generate chart HTML. Returns (chart_id, error)."""
    sql = spec.get("sql", "")
    if not sql or not data_source:
        return None, ("No SQL defined" if not sql else "No data source")

    try:
        from chart_generate import generate_chart as _gen
        df, err = data_source.execute_query(sql)
        if err:
            return None, f"SQL error: {err}"
        if df.empty:
            return None, "Query returned no rows"

        opts = {}
        if spec.get("title"):
            opts["title"] = spec["title"]
        opts.update(spec.get("options", {}))

        result = _gen(
            df=df,
            chart_type=_CHART_TYPE_ALIASES.get(spec.get("chart_type", "Bar_Chart"), spec.get("chart_type", "Bar_Chart")),
            mapping=spec.get("field_mapping", {}),
            options=opts,
            color_scheme=color_scheme,
        )
        if "error" in result:
            return None, result["error"]

        chart_id = str(uuid.uuid4())
        chart_store[chart_id] = result["html"]
        return chart_id, None

    except Exception as exc:
        return None, str(exc)


# ── Page route ────────────────────────────────────────────────────────────────

@bp.get("/dashboard/<dashboard_id>")
def dashboard_page(dashboard_id: str):
    return render_template("dashboard.html", dashboard_id=dashboard_id)


# ── API: create (called by agent generate_dashboard tool) ────────────────────

@bp.post("/api/dashboard/generate")
def create_dashboard():
    from .state import session_manager, chart_store
    body = request.get_json(force=True)
    sid = body.get("session_id", "")
    name = body.get("name", "Dashboard")
    widgets_spec = body.get("widgets", [])
    color_scheme = body.get("color_scheme", "mckinsey")

    sess = session_manager.get(sid)
    data_source = sess.data_source if sess else None

    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_name = re.sub(r'[^\w\-]', '_', name)
    dashboard_id = f"{safe_name}_{ts}"

    built_widgets = []
    for spec in widgets_spec:
        widget_id = spec.get("id") or str(uuid.uuid4())[:8]
        chart_id, error = _render_widget(data_source, chart_store, color_scheme, spec)
        built_widgets.append({
            "id": widget_id,
            "title": spec.get("title", ""),
            "chart_type": spec.get("chart_type", "Bar_Chart"),
            "sql": spec.get("sql", ""),
            "field_mapping": spec.get("field_mapping", {}),
            "options": spec.get("options", {}),
            "grid": spec.get("grid", {"x": 0, "y": 0, "w": 6, "h": 4}),
            "chart_id": chart_id,
            "error": error,
        })

    dashboard = {
        "_schema_version": _SCHEMA_VERSION,
        "id": dashboard_id,
        "name": name,
        "created_at": datetime.datetime.now().isoformat(),
        "color_scheme": color_scheme,
        "session_id": sid,
        "widgets": built_widgets,
    }
    _save_dashboard(dashboard, dashboard_id)
    return jsonify({"dashboard_id": dashboard_id, "url": f"/dashboard/{dashboard_id}"})


# ── API: get ──────────────────────────────────────────────────────────────────

@bp.get("/api/dashboard/<dashboard_id>")
def get_dashboard(dashboard_id: str):
    return jsonify(_load_dashboard(dashboard_id))


# ── API: list ─────────────────────────────────────────────────────────────────

@bp.get("/api/dashboards")
def list_dashboards():
    os.makedirs(_DASHBOARD_DIR, exist_ok=True)
    results = []
    for fname in sorted(os.listdir(_DASHBOARD_DIR), reverse=True):
        if not fname.endswith(".json"):
            continue
        fpath = os.path.join(_DASHBOARD_DIR, fname)
        try:
            with open(fpath, encoding="utf-8") as f:
                d = json.load(f)
            results.append({
                "id": d.get("id", fname[:-5]),
                "name": d.get("name", fname[:-5]),
                "created_at": d.get("created_at", ""),
                "widget_count": len(d.get("widgets", [])),
            })
        except Exception:
            continue
    return jsonify(results)


# ── API: update layout ────────────────────────────────────────────────────────

@bp.put("/api/dashboard/<dashboard_id>")
def update_dashboard(dashboard_id: str):
    body = request.get_json(force=True)
    dashboard = _load_dashboard(dashboard_id)

    grid_updates = {w["id"]: w["grid"] for w in body.get("widgets", []) if "id" in w and "grid" in w}
    if grid_updates:
        for widget in dashboard["widgets"]:
            if widget["id"] in grid_updates:
                widget["grid"] = grid_updates[widget["id"]]

    if "name" in body:
        dashboard["name"] = body["name"]

    if "container_width" in body:
        dashboard["container_width"] = body["container_width"]

    dashboard["updated_at"] = datetime.datetime.now().isoformat()
    _save_dashboard(dashboard, dashboard_id)
    return jsonify({"ok": True})


# ── API: delete ───────────────────────────────────────────────────────────────

@bp.delete("/api/dashboard/<dashboard_id>")
def delete_dashboard(dashboard_id: str):
    path = _dashboard_path(dashboard_id)
    if not os.path.isfile(path):
        abort(404)
    os.remove(path)
    return jsonify({"ok": True})


# ── API: refresh ──────────────────────────────────────────────────────────────

@bp.post("/api/dashboard/<dashboard_id>/refresh")
def refresh_dashboard(dashboard_id: str):
    from .state import session_manager, chart_store
    body = request.get_json(force=True)
    sid = body.get("session_id", "")

    sess = session_manager.get(sid)
    if not sess:
        return jsonify({"error": "Session not found — please open the dashboard from an active chat session"}), 404

    data_source = sess.data_source
    if not data_source:
        return jsonify({"error": "No data source connected in the session. Upload data first."}), 400

    dashboard = _load_dashboard(dashboard_id)
    color_scheme = dashboard.get("color_scheme", "mckinsey")

    widget_results = []
    for widget in dashboard["widgets"]:
        chart_id, error = _render_widget(data_source, chart_store, color_scheme, widget)
        widget["chart_id"] = chart_id
        widget["error"] = error
        widget_results.append({"id": widget["id"], "chart_id": chart_id, "error": error})

    dashboard["refreshed_at"] = datetime.datetime.now().isoformat()
    _save_dashboard(dashboard, dashboard_id)

    return jsonify({"ok": True, "widgets": widget_results})
