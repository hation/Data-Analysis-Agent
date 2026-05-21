#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Data source connectors — DuckDB in-memory backend for fast DataFrame ingestion."""
import io
import logging
import re
import datetime
import numpy as np
import requests
import duckdb
import pandas as pd
from typing import Tuple, List, Optional

log = logging.getLogger(__name__)

MAX_DISPLAY_ROWS = 200   # max rows shown to the LLM in query results


class DataSource:
    name: str = ""

    def get_schema(self) -> str:
        raise NotImplementedError

    def execute_query(self, sql: str) -> Tuple[pd.DataFrame, str]:
        """Returns (dataframe, error_string). error_string is empty on success."""
        raise NotImplementedError

    def get_preview(self) -> List[dict]:
        """Return table metadata list (name / columns / total_rows). No row data."""
        return []

    def get_preview_table(self, table_name: str, max_rows: int = 100) -> dict:
        """Return row data for a single table. Called on demand by the frontend."""
        return {"name": table_name, "columns": [], "rows": [], "total_rows": 0}

    def create_analysis_table(
        self, sql: str, table_name: str = "analysis_data", _df=None
    ) -> str:
        raise NotImplementedError

    def list_tables(self) -> List[str]:
        """Return ALL table names currently in the data source, including
        analysis/derived tables created at runtime via create_analysis_table.
        Subclasses backed by DuckDB should query information_schema."""
        raise NotImplementedError

    @staticmethod
    def format_result(df: pd.DataFrame) -> str:
        if df.empty:
            return "Query returned no results."
        total = len(df)
        preview = df.head(MAX_DISPLAY_ROWS)
        text = preview.to_string(index=False, max_cols=30)
        if total > MAX_DISPLAY_ROWS:
            text += f"\n\n... showing {MAX_DISPLAY_ROWS} of {total} rows"
        return text


# ── helpers ────────────────────────────────────────────────────────────────

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
        #    DuckDB 推断 object 列时，一旦发现有 datetime 值就会尝试把整列
        #    cast 成 TIMESTAMP，但列里同时混有 float/int 值时就崩溃。
        #    策略：
        #      a) 全部是 datetime/Timestamp → 转成 datetime64（最优）
        #      b) 混合了 datetime 和其他类型 → 把 datetime 转成 ISO 字符串，整列变 str
        #      c) 无 datetime → 保持原样（DuckDB 自行处理 object/str 列）
        if dtype == object:
            non_null = s.dropna()
            if len(non_null) == 0:
                continue
            has_dt = any(isinstance(v, (pd.Timestamp, datetime.datetime)) for v in non_null)
            if has_dt:
                all_dt = all(isinstance(v, (pd.Timestamp, datetime.datetime)) for v in non_null)
                if all_dt:
                    # 全为 datetime → 安全转换为 datetime64
                    try:
                        df[col] = pd.to_datetime(s, errors="coerce")
                    except Exception:
                        df[col] = s.apply(lambda v: v.isoformat() if hasattr(v, 'isoformat') else (str(v) if pd.notna(v) else None))
                else:
                    # 混合类型：把 datetime 格式化为日期字符串，整列转 str
                    def _to_str(v):
                        if v is None or (isinstance(v, float) and np.isnan(v)):
                            return None
                        if hasattr(v, 'strftime'):
                            return v.strftime('%Y-%m-%d')
                        return str(v)
                    df[col] = s.apply(_to_str)
            continue

        # ── 3. float64 列：若值全在 Excel 日期序号范围内（1 ~ 2958465），
        #      pandas-calamine 可能把日期读成纯浮点数而非 datetime。
        #      检测到后转换为 datetime；否则保留 float64（DuckDB 可直接处理）。
        if dtype == "float64":
            non_null = s.dropna()
            if len(non_null) == 0:
                continue
            # Excel 日期序号范围：1900-01-01 (1) ~ 9999-12-31 (2958465)
            looks_like_date = (
                non_null.between(1, 2958465).all()
                and (non_null == non_null.round()).all()  # 全为整数值
            )
            if looks_like_date:
                try:
                    df[col] = pd.to_datetime(
                        non_null.astype(int), unit="D", origin="1899-12-30"
                    ).reindex(s.index)
                except Exception:
                    pass  # 转换失败则保留原始 float64
            continue

    return df


def _register(conn: duckdb.DuckDBPyConnection, table: str, df: pd.DataFrame):
    """Zero-copy register a DataFrame as a DuckDB table (no INSERT at all)."""
    # Sanitize dtypes first to avoid DuckDB cast errors (e.g. DOUBLE -> TIMESTAMP)
    df = _sanitize_df(df)
    # register() creates a view over the Python object; CREATE TABLE materialises it
    # so that the original df can be GC'd and the table is mutable.
    conn.register("_tmp_reg_", df)
    conn.execute(f'CREATE OR REPLACE TABLE "{table}" AS SELECT * FROM _tmp_reg_')
    conn.unregister("_tmp_reg_")


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


