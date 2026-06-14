# Version Development Log

## v1.0
- The project officially released its first stable version
- Supports basic data upload, viewing, analysis, and visualization
- Supports common data sources such as Excel, CSV, and databases
- Enables common data analysis tasks through conversational interaction
- Provides basic chart generation and result export capabilities

---

## v2.0
**May/11/2026**

This update focuses on **stronger analytical capabilities, more consistent presentation, and better export features**.

### 1. Logging System Upgrade
- Added a unified logging system
- Automatically records runtime activity, tool calls, model requests, and exceptions
- Logs rotate daily and are retained for 30 days to help with troubleshooting

### 2. Unified Color Scheme
- Fixed inconsistent color schemes between charts and PPTs
- When users switch brand colors, both charts and reports will update accordingly
- Default color scheme is McKinsey, with support for BCG and others

### 3. Agent Architecture Refactoring
- Split the original single-file Agent into multiple modules
- Improved code maintainability and extensibility
- Makes future feature integration easier

### 4. Internationalization Support
- Added Chinese/English language switching
- Frontend interface can be switched between Chinese and English with one click
- Page text, prompts, and command descriptions are fully adapted

### 5. Slash Command Optimization
- Replaced the general analysis command with more specific commands
- Such as `/decile`, `/tree`, and `/kmeans`
- Makes it easier for users to understand the purpose of each command

### 6. Enhanced Export Features
- Added Excel and Word report export
- Supports generating downloadable files directly from analysis results
- `/export` and `/report` commands enable quick export tasks

### 7. Enhanced Data Cleaning Features
- Added data profiling, missing value handling, winsorization, and trimming
- Supports more flexible data preprocessing workflows
- Cleaned data can be used directly for further analysis

### 8. Data Preview Upgrade
- Replaced the original data structure view with a table preview
- Provides an experience closer to Excel
- Allows quick browsing of tables, fields, and sample data

### 9. Token Usage Tracking
- Added context window and output token statistics
- Users can view token usage directly in the interface
- Helps control model cost and context length

### 10. Thinking Mode Display
- Supports displaying the model’s reasoning process
- Users can view the model’s chain of thought when needed
- Useful for debugging and understanding complex analysis tasks

### 11. Frontend Experience Improvements
- Further modularized the page structure for easier maintenance
- Separated styles and scripts into independent files
- Improved interface stability and responsiveness

---
## v3.0
May 18, 2026
This upgrade focuses on external ecosystem integration and enhanced business knowledge capabilities, significantly expanding the Agent’s data acquisition abilities and adaptability to different fields.

### 1. MCP Tool Invocation Capability
- Added support for the MCP (Model Context Protocol); Agents can now dynamically invoke external MCP tools.
- Supports the use of calculators, code executors, third-party API wrappers, and other tools to expand analytical capabilities.
- Through a standardized protocol, any tool that complies with MCP specifications can be integrated.
- The entire process of tool invocation is automatically logged for easy debugging and auditing.

### 2. Business Knowledge Base Integration
- Added a business database feature that allows the import of internal company materials, product documentation, industry reports, etc.
- Materials are automatically processed in a vectorized manner to create a searchable knowledge base.
- When performing analyses, Agents automatically retrieve relevant information, enhancing their understanding and insight into specific business scenarios.- Supports multiple formats: Word, Excel, etc., to meet the needs of importing common documents.

### 3. Expansion of data sources: Google Sheets and custom APIs
- Integration with Google Sheets API: Allows direct access to data in Google Sheets as an analysis source.
- Custom database API interface: Provides a generic API adapter.
- All external data sources can be utilized along with a full set of functions such as data cleaning, previewing, and analysis.

---

## v4.0
May 29, 2026

This upgrade focuses on comprehensive front-end experience refactoring, chart stability enhancement, and engineering quality reinforcement.

### 1. User Interface Optimization
- Sidebar refactored into a three-part information architecture: Status Area, Operations Area, History Area
- Added Model Connection Test indicator (automatically tests upon model selection, also manually triggerable in settings)
- Agent output bubbles changed to a "report style": left brand-colored vertical line + shaded background, visually unified with chart frames
- Supports one-click dark mode switching
- Split `agent_chat.css` into five sub-modules: `tokens`, `base`, `chat`, `modals`, `kb`
- Added an operation guide, including explanations for common issues

### 2. Enhanced Stability
- Localized chart dependencies to eliminate reliance on external CDNs
- Fixed the issue where loading historical conversations forced overriding the currently selected model: now restores from history only when the user hasn't selected a model yet

### 3. Batch Data Processing Capability Improvement
- Changed the conversion logic after original data source connection, switching from SQL Slight to duckdb, enabling second-level processing for tens of thousands of rows of data

### 4. New Time Series Analysis Module
- Supports Prophet, SARIMA, ARIMA, VAR, and GRU models

