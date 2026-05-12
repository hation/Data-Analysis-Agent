#!/bin/bash

set -e

# 切换到脚本所在目录
cd "$(dirname "$0")"

APP_FILE="app.py"
REQUIREMENTS_FILE="requirements.txt"
VENV_DIR=".venv"

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

# 创建虚拟环境（如果不存在）
if [ ! -x "$VENV_DIR/bin/python" ]; then
    echo "[INFO] Creating virtual environment..."
    $PY_CMD -m venv "$VENV_DIR"
fi

# 激活虚拟环境
source "$VENV_DIR/bin/activate"

# 确保 pip 可用
python -m pip --version >/dev/null 2>&1 || python -m ensurepip --upgrade

# 每次运行都检查并安装缺失依赖
if [ -f "$REQUIREMENTS_FILE" ]; then
    echo "[INFO] Installing missing dependencies..."
    python -m pip install --upgrade pip || echo "[WARN] pip upgrade failed, continuing..."
    python -m pip install -r "$REQUIREMENTS_FILE" || {
        echo "[WARN] Retry installing dependencies with PyPI mirror..."
        python -m pip install -r "$REQUIREMENTS_FILE" -i https://pypi.tuna.tsinghua.edu.cn/simple || {
            echo "[ERROR] Failed to install dependencies from requirements.txt."
            read -p "Press Enter to exit..."
            exit 1
        }
    }
else
    echo "[WARN] requirements.txt not found, skipping dependency install."
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