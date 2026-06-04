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


def _is_wide_pivoted(raw: pd.DataFrame) -> bool:
    """Detect if this sheet is a wide/pivoted table where:
    - The first column contains metric/row labels (text)
    - The remaining columns contain time-series or category values (mostly numeric)
    - Most column headers are Unnamed or blank (pandas default)

    Heuristic: if >60% of column headers are Unnamed/blank AND the first column
    has text values in most rows → this is a wide pivoted table that needs
    to be read with the first column as the index and then transposed.
    """
    if raw.shape[1] < 5:
        return False

    # Count blank/Unnamed column headers (from pandas default header=0 read)
    # Use the raw values since we read with header=None; check the row that
    # pandas *would* use as header (row 0) for blanks.
    top_row = [str(v).strip() for v in raw.iloc[0]]
    blank_cols = sum(1 for v in top_row if not v or v == 'nan')
    blank_ratio = blank_cols / len(top_row)

    # Check if first column has text labels in most rows (metric names)
    first_col = raw.iloc[:, 0].dropna().astype(str)
    text_in_first = sum(
        1 for v in first_col
        if v.strip() and not v.strip().replace('.', '').replace('-', '').isdigit()
    )
    text_ratio = text_in_first / max(len(first_col), 1)

    # Wide pivoted: mostly blank column headers AND first col is mostly text labels
    return blank_ratio > 0.6 and text_ratio > 0.5


def _pivot_to_long(raw: pd.DataFrame) -> Optional[pd.DataFrame]:
    """Convert a wide pivoted table (metrics × dates) to long format (dates × metrics).

    Strategy:
    1. Find the row that contains the most date-like values → use as column headers
    2. Find rows where the first cell is a metric name → use as data rows
    3. Transpose: rows become columns (metric names), columns become rows (dates/periods)
    """
    import re

    DATE_PAT = re.compile(r'\d{4}[-/]\d{1,2}[-/]\d{1,2}')

    n_rows, n_cols = raw.shape

    # Step 1: Find the best "header row" — the one with the most date-like values
    best_header_row = 0
    best_date_count = 0
    for i in range(min(n_rows, 10)):
        row_vals = [str(v) for v in raw.iloc[i]]
        date_count = sum(1 for v in row_vals if DATE_PAT.search(v))
        if date_count > best_date_count:
            best_date_count = date_count
            best_header_row = i

    # Step 2: Find data rows — rows where the first cell is a non-blank text label
    header_row_vals = [str(v).strip() for v in raw.iloc[best_header_row]]

    data_rows = []
    row_labels = []
    for i in range(n_rows):
        if i == best_header_row:
            continue
        first_cell = str(raw.iloc[i, 0]).strip()
        if not first_cell or first_cell == 'nan':
            continue
        # Must have some numeric data in the row (at least 30% of non-blank cells)
        row_vals = raw.iloc[i, 1:]
        numeric = sum(1 for v in row_vals
                      if str(v).strip() and str(v).strip() != 'nan'
                      and str(v).strip().replace('.', '').replace('-', '').replace('%', '').lstrip('-').isdigit())
        non_blank = sum(1 for v in row_vals if str(v).strip() and str(v).strip() != 'nan')
        if non_blank > 0 and numeric / non_blank > 0.3:
            data_rows.append(i)
            row_labels.append(first_cell)

    if not data_rows or best_date_count < 3:
        return None  # Not recognizable as a wide pivoted table

    # Step 3: Build the transposed DataFrame
    # Columns = metric names (from first column of data rows)
    # Rows = dates/periods (from the header row we found)
    col_headers = header_row_vals[1:]   # skip the first cell (it's the row-label column)
    data_matrix = []
    for i in data_rows:
        data_matrix.append([str(v).strip() if str(v).strip() != 'nan' else None
                            for v in raw.iloc[i, 1:]])

    # Transpose: data_matrix[metric][date] → df[date][metric]
    df = pd.DataFrame(data_matrix, index=row_labels, columns=col_headers).T
    df.index.name = 'period'
    df = df.reset_index()

    # Clean column names
    df.columns = _dedup_columns([_clean_identifier(str(c)) for c in df.columns])

    # Drop all-null rows and columns
    df = df.dropna(how='all').dropna(axis=1, how='all')

    # Keep only rows where the period column looks like a real date/period value
    # (filter out metadata rows like "City", "DeltaDo7D", etc.)
    period_col = df.columns[0]
    DATE_PAT2 = re.compile(r'\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[Ww]\d{2}|\w+\s+\d{4}')
    mask = df[period_col].astype(str).str.strip().apply(
        lambda v: bool(DATE_PAT2.search(v)) or v.replace('.', '').replace('-', '').isdigit()
    )
    df = df[mask].reset_index(drop=True)

    log.info(
        "[ExcelDS] wide-pivoted sheet: %d metric cols × %d period rows (header at row %d)",
        len(data_rows), len(df), best_header_row,
    )
    return df if not df.empty else None


def _parse_sheet(path: str, sheet: str, engine: str) -> Tuple[str, Optional[pd.DataFrame]]:
    """Parse a single Excel sheet, auto-detecting the header row.

    Also handles wide/pivoted tables (metrics × dates) by transposing them
    into a tidy long format (dates × metrics) that SQL can query cleanly.
    """
    try:
        # Read without header first to detect structure
        raw = pd.read_excel(path, sheet_name=sheet, engine=engine, header=None)
        if raw.empty:
            return sheet, None

        # Detect wide pivoted format before normal header detection
        if _is_wide_pivoted(raw):
            df = _pivot_to_long(raw)
            if df is not None:
                log.info("[ExcelDS] sheet %r: transposed wide-pivoted format → %d rows", sheet, len(df))
                return sheet, df
            # Fall through to normal parsing if pivot detection failed

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
            log.warning(
                "[ExcelDS] python_calamine not installed, falling back to openpyxl "
                "(significantly slower for large files — run: pip install python-calamine)"
            )
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
