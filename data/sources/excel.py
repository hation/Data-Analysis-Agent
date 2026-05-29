#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ExcelDataSource — multi-sheet .xlsx/.xls loader (calamine, falls back to openpyxl)."""
import logging
from typing import List, Optional, Tuple

import pandas as pd

from ._utils import (
    _clean_identifier, _dedup_columns, _detect_header_row,
    _list_tables, _new_conn, _preview_table_dict, _query, _register,
    _table_schema_str,
)
from .base import DataSource

log = logging.getLogger(__name__)


def _parse_sheet(path: str, sheet: str, engine: str) -> Tuple[str, Optional[pd.DataFrame]]:
    """Parse a single Excel sheet, auto-detecting the header row."""
    try:
        # Read without header first to detect the best header row
        raw = pd.read_excel(path, sheet_name=sheet, engine=engine, header=None)
        if raw.empty:
            return sheet, None
        header_idx = _detect_header_row(raw.values.tolist())
        df = pd.read_excel(path, sheet_name=sheet, engine=engine,
                           header=header_idx, skiprows=range(header_idx) if header_idx else None)
        log.info("[ExcelDS] sheet %r: header at row %d", sheet, header_idx)
        df.columns = _dedup_columns([_clean_identifier(c) for c in df.columns])
        df = df.dropna(how="all")
        if df.empty or len(df.columns) == 0:
            return sheet, None
        return sheet, df
    except Exception as exc:
        log.warning("[ExcelDS] sheet %r parse failed: %s", sheet, exc)
        return sheet, None


class ExcelDataSource(DataSource):
    """Load one or more sheets from an Excel file into a DuckDB in-memory DB."""

    def __init__(self, file_path: str, filename: str):
        self.name = filename
        self.file_path = file_path
        self._conn = _new_conn()
        self._tables: List[str] = []
        self._load(file_path)

    def _load(self, path: str):
        from concurrent.futures import ThreadPoolExecutor

        # calamine (Rust-based) is 5-10× faster than openpyxl; fall back if unavailable
        try:
            import python_calamine  # noqa: F401
            engine = "calamine"
        except ImportError:
            engine = "openpyxl"

        # Read sheet names only (fast metadata call)
        xl_meta = pd.ExcelFile(path, engine=engine)
        sheet_names = xl_meta.sheet_names
        xl_meta.close()
        log.info("[ExcelDS] engine=%s  sheets=%s", engine, sheet_names)

        # Parse all sheets in parallel
        with ThreadPoolExecutor(max_workers=min(4, len(sheet_names))) as pool:
            futures = {pool.submit(_parse_sheet, path, s, engine): s for s in sheet_names}

        # Register in original sheet order
        for sheet in sheet_names:
            future = next(f for f, s in futures.items() if s == sheet)
            _, df = future.result()
            if df is None:
                log.info("[ExcelDS] sheet %r skipped (no data)", sheet)
                continue
            table = _clean_identifier(sheet) or f"sheet{len(self._tables) + 1}"
            log.info("[ExcelDS] register → table=%r  rows=%d", table, len(df))
            _register(self._conn, table, df)
            self._tables.append(table)

        if not self._tables:
            raise ValueError("Excel 文件中未发现有效工作表。")

    def get_schema(self) -> str:
        parts: List[str] = []
        for table in self._tables:
            rows = self._conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
            parts.append(_table_schema_str(self._conn, table, rows))
        return "\n\n".join(parts)

    def execute_query(self, sql: str) -> Tuple[pd.DataFrame, str]:
        return _query(self._conn, sql)

    def create_analysis_table(self, sql: str, table_name: str = "analysis_data", _df=None) -> str:
        if _df is not None:
            _register(self._conn, table_name, _df)
            rows = len(_df)
        else:
            try:
                self._conn.execute(
                    f'CREATE OR REPLACE TABLE "{table_name}" AS ({sql})'
                )
                rows = self._conn.execute(
                    f'SELECT COUNT(*) FROM "{table_name}"'
                ).fetchone()[0]
            except Exception as exc:
                return f"Error building analysis table: {exc}"
        # Track the new table so get_schema / list_tables include it.
        if table_name not in self._tables:
            self._tables.append(table_name)
        return _table_schema_str(self._conn, table_name, rows)

    def list_tables(self) -> List[str]:
        return _list_tables(self._conn)

    def get_preview(self) -> List[dict]:
        """Return table metadata only — fast even for 50+ sheet workbooks."""
        result = []
        for t in self._tables:
            try:
                cols = [r[0] for r in self._conn.execute(f'DESCRIBE "{t}"').fetchall()]
                total = self._conn.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
                result.append({"name": t, "columns": cols, "total_rows": total})
            except Exception:
                continue
        return result

    def get_preview_table(self, table_name: str, max_rows: int = 100) -> dict:
        return _preview_table_dict(self._conn, table_name, table_name, max_rows)
