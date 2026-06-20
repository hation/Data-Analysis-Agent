"""Public catalog for file-based analysis skills."""
from flask import Blueprint, jsonify

from agent.prompts import COMMAND_HINTS
from agent.skills import load_skills

bp = Blueprint("skills", __name__)


@bp.get("/api/skills")
def list_skills():
    # Built-in commands keep precedence if a skill accidentally reuses a name.
    skills = [
        skill.to_public_dict()
        for name, skill in load_skills().items()
        if name not in COMMAND_HINTS
    ]
    return jsonify({"skills": skills})
