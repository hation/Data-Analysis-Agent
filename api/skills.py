"""Public catalog for file-based analysis skills."""
import logging

from flask import Blueprint, jsonify, request

from agent.skills import SkillLoader

log = logging.getLogger(__name__)

bp = Blueprint("skills", __name__)


@bp.get("/api/skills")
def list_skills():
    workspace_dir = None
    sid = (request.args.get("sid") or "").strip()
    if sid:
        from data.workspace import workspace_manager
        runtime = workspace_manager.get(sid)
        if runtime:
            workspace_dir = runtime.workdir / ".baa" / "skills"
    loader = SkillLoader(workspace_dir=workspace_dir)
    loaded = loader.load_all()
    # Skill and Command namespaces are independent from S0 onward.
    skills = [skill.to_public_dict() for skill in loaded.values()]
    return jsonify({
        "skills": skills,
        "diagnostics": [item.to_dict() for item in loader.diagnostics()],
    })
