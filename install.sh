#!/usr/bin/env sh
set -eu

REPO_URL="https://github.com/Zafer-Liu/Data-Analysis-Agent.git"
PROJECT_NAME="Data-Analysis-Agent"
INSTALL_DIR="$HOME/.data-analysis-agent"
PROJECT_DIR="$INSTALL_DIR/$PROJECT_NAME"
LAUNCHER="$HOME/.local/bin/data-analysis-agent"
PIP_MIRROR="https://pypi.tuna.tsinghua.edu.cn/simple"
MIN_MINOR=10

info()  { printf '\033[36m[Data-Analysis-Agent] %s\033[0m\n' "$1"; }
warn()  { printf '\033[33m[WARN] %s\033[0m\n' "$1"; }
error() { printf '\033[31m[ERROR] %s\033[0m\n' "$1" >&2; }

# =========================================================
#  Check Python 3.10+
# =========================================================
info "Checking Python 3.${MIN_MINOR}+..."

PY_CMD=""
for cmd in python3 python; do
    if command -v "$cmd" >/dev/null 2>&1; then
        major=$("$cmd" -c "import sys; print(sys.version_info.major)" 2>/dev/null || echo 0)
        minor=$("$cmd" -c "import sys; print(sys.version_info.minor)" 2>/dev/null || echo 0)
        if [ "$major" = "3" ] && [ "$minor" -ge "$MIN_MINOR" ] 2>/dev/null; then
            PY_CMD="$cmd"
            break
        fi
    fi
done

if [ -z "$PY_CMD" ]; then
    error "Python 3.${MIN_MINOR}+ is required but was not found."
    echo ""
    echo "  Please install Python from: https://www.python.org/downloads/"
    echo "  On macOS:  brew install python"
    echo "  On Ubuntu: sudo apt install python3.10"
    echo ""
    exit 1
fi

info "Found: $PY_CMD ($("$PY_CMD" --version 2>&1))"

# =========================================================
#  Check Git
# =========================================================
info "Checking Git..."
if ! command -v git >/dev/null 2>&1; then
    error "Git is required but was not found."
    echo ""
    echo "  Install Git:"
    echo "   macOS:  brew install git"
    echo "   Ubuntu: sudo apt install git"
    echo ""
    exit 1
fi

# =========================================================
#  Clone or update repository
# =========================================================
mkdir -p "$INSTALL_DIR"
mkdir -p "$HOME/.local/bin"

if [ -d "$PROJECT_DIR" ]; then
    info "Project already exists at $PROJECT_DIR. Updating..."
    cd "$PROJECT_DIR"
    git pull
else
    info "Cloning repository (this may take a minute)..."
    git clone "$REPO_URL" "$PROJECT_DIR" || {
        error "Failed to clone repository. Check your network connection."
        exit 1
    }
    cd "$PROJECT_DIR"
fi

# =========================================================
#  Create virtual environment
# =========================================================
info "Creating virtual environment..."
"$PY_CMD" -m venv .venv || {
    error "Failed to create virtual environment."
    echo "  On Ubuntu/Debian you may need: sudo apt install python3-venv"
    exit 1
}

# =========================================================
#  Install dependencies
# =========================================================
info "Installing dependencies (this may take a few minutes)..."
.venv/bin/python -m pip install --upgrade pip -q
[ $? -ne 0 ] && warn "pip upgrade failed, continuing..."

.venv/bin/pip install -r requirements.txt -q
if [ $? -ne 0 ]; then
    warn "Direct install failed. Retrying with Tsinghua mirror..."
    .venv/bin/pip install -r requirements.txt -i "$PIP_MIRROR" -q
    if [ $? -ne 0 ]; then
        error "Dependency installation failed."
        echo ""
        echo "  Common causes:"
        echo "   1. Network issue — check your internet connection"
        echo "   2. Proxy required — export HTTP_PROXY=http://your-proxy:port"
        echo "   3. Disk space — ensure you have at least 2 GB free"
        echo ""
        echo "  To diagnose, run manually:"
        echo "    $PROJECT_DIR/.venv/bin/pip install -r requirements.txt"
        echo ""
        exit 1
    fi
fi

# =========================================================
#  Create launcher
# =========================================================
cat > "$LAUNCHER" << EOF
#!/usr/bin/env sh
cd "$PROJECT_DIR"
. ".venv/bin/activate"
echo "[INFO] Starting application..."
(sleep 2 && (command -v open >/dev/null 2>&1 && open "http://127.0.0.1:5001" || \
             command -v xdg-open >/dev/null 2>&1 && xdg-open "http://127.0.0.1:5001")) &
python app.py
EOF

chmod +x "$LAUNCHER"

# =========================================================
#  Done
# =========================================================
echo ""
info "Installation complete!"
echo ""
printf '\033[32m  To start the app, run:\033[0m\n'
printf '\033[32m    data-analysis-agent\033[0m\n'
echo ""
echo "  If you see 'command not found', add this to your shell config (~/.zshrc or ~/.bashrc):"
echo '    export PATH="$HOME/.local/bin:$PATH"'
echo "  Then run: source ~/.zshrc  (or restart your terminal)"
echo ""
printf "Launch the app now? [Y/n] "
read -r answer
case "$answer" in
    [Nn]*) echo "Run 'data-analysis-agent' whenever you're ready." ;;
    *)     "$LAUNCHER" ;;
esac
