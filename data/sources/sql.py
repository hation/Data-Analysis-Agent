#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SQLDataSource — any SQLAlchemy-supported DB + DuckDB analysis cache."""
import logging
from typing import List, Optional, Tuple

import duckdb
import pandas as pd

from ._utils import _new_conn, _preview_table_dict, _query, _register, _table_schema_str
from .base import DataSource

log = logging.getLogger(__name__)


class SQLDataSource(DataSource):
    """Connect to any SQLAlchemy-supported database."""

    def __init__(self, connection_string: str, display_name: str = ""):
        from sqlalchemy import create_engine, text, inspect as sa_inspect

        self._engine = create_engine(connection_string, pool_pre_ping=True)
        with self._engine.connect() as conn:
            conn.execute(text("SELECT 1"))

        if display_name:
            self.name = display_name
        else:
            try:
                url = self._engine.url
                self.name = f"{url.host}/{url.database or ''}"
            except Exception:
                self.name = "SQL Database"

        self._inspect = sa_inspect(self._engine)
        # DuckDB cache for materialised analysis tables
        self._cache_conn: Optional[duckdb.DuckDBPyConnection] = None
        self._cache_tables: set = set()

    def get_schema(self) -> str:
        parts: List[str] = []
        try:
            tables = self._inspect.get_table_names()[:50]
        except Exception:
            tables = []
        for table in tables:
            try:
                cols = self._inspect.get_columns(table)
                col_lines = [f"  {c['name']}  {c['type']}" for c in cols]
                parts.append(f"Table: {table}\n" + "\n".join(col_lines))
            except Exception:
                parts.append(f"Table: {table}  (schema unavailable)")
        for t in sorted(self._cache_tables):
            rows = self._cache_conn.execute(
                f'SELECT COUNT(*) FROM "{t}"'
            ).fetchone()[0]
            parts.append(_table_schema_str(self._cache_conn, t, rows))
        return "\n\n".join(parts) if parts else "No tables found."

    def execute_query(self, sql: str) -> Tuple[pd.DataFrame, str]:
        if self._cache_conn and any(t in sql for t in self._cache_tables):
            return _query(self._cache_conn, sql)
        from sqlalchemy import text
        try:
            with self._engine.connect() as conn:
                df = pd.read_sql(text(sql), conn)
            return df, ""
        except Exception as exc:
            return pd.DataFrame(), str(exc)

    def create_analysis_table(self, sql: str, table_name: str = "analysis_data", _df=None) -> str:
        if self._cache_conn is None:
            self._cache_conn = _new_conn()
        if _df is not None:
            _register(self._cache_conn, table_name, _df)
            rows = len(_df)
        else:
            df, err = self.execute_query(sql)
            if err:
                return f"Error building analysis table: {err}"
            _register(self._cache_conn, table_name, df)
            rows = len(df)
        self._cache_tables.add(table_name)
        return _table_schema_str(self._cache_conn, table_name, rows)

    def list_tables(self) -> List[str]:
        # Source DB tables + runtime analysis cache tables.
        try:
            tables = list(self._inspect.get_table_names())
        except Exception:
            tables = []
        for t in sorted(self._cache_tables):
            if t not in tables:
                tables.append(t)
        return tables

    def get_preview(self) -> List[dict]:
        result = []
        # Analysis cache tables
        if self._cache_conn:
            for t in sorted(self._cache_tables):
                try:
                    cols = [r[0] for r in self._cache_conn.execute(f'DESCRIBE "{t}"').fetchall()]
                    total = self._cache_conn.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
                    result.append({"name": f"[分析表] {t}", "columns": cols, "total_rows": total})
                except Exception:
                    continue
        # Source DB tables — just names + columns, no row data
        try:
            tables = self._inspect.get_table_names()[:20]
        except Exception:
            tables = []
        for t in tables:
            try:
                from sqlalchemy import text as _text
                with self._engine.connect() as _c:
                    col_rows = _c.execute(_text(f"SELECT * FROM `{t}` LIMIT 0")).keys()
                    cols = list(col_rows)
                result.append({"name": t, "columns": cols, "total_rows": None})
            except Exception:
                result.append({"name": t, "columns": [], "total_rows": None})
        return result

    def get_preview_table(self, table_name: str, max_rows: int = 100) -> dict:
        # Check analysis cache first (DuckDB-backed)
        if self._cache_conn and table_name.startswith("[分析表] "):
            real = table_name[len("[分析表] "):]
            return _preview_table_dict(self._cache_conn, real, table_name, max_rows)
        # Source DB table — goes through SQLAlchemy
        df, err = self.execute_query(f"SELECT * FROM `{table_name}` LIMIT {max_rows}")
        if err:
            return {"name": table_name, "columns": [], "rows": [], "total_rows": None, "error": err}
        rows = [["" if v is None else str(v) for v in row] for row in df.itertuples(index=False)]
        return {"name": table_name, "columns": list(df.columns),
                "rows": rows, "total_rows": None}
