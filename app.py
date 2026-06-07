#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Business Analyst Agent — 自适应 Vercel & 本地环境
"""

import os
from pathlib import Path
import sys

# -------------------------------
# 自动检测并安装缺失依赖（仅本地环境）
# -------------------------------
def ensure_requirements():
    import importlib
    import subprocess

    req_file = Path(__file__).parent / "requirements.txt"
    if not req_file.exists():
        print("[WARN] requirements.txt not found, skipping dependency check.")
        return

    # ✅ 标记文件：记录上次安装时的 requirements.txt 修改时间
    stamp_file = Path(__file__).parent / ".deps_installed"
    req_mtime = req_file.stat().st_mtime
    if stamp_file.exists():
        try:
            if float(stamp_file.read_text()) >= req_mtime:
                return  # ✅ 未变动，直接跳过，耗时 <1ms
        except ValueError:
            pass  # 标记文件损坏，继续检测

    # pip包名 → import名 映射
    name_map = {
        "python-dotenv": "dotenv",
        "python-docx": "docx",
        "python-pptx": "pptx",
        "pillow": "PIL",
        "scikit-learn": "sklearn",
        "beautifulsoup4": "bs4",
        "opencv-python": "cv2",
        "psycopg2-binary": "psycopg2",
    }

    missing = []
    with open(req_file, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            pip_name = line.split("==")[0].split(">=")[0].split("<=")[0]\
                           .split("~=")[0].split("!=")[0].split("[")[0].strip()
            import_name = name_map.get(pip_name.lower(), pip_name.replace("-", "_"))
            try:
                importlib.import_module(import_name)
            except ImportError:
                missing.append(pip_name)

    if missing:
        print(f"[INFO] Installing missing packages: {missing}")
        try:
            subprocess.check_call(
                [sys.executable, "-m", "pip", "install"] + missing,
            )
        except subprocess.CalledProcessError as e:
            print(f"[WARN] Some packages failed to install: {e}. Continuing anyway...")
        print("[INFO] Installation complete. Restarting...")
        stamp_file.write_text(str(req_mtime))
        # os.execv 在 Windows 上行为不稳定，改用 subprocess 启动新进程后退出。
        try:
            subprocess.Popen([sys.executable] + sys.argv)
        except Exception as exc:
            print(f"[WARN] Auto-restart failed ({exc}), please restart manually.")
        sys.exit(0)
    else:
        stamp_file.write_text(str(req_mtime))  # ✅ 写入标记，下次直接跳过
        print("[INFO] All requirements already satisfied.")

# Vercel 环境依赖由平台管理，只在本地运行
if os.environ.get("VERCEL") != "1":
    ensure_requirements()

# -------------------------------
# 应用本地兼容性补丁
# -------------------------------
try:
    import local_patches; local_patches.apply()
except ImportError:
    pass

# -------------------------------
# 自动判断运行环境
# -------------------------------
is_vercel = os.environ.get("VERCEL") == "1"

# 日志目录
log_dir = Path("/tmp/outputs/Log") if is_vercel else Path(__file__).parent / "outputs" / "Log"
os.environ.setdefault("LOG_DIR", str(log_dir))

# 将项目根目录加入 sys.path
sys.path.insert(0, str(Path(__file__).parent))

# -------------------------------
# 初始化日志
# -------------------------------
from log_setup import setup_logging
setup_logging(level=20)  # logging.INFO

# -------------------------------
# 启动后台清理（仅本地；Vercel 短生命周期不需要）
# -------------------------------
if not is_vercel:
    from cleanup import setup_cleanup
    setup_cleanup(Path(__file__).parent)

# -------------------------------
# 导入 Flask app
# -------------------------------
from api import create_app
app = create_app()

# -------------------------------
# 启动配置
# -------------------------------
if __name__ == "__main__":
    port = int(os.environ.get("PORT") or os.environ.get("AGENT_PORT", 5001))
    print(f"\n  Business Analyst Agent → http://localhost:{port}\n")
    app.run(host="0.0.0.0", port=port, debug=not is_vercel, use_reloader=False)