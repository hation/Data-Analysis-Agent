$ErrorActionPreference = "Stop"

$RepoUrl     = "https://github.com/Zafer-Liu/Data-Analysis-Agent.git"
$ProjectName = "Data-Analysis-Agent"
$InstallDir  = Join-Path $env:USERPROFILE ".data-analysis-agent"
$ProjectDir  = Join-Path $InstallDir $ProjectName
$PipMirror   = "https://pypi.tuna.tsinghua.edu.cn/simple"

function Info($msg)  { Write-Host "[Data-Analysis-Agent] $msg" -ForegroundColor Cyan }
function Warn($msg)  { Write-Host "[WARN] $msg"  -ForegroundColor Yellow }
function Error_($msg){ Write-Host "[ERROR] $msg" -ForegroundColor Red }

# =========================================================
#  Check Python 3.10+
# =========================================================
Info "Checking Python 3.10+..."

$PyCmds = @("python", "py")
$PyCmd  = $null

foreach ($cmd in $PyCmds) {
    try {
        $ver = & $cmd -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>$null
        if ($ver -match "^3\.(\d+)$" -and [int]$Matches[1] -ge 10) {
            $PyCmd = $cmd
            break
        }
    } catch {}
}

if (-not $PyCmd) {
    Error_ "Python 3.10+ is required but was not found."
    Write-Host ""
    Write-Host "  Please install Python from: https://www.python.org/downloads/"
    Write-Host "  Make sure to check 'Add Python to PATH' during installation."
    Write-Host ""
    Start-Process "https://www.python.org/downloads/"
    Read-Host "Press Enter to exit"
    exit 1
}

Info "Found: $PyCmd ($( & $PyCmd --version 2>&1 ))"

# =========================================================
#  Check Git
# =========================================================
Info "Checking Git..."
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Error_ "Git is required but was not found."
    Write-Host ""
    Write-Host "  Please install Git from: https://git-scm.com/downloads"
    Write-Host ""
    Start-Process "https://git-scm.com/downloads"
    Read-Host "Press Enter to exit"
    exit 1
}

# =========================================================
#  Clone or update repository
# =========================================================
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

if (Test-Path $ProjectDir) {
    Info "Project already exists at $ProjectDir. Updating..."
    Push-Location $ProjectDir
    git pull
    Pop-Location
} else {
    Info "Cloning repository (this may take a minute)..."
    git clone $RepoUrl $ProjectDir
    if ($LASTEXITCODE -ne 0) {
        Error_ "Failed to clone repository. Check your network connection."
        Read-Host "Press Enter to exit"
        exit 1
    }
}

Push-Location $ProjectDir

# =========================================================
#  Create virtual environment
# =========================================================
Info "Creating virtual environment..."
& $PyCmd -m venv .venv
if ($LASTEXITCODE -ne 0) {
    Error_ "Failed to create virtual environment."
    Read-Host "Press Enter to exit"
    exit 1
}

# =========================================================
#  Install dependencies
# =========================================================
Info "Installing dependencies (this may take a few minutes)..."
& ".\.venv\Scripts\python.exe" -m pip install --upgrade pip -q

& ".\.venv\Scripts\pip.exe" install -r requirements.txt -q
if ($LASTEXITCODE -ne 0) {
    Warn "Direct install failed. Retrying with Tsinghua mirror..."
    & ".\.venv\Scripts\pip.exe" install -r requirements.txt -i $PipMirror -q
    if ($LASTEXITCODE -ne 0) {
        Error_ "Dependency installation failed."
        Write-Host ""
        Write-Host "  Common causes:"
        Write-Host "   1. Network issue — check your internet connection"
        Write-Host "   2. Proxy required — set HTTP_PROXY and HTTPS_PROXY"
        Write-Host "   3. Disk space — ensure you have at least 2 GB free"
        Write-Host ""
        Pop-Location
        Read-Host "Press Enter to exit"
        exit 1
    }
}

# =========================================================
#  Create launcher
# =========================================================
$Launcher = Join-Path $env:USERPROFILE "data-analysis-agent.bat"

@"
@echo off
cd /d "$ProjectDir"
call ".venv\Scripts\activate.bat"
echo [INFO] Starting application...
start /b cmd /c "timeout /t 2 >nul && start http://127.0.0.1:5001"
python app.py
pause
"@ | Set-Content -Encoding ASCII $Launcher

Pop-Location

# =========================================================
#  Done
# =========================================================
Write-Host ""
Info "Installation complete!"
Write-Host ""
Write-Host "  To start the app, double-click:" -ForegroundColor Green
Write-Host "    $Launcher" -ForegroundColor Green
Write-Host ""
Write-Host "  Or run manually:"
Write-Host "    cd $ProjectDir"
Write-Host "    .\.venv\Scripts\activate"
Write-Host "    python app.py"
Write-Host ""
Read-Host "Press Enter to launch the app now (or Ctrl+C to exit)"
& $Launcher
