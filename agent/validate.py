#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Pre-flight validation of tool call arguments.

Runs BEFORE the tool dispatch, so dangerous inputs (write SQL,
malformed schemas) never reach the underlying executor.

Centralized here so:
  - The "what's blocked" policy lives in one place
  - Tests can exercise the rules without spinning up an LLM
  - Both BusinessAgent and any future bypass path (e.g. /sql fast path)
    can apply the same guards

SQL validation strategy (AST-level, not keyword matching)
---------------------------------------------------------
Previous approach: keyword blacklist (DROP/DELETE/…) + "must start with SELECT".

Problems with the old approach:
  1. False positives: SELECT update_time FROM … or WHERE note = 'please DELETE'
     were blocked even though they are read-only.
  2. Bypasses: DuckDB allows reading arbitrary files via read_csv('/etc/passwd'),
     ATTACH external databases, INSTALL/LOAD extensions, COPY … TO … — all of
     which can start with SELECT or contain no blocked keywords.

New approach:
  - Use sqlglot to parse the SQL into an AST and inspect structure.
  - Accept only a single SELECT or WITH (CTE) statement.
  - Recursively scan for banned function calls and COPY nodes.
  - Fall back to the old keyword heuristic if sqlglot is unavailable
    (so the app still works without the optional dependency).

DuckDB connection-level lockdown (second layer, in _utils.py):
  SET disabled_filesystems = 'LocalFileSystem'
  SET enable_external_access = false
