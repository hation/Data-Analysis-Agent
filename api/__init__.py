"""Flask application factory."""
import os
from pathlib import Path

from flask import Flask, render_template
from flask_cors import CORS


def _start_background_services() -> None:
    """Start long-lived background services (local only, skipped on Vercel)."""
    if os.environ.get("VERCEL"):
        return
    try:
        from MCP.flowchart_server import ensure_flowchart_server
        ensure_flowchart_server()
    except Exception as e:
        import logging
        logging.getLogger(__name__).warning("[startup] flowchart server: %s", e)


def create_app() -> Flask:
    _start_background_services()

    root = Path(__file__).parent.parent
    app = Flask(
        __name__,
        template_folder=str(root / "templates"),
        static_folder=str(root / "static"),
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

    app.register_blueprint(models_bp)
    app.register_blueprint(datasource_bp)
    app.register_blueprint(chat_bp)
    app.register_blueprint(saved_sessions_bp)
    app.register_blueprint(system_bp)
    app.register_blueprint(output_bp)
    app.register_blueprint(mcp_bp)
    app.register_blueprint(dashboard_bp)
    app.register_blueprint(knowledge_bp)

    @app.get("/")
    def index():
        return render_template("agent_chat.html")

    return app
