#!/usr/bin/env bash
# =========================================================
#  Move to script directory
# =========================================================
cd "$(dirname "$0")" || { echo "[ERROR] Failed to switch to the script directory."; exit 1; }

# =========================================================
#  Config
# =========================================================
APP_FILE="app.py"
REQUIREMENTS_FILE="requirements.txt"
VENV_DIR=".venv"
PORT=5001
PIP_MIRROR="https://pypi.tuna.tsinghua.edu.cn/simple"
MIN_MINOR=10
PY_CMD=""

# =========================================================
#  Detect Python 3.10+
# =========================================================
echo "[INFO] Detecting Python 3.${MIN_MINOR}+..."

for cmd in python3 python; do
    if command -v "$cmd" &>/dev/null; then
        major=$("$cmd" -c "import sys; print(sys.version_info.major)" 2>/dev/null)
        minor=$("$cmd" -c "import sys; print(sys.version_info.minor)" 2>/dev/null)
        if [ "$major" = "3" ] && [ "$minor" -ge "$MIN_MINOR" ] 2>/dev/null; then
            PY_CMD="$cmd"
            break
        fi
    fi
done

if [ -z "$PY_CMD" ]; then
    echo ""
    echo "[ERROR] Python 3.${MIN_MINOR}+ is required but was not found."
    echo ""
    echo "  Please install Python from: https://www.python.org/downloads/"
    echo "  On macOS you can also run:  brew install python"
    echo ""
    # Try to open download page on macOS
    command -v open &>/dev/null && open "https://www.python.org/downloads/"
    read -rp "Press Enter to exit..."
    exit 1
fi

echo "[INFO] Using: $PY_CMD ($("$PY_CMD" --version 2>&1))"

# =========================================================
#  Create venv if missing or broken
# =========================================================
if [ ! -f "$VENV_DIR/bin/python" ]; then
    echo "[INFO] Creating virtual environment (first run only)..."
    "$PY_CMD" -m venv "$VENV_DIR" || {
        echo "[ERROR] Failed to create virtual environment."
        echo "[TIP]   On some systems you may need: sudo apt install python3-venv"
        read -rp "Press Enter to exit..."
        exit 1
    }
fi

if [ ! -f "$VENV_DIR/bin/activate" ]; then
    echo "[WARN] Virtual environment appears broken. Recreating..."
    rm -rf "$VENV_DIR"
    "$PY_CMD" -m venv "$VENV_DIR" || {
        echo "[ERROR] Failed to recreate virtual environment."
        read -rp "Press Enter to exit..."
        exit 1
    }
fi

# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate" || {
    echo "[ERROR] Failed to activate virtual environment."
    read -rp "Press Enter to exit..."
    exit 1
}
PY_CMD="python"

# =========================================================
#  Bootstrap pip
# =========================================================
if ! "$PY_CMD" -m pip --version &>/dev/null; then
    echo "[INFO] Bootstrapping pip..."
    "$PY_CMD" -m ensurepip --upgrade || {
        echo "[ERROR] pip is not available and cannot be bootstrapped."
        read -rp "Press Enter to exit..."
        exit 1
    }
fi

# =========================================================
#  Install dependencies only when needed (stamp file)
# =========================================================
STAMP_FILE="$VENV_DIR/.install_stamp"
NEEDS_INSTALL=0

if [ ! -f "$STAMP_FILE" ]; then
    NEEDS_INSTALL=1
elif [ -f "$REQUIREMENTS_FILE" ] && [ "$REQUIREMENTS_FILE" -nt "$STAMP_FILE" ]; then
    NEEDS_INSTALL=1
fi

if [ "$NEEDS_INSTALL" = "1" ]; then
    if [ ! -f "$REQUIREMENTS_FILE" ]; then
        echo "[WARN] requirements.txt not found. Skipping dependency install."
    else
        echo "[INFO] Installing dependencies (this may take a few minutes on first run)..."
        "$PY_CMD" -m pip install --upgrade pip -q
        [ $? -ne 0 ] && echo "[WARN] pip upgrade failed, continuing..."

        "$PY_CMD" -m pip install -r "$REQUIREMENTS_FILE" -q
        if [ $? -ne 0 ]; then
            echo "[WARN] Direct install failed. Retrying with Tsinghua mirror..."
            "$PY_CMD" -m pip install -r "$REQUIREMENTS_FILE" -i "$PIP_MIRROR" -q
            if [ $? -ne 0 ]; then
                echo ""
                echo "[ERROR] Dependency installation failed."
                echo ""
                echo "  Common causes:"
                echo "   1. Network issue — check your internet connection"
                echo "   2. Proxy required — export HTTP_PROXY=http://your-proxy:port"
                echo "   3. Disk space — ensure you have at least 2 GB free"
                echo ""
                echo "  To diagnose, run manually:"
                echo "    $VENV_DIR/bin/pip install -r requirements.txt"
                echo ""
                read -rp "Press Enter to exit..."
                exit 1
            fi
        fi

        # Write stamp only after successful install
        date > "$STAMP_FILE"
        echo "[INFO] Dependencies installed successfully."
    fi
else
    echo "[INFO] Dependencies already up to date. Skipping install."
fi

# =========================================================
#  Check app file
# =========================================================
if [ ! -f "$APP_FILE" ]; then
    echo "[ERROR] Entry file not found: $APP_FILE"
    read -rp "Press Enter to exit..."
    exit 1
fi

# =========================================================
#  Check port availability
# =========================================================
if lsof -iTCP:"$PORT" -sTCP:LISTEN &>/dev/null 2>&1; then
    PID=$(lsof -ti TCP:"$PORT" -sTCP:LISTEN 2>/dev/null)
    echo ""
    echo "[ERROR] Port $PORT is already in use (PID=$PID)."
    echo ""
    echo "  This usually means the app is already running."
    echo "  To stop it:  kill $PID"
    echo ""
    read -rp "Press Enter to exit..."
    exit 1
fi

# =========================================================
#  Start app and open browser
# =========================================================
echo ""
echo "[INFO] Starting application..."
echo "[INFO] Opening http://127.0.0.1:$PORT in your browser..."
echo "[INFO] Press Ctrl+C in this terminal to stop the server."
echo ""

# Open browser after Flask starts (macOS: open, Linux: xdg-open)
(sleep 2 && (command -v open &>/dev/null && open "http://127.0.0.1:$PORT" || \
             command -v xdg-open &>/dev/null && xdg-open "http://127.0.0.1:$PORT")) &

"$PY_CMD" "$APP_FILE"
RET=$?

[ $RET -ne 0 ] && echo "[ERROR] Application exited with code $RET. Check outputs/Log/ for details."

read -rp "Press Enter to exit..."
exit $RET
