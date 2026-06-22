# -*- coding: utf-8 -*-
"""Mixin: data-oriented tools (schema, query, analysis, chart, clean, profile)."""
import logging
import re
import sqlite3
from typing import Any

log = logging.getLogger(__name__)

_TIME_SERIES_PREFIX = "Time_Series_"
_ANALYSIS_JOB_ROW_THRESHOLD = 1000


def _execute_analysis(
    analysis_name: str,
    df,
    target_column: str,
    groupby_column: str,
    n_deciles: int,
    progress_callback=None,
):
    """Run one analysis without holding an Agent or data-source reference."""
    from Function.Analyze.registry import get as get_analysis

    entry = get_analysis(analysis_name)
    run_fn = entry.get("run")
    if run_fn is None:
        raise RuntimeError(f"Analysis module '{analysis_name}' failed to load.")
    kwargs = {
        "df": df,
        "target_column": target_column,
        "groupby_column": groupby_column or None,
        "n_deciles": n_deciles,
    }
    if progress_callback is not None and analysis_name.startswith(_TIME_SERIES_PREFIX):
        kwargs["progress_callback"] = progress_callback
    return entry, run_fn(**kwargs)


class DataToolsMixin:
    """All methods here rely on self.data_source, self._schema_cache,
    self.ppt_color_scheme — defined in BusinessAgent.__init__."""

    # ── Knowledge base lookup ─────────────────────────────────────────────────

    def _tool_query_knowledge_results(self, question: str) -> dict:
        try:
            from Function.Knowledge.knowledge_base import KnowledgeBase
            kb = KnowledgeBase()
            return kb.search(question)
        except Exception as e:
            return {"error": f"Knowledge base unavailable: {e}"}

    def _format_knowledge_results(self, results: dict) -> str:
        if results.get("error"):
            return results["error"]

        if not any(results.values()):
            return "No relevant knowledge found."

        lines: list[str] = []

        for m in results.get("metrics", []):
            lines.append(f"[Metric] {m['name']}")
            if m.get("alias"):
                lines.append(f"  Alias: {m['alias']}")
            if m.get("definition"):
                lines.append(f"  Definition: {m['definition']}")
            if m.get("sql_template"):
                lines.append(f"  SQL template: {m['sql_template']}")
            if m.get("notes"):
                lines.append(f"  Notes: {m['notes']}")

        for r in results.get("rules", []):
            lines.append(f"[Rule/{r['severity'].upper()}] {r['rule_id']}: {r['description']}")
            if r.get("condition"):
                lines.append(f"  Condition: {r['condition']}")

        for n in results.get("notes", []):
            lines.append(f"[Context] {n['topic']}: {n['content']}")

        for d in results.get("documents", []):
            source = d.get("source_name", "unknown")
            idx = d.get("chunk_index", 0)
            score = d.get("score", d.get("vector_score", ""))
            score_part = f" | score={score}" if score != "" else ""
            content = (d.get("content") or "").strip()
            lines.append(f"[Document] {source}#chunk-{idx}{score_part}")
            lines.append(content[:1800])

        return "\n".join(lines)

    def _knowledge_refs_from_results(self, results: dict, limit: int = 8) -> list[dict]:
        """Compact, UI-safe citation metadata for the knowledge tool step."""
        if results.get("error"):
            return []

        refs: list[dict] = []
        for m in results.get("metrics", []):
            refs.append({
                "type": "指标",
                "title": m.get("name", ""),
                "source": m.get("alias", "") or "指标定义",
                "snippet": m.get("definition", "") or m.get("notes", ""),
                "score": m.get("vector_score", ""),
            })

        for r in results.get("rules", []):
            refs.append({
                "type": "规则",
                "title": r.get("rule_id", ""),
                "source": (r.get("severity") or "warning").upper(),
                "snippet": r.get("description", "") or r.get("condition", ""),
                "score": "",
            })

        for n in results.get("notes", []):
            refs.append({
                "type": "背景",
                "title": n.get("topic", ""),
                "source": n.get("tags", "") or "背景知识",
                "snippet": n.get("content", ""),
                "score": n.get("vector_score", ""),
            })

        for d in results.get("documents", []):
            refs.append({
                "type": "文档",
                "title": f"{d.get('source_name', 'unknown')} #chunk-{d.get('chunk_index', 0)}",
                "source": d.get("source_name", ""),
                "snippet": d.get("content", ""),
                "score": d.get("score", d.get("vector_score", "")),
            })

        clean_refs: list[dict] = []
        for ref in refs[:limit]:
            clean_refs.append({
                "type": str(ref.get("type") or ""),
                "title": str(ref.get("title") or "")[:120],
                "source": str(ref.get("source") or "")[:160],
                "snippet": re.sub(r"\s+", " ", str(ref.get("snippet") or "")).strip()[:260],
                "score": ref.get("score", ""),
            })
        return clean_refs

    def _tool_query_knowledge_with_refs(self, question: str) -> tuple[str, list[dict]]:
        results = self._tool_query_knowledge_results(question)
        return self._format_knowledge_results(results), self._knowledge_refs_from_results(results)

    def _tool_query_knowledge(self, question: str) -> str:
        results = self._tool_query_knowledge_results(question)
        return self._format_knowledge_results(results)

    # ── Basic data access ─────────────────────────────────────────────────────

    def _tool_get_schema(self) -> str:
        if not self.data_source and not getattr(self, "_combined_schema", None):
            return "No data source connected."
        if not self._schema_cache:
            combined = getattr(self, "_combined_schema", None)
            self._schema_cache = combined if combined else self.data_source.get_schema()
        return self._schema_cache

    def _tool_get_table_detail(self, table_name: str) -> str:
        """Return full column list + row count for a single table (SQL databases)."""
        # Try each active source until one knows the table
        for src in getattr(self, "_all_sources", [self.data_source]):
            if src is None:
                continue
            fn = getattr(src, "get_table_detail", None)
            if fn is None:
                continue
            try:
                tables = src.list_tables()
            except Exception:
                tables = []
            if table_name in tables:
                return fn(table_name)
        # Fallback: try primary source regardless
        if self.data_source:
            fn = getattr(self.data_source, "get_table_detail", None)
            if fn:
                return fn(table_name)
        return f"Table '{table_name}' not found in any connected data source."

    @staticmethod
    def _strip_src_prefix(sql: str, src_index: int) -> str:
        """Remove ``src{N}__`` prefixes injected by get_combined_schema.

        Called just before executing SQL against a specific DataSource so the
        engine sees only bare table names it actually owns.
        """
        import re as _re
        prefix = f"src{src_index}__"
        # Replace quoted  "src1__tablename"  and bare  src1__tablename
        sql = _re.sub(
            rf'"?{_re.escape(prefix)}([^"\s,)]+)"?',
            lambda m: f'"{m.group(1)}"',
            sql,
        )
        return sql

    def _route_query(self, sql: str):
        """Return (DataSource, rewritten_sql) for the source that owns the tables
        referenced in *sql*.

        Routing priority
        ----------------
        1. **Cross-source SQL** (SQL contains ``src{N}__`` prefixes from two or
           more distinct source indices) → execute on ``_merged_source`` as-is.
           The merged connection already has all tables registered with prefixes.
        2. **Single-source prefixed SQL** (all ``src{N}__`` prefixes point to the
           same index N) → strip prefix, execute on ``sources[N-1]`` directly.
        3. **Bare table names** (no prefix) → heuristic match against each
           source's table list; first match wins.  Falls back to primary source.

        Returns a (DataSource, sql) tuple.  Callers must use the returned *sql*.
        """
        import re as _re
        sources = getattr(self, "_all_sources", None)
        if not sources or len(sources) == 1:
            return self.data_source, sql

        # ── Detect src{N}__ prefixes in SQL ─────────────────────────────────
        prefix_pat = _re.compile(r'src(\d+)__', _re.IGNORECASE)
        prefix_hits = prefix_pat.findall(sql)

        if prefix_hits:
            unique_indices = set(int(h) for h in prefix_hits)

            # ── Mode 1: cross-source — two or more different src indices ────
            if len(unique_indices) > 1:
                merged = getattr(self, "_merged_source", None)
                if merged is not None:
                    log.debug("[route] cross-source SQL → MergedDataSource")
                    return merged, sql
                # Merged source unavailable — fall through to heuristic as best-effort
                log.warning("[route] cross-source SQL but _merged_source is None, "
                            "falling back to primary source")
                return self.data_source, sql

            # ── Mode 2: single-source prefix — strip and route directly ─────
            idx = next(iter(unique_indices))   # 1-based
            if 1 <= idx <= len(sources):
                src = sources[idx - 1]
                rewritten = self._strip_src_prefix(sql, idx)
                log.debug("[route] src%d prefix → source=%s", idx, getattr(src, "name", "?"))
                return src, rewritten
            # Index out of range — fall through

        # ── Mode 3: bare table name heuristic ───────────────────────────────
        sql_upper = sql.upper()
        for src in sources:
            try:
                tables = [t.upper() for t in src.list_tables()]
            except Exception:
                tables = []
            if any(t in sql_upper for t in tables):
                log.debug("[route] bare-name heuristic → source=%s", getattr(src, "name", "?"))
                return src, sql

        # Fallback: primary source, unchanged SQL
        return self.data_source, sql

    def _tool_query_data(self, sql: str) -> str:
        result, _refs = self._tool_query_data_with_refs(sql)
        return result

    def _data_refs_for_sql(self, sql: str, src, row_count: int | None = None) -> list[dict]:
        source_name = getattr(src, "name", "未知数据源") if src else "未知数据源"
        tables = []
        for pattern in (
            r'(?i)\bfrom\s+"([^"]+)"',
            r'(?i)\bjoin\s+"([^"]+)"',
            r'(?i)\bfrom\s+([A-Za-z_][\w$]*)',
            r'(?i)\bjoin\s+([A-Za-z_][\w$]*)',
        ):
            tables.extend(re.findall(pattern, sql or ""))
        # Keep order, remove duplicates and internal aliases.
        seen = set()
        clean_tables = []
        for t in tables:
            if t.lower() in {"select", "where", "group", "order"}:
                continue
            if t not in seen:
                seen.add(t)
                clean_tables.append(t)
        return [{
            "type": "数据查询",
            "title": ", ".join(clean_tables[:6]) or "SQL 查询",
            "source": source_name,
            "snippet": " ".join((sql or "").split())[:320],
            "rows": row_count,
        }]

    def _tool_query_data_with_refs(self, sql: str) -> tuple[str, list[dict]]:
        sql_preview = sql.replace("\n", " ")[:120]
        src, rewritten_sql = self._route_query(sql)
        if not src:
            log.warning("[tools] query_data  no data source  sql=%.80r", sql_preview)
            return "No data source. Please connect a database or upload an Excel file first.", []
        df, error = src.execute_query(rewritten_sql)
        if error:
            log.warning("[tools] query_data  ERROR  source=%s  sql=%.80r  error=%s",
                        getattr(src, "name", "?"), sql_preview, error[:200])
            # If primary source failed and we have alternatives, try them
            # (only for bare-name queries — prefixed queries target a specific source)
            import re as _re
            if not _re.search(r'src\d+__', sql, _re.IGNORECASE):
                sources = getattr(self, "_all_sources", None) or []
                for alt in sources:
                    if alt is src:
                        continue
                    df2, err2 = alt.execute_query(rewritten_sql)
                    if not err2:
                        log.info("[tools] query_data  fallback OK  source=%s  rows=%d",
                                 getattr(alt, "name", "?"), len(df2))
                        return alt.format_result(df2), self._data_refs_for_sql(sql, alt, len(df2))
            return f"SQL Error: {error}", self._data_refs_for_sql(sql, src, None)
        log.info("[tools] query_data  OK  source=%s  rows=%d  sql=%.80r",
                 getattr(src, "name", "?"), len(df), sql_preview)
        return src.format_result(df), self._data_refs_for_sql(sql, src, len(df))

    def _tool_create_analysis_table(self, sql: str, table_name: str = "analysis_data") -> str:
        result, _refs = self._tool_create_analysis_table_with_refs(sql, table_name)
        return result

    def _tool_create_analysis_table_with_refs(
        self, sql: str, table_name: str = "analysis_data"
    ) -> tuple[str, list[dict]]:
        src, rewritten_sql = self._route_query(sql)
        if not src:
            return "No data source connected.", []
        result = src.create_analysis_table(rewritten_sql, table_name)
        self._schema_cache = None
        log.info("[tools] create_analysis_table  table=%s  source=%s",
                 table_name, getattr(src, "name", "?"))
        refs = self._data_refs_for_sql(sql, src, None)
        refs[0]["type"] = "分析表"
        refs[0]["title"] = table_name
        return result, refs

    # ── DataFrame → DataSource writer (backward-compatible) ──────────────────

    def _write_analysis_df(self, df, table_name: str) -> None:
        """Write df into the connected data source as a queryable table.

        Tries the new connector API first; falls back to direct SQLite write
        for older connector.py versions that lack the _df parameter.
        """
        ds = self.data_source

        try:
            ds.create_analysis_table(sql=None, table_name=table_name, _df=df)
            self._schema_cache = None
            return
        except TypeError:
            pass  # old connector — fall through to direct SQLite write

        conn = getattr(ds, "_conn", None)
        if conn is None:
            if getattr(ds, "_cache_conn", None) is None:
                ds._cache_conn = sqlite3.connect(":memory:", check_same_thread=False)
                ds._cache_tables = set()
            conn = ds._cache_conn
            ds._cache_tables.add(table_name)

        df.to_sql(table_name, conn, if_exists="replace", index=False)
        self._schema_cache = None

    # ── Analysis tool ─────────────────────────────────────────────────────────

    def _tool_run_analysis(
        self,
        analysis_name: str,
        sql: str,
        target_column: str,
        groupby_column: str = "",
        n_deciles: int = 10,
    ) -> str:
        if not self.data_source:
            return "No data source connected."

        df, error = self.data_source.execute_query(sql)
        if error:
            return f"SQL Error while fetching data: {error}"
        if df.empty:
            return "Query returned no rows — cannot run analysis."

        try:
            entry, ret = _execute_analysis(
                analysis_name,
                df,
                target_column,
                groupby_column,
                n_deciles,
            )
        except KeyError as exc:
            return str(exc)
        except Exception as exc:
            return f"Analysis error: {exc}"

        return self._finalize_analysis_result(
            entry, ret, analysis_name, sql, target_column, n_deciles
        )

    def _tool_run_analysis_with_jobs(
        self,
        analysis_name: str,
        sql: str,
        target_column: str,
        groupby_column: str = "",
        n_deciles: int = 10,
    ):
        """Run large time-series analyses as cancellable JobRunner work."""
        if not self.data_source:
            return "No data source connected."

        df, error = self.data_source.execute_query(sql)
        if error:
            return f"SQL Error while fetching data: {error}"
        if df.empty:
            return "Query returned no rows — cannot run analysis."

        should_job = (
            analysis_name.startswith(_TIME_SERIES_PREFIX)
            and len(df) >= _ANALYSIS_JOB_ROW_THRESHOLD
            and self._job_runner is not None
        )
        if not should_job:
            try:
                entry, ret = _execute_analysis(
                    analysis_name, df, target_column, groupby_column, n_deciles
                )
            except KeyError as exc:
                return str(exc)
            except Exception as exc:
                return f"Analysis error: {exc}"
            return self._finalize_analysis_result(
                entry, ret, analysis_name, sql, target_column, n_deciles
            )

        result_holder = {}

        def _worker(ctx):
            def _progress(pct: int, message: str = ""):
                ctx.check_canceled()
                ctx.set_progress(pct, message)

            _progress(2, "正在准备时序分析")
            entry, ret = _execute_analysis(
                analysis_name,
                df,
                target_column,
                groupby_column,
                n_deciles,
                progress_callback=_progress,
            )
            ctx.check_canceled()
            result_holder["entry"] = entry
            result_holder["ret"] = ret
            return {
                "analysis_name": analysis_name,
                "input_rows": len(df),
                "output_tables": list(entry.get("output_tables", [])),
            }

        job = yield from self._run_as_job(
            _worker,
            job_type="time_series_analysis",
            label=f"{analysis_name} · {len(df)} rows",
        )
        if job.get("status") == "canceled":
            return "Analysis canceled."
        if job.get("status") != "succeeded":
            return f"Analysis error: {job.get('error') or 'background job failed'}"
        if "ret" not in result_holder:
            return "Analysis error: background result was not available."

        return self._finalize_analysis_result(
            result_holder["entry"],
            result_holder["ret"],
            analysis_name,
            sql,
            target_column,
            n_deciles,
        )

    def _finalize_analysis_result(
        self,
        entry,
        ret,
        analysis_name: str,
        sql: str,
        target_column: str,
        n_deciles: int,
    ) -> str:
        """Persist computed tables on the request thread and format the result."""

        if len(ret) == 4:
            result_df, breakdown_df, extra_df, markdown = ret
        else:
            result_df, breakdown_df, markdown = ret
            extra_df = None

        try:
            _out_tbls = entry.get("output_tables", [])
            self._write_analysis_df(result_df, "analysis_result")
            if not breakdown_df.empty:
                self._write_analysis_df(breakdown_df, "analysis_breakdown")
            # Always write the third table so LLM SQL queries don't fail on missing table.
            # Write an empty-but-structured DataFrame when the result is empty.
            if extra_df is not None:
                extra_table_name = _out_tbls[2] if len(_out_tbls) > 2 else "analysis_extra"
                self._write_analysis_df(extra_df, extra_table_name)
        except Exception as exc:
            return (
                markdown
                + f"\n\n⚠️ **结果表写入失败**：{exc}\n"
                "分析计算已完成，但结果无法存为可查询表格，请联系开发者。"
            )

        if analysis_name == "K_Means" and "cluster" in breakdown_df.columns:
            markdown += self._kmeans_build_labeled(sql, breakdown_df)

        if analysis_name == "Data_Decile_Analysis" and "decile" in result_df.columns:
            markdown += self._decile_build_labeled(sql, target_column, n_deciles)

        return markdown

    def _kmeans_build_labeled(self, sql: str, breakdown_df) -> str:
        try:
            labeled_sql = re.sub(
                r"(?is)\bSELECT\b.+?\bFROM\b",
                "SELECT *\nFROM",
                sql,
                count=1,
            )
            full_df, err = self.data_source.execute_query(labeled_sql)
            if err or full_df.empty:
                return ""
            if len(full_df) != len(breakdown_df):
                return ""

            labeled_df = full_df.copy().reset_index(drop=True)
            labeled_df["cluster"] = breakdown_df["cluster"].values
            self._write_analysis_df(labeled_df, "cluster_labels")
            self._schema_cache = None

            cols_preview = ", ".join(str(c) for c in labeled_df.columns[:8])
            if len(labeled_df.columns) > 8:
                cols_preview += ", ..."
            return (
                "\n\n---\n"
                "### 📌 数据标签表 `cluster_labels`\n"
                f"已将聚类结果（cluster 列）回写到原始数据，"
                f"生成包含所有原始字段的标签表：\n\n"
                f"**列：** `{cols_preview}`\n\n"
                "可直接用于后续分析，例如：\n"
                "```sql\n"
                "-- 查看各簇的详细记录\n"
                "SELECT * FROM cluster_labels WHERE cluster = 0 LIMIT 20\n\n"
                "-- 统计各簇某字段的均值\n"
                "SELECT cluster, AVG(target_col) AS avg_val FROM cluster_labels GROUP BY cluster\n"
                "```"
            )
        except Exception:
            return ""

    def _decile_build_labeled(self, sql: str, target_column: str, n_deciles: int) -> str:
        """回写十分位标签到原始数据，生成 decile_labels 表。"""
        try:
            labeled_sql = re.sub(
                r"(?is)\bSELECT\b.+?\bFROM\b",
                "SELECT *\nFROM",
                sql,
                count=1,
            )
            full_df, err = self.data_source.execute_query(labeled_sql)
            if err or full_df.empty:
                return ""

            import pandas as pd
            col = full_df[target_column]
            # 用与 analyze.py 完全一致的逻辑重新打标签
            raw_cut = pd.qcut(
                pd.to_numeric(col, errors="coerce"),
                q=n_deciles,
                duplicates="drop",
            )
            ordered_cats = raw_cut.cat.categories
            cat_to_int = {cat: i + 1 for i, cat in enumerate(ordered_cats)}
            decile_int = raw_cut.map(cat_to_int)
            actual_n = int(decile_int.nunique())

            labeled_df = full_df.copy().reset_index(drop=True)
            labeled_df["decile"] = decile_int.values
            # 生成可读标签，如 "D01 (低)" / "D10 (高)"
            width = len(str(actual_n))
            def _label(d):
                if pd.isna(d):
                    return None
                d = int(d)
                if d == 1:
                    suffix = "（最低）"
                elif d == actual_n:
                    suffix = "（最高）"
                else:
                    suffix = ""
                return f"D{str(d).zfill(width)}{suffix}"
            labeled_df["decile_label"] = labeled_df["decile"].map(_label)

            self._write_analysis_df(labeled_df, "decile_labels")
            self._schema_cache = None

            cols_preview = ", ".join(str(c) for c in labeled_df.columns[:8])
            if len(labeled_df.columns) > 8:
                cols_preview += ", ..."
            return (
                "\n\n---\n"
                "### 📌 数据标签表 `decile_labels`\n"
                f"已将十分位标签（`decile` + `decile_label`）回写到原始数据，"
                f"共 {len(labeled_df)} 行：\n\n"
                f"**列：** `{cols_preview}`\n\n"
                "可直接导出或用于进一步分析，例如：\n"
                "```sql\n"
                "-- 查看某分位的原始记录\n"
                f"SELECT * FROM decile_labels WHERE decile = 10 LIMIT 20\n\n"
                "-- 各分位均值汇总\n"
                f"SELECT decile, decile_label, AVG({target_column}) AS avg_val\n"
                "FROM decile_labels GROUP BY decile, decile_label ORDER BY decile\n"
                "```"
            )
        except Exception:
            return ""

    # ── Chart selector ────────────────────────────────────────────────────────

    def _tool_select_chart(self, user_intent: str, available_columns: list = None) -> str:
        """Query the embedded chart registry and return ranked candidates with exact field_mapping specs."""
        try:
            from LLM.chart_selector import select_charts, format_selection_result
            cols = list(available_columns or [])
            # Auto-enrich with schema column names when the caller didn't supply them
            if not cols and self.data_source:
                schema = self._tool_get_schema()
                cols = re.findall(r"^\s{2,4}(\w+)\b", schema, re.MULTILINE)
            candidates = select_charts(user_intent, cols, top_n=3)
            return format_selection_result(candidates)
        except Exception as exc:
            return f"Chart selection error: {exc}"

    # ── Chart tool ────────────────────────────────────────────────────────────

    def _tool_generate_chart(
        self, chart_type: str, sql: str, field_mapping: dict, title: str = ""
    ) -> dict:
        if not self.data_source:
            return {"error": "No data source connected."}
        df, error = self.data_source.execute_query(sql)
        if error:
            return {"error": f"Data query failed: {error}"}
        if df.empty:
            return {"error": "Query returned no rows — cannot generate chart."}

        from chart_generate import generate_chart as _gen

        options = {"title": title} if title else {}
        result = _gen(
            df=df,
            chart_type=chart_type,
            mapping=field_mapping,
            options=options,
            color_scheme=self.ppt_color_scheme,
        )
        if "error" in result:
            return {"error": result["error"]}
        return {"html": result.get("html", ""), "chart_type": chart_type}

    # ── Table discovery helpers ───────────────────────────────────────────────

    def _discover_all_tables(self) -> list:
        if not self.data_source:
            return []
        # Preferred: connector.list_tables() — returns ALL tables incl. runtime
        # analysis/derived tables (DuckDB information_schema based).
        list_fn = getattr(self.data_source, "list_tables", None)
        if callable(list_fn):
            try:
                tables = list_fn()
                if tables:
                    return list(tables)
            except Exception:
                pass
        # Fallback: parse the schema text (works for any connector).
        schema = self._tool_get_schema()
        return re.findall(r"^Table:\s+(\S+)", schema, re.MULTILINE)

    def _get_first_raw_table(self) -> str:
        tables = self._discover_all_tables()
        raw = [t for t in tables if not t.startswith("analysis_") and t != "cleaned_data"]
        return raw[0] if raw else (tables[0] if tables else "")

    # ── Profile & clean ───────────────────────────────────────────────────────

    def _tool_profile_data(self, table_name: str = "", columns: list = None) -> dict:
        if not self.data_source:
            return {"text": "❌ 请先连接数据源。", "charts": []}

        tname = table_name or self._get_first_raw_table()
        if not tname:
            return {"text": "❌ 数据源中没有可用的表格。", "charts": []}

        df, err = self.data_source.execute_query(f'SELECT * FROM "{tname}"')
        if err or df is None or df.empty:
            return {"text": f"❌ 读取表 '{tname}' 失败：{err}", "charts": []}

        try:
            from Function.Clean.data_profile import profile
            text, charts = profile(df, columns or None)
            return {"text": f"### 数据概况 · `{tname}`\n\n" + text, "charts": charts}
        except Exception as exc:
            return {"text": f"❌ 数据概况生成失败：{exc}", "charts": []}

    def _tool_clean_data(
        self,
        operation: str,
        table_name: str = "",
        columns=None,
        fill_method: str = "mean",
        lower_pct: float = 1.0,
        upper_pct: float = 99.0,
        trim_column: str = "",
        min_val=None,
        max_val=None,
        output_table: str = "cleaned_data",
    ) -> str:
        if not self.data_source:
            return "❌ 请先连接数据源。"

        tname = table_name or self._get_first_raw_table()
        if not tname:
            return "❌ 数据源中没有可用的表格。"

        df, err = self.data_source.execute_query(f'SELECT * FROM "{tname}"')
        if err or df is None or df.empty:
            return f"❌ 读取表 '{tname}' 失败：{err}"

        try:
            if operation == "fill_na":
                from Function.Clean.missing_handler import fill_missing
                cleaned_df, summary = fill_missing(df, fill_method, columns)
            elif operation == "winsorize":
                from Function.Clean.winsorize import winsorize
                cleaned_df, summary = winsorize(df, lower_pct, upper_pct, columns)
            elif operation == "trimming":
                if not trim_column:
                    return "❌ trimming 操作需要指定 trim_column。"
                if min_val is None or max_val is None:
                    return "❌ trimming 操作需要同时指定 min_val 和 max_val。"
                from Function.Clean.trimming import trim
                cleaned_df, summary = trim(df, trim_column, float(min_val), float(max_val))
            else:
                return f"❌ 未知操作 '{operation}'，支持：fill_na / winsorize / trimming"
        except Exception as exc:
            return f"❌ 清洗失败：{exc}"

        try:
            self._write_analysis_df(cleaned_df, output_table)
            self._schema_cache = None
        except Exception as exc:
            return summary + f"\n\n⚠️ 结果表写入失败：{exc}"

        return (
            summary
            + f"\n\n✅ 清洗结果已保存为表 `{output_table}`，可直接用于后续分析和图表生成。"
        )
