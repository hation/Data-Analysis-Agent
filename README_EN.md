# Business Analyst Agent

<div align="right">

[中文](./README.md)

</div>

[![Python](https://img.shields.io/badge/Python-3.8%2B-blue.svg)](#)
[![Flask](https://img.shields.io/badge/Backend-Flask-black.svg)](#)
[![Plotly](https://img.shields.io/badge/Visualization-Plotly-3F4F75.svg)](#)
[![LLM](https://img.shields.io/badge/LLM-OpenAI%20Compatible-green.svg)](#)
[![Charts](https://img.shields.io/badge/Charts-43_Types-orange.svg)](#)
[![License](https://img.shields.io/badge/License-Apache%202.0-yellow.svg)](LICENSE)

> An AI agent for business analytics: connect your data source, ask in natural language, and it automatically performs SQL querying, chart generation, and insight delivery.

---

## Introduction

**Business Analyst Agent** is a conversational analytics system for business scenarios.  
You can upload Excel/CSV files or connect SQL databases (MySQL/PostgreSQL/SQLite/SQL Server), then ask questions in plain language. The agent will automatically:

1. Understand data schema
2. Generate and execute SQL
3. Select and render charts (43 chart types)
4. Output concise business insights

The backend streams the process via **SSE**, so users can see each step in real time (schema → query → chart).

---

## Features

- **Natural-language analytics** (no manual SQL required)
- **Multiple data sources**: Excel / CSV / MySQL / PostgreSQL / SQLite / SQL Server
- **Smart chart recommendation** with 43 chart types
- **SSE real-time feedback** for transparent tool execution
- **Configurable model providers**: DeepSeek / OpenAI / Claude / any OpenAI-compatible API
- **Slash commands**: `/chart` (chart-first), `/sql` (direct SQL execution)

---

## Screenshots

### Data Preview
![Data Preview](Images/Data_preview.png)

### Data Query
![Data Query](Images/Data_query.png)

### Custom Model
![Custom Model](Images/Custom_model.png)

### Auto Generated Image
![Auto Generated](Images/Auto_generated_image.png)

---

## Quick Start

### Requirements
- Python 3.8+
- Windows (`start.bat` one-click startup provided)

### Install & Run

**Option 1: One-click on Windows (recommended)**
```bash
start.bat