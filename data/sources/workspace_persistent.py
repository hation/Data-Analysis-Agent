#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""WorkspacePersistentSource — 持久化 DuckDB 数据源（A5+）。

与 CSVDataSource / ExcelDataSource 不同，本类使用工作目录下的
``.zhixi/workspace.duckdb`` 持久化文件连接，关闭软件后表仍在。

设计要点：
  - 连接：``duckdb.connect(str(db_path))`` 持久化到磁盘
  - 表注册：工作目录内文件通过 ``_register_file`` 注册到此连接
  - 增量更新：配合 ``WorkspaceRuntime.load_registry()`` / ``save_registry()``
    检测文件 sha256 变化，未变则跳过解析（大 Excel 秒开）
  - 安全：不设 ``enable_external_access=false``（A4 已移除），依赖
    ``agent/validate.py`` 的 SQL AST 路径白名单做安全控制
"""
from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import List, Tuple

import duckdb
import pandas as pd

from ._utils import (
    _clean_identifier, _dedup_columns, _list_tables, _table_schema_str,
    _preview_table_dict, _query, _register,
)
from .excel import _excel_engine, _parse_sheets_parallel
from .base import DataSource

log = logging.getLogger(__name__)


def parse_workspace_excel_job(
    ctx,
    runtime,
    file_path: str,
    base_table_name: str,
    file_key: str,
    file_hash: str,
    old_tables=None,
) -> dict:
    """Parse/register a mounted workbook with a worker-owned DuckDB connection."""
    old_tables = list(old_tables or [])
    engine, sheet_names = _excel_engine(file_path)
    if not sheet_names:
        raise ValueError("Excel 文件中未发现工作表。")
    ctx.set_progress(2, f"正在读取 {file_key} 的工作表")
    ctx.check_canceled()

    total = len(sheet_names)

    def _sheet_done(sheet, done, _total):
        ctx.set_progress(
            5 + int(done * 78 / total),
            f"已解析工作表 {done}/{total}：{sheet}",
        )

    parsed = _parse_sheets_parallel(
        file_path,
        sheet_names,
        engine,
        check_canceled=ctx.check_canceled,
        on_complete=_sheet_done,
    )
    ctx.check_canceled()

    registered: List[str] = []
    conn = None
    with runtime.db_lock:
        try:
            conn = duckdb.connect(str(runtime.db_path))
            conn.execute("PRAGMA threads=4")
            conn.execute("BEGIN TRANSACTION")
            for table in old_tables:
                conn.execute(f'DROP TABLE IF EXISTS "{table}"')
            for index, (sheet, df) in enumerate(parsed, start=1):
                ctx.check_canceled()
                if df is not None:
                    if total == 1:
                        table_name = base_table_name
                    else:
                        table_name = _clean_identifier(sheet) or f"{base_table_name}_{index}"
                    base, suffix = table_name, 2
                    while table_name in registered:
                        table_name = f"{base}_{suffix}"
                        suffix += 1
                    _register(conn, table_name, df)
                    registered.append(table_name)
                ctx.set_progress(
                    83 + int(index * 14 / total),
                    f"正在注册工作表 {index}/{total}：{sheet}",
                )
            if not registered:
                raise ValueError("Excel 文件中未发现有效工作表。")
            conn.execute("COMMIT")
        except Exception:
            if conn is not None:
                try:
                    conn.execute("ROLLBACK")
                except Exception:
                    pass
            raise
        finally:
            if conn is not None:
                conn.close()

        registry = runtime.load_registry()
        registry[file_key] = {
            "sha256": file_hash,
            "tables": registered,
            "source_type": Path(file_path).suffix.lower().lstrip("."),
            "file_path": file_path,
        }
        runtime.save_registry(registry)

    ctx.set_progress(100, f"{file_key} 解析完成，共 {len(registered)} 个工作表")
    return {
        "workspace_id": runtime.workspace_id,
        "workdir": str(runtime.workdir),
        "source_name": file_key,
        "tables": registered,
    }


class WorkspacePersistentSource(DataSource):
    """使用持久化 DuckDB 文件的数据源。

    一个工作目录对应一个 ``workspace.duckdb`` 文件，所有表注册到此连接。
    关闭软件后 ``.duckdb`` 文件保留，下次挂载时表已就绪。
    """

    def __init__(
        self,
        db_path: str,
        display_name: str = "工作目录",
        db_lock: threading.RLock | None = None,
    ):
        self.name = display_name
        self.file_path = db_path  # 兼容 workspace.py 卸载时的 file_path 检查
        self._db_path = Path(db_path)
        self._db_lock = db_lock or threading.RLock()
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        # 持久化连接：read_write 模式
        with self._db_lock:
            self._conn = duckdb.connect(str(self._db_path))
            self._conn.execute("PRAGMA threads=4")
        log.info("[WorkspaceDS] opened persistent duckdb: %s  tables=%s",
                 self._db_path, self.list_tables())

    def _register_csv(self, file_path: str, table_name: str) -> bool:
        """注册 CSV 文件到持久化连接。返回是否成功。"""
        try:
            # 先删旧表（如果存在）
            self._conn.execute(f'DROP TABLE IF EXISTS "{table_name}"')
            self._conn.execute(
                f'CREATE OR REPLACE TABLE "{table_name}" AS '
                f"SELECT * FROM read_csv_auto('{file_path}', header=true, "
                f"null_padding=true, ignore_errors=true, "
                f"nullstr=['', 'null', 'NULL', 'Null', 'nan', 'NaN', 'N/A', 'n/a'])"
            )
            # 清理列名
            self._clean_columns(table_name)
            log.info("[WorkspaceDS] registered CSV %s → %s", file_path, table_name)
            return True
        except Exception as e:
            log.warning("[WorkspaceDS] CSV %s failed (%s), trying pandas", file_path, e)
            try:
                df = pd.read_csv(
                    file_path,
                    encoding="utf-8-sig",
                    na_values=["", "null", "NULL", "Null", "nan", "NaN", "N/A", "n/a"],
                    keep_default_na=True,
                )
                df.columns = _dedup_columns([_clean_identifier(c) for c in df.columns])
                df = df.dropna(how="all")
                self._conn.register("_tmp_ws_", df)
                self._conn.execute(
                    f'CREATE OR REPLACE TABLE "{table_name}" AS SELECT * FROM _tmp_ws_'
                )
                self._conn.unregister("_tmp_ws_")
                return True
            except Exception as e2:
                log.error("[WorkspaceDS] CSV %s pandas fallback failed: %s", file_path, e2)
                return False

    def _register_excel(self, file_path: str, base_table_name: str) -> List[str]:
        """注册 Excel 文件所有 sheet 到持久化连接。返回注册成功的表名列表。"""
        from concurrent.futures import ThreadPoolExecutor
        import python_calamine  # 优先 calamine

        registered: List[str] = []
        try:
            xl_meta = pd.ExcelFile(file_path, engine="calamine")
            sheet_names = xl_meta.sheet_names
            xl_meta.close()
        except Exception:
            try:
                xl_meta = pd.ExcelFile(file_path, engine="openpyxl")
                sheet_names = xl_meta.sheet_names
                xl_meta.close()
            except Exception as e:
                log.error("[WorkspaceDS] Excel %s cannot read sheets: %s", file_path, e)
                return []

        # 并行解析所有 sheet
        def _parse(sheet):
            try:
                df = pd.read_excel(file_path, sheet_name=sheet, engine="calamine")
                return sheet, df
            except Exception:
                try:
                    df = pd.read_excel(file_path, sheet_name=sheet, engine="openpyxl")
                    return sheet, df
                except Exception as e:
                    log.warning("[WorkspaceDS] sheet %s failed: %s", sheet, e)
                    return sheet, None

        # calamine (Rust engine) releases the GIL → real parallelism.
        # 4 → 8 capped by sheet count; registration itself stays serialized
        # behind the workspace db_lock, only parsing is parallel.
        with ThreadPoolExecutor(max_workers=min(8, len(sheet_names))) as pool:
            results = list(pool.map(_parse, sheet_names))

        for sheet, df in results:
            if df is None or df.empty:
                continue
            df.columns = _dedup_columns([_clean_identifier(c) for c in df.columns])
            df = df.dropna(how="all")
            # 表名：sheet 名（多 sheet 时用 sheet 名，单 sheet 时用文件名）
            if len(sheet_names) == 1:
                table_name = base_table_name
            else:
                table_name = _clean_identifier(sheet) or f"{base_table_name}_{sheet}"
            try:
                self._conn.register("_tmp_ws_", df)
                self._conn.execute(
                    f'CREATE OR REPLACE TABLE "{table_name}" AS SELECT * FROM _tmp_ws_'
                )
                self._conn.unregister("_tmp_ws_")
                registered.append(table_name)
            except Exception as e:
                log.error("[WorkspaceDS] register sheet %s failed: %s", sheet, e)
                try:
                    self._conn.unregister("_tmp_ws_")
                except Exception:
                    pass

        log.info("[WorkspaceDS] registered Excel %s → tables=%s", file_path, registered)
        return registered

    def _clean_columns(self, table_name: str):
        """重命名表的列为合法标识符。"""
        cols_raw = [r[0] for r in self._conn.execute(f'DESCRIBE "{table_name}"').fetchall()]
        cleaned = _dedup_columns([_clean_identifier(c) for c in cols_raw])
        for old, new in zip(cols_raw, cleaned):
            if old != new:
                self._conn.execute(
                    f'ALTER TABLE "{table_name}" RENAME COLUMN "{old}" TO "{new}"'
                )

    # ── DataSource 接口实现 ──────────────────────────────────────────────────

    def get_schema(self) -> str:
        parts: List[str] = []
        with self._db_lock:
            for table in (self.list_tables() or []):
                try:
                    rows = self._conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
                    parts.append(_table_schema_str(self._conn, table, rows))
                except Exception as e:
                    log.warning("[WorkspaceDS] schema for %s failed: %s", table, e)
        return "\n\n".join(parts) if parts else "No tables in workspace."

    def execute_query(self, sql: str) -> Tuple[pd.DataFrame, str]:
        with self._db_lock:
            return _query(self._conn, sql)

    def get_preview(self) -> List[dict]:
        result = []
        with self._db_lock:
            for table in self.list_tables():
                try:
                    rows = self._conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
                    info = _preview_table_dict(self._conn, table, table, 0)
                    info["total_rows"] = rows
                    result.append(info)
                except Exception:
                    pass
        return result

    def get_preview_table(self, table_name: str, max_rows: int = 100) -> dict:
        with self._db_lock:
            return _preview_table_dict(self._conn, table_name, table_name, max_rows)

    def create_analysis_table(self, sql: str, table_name: str = "analysis_data", _df=None) -> str:
        try:
            with self._db_lock:
                self._conn.execute(
                    f'CREATE OR REPLACE TABLE "{table_name}" AS ({sql})'
                )
                rows = self._conn.execute(f'SELECT COUNT(*) FROM "{table_name}"').fetchone()[0]
            return f"表 '{table_name}' 已创建，共 {rows} 行。"
        except Exception as e:
            return f"创建表失败：{e}"

    def list_tables(self) -> List[str]:
        with self._db_lock:
            return _list_tables(self._conn)

    def close(self):
        """关闭持久化连接。"""
        try:
            with self._db_lock:
                self._conn.close()
        except Exception:
            pass
