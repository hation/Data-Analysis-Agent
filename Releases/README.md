# 智能商业分析 Agent v5.1

> **发布日期：** 2026 年 6 月  
> **类型：** 功能版本（Feature Release）

---

## 📦 下载

| 平台 | 文件 | 大小 | 说明 |
|------|------|------|------|
| Windows (x64) | [`BusinessAnalyticsAgent_v5.1.exe`](./BusinessAnalyticsAgent_v5.1.exe) | 44 MB | 一键安装，双击即用 |
| macOS | *(暂不提供安装包)* | — | 请使用[压缩包方式](../README.md#install)安装 |

> **Windows 安全提示：** 安装时若弹出"Windows 已保护你的电脑"或"未知发布者"警告，点击"更多信息" → "仍要运行"。安装包未经 Microsoft 代码签名，属正常现象。

---

## ✨ v5.1 更新内容

### 🚀 安装体验优化

- **新增 Windows 一键安装包**，无需手动安装 Python 或配置环境，双击安装程序即可完成全部配置
- 优化 `start.bat` 启动逻辑，修复首次启动闪退问题，改善错误提示
- 首次启动自动创建虚拟环境并安装依赖，后续启动无等待

### 🤖 多模型支持

| 提供商 | 默认模型 |
|--------|----------|
| DeepSeek | `deepseek-v4-flash` |
| OpenAI | `gpt-4o-mini` |
| AtlasCloud | `deepseek-v4-pro` |
| 自定义 | 任意 OpenAI 兼容 API |

### 📊 核心分析能力

- 自然语言转 SQL，支持 Excel / CSV / SQLite / MySQL / PostgreSQL / SQL Server
- 43 种图表类型自动推荐
- SSE 流式输出，分析过程实时可见
- 支持异常值处理、K-Means 聚类、决策树建模、十分位分组分析
- 导出 Excel / Word / PPT 报告

---

## 🔧 系统要求

| 项目 | 要求 |
|------|------|
| 操作系统 | Windows 10 / 11（64 位） |
| 内存 | 建议 8 GB 以上 |
| 磁盘空间 | 安装需约 500 MB |
| 网络 | 需可访问所选 LLM 提供商的 API |

---

## 🛠 安装步骤

1. 下载 `BusinessAnalyticsAgent_v5.1.exe`
2. 双击运行，按提示完成安装
3. 从桌面或开始菜单启动 **BusinessAnalyticsAgent**
4. 在设置面板中填入 API Key
5. 上传数据文件或连接数据库，开始分析

---

## 🐛 已修复问题

| 问题 | 说明 |
|------|------|
| `start.bat` 首次启动闪退 | 修复 Windows 换行符兼容性问题 |
| Python 版本检测失败 | 简化检测逻辑，兼容更多 Windows 环境 |

---

## 🔄 从旧版升级

直接安装新版安装包，选择覆盖安装即可。  
已配置的 API Key 和数据文件不受影响。

---

## 🤝 反馈与贡献

- **Bug 报告 / 功能建议：** [GitHub Issues](https://github.com/Zafer-Liu/Data-Analysis-Agent/issues)
- **代码贡献：** 欢迎提交 Pull Request

---

*[查看完整文档 →](../README.md)*
