# Intelligent Business Analysis Agent

<p align="center">
  <img src="./Images/Banner.png" alt="Business Analysis Agent Banner" width="100%" />
</p>

<p align="right"><a href="./README.md">中文</a></p>

![Python](https://img.shields.io/badge/Python-3.10%2B-blue.svg)
![Flask](https://img.shields.io/badge/Backend-Flask-black.svg)
![Plotly](https://img.shields.io/badge/Visualization-Plotly-3F4F75.svg)
![LLM](https://img.shields.io/badge/LLM-OpenAI%20Compatible-green.svg)
![Charts](https://img.shields.io/badge/Charts-43_Types-orange.svg)
![License](https://img.shields.io/badge/License-Apache%202.0-yellow.svg)

> An AI Agent designed for business analytics scenarios.  
> Once connected to a data source, users can ask questions in plain language — the system automatically handles:
>
> - Data schema recognition
> - SQL generation & execution
> - Chart generation
> - Business insight analysis

---

# Table of Contents

- [✨ Project Highlights](#-project-highlights)
- [🧠 Core Capabilities](#-core-capabilities)
- [⚙️ Installation](#️-installation)
- [🛠 Slash Commands](#-slash-commands)
- [📈 Usage Examples](#-usage-examples)
- [🤖 LLM Configuration](#-llm-configuration)
- [🗺️ Project Milestones](#️-project-milestones)
- [❓ FAQ](#-faq)
- [🚀 Looking for Contributors](#-looking-for-contributors)
- [📄 License](#-license)
- [⭐ Project Goal](#-project-goal)

---

# ✨ Project Highlights

Business Analyst Agent is a conversational business data analysis system. Its goal is to let non-technical users perform data analysis simply by "chatting."

Upload an Excel / CSV file or connect a database, then ask questions directly:

```text
What is the sales trend for the last three months?
Which region has the highest profit?
Generate a user growth chart for me.
```

The system will automatically:

1. Understand the intent of the question
2. Analyze the data schema
3. Generate SQL automatically
4. Execute the query
5. Recommend a suitable chart
6. Output business insights

All results are streamed in real time via **SSE (Server-Sent Events)**.

---

# 🧠 Core Capabilities

## 1️⃣ Natural Language Data Analysis

No SQL required.

Just type in plain language:

```text
Monthly order volume trend for this year
```

The system automatically handles:

- SQL generation
- Data querying
- Chart recommendation
- Analysis summary

![Data Query](Images/Data_query.png)

---

## 2️⃣ Multi-Source Data Support

Supports uploading and connecting various data sources:

- Files: Excel / CSV
- Databases: SQLite, MySQL, PostgreSQL, SQL Server
- Planned: DuckDB, Spark

![Data Preview](Images/Data_preview.png)

---

## 3️⃣ Intelligent Chart System

| Category | Chart Types |
|---|---|
| **COMPARING** | Marimekko_ABS, Marimekko_PCT, Bar_Chart, Grouped_Bar_Chart, Stacked_Bar_Chart, Diverging_Bar_Chart, Dot_Plot, Waffle, Bullet_Chart, Sankey_Chart, Heatmap, Waterfall |
| **TIME** | Line_Chart, Circular_Line_Chart, Slope_Chart, Sparkline, Bump_Chart, Cycle_Chart, Area_Chart, Stacked_Area_Chart, Horizon_Chart, Connected_Scatter |
| **DISTRIBUTION** | Histogram_Pareto_chart, Pyramid_Chart, Error_Bar_Chart, Box-and-Whisker_Plot, Violin_Chart, Ridgeline_Plot, Beeswarm_Plot, stem_leaf |
| **GEOSPATIAL** | Flow_Map, Dot_Density_Map, Choropleth_Map |
| **RELATIONSHIP** | Scatter_Plot, Bubble_Plot, Radar_Charts, Chord_Diagram, Arc_Chart, Network_Diagram, Parallel_Coordinates_Plot |
| **PART-TO-WHOLE** | Treemap, Sunburst_Diagram, Nightingale_Chart, Pie_Chart |

The system automatically recommends the most suitable chart based on query results.

![Auto Generated](Images/Auto_generated_image.png)

---

## 4️⃣ SSE Streaming Analysis

The analysis process is visible in real time:

```text
[1/4] Reading data schema...
[2/4] Generating SQL...
[3/4] Executing query...
[4/4] Generating charts and insights...
```

More transparent and interactive than traditional BI tools.

---

## 5️⃣ Multi-Model Compatibility

Supports:
- DeepSeek
- OpenAI
- Claude
- Any OpenAI SDK-compatible API

Fully customizable:

- `base_url`
- `model`
- `api_key`

Default configuration:

| Provider | Default Model |
|---|---|
| DeepSeek | `deepseek-chat` |
| OpenAI | `gpt-4o-mini` |
| Anthropic | `claude-3-5-haiku-20241022` |

---

## 6️⃣ Data Analysis

Currently supported analytics features:
- Outlier handling (trimming & winsorizing)
- Decile grouping analysis
- K-Means clustering
- Decision tree modeling

![Analyze](Images/Analyze.png)

---

## 7️⃣ Report Generation

Supports exporting:
- Formatted Excel spreadsheets
- DOCX reports
- Built-in styled PPT presentations

![Output](Images/Output.png)

---

## 8️⃣ MCP Extension

**Supports connecting local or remote MCP servers to extend Agent capabilities**

![MCP](Images/MCP1.png)

- Tutorial: [MCP_tutorial](Information/MCP_tutorial.md)

---

## 9️⃣ Knowledge Base Input

Upload domain knowledge to help the Agent better understand your data.

![repository](Images/repository2.png)

- Tutorial: [repository_tutorial](Information/repository_tutorial.md)

---

# ⚙️ Installation

### Option 1: Download Package (Recommended)

#### 1) Download the archive

![Download installation package](Images/package.png)

#### 2) Extract and run directly from the project directory:

**Windows users**

```bat
start.bat
```

> Note: The first run of `start.bat` will automatically set up the environment — this may take a while. Subsequent runs will be much faster.

**Mac users**

① Use the script `start.command`

② Grant execution permission in Terminal (press Command + Space, type Terminal, press Enter):
   ```bash
   chmod +x start.command
   ```

③ Double-click `start.command` to run.

> Note: macOS security policy may block the first run. To fix: right-click `start.command` → "Open" → confirm "Open", or run in Terminal: `xattr -d com.apple.quarantine start.command`

#### 2) Extract and run via command line (fallback method)

**① Windows:**

Navigate to the project directory (or Shift + right-click inside the folder to open PowerShell):
```bash
cd ~/Data-Analysis-Agent   # replace with your actual path
```

Install dependencies:
```bash
pip install -r requirements.txt
```

Start the service:
```bash
python app.py
```

**② Mac:**

Navigate to the project directory (press Command + Space, type Terminal, press Enter):
```bash
cd ~/Data-Analysis-Agent   # replace with your actual path
```

Install dependencies:
```bash
pip3 install -r requirements.txt
```

Start the service:
```bash
python3 app.py
```

#### 3) Open `http://localhost:5001` in your browser

Note: This is a local address — your data stays on your machine.

![Download installation package2](Images/package2.png)

#### 4) Configure your API key

![Configure the API3](Images/Deepseek3.png)

#### 5) Future updates

![Update](Images/Update.png)

> Note: Please restart before updating.

---

### Option 2: One-Command Install + Launch (Beta — unstable)

#### 1) Windows (PowerShell)

```powershell
iwr -useb https://raw.githubusercontent.com/Zafer-Liu/Data-Analysis-Agent/main/install.ps1 | iex
```

After installation, launch with:

- Double-click (Windows):
  ```bat
  %USERPROFILE%\data-analysis-agent.bat
  ```
- Or navigate to the directory manually:
  ```powershell
  cd $env:USERPROFILE\.data-analysis-agent\Data-Analysis-Agent
  .\.venv\Scripts\activate
  python app.py
  ```

#### 1) macOS / Linux (Shell)

```bash
curl -fsSL https://raw.githubusercontent.com/Zafer-Liu/Data-Analysis-Agent/main/install.sh | sh
```

After installation, launch with:

```bash
data-analysis-agent
```

If you see `command not found`, add `~/.local/bin` to your PATH (in `~/.bashrc` or `~/.zshrc`):

```bash
export PATH="$HOME/.local/bin:$PATH"
```

#### 2) Open in browser (same as Option 1)

#### 3) Configure API key (same as Option 1)

#### 4) Future updates (same as Option 1)

---

### Option 3: Install via GitHub (Command Line)

#### 1) Clone the repository

```bash
git clone https://github.com/Zafer-Liu/Data-Analysis-Agent.git
```

#### 2) Enter the project directory

```bash
cd Data-Analysis-Agent
```

#### 3) Install dependencies

```bash
pip install -r requirements.txt
```

#### 4) Start the service

```bash
python app.py
```

#### 5) Open in browser (same as Option 1)

#### 6) Configure API key (same as Option 1)

#### 7) Future updates (same as Option 1)

---

# 🛠 Slash Commands

| Command | Status | Description |
|---|---|---|
| `/chart` | ✅ | Force chart generation as the primary output |
| `/sql` | ✅ | Execute SQL directly |
| `/analyze` | ✅ | In-depth statistical analysis |
| `/tree` | ✅ | Decision tree analysis |
| `/kmeans` | ✅ | K-Means clustering analysis |
| `/data` | ✅ | Data exploration and preview |
| `/inset` | ✅ | Missing value imputation |
| `/winsorize` | ✅ | Winsorizing (replace extreme values) |
| `/trimming` | ✅ | Trimming (remove extreme values) |
| `/export` | ✅ | Export data file |
| `/report` | ✅ | Export Word/PDF report |
| `/ppt` | ✅ | Export PPT presentation |
| `/status` | ✅ | View task status |

---

# 📈 Usage Examples

## Example 1: Trend Analysis

User input:

```text
Sales trend over the last 12 months
```

System output:

- SQL query
- Trend line chart
- Sales growth analysis

---

## Example 2: Regional Analysis

User input:

```text
Which region has the highest profit?
```

System output:

- Regional profit ranking
- Bar chart
- Regional business insights

---

## Example 3: Chart-First Mode

User input:

```text
/chart User growth overview
```

The system prioritizes generating a visualization.

---

# 🤖 LLM Configuration

Fill in the following fields in the ⚙ sidebar:

```text
API Key
Base URL
Model
```

You can switch models at any time.

---

# 🗺️ Project Milestones

## Changelog

**Current Version: v4.0 — May 29, 2026**

This release focuses on **a complete frontend overhaul, improved chart stability, and engineering quality enhancements**.

### 1. UI Improvements
- Sidebar restructured into a three-section layout: status, actions, and history
- Added **model connection test** indicator (auto-tests on model selection; can also be triggered manually in settings)
- Agent output bubbles redesigned in "report style": left-side brand-color vertical bar + shaded background, visually consistent with chart frames
- One-click dark mode toggle
- `agent_chat.css` split into five submodules: `tokens`, `base`, `chat`, `modals`, `kb`
- Added an operation guide with common issue explanations

### 2. Stability Enhancements
- Chart dependencies localized to eliminate external CDN reliance
- Fixed a bug where loading conversation history would overwrite the currently selected model — now only restores model from history if the user hasn't made a selection yet

### 3. Batch Data Processing Improvements
- Replaced SQLite with DuckDB for data source ingestion, enabling millions of rows to be processed in seconds

### 4. New Time Series Analysis Module
- Added support for Prophet, SARIMA, ARIMA, VAR, and GRU models

## Full Changelog
- [Version_Update_Log](Information/Version_Update_Log.md)
- [Version_Update_Log_EN](Information/Version_Update_Log_EN.md)

---

# ❓ FAQ

## Q: "LLM not configured" error?

A: Fill in your API Key in the ⚙ sidebar and save.

## Q: How do I get an API Key?

A: Using DeepSeek as an example:

![Configure the API1](Images/Deepseek1.png)

![Configure the API2](Images/Deepseek2.png)

![Configure the API3](Images/Deepseek3.png)

## Q: Chart links stop working after restart?

A: Generated charts are stored locally in the `*\outputs\charts` directory.

## Q: How do I connect a SQL database?

A: Use the following connection string format: `mysql+pymysql://username:password@host:port/dbname`

- ❌ Incorrect: `mysql://user:pass@host:3306/dbname`
- ✅ Correct: `mysql+pymysql://user:pass@host:3306/dbname`

---

# 🚀 Looking for Contributors

A great open-source project is never a solo act.  
We're building a **data tool that can truly handle complex business scenarios** — one that blazes through massive datasets, navigates multi-table logic with ease, and surfaces insights on visual dashboards.

Right now, we're facing some genuinely challenging — and genuinely rewarding — problems. If you love solving hard problems, we need you:

---

### Key challenges we'd love your help with:
- **Multi-sheet inter-table logic optimization** — How do you intelligently untangle dependencies across dozens of sheets?
- **Dashboard interaction & performance** — Make data stories flow more smoothly, intuitively, and powerfully.
- **Model capability in edge business scenarios** — The edge cases general-purpose tools can't handle are exactly where we operate.
- **Remote server integration** — Building a framework for remote GPU invocation.

---

### Why is it worth your time?

- You'll tackle **real, deep, non-toy** technical challenges
- Your code will directly impact **end-user productivity** in the field
- Flexible contributions — submit a PR or reach out directly, your call
- Outstanding contributors may be invited to become project Committers

---

### How to get involved?

- Submit a **Pull Request** — we review within 24 hours
- Or email: `rusboldtshanti34@gmail.com` (please include "Contributor + your area of expertise")

---

# 📄 License

Apache License 2.0

---

# ⭐ Project Goal

Make business analysis as simple as having a conversation.