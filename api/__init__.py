"""Flask application factory."""
import logging
import os
from pathlib import Path

from flask import Flask, render_template
from flask_cors import CORS
from infrastructure.paths import resource_path

log = logging.getLogger(__name__)


def _start_background_services() -> None:
    """Start long-lived background services (local only, skipped on Vercel)."""
    if os.environ.get("VERCEL"):
        return
    if not resource_path("MCP").is_dir():
        log.info("[startup] bundled MCP resources are not installed; continuing without them")
        return
    try:
        from MCP.flowchart_server import ensure_flowchart_server
        ensure_flowchart_server()
    except Exception as e:
        log.warning("[startup] flowchart server: %s", e)


def create_app() -> Flask:
    _start_background_services()

    app = Flask(
        __name__,
        template_folder=str(resource_path("templates")),
        static_folder=str(resource_path("static")),
    )
    app.secret_key = os.urandom(32)
    CORS(app)

    from .models          import bp as models_bp
    from .datasource      import bp as datasource_bp
    from .chat            import bp as chat_bp
    from .saved_sessions  import bp as saved_sessions_bp
    from .system          import bp as system_bp
    from .output          import bp as output_bp
    from .mcp             import bp as mcp_bp
    from .dashboard       import bp as dashboard_bp
    from .knowledge       import bp as knowledge_bp
    from .workspace       import bp as workspace_bp
    from .jobs            import bp as jobs_bp
    from .skills          import bp as skills_bp
    from .commands        import bp as commands_bp

    app.register_blueprint(models_bp)
    app.register_blueprint(datasource_bp)
    app.register_blueprint(chat_bp)
    app.register_blueprint(saved_sessions_bp)
    app.register_blueprint(system_bp)
    app.register_blueprint(output_bp)
    app.register_blueprint(mcp_bp)
    app.register_blueprint(dashboard_bp)
    app.register_blueprint(knowledge_bp)
    app.register_blueprint(workspace_bp)
    app.register_blueprint(jobs_bp)
    app.register_blueprint(skills_bp)
    app.register_blueprint(commands_bp)

    @app.get("/")
    def index():
        return render_template("agent_chat.html")

    @app.get("/api/health")
    def health():
        """Minimal desktop-launch readiness probe; never expose local config."""
        return {
            "ok": True,
            "status": "healthy",
            "service": "business-analytics-agent",
        }

    return app
