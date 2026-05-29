#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""GoogleSheetsDataSource — service-account auth → all worksheets in parallel."""
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