# ── File-based sources ─────────────────────────────────────────────────────

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


class CSVDataSource(DataSource):
    """Load a single CSV file into a DuckDB in-memory DB."""

    def __init__(self, file_path: str, filename: str):
        self.name = filename
        self.file_path = file_path
        self._conn = _new_conn()
        table = _clean_identifier(filename.rsplit(".", 1)[0]) or "data"
        self._table = table

        # DuckDB can read CSV directly — fastest path for large files
        try:
            self._conn.execute(
                f"CREATE OR REPLACE TABLE \"{table}\" AS "
                f"SELECT * FROM read_csv_auto('{file_path}', header=true, "
                f"null_padding=true, ignore_errors=true)"
            )
            # Rename columns to cleaned identifiers
            cols_raw = [r[0] for r in self._conn.execute(f'DESCRIBE "{table}"').fetchall()]
            cleaned = _dedup_columns([_clean_identifier(c) for c in cols_raw])
            for old, new in zip(cols_raw, cleaned):
                if old != new:
                    self._conn.execute(
                        f'ALTER TABLE "{table}" RENAME COLUMN "{old}" TO "{new}"'
                    )
            log.info("[CSVDS] loaded %r via read_csv_auto", file_path)
        except Exception as e:
            log.warning("[CSVDS] read_csv_auto failed (%s), falling back to pandas", e)
            df = pd.read_csv(file_path, encoding="utf-8-sig")
            df.columns = _dedup_columns([_clean_identifier(c) for c in df.columns])
            df = df.dropna(how="all")
            _register(self._conn, table, df)

    def get_schema(self) -> str:
        # Include every table (raw + analysis tables created at runtime).
        parts: List[str] = []
        for table in (self.list_tables() or [self._table]):
            rows = self._conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
            parts.append(_table_schema_str(self._conn, table, rows))
        return "\n\n".join(parts)

    def list_tables(self) -> List[str]:
        return _list_tables(self._conn)

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
        return _table_schema_str(self._conn, table_name, rows)

    def get_preview(self) -> List[dict]:
        try:
            cols = [r[0] for r in self._conn.execute(f'DESCRIBE "{self._table}"').fetchall()]
            total = self._conn.execute(f'SELECT COUNT(*) FROM "{self._table}"').fetchone()[0]
            return [{"name": self._table, "columns": cols, "total_rows": total}]
        except Exception:
            return []

    def get_preview_table(self, table_name: str, max_rows: int = 100) -> dict:
        return _preview_table_dict(self._conn, table_name, table_name, max_rows)


# ── Google Sheets source ───────────────────────────────────────────────────

class GoogleSheetsDataSource(DataSource):
    """Load worksheets from a Google Spreadsheet via a service-account JSON dict."""

    _CONNECT_TIMEOUT = 20   # seconds for OAuth token + spreadsheet open
    _FETCH_TIMEOUT   = 30   # seconds per sheet fetch

    def __init__(self, creds_dict: dict, spreadsheet_url_or_id: str, display_name: str = ""):
        import gspread
        from google.oauth2.service_account import Credentials

        scopes = [
            "https://www.googleapis.com/auth/spreadsheets.readonly",
            "https://www.googleapis.com/auth/drive.readonly",
        ]
        log.info("[GSheets] building credentials …")
        creds = Credentials.from_service_account_info(creds_dict, scopes=scopes)

        log.info("[GSheets] authorizing …")
        gc = gspread.authorize(creds)
        gc.set_timeout(self._CONNECT_TIMEOUT)

        log.info("[GSheets] opening spreadsheet …")
        if spreadsheet_url_or_id.startswith("http"):
            spreadsheet = gc.open_by_url(spreadsheet_url_or_id)
        else:
            spreadsheet = gc.open_by_key(spreadsheet_url_or_id)

        self.name = display_name or spreadsheet.title
        log.info("[GSheets] opened %r", self.name)
        self._conn = _new_conn()
        self._tables: List[str] = []
        self._load(spreadsheet)

    @staticmethod
    def _fetch_sheet(ws) -> Optional[pd.DataFrame]:
        """Fetch one worksheet as a DataFrame. Returns None if empty or failed."""
        try:
            rows = ws.get_all_values()
        except Exception as exc:
            log.warning("[GSheets] sheet %r fetch failed: %s", ws.title, exc)
            return None
        if len(rows) < 2:
            return None
        header_idx = _detect_header_row(rows)
        header = rows[header_idx]
        data = rows[header_idx + 1:]
        if not data:
            return None
        log.info("[GSheets] sheet %r: header at row %d", ws.title, header_idx)
        df = pd.DataFrame(data, columns=header)
        df.columns = _dedup_columns([_clean_identifier(c) for c in df.columns])
        df.replace("", pd.NA, inplace=True)
        df = df.dropna(how="all")
        if df.empty or len(df.columns) == 0:
            return None
        log.info("[GSheets] sheet %r → %d rows", ws.title, len(df))
        return df

    def _load(self, spreadsheet):
        from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout

        worksheets = spreadsheet.worksheets()
        log.info("[GSheets] fetching %d sheet(s) concurrently …", len(worksheets))

        with ThreadPoolExecutor(max_workers=min(8, len(worksheets))) as pool:
            futures = {pool.submit(self._fetch_sheet, ws): ws for ws in worksheets}

        sheet_dfs = {}
        for future, ws in futures.items():
            try:
                df = future.result(timeout=self._FETCH_TIMEOUT)
            except FutureTimeout:
                log.warning("[GSheets] sheet %r timed out, skipping", ws.title)
                df = None
            except Exception as exc:
                log.warning("[GSheets] sheet %r error: %s", ws.title, exc)
                df = None
            if df is not None:
                sheet_dfs[ws.title] = df

        for ws in worksheets:
            if ws.title not in sheet_dfs:
                continue
            df = sheet_dfs[ws.title]
            table = _clean_identifier(ws.title) or f"sheet{len(self._tables) + 1}"
            _register(self._conn, table, df)
            self._tables.append(table)

        if not self._tables:
            raise ValueError("Google Spreadsheet 中未发现有效工作表。")

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
        if table_name not in self._tables:
            self._tables.append(table_name)
        return _table_schema_str(self._conn, table_name, rows)

    def list_tables(self) -> List[str]:
        return _list_tables(self._conn)

    def get_preview(self) -> List[dict]:
        tables = self._conn.execute(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_schema='main' ORDER BY table_name"
        ).fetchall()
        result = []
        for (t,) in tables:
            try:
                cols = [r[0] for r in self._conn.execute(f'DESCRIBE "{t}"').fetchall()]
                total = self._conn.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
                result.append({"name": t, "columns": cols, "total_rows": total})
            except Exception:
                continue
        return result

    def get_preview_table(self, table_name: str, max_rows: int = 100) -> dict:
        return _preview_table_dict(self._conn, table_name, table_name, max_rows)