```markdown
---

## v5.0
**June 4, 2026**

This is a major release, covering four key areas: **multi-source support, intelligent interaction, stability fixes, and security hardening**.

### 1. Multi-Source Support
- You can now connect to multiple data sources at the same time — no longer limited to just one
- A new data source list has been added to the sidebar, with an independent toggle for each source, so you can freely choose which sources are active and included in analysis
- In multi-source scenarios, the AI can automatically determine which source each query should pull from, and supports joint analysis across sources

### 2. AI Proactive Questions
- When a request is ambiguous (e.g., it's unclear which dimension to analyze by or which metric to use), the AI will proactively pause and ask a question
- Option cards appear in the interface — just click an option to continue, or choose "Other" to enter a custom answer
- The AI won't interrupt arbitrarily — it only asks when different choices would lead to substantially different results

### 3. Automatic Conversation Saving
- Each conversation is automatically saved after the AI finishes responding, so it won't be lost when you refresh or reopen the page
- In the saved conversation list, auto-saved and manually saved records now share a unified style, distinguished by a small label — there's no longer a visual "hierarchy" between them
- Fixed an issue where auto-save would incorrectly create a new record when you continued chatting after loading a saved conversation

### 4. Improved MCP Tool Integration Experience
- Connected MCP tools can now be expanded to view detailed descriptions, so you can understand each tool's purpose and parameters
- Added "Smart Fill": paste in a tool's install command or configuration, and the form is automatically parsed and filled — no need to enter each field manually
- Added "Local Scan": enter the path to a local toolkit, and configuration details are automatically detected

### 5. Data Preview Upgrade
- The data preview dialog now uses a split-panel layout: the left side lists all tables (with row counts), and the right side shows their contents
- With multiple sources, the left side groups tables by source, showing how many tables each source contains
- The divider can be dragged to adjust the panel widths

### 6. Improved SQL Database Connectivity

- After connecting to an external database, tables the AI has queried are automatically cached locally, greatly speeding up repeated queries without having to reconnect to the remote server each time
- Fixed inaccurate table count detection (previously, large databases might only have some tables recognized; now all tables and views are retrieved)
- Fixed incorrect table-name quoting formats across database dialects (MySQL, PostgreSQL, etc.)
- Large tables (over 500,000 rows) are no longer fully pulled to the local machine; queries are executed directly on the remote server to avoid out-of-memory errors

### 7. Preventing AI from Fabricating Data

- Fixed an issue where, across multiple conversation turns, the AI would "remember" numbers from earlier replies and reuse them in the next turn instead of re-querying
- The AI can now see the complete history of queries and won't treat textual descriptions as known facts

### 8. Knowledge Base Trigger Fix

- Fixed an issue where the business knowledge base often wasn't triggered during conversations — the AI used to skip checking the knowledge base for various reasons
- Now, for any data analysis request, the AI consults the metric definitions and business rules in the knowledge base first, before starting the analysis

### 9. Other Experience Fixes

- While the AI is responding, scrolling up to review earlier content no longer forces you back to the bottom; the view only auto-scrolls to the latest message when you send a new one
- Fixed an issue where Google Sheets data sources would sometimes only recognize half of the worksheets
- Fixed an issue where the grouping field in grouped bar charts would sometimes have no effect, causing the chart to fall back to a regular bar chart
- Fixed an issue where, after loading a saved conversation, the sidebar data source status wouldn't refresh and would show stale or blank states
- Enhanced security: all SQL queries run by the AI undergo stricter syntax-level checks, and filesystem and network access have been disabled at the database connection layer

```
## v5.1
**June 13, 2026**

This update focuses on multi-data-source federated analysis and data connectivity stability improvements.

### 1. Enhanced Cross-Data-Source Federated Analysis
- Added a multi-data-source virtual merge layer, supporting direct cross-source `JOIN` and `UNION` operations on tables from different data sources.
- When multiple Excel or CSV files contain tables with the same name, the system now automatically prefixes table names with their data source identifier, enabling the AI to accurately distinguish and query data from the specified file.
- Optimized multi-data-source query routing. Both single-source and cross-source queries now automatically select the correct execution method.
- Data source schema information now includes sample data, helping the AI differentiate between tables with identical structures but different content.

### 2. Excel Data Connectivity Fixes
- Fixed an issue where Excel columns containing "space-separated number strings" (e.g., bank account numbers, ID numbers, codes) would fail to upload.
- Standard text columns are now consistently recognized as strings, preventing DuckDB from incorrectly inferring them as numeric and triggering type conversion errors.

### 3. Optimized Data Source Disconnection Prompts
- Fixed a problem where, after a service restart, the frontend would still show data sources as connected, but queries would not respond.
- When a data source connection within a session becomes invalid, the system now clearly prompts the user to reconnect, instead of returning blank replies.
- Added dual frontend-backend checks to prevent the AI from continuing with invalid execution when data structures are missing.

### 4. Improved Model Testing Experience
- Model settings now support "test before save".
- After users enter a new API Key, Base URL, or model name, they can directly test the current inputs.
- If input fields are empty, the system will automatically use the saved configuration, maintaining compatibility with the original testing method.