"""
import logging
from typing import Any, Dict, Optional

log = logging.getLogger(__name__)

# Tool names whose JSON args carry a `sql` field that runs against the data source.
SQL_TOOLS = {"create_analysis_table", "query_data", "generate_chart", "run_analysis"}

# Functions that must never appear in any SQL we execute, regardless of context.
# These are DuckDB-specific filesystem / network / extension functions.
_BANNED_FUNCTIONS = {
    # File system reads
    "read_csv", "read_csv_auto", "read_json", "read_json_auto",
    "read_parquet", "read_text", "read_blob", "glob",
    # File system writes
    "copy_to",
    # Extension management (can load arbitrary native code)
    "install", "load",
    # External database attachment
    "attach", "detach",
    # Meta-commands
    "pragma",
    # Network access (httpfs extension)
    "http_get", "httpget", "http_post",
}


def _validate_sql_ast(sql: str) -> Optional[str]:
    """AST-level SQL validation using sqlglot.

    Returns an error string if the SQL is disallowed, else None.
    Falls back to a lightweight heuristic when sqlglot is not installed.
    """
    try:
        import sqlglot
        import sqlglot.expressions as exp
    except ImportError:
        # sqlglot not installed — fall back to conservative heuristic
        log.debug("[validate] sqlglot not available, using heuristic fallback")
        return _validate_sql_heuristic(sql)

    # ── Parse ──────────────────────────────────────────────────────────────────
    try:
        statements = sqlglot.parse(sql, dialect="duckdb", error_level=sqlglot.ErrorLevel.RAISE)
    except Exception as exc:
        # Parse error — could be valid DuckDB but not parseable by sqlglot.
        # Fall back to heuristic rather than blocking legitimate queries.
        log.debug("[validate] sqlglot parse error (%s), falling back to heuristic", exc)
        return _validate_sql_heuristic(sql)

    # ── Multi-statement check ──────────────────────────────────────────────────
    if len(statements) > 1:
        return "不允许多语句 SQL（检测到分号分隔的多条语句）。"
    if not statements:
        return "SQL 语句为空。"

    stmt = statements[0]

    # ── Top-level statement type ───────────────────────────────────────────────
    if not isinstance(stmt, (exp.Select, exp.With)):
        stmt_type = type(stmt).__name__
        return (
            f"只允许 SELECT / WITH 查询，检测到: {stmt_type}。"
            "请使用 SELECT 语句查询数据。"
        )

    # ── Banned function scan (recursive) ──────────────────────────────────────
    for node in stmt.walk():
        # Anonymous function (e.g. read_csv_auto which sqlglot may not recognise)
        if isinstance(node, exp.Anonymous):
            fname = (node.name or "").lower()
            if fname in _BANNED_FUNCTIONS:
                return f"禁止使用函数 {fname}()：该函数可访问文件系统或网络。"

        # Named function nodes
        if isinstance(node, exp.Func):
            fname = type(node).__name__.lower()
            # Also check the sql_name if available
            sql_name = getattr(node, "sql_name", lambda: "")()
            for candidate in (fname, sql_name.lower()):
                if candidate in _BANNED_FUNCTIONS:
                    return f"禁止使用函数 {candidate}()：该函数可访问文件系统或网络。"

    # ── COPY statement scan ────────────────────────────────────────────────────
    for node in stmt.walk():
        if isinstance(node, exp.Copy):
            return "禁止 COPY 操作：不允许将数据写入文件。"

    return None  # all good


def _validate_sql_heuristic(sql: str) -> Optional[str]:
    """Lightweight keyword-based fallback used when sqlglot is unavailable.

    Less precise than AST validation (can produce false positives on column
    names / string literals), but keeps security guarantees when the optional
    dependency is missing.
    """
    import re

    sql_stripped = sql.strip()
    sql_lower = sql_stripped.lower()

    if not sql_lower:
        return "SQL 语句为空。"

    # ── Multi-statement check (split on unquoted semicolons) ──────────────────
    # Simple heuristic: count semicolons outside of single/double-quoted strings.
    # Strips trailing semicolon first (many tools append one).
    sql_no_trail = sql_stripped.rstrip(";").strip()
    # Remove quoted strings ('' and "") to avoid false positives on ';' in literals
    _no_quotes = re.sub(r"'[^']*'|\"[^\"]*\"", "", sql_no_trail)
    if ";" in _no_quotes:
        return "不允许多语句 SQL（检测到分号分隔的多条语句）。"

    if not sql_lower.startswith("select") and not sql_lower.startswith("with"):
        return f"只允许 SELECT/WITH 查询。检测到: {sql_lower[:60]}"

    # ── Write-operation keywords ───────────────────────────────────────────────
    _WRITE_TOKENS = [
        r"\bdrop\b", r"\bdelete\b", r"\btruncate\b",
        r"\binsert\b", r"\bupdate\b", r"\balter\b",
        r"\bcreate\s+table\b", r"\bcreate\s+index\b",
    ]
    for pattern in _WRITE_TOKENS:
        if re.search(pattern, sql_lower):
            token = re.sub(r"\\[bsS]|\(.*\)", "", pattern).strip().replace("\\", "")
            return f"禁止写操作关键字 {token}：只允许 SELECT 查询。"

    # ── Banned DuckDB filesystem / extension keywords ─────────────────────────
    _BANNED_TOKENS = [
        r"\bread_csv\b", r"\bread_csv_auto\b", r"\bread_json\b",
        r"\bread_parquet\b", r"\bread_text\b", r"\bread_blob\b",
        r"\binstall\b", r"\bload\b", r"\battach\b", r"\bdetach\b",
        r"\bcopy\b", r"\bpragma\b",
    ]
    for pattern in _BANNED_TOKENS:
        if re.search(pattern, sql_lower):
            token = pattern.replace(r"\b", "").strip()
            return f"禁止使用 {token}：该操作可访问文件系统或网络。"

    return None


def validate_tool_args(name: str, args: Dict[str, Any]) -> Optional[str]:
    """Return an error string if args are obviously invalid, else None.

    Policy:
      - SQL_TOOLS: `sql` is required; AST-level validation (SELECT/WITH only,
        no banned functions, no multi-statement)
      - run_analysis: analysis_name + target_column required
      - propose_ppt_outline / generate_ppt: `slides` (if present) must be a list
      - propose_dashboard_outline / generate_dashboard: `widgets` (if present) must be a list
    """
    if name in SQL_TOOLS:
        sql = (args.get("sql") or "").strip()
        if not sql:
            return f"'{name}' requires a non-empty 'sql' argument."
        err = _validate_sql_ast(sql)
        if err:
            return f"'{name}' SQL validation failed: {err}"

    if name == "run_analysis":
        if not args.get("analysis_name"):
            return "'run_analysis' requires 'analysis_name'."
        if not args.get("target_column"):
            return "'run_analysis' requires 'target_column'."

    if name in ("propose_ppt_outline", "generate_ppt"):
        slides = args.get("slides")
        if slides is not None and not isinstance(slides, list):
            return f"'{name}': 'slides' must be a list."

    if name in ("propose_dashboard_outline", "generate_dashboard"):
        widgets = args.get("widgets")
        if widgets is not None and not isinstance(widgets, list):
            return f"'{name}': 'widgets' must be a list."

    return None