# ── HTTP REST API source ───────────────────────────────────────────────────

def _flatten_json(data) -> pd.DataFrame:
    """Best-effort conversion of a JSON API response to a DataFrame."""
    if isinstance(data, list):
        return pd.json_normalize(data)
    if isinstance(data, dict):
        for v in data.values():
            if isinstance(v, list) and v:
                return pd.json_normalize(v)
        return pd.json_normalize([data])
    raise ValueError(f"Cannot convert JSON type {type(data).__name__} to DataFrame.")


class HTTPAPIDataSource(DataSource):
    """Fetch data from an HTTP REST endpoint and load into DuckDB in-memory."""

    def __init__(self, url: str, auth_type: str = "none", auth_value: str = "",
                 display_name: str = ""):
        self._url = url
        self._auth_type = auth_type
        self._auth_value = auth_value
        self.name = display_name or url
        self._conn = _new_conn()
        self._table = "api_data"
        self._load()

    def _build_headers(self) -> dict:
        headers: dict = {"Accept": "application/json, text/csv"}
        if self._auth_type == "bearer":
            headers["Authorization"] = f"Bearer {self._auth_value}"
        elif self._auth_type == "api_key":
            headers["X-API-Key"] = self._auth_value
        return headers

    def _load(self):
        resp = requests.get(self._url, headers=self._build_headers(), timeout=30)
        resp.raise_for_status()
        content_type = resp.headers.get("Content-Type", "")
        text = resp.text.strip()
        if "csv" in content_type or (not text.startswith(("{", "["))):
            try:
                df = pd.read_csv(io.StringIO(resp.text))
            except Exception:
                df = _flatten_json(resp.json())
        else:
            df = _flatten_json(resp.json())
        if df.empty:
            raise ValueError("API 响应解析后为空，无法加载数据。")
        df.columns = _dedup_columns([_clean_identifier(c) for c in df.columns])
        df = df.dropna(how="all")
        _register(self._conn, self._table, df)

    def get_schema(self) -> str:
        # Include every table (raw + analysis tables created at runtime).
        parts: List[str] = []
        for table in (self.list_tables() or [self._table]):
            rows = self._conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
            parts.append(_table_schema_str(self._conn, table, rows))
        return "\n\n".join(parts)

    def list_tables(self) -> List[str]:
        return _list_tables(self._conn)

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
        return _table_schema_str(self._conn, table_name, rows)

    def get_preview(self) -> List[dict]:
        try:
            cols = [r[0] for r in self._conn.execute(f'DESCRIBE "{self._table}"').fetchall()]
            total = self._conn.execute(f'SELECT COUNT(*) FROM "{self._table}"').fetchone()[0]
            return [{"name": self._table, "columns": cols, "total_rows": total}]
        except Exception:
            return []

    def get_preview_table(self, table_name: str, max_rows: int = 100) -> dict:
        return _preview_table_dict(self._conn, table_name, table_name, max_rows)


# ── SQL database source ────────────────────────────────────────────────────

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
