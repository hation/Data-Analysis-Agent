# 批次 58 知识图谱 - 图表生成与数据清洁模块

## 模块架构

### 核心模块

**图表生成框架**
- `base.py`: 统一接口协议，定义 `ChartResult` 和 `FieldMapping` 数据类
- `color_schemes.py`: 配色方案管理，支持企业级配色
- `__init__.py`: 框架入口文件，导出公共接口

**图表类型**
- `Sunburst_Diagram/`: 旭日图 - 多层级占比展示
- `Treemap/`: 矩形树图 - 嵌套矩形占比展示
- `Violin_Chart/`: 小提琴图 - 分布形状展示
- `Waffle/`: 华夫格图 - 比例方格图
- `Waterfall/`: 瀑布图 - 累积变化过程展示

**数据清洁模块**
- `Clean/data_profile.py`: 数据概况分析
- `Clean/missing_handler.py`: 缺失值处理
- `Clean/__init__.py`: 清洁模块入口

## 核心类与函数

### 基础接口

```python
@dataclass
class ChartResult:
    html: str = ""
    spec: Dict[str, Any] = field(default_factory=dict)
    warnings: List[str] = field(default_factory=list)
    meta: Dict[str, Any] = field(default_factory=dict)
    
    def is_valid(self) -> bool:
        return bool(self.html.strip()) and len(self.html) > 500

@dataclass
class FieldMapping:
    label: Optional[str] = None
    value: Optional[str] = None
    x: Optional[str] = None
    y: Optional[str] = None
    series: Optional[str] = None
    # ... 其他字段
    
    def to_dict(self) -> Dict[str, str]:
        return {k: v for k, v in self.__dict__.items() if v is not None}
    
    @classmethod
    def from_dict(cls, d: Dict[str, str]) -> "FieldMapping":
        # 从字典创建 FieldMapping 实例
        pass
```

### 配色方案

```python
COLOR_SCHEMES = {
    "mckinsey": {"name": "McKinsey Blue", "colors": [...], "primary": "#003B71"},
    "bcg": {"name": "BCG Green", "colors": [...], "primary": "#006C5B"},
    "bain": {"name": "Bain Red", "colors": [...], "primary": "#E41E26"},
    "ey": {"name": "EY Yellow", "colors": [...], "primary": "#FFD100"},
}

def get_color_scheme(scheme_name):
    # 获取指定配色方案
    pass

def list_color_schemes():
    # 获取所有可用配色方案
    pass

def get_colors_list(scheme_name, count=None):
    # 获取颜色列表（支持循环使用）
    pass
```

### 数据清洁

```python
def profile(df: pd.DataFrame, columns: Optional[List[str]] = None):
    # 数据概况分析：统计信息、缺失值检测、数据质量评估
    pass

def fill_missing(df: pd.DataFrame, method: str, columns: Optional[List[str]] = None):
    # 缺失值处理：支持 zero/mean/median 方法
    pass
```

## 图表类型详细分析

### 1. 旭日图 (Sunburst Diagram)

**功能**：用圆形扇区表示占比，支持多层级嵌套展示

**数据格式**：`labels列(节点名称) + values列(数值) + 可选parents列(父级)`

**特点**：
- 适合展示有层级且数量较多的分类数据
- 支持自动列匹配和类型推断
- 使用 Plotly 库实现
- 返回完整的 HTML 渲染结果

### 2. 矩形树图 (Treemap)

**功能**：用矩形面积表示占比，支持多层级嵌套展示

**数据格式**：`labels列(类别名称) + values列(数值) + 可选parents列(父级)`

**特点**：
- 适合展示有层级且数量较多的分类数据
- 直观的面积对比
- 支持自动列匹配
- 使用 Plotly 库实现

### 3. 小提琴图 (Violin Chart)

**功能**：结合箱线图和密度估计，展示分布形状

**数据格式**：`y列(数值) + [可选: x列(分类)]`

**特点**：
- 比箱线图更丰富的分布信息
- 支持分类对比
- 使用 Plotly 库实现
- 适合展示数据分布的形状特征

### 4. 华夫格图 (Waffle Chart)

**功能**：用单元格拼成比例方格图，直观展示各分类占整体比例

**数据格式**：`category列 + value列`

**特点**：
- 直观的比例展示
- 支持麦肯锡配色方案
- 使用 Plotly 库实现
- 适合展示分类比例数据

### 5. 瀑布图 (Waterfall Chart)

**功能**：展示数值从起点经过增减变化到终点的过程

**数据格式**：`x列(阶段名称) + y列(数值) + 可选type列(initial/increase/decrease/total)`

**特点**：
- 可视化累积变化过程
- 支持类型标记（增加/减少/总计）
- 使用 Plotly 库实现
- 适合展示财务数据分析

## 工作流程

### 图表生成流程

1. 接收数据和配置
2. 自动列匹配和类型推断
3. 生成图表规范和 HTML 渲染
4. 返回统一的 `ChartResult` 格式

### 数据清洁流程

1. 数据概况分析
2. 缺失值检测和处理
3. 数据质量评估
4. 输出清洁后的 DataFrame 和处理报告

## 依赖关系

```
图表类型模块 → base.py → 公共接口
图表类型模块 → color_schemes.py → 配色方案
数据清洁模块 → pandas, numpy → 数据处理
图表生成 → Plotly → 可视化库
```

## 设计特点

### 优点

- **统一接口**：所有图表类型遵循相同的接口
- **自动列匹配**：智能识别数据列的语义
- **企业级配色**：支持专业咨询公司配色方案
- **完整文档**：每个图表类型都有详细的 README
- **模块化设计**：清晰的模块划分和低耦合度

### 改进建议

- **代码重复**：多个图表类型有相同的列匹配逻辑，可以提取到公共模块
- **文档格式**：README 格式可以标准化
- **配置管理**：图表配置可以集中管理
- **测试覆盖**：增加单元测试和集成测试

## 总结

批次 58 包含了完整的图表生成框架和数据清洁模块，提供了企业级的数据可视化解决方案。各图表类型遵循统一接口，支持自动列匹配和专业配色方案，适合数据分析和报告生成场景。数据清洁模块提供了完善的数据质量评估和处理功能，确保了数据的完整性和准确性。
