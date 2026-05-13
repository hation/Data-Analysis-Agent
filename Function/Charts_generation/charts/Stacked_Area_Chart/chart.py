"""
堆叠面积图 Stacked Area Chart - 趋势图表
图表分类: 趋势 Trend
感知排名: ★★★★☆

统一接口:
    generate(df, mapping, options) -> ChartResult

使用示例:
    from charts.Stacked_Area_Chart.chart import generate
    from charts import ChartResult

    result = generate(
        df=df,
        mapping={"x": "月份", "y": ["销售额", "成本"]},
        options={"title": "累积趋势"}
    )
"""
import pandas as pd
import plotly.graph_objects as go
import plotly.io as pio
from typing import List

try:
    from charts.base import ChartResult
except ImportError:
    class ChartResult:
        def __init__(self, html: str = "", spec: dict = None, warnings: list = None, meta: dict = None):
            self.html = html
            self.spec = spec or {}
            self.warnings = warnings or []
            self.meta = meta or {}
        def is_valid(self):
            return bool(self.html.strip()) and len(self.html) > 500

try:
    from charts.color_schemes import get_color_scheme
except ImportError:
    def get_color_scheme(name="mckinsey"):
        return {"colors": ["#003D7A", "#0084D1", "#00A4EF", "#7FBA00", "#FFB81C",
                           "#F7630C", "#DA3B01", "#A4373A", "#6B2C91", "#00B4EF"]}


def _get_colors(scheme_name: str, count: int) -> List[str]:
    scheme = get_color_scheme(scheme_name)
    palette = scheme.get("colors", [])
    if not palette:
        palette = ["#003D7A", "#0084D1", "#00A4EF", "#7FBA00", "#FFB81C"]
    return [palette[i % len(palette)] for i in range(count)]

def _hex_to_rgba(hex_color: str, alpha: float = 0.4) -> str:
    """将 #RRGGBB 转为 rgba(r,g,b,a) 格式，兼容所有 Plotly 版本"""
    hex_color = hex_color.lstrip("#")
    r, g, b = int(hex_color[0:2], 16), int(hex_color[2:4], 16), int(hex_color[4:6], 16)
    return f"rgba({r},{g},{b},{alpha})"

def _auto_col_x(df: pd.DataFrame) -> str:
    hints = ["date","time","month","year","week","day","period","Week_Num","时间","日期","月份","年份","周","周数"]
    col_lower = {c.lower(): c for c in df.columns}
    for hint in hints:
        if hint.lower() in col_lower:
            return col_lower[hint.lower()]
    for c in df.columns:
        if df[c].dtype == object:
            return c
    for c in df.columns:
        if pd.api.types.is_numeric_dtype(df[c]):
            return c
    raise ValueError("找不到有效的 x 列")

def _auto_cols_y(df: pd.DataFrame, x_col: str) -> List[str]:
    y_cols = [c for c in df.columns if c != x_col and pd.api.types.is_numeric_dtype(df[c])]
    if not y_cols:
        for c in df.columns:
            if c != x_col:
                df[c] = pd.to_numeric(df[c].astype(str).str.replace(',', ''), errors='coerce')
                if pd.api.types.is_numeric_dtype(df[c]):
                    y_cols.append(c)
    return y_cols

def generate(df: pd.DataFrame, mapping: dict = None, options: dict = None) -> ChartResult:
    warnings = []
    meta = {}

    if df.empty:
        return ChartResult("<p>数据为空</p>")

    # 优先使用 mapping 中指定的列
    x_col = None
    y_cols = []
    if mapping:
        if mapping.get("x"):
            x_col = mapping["x"]
        if mapping.get("y"):
            y_val = mapping["y"]
            y_cols = y_val if isinstance(y_val, list) else [y_val]

    if not x_col:
        try:
            x_col = _auto_col_x(df)
        except ValueError as e:
            warnings.append(str(e))
            return ChartResult("<p>找不到有效的 x 列</p>", warnings=warnings)

    if not y_cols:
        y_cols = _auto_cols_y(df, x_col)
    if not y_cols:
        warnings.append("找不到有效的数值列")
        return ChartResult("<p>找不到有效的数值列</p>", warnings=warnings)

    # 清理数字
    for col in y_cols:
        df[col] = pd.to_numeric(df[col].astype(str).str.replace(',', ''), errors='coerce')

    # x 列转换为字符串
    if pd.api.types.is_integer_dtype(df[x_col]):
        df[x_col] = df[x_col].astype(str)

    # 根据总和排序 y 列（大到小）
    y_cols_sorted = sorted(y_cols, key=lambda c: df[c].sum(), reverse=True)

    fig = go.Figure()
    color_scheme_name = options.get("color_scheme", "mckinsey") if options else "mckinsey"
    colors = _get_colors(color_scheme_name, len(y_cols_sorted))

    for i, col in enumerate(y_cols_sorted):
        fig.add_trace(go.Scatter(
            x=df[x_col],
            y=df[col],
            mode='lines',
            name=col,
            line=dict(color=colors[i], width=0.8),
            stackgroup='one',
            fillcolor=_hex_to_rgba(colors[i], 0.4),  # 40%透明度，便于观察小数值曲线
        ))

    fig.update_layout(
        title=options.get("title", "堆叠面积图") if options else "堆叠面积图",
        font_family="Heiti SC, Microsoft YaHei, sans-serif",
        plot_bgcolor="white",
        paper_bgcolor="white",
        margin=dict(l=50, r=50, t=70, b=50),
        hovermode="x unified",
        xaxis_title=x_col,
        yaxis_title="数值",
        showlegend=True,
        legend=dict(orientation="v", yanchor="top", y=0.99, xanchor="left", x=0.01)
    )

    chart_html = pio.to_html(fig, full_html=False, include_plotlyjs="cdn")
    html = f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>{options.get('title', '堆叠面积图') if options else '堆叠面积图'}</title></head>
<body><div>{chart_html}</div></body></html>"""

    return ChartResult(html=html, warnings=warnings, meta=meta)