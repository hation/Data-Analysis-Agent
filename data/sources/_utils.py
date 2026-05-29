#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Shared DuckDB / DataFrame helpers used by every data source.

These were originally module-level helpers in `data.connector`. They are
intentionally underscore-prefixed and not re-exported — concrete sources
import them directly.
"""
import datetime
import logging
import re
from typing import List, Optional, Tuple

import duckdb
import numpy as np
import pandas as pd

log = logging.getLogger(__name__)


# ── Identifier / column helpers ──────────────────────────────────────────────

def _clean_identifier(raw: str) -> str:
    """Turn an arbitrary string into a safe DuckDB/SQL identifier."""
    if isinstance(raw, (tuple, list)):
        raw = "_".join(str(x) for x in raw)
    s = str(raw).strip()
    s = re.sub(r"[^\w]+", "_", s, flags=re.UNICODE)
    s = s.strip("_")
    if s and s[0].isdigit():
        s = "_" + s
    return s or "col"


def _dedup_columns(cols: List[str]) -> List[str]:
    """Append _2, _3 … to duplicate column names."""
    seen: dict = {}
    result = []
    for c in cols:
        if c not in seen:
            seen[c] = 1
            result.append(c)
        else:
            seen[c] += 1
            result.append(f"{c}_{seen[c]}")
    return result


def _detect_header_row(rows: list, scan: int = 10) -> int:
    """
    Return the index of the best header row within the first `scan` rows.
    Scores each row by number of non-empty, non-numeric cells (good column names
    are usually text). Ties broken by preferring earlier rows.
    Returns 0 if nothing clearly better is found.
    """
    best_idx, best_score = 0, -1
    for i, row in enumerate(rows[:scan]):
        score = sum(
            1 for cell in row
            if str(cell).strip() and not str(cell).strip().replace(".", "").replace("-", "").replace("%", "").isdigit()
        )
        if score > best_score:
            best_score, best_idx = score, i
    return best_idx


# ── DuckDB connection / registration ─────────────────────────────────────────

def _new_conn() -> duckdb.DuckDBPyConnection:
    """Open a fresh DuckDB in-memory connection with sane thread settings."""
    conn = duckdb.connect(":memory:")
    # Allow connections to be used from multiple threads (Flask worker threads)
    conn.execute("PRAGMA threads=4")
    return conn


def _sanitize_df(df: pd.DataFrame) -> pd.DataFrame:
    """
    修复 DuckDB 无法自动 cast 的列类型，避免 "Failed to cast value: DOUBLE -> TIMESTAMP" 等错误。

    主要场景：
    1. pandas 把 Excel 数值型日期序列号（如 44927.0）读成 float64，
       但 DuckDB 试图将其 cast 为 TIMESTAMP 导致崩溃。
    2. object 列混合了 datetime / Timestamp 值，DuckDB 同样可能出错。
    3. pandas ExtensionArray 类型（Int64Dtype, StringDtype 等）偶发不兼容。
    """
    df = df.copy()
    for col in df.columns:
        s = df[col]
        dtype = s.dtype

        # ── 1. pandas nullable 整型 / 布尔 → 普通 numpy 类型 ──────────────
        if hasattr(dtype, "numpy_dtype"):
            try:
                df[col] = s.astype(dtype.numpy_dtype)
                s = df[col]
                dtype = s.dtype
            except Exception:
                df[col] = s.astype(object)
                continue

        # ── 2. object 列：处理含有 datetime / Timestamp 的混合类型列 ──────────
        if dtype == object:
            non_null = s.dropna()
            if len(non_null) == 0:
                continue
            has_dt = any(isinstance(v, (pd.Timestamp, datetime.datetime)) for v in non_null)
            if has_dt:
                all_dt = all(isinstance(v, (pd.Timestamp, datetime.datetime)) for v in non_null)
                if all_dt:
                    try:
                        df[col] = pd.to_datetime(s, errors="coerce")
                    except Exception:
                        df[col] = s.apply(lambda v: v.isoformat() if hasattr(v, 'isoformat') else (str(v) if pd.notna(v) else None))
                else:
                    def _to_str(v):
                        if v is None or (isinstance(v, float) and np.isnan(v)):
                            return None
                        if hasattr(v, 'strftime'):
                            return v.strftime('%Y-%m-%d')
                        return str(v)
                    df[col] = s.apply(_to_str)
            continue

        # ── 3. float64 列：若值全在 Excel 日期序号范围内，转 datetime ──────────
        if dtype == "float64":
            non_null = s.dropna()
            if len(non_null) == 0:
                continue
            looks_like_date = (
                non_null.between(1, 2958465).all()
                and (non_null == non_null.round()).all()
            )
            if looks_like_date:
                try:
                    df[col] = pd.to_datetime(
                        non_null.astype(int), unit="D", origin="1899-12-30"
                    ).reindex(s.index)
                except Exception:
                    pass
            continue

    return df


def _register(conn: duckdb.DuckDBPyConnection, table: str, df: pd.DataFrame):
    """Zero-copy register a DataFrame as a DuckDB table (no INSERT at all)."""
    df = _sanitize_df(df)
    conn.register("_tmp_reg_", df)
    conn.execute(f'CREATE OR REPLACE TABLE "{table}" AS SELECT * FROM _tmp_reg_')
    conn.unregister("_tmp_reg_")


# ── DuckDB query / introspection ─────────────────────────────────────────────

def _table_schema_str(conn: duckdb.DuckDBPyConnection, table: str, row_count: int) -> str:
    rows = conn.execute(f'DESCRIBE "{table}"').fetchall()
    col_lines = [f"  {r[0]}  {r[1]}" for r in rows]
    return f"Table: {table}  ({row_count} rows)\n" + "\n".join(col_lines)


def _preview_table_dict(conn: duckdb.DuckDBPyConnection, table: str,
                        display_name: str, max_rows: int) -> dict:
    """Fast preview fetch from a DuckDB connection — avoids pandas fillna/astype overhead."""
    try:
        rel = conn.execute(f'SELECT * FROM "{table}" LIMIT {max_rows}')
        cols = [d[0] for d in rel.description]
        rows_raw = rel.fetchall()
        total = conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
        rows = [["" if v is None else str(v) for v in row] for row in rows_raw]
        return {"name": display_name, "columns": cols, "rows": rows, "total_rows": total}
    except Exception as e:
        return {"name": display_name, "columns": [], "rows": [], "total_rows": 0, "error": str(e)}


def _query(conn: duckdb.DuckDBPyConnection, sql: str) -> Tuple[pd.DataFrame, str]:
    try:
        return conn.execute(sql).df(), ""
    except Exception as exc:
        return pd.DataFrame(), str(exc)


def _list_tables(conn: duckdb.DuckDBPyConnection) -> List[str]:
    """List every base table in a DuckDB connection — including analysis/derived
    tables created at runtime. Uses information_schema (DuckDB-native)."""
    try:
        rows = conn.execute(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_schema = 'main' AND table_type = 'BASE TABLE' "
            "ORDER BY table_name"
        ).fetchall()
        return [r[0] for r in rows]
    except Exception as exc:
        log.warning("[_list_tables] failed: %s", exc)
        return []
