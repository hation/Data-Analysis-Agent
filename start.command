#!/bin/bash

set -e

# 切换到脚本所在目录
cd "$(dirname "$0")"

APP_FILE="app.py"
REQUIREMENTS_FILE="requirements.txt"
VENV_DIR=".venv"
READY_FLAG=".venv/.deps_installed"

echo "[INFO] Checking Python..."

PY_CMD=""

if command -v python3 >/dev/null 2>&1; then
    PY_CMD="python3"
fi

if [ -z "$PY_CMD" ]; then
    echo "[ERROR] Python 3 is required."
    echo "[TIP] Please install Python from: https://www.python.org/downloads/"
    open "https://www.python.org/downloads/"
    read -p "Press Enter to exit..."
    exit 1
fi

echo "[INFO] Python command: $PY_CMD"
$PY_CMD --version

# 创建虚拟环境
if [ ! -x "$VENV_DIR/bin/python" ]; then
    echo "[INFO] Creating virtual environment..."
    $PY_CMD -m venv "$VENV_DIR"
fi

# 激活虚拟环境
source "$VENV_DIR/bin/activate"

# 确保 pip 可用
python -m pip --version >/dev/null 2>&1 || python -m ensurepip --upgrade

# 首次安装依赖，后续跳过
if [ -f "$READY_FLAG" ]; then
    echo "[INFO] Dependencies already installed. Skipping install."
else
    if [ -f "$REQUIREMENTS_FILE" ]; then
        echo "[INFO] Installing dependencies..."
        python -m pip install --upgrade pip
        python -m pip install -r "$REQUIREMENTS_FILE"
        touch "$READY_FLAG"
    else
        echo "[WARN] requirements.txt not found, skipping dependency install."
    fi
fi

# 检查入口文件
if [ ! -f "$APP_FILE" ]; then
    echo "[ERROR] Entry file not found: $APP_FILE"
    read -p "Press Enter to exit..."
    exit 1
fi

echo "[INFO] Starting application..."
python "$APP_FILE"
EXIT_CODE=$?

read -p "Press Enter to exit..."
exit $EXIT_CODE