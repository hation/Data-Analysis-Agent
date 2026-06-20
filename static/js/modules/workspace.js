// Workspace (workdir mount) business module.
// Talks to /api/session/<sid>/workspace/* endpoints.
// Sidebar status row + ov-workspace modal shell stay as plain DOM (consistent
// with src-name / mcp-status-text); the current-state card inside the modal is
// rendered by window.BAA.vueWorkspace (Vue island #6 in vue_app.js).
(function () {
  window.BAA = window.BAA || {};
  const { $ } = window.BAA.dom;
  const state = window.BAA.state;

  // ── Sidebar status row sync ───────────────────────────────────────
  function _setSidebarState(mounted, workdir) {
    const dot = $("ws-dot");
    const txt = $("ws-status-text");
    if (!dot || !txt) return;
    if (mounted) {
      dot.classList.add("on");
      // Show the last path segment so the row stays narrow.
      const seg = (workdir || "").split(/[\\/]/).filter(Boolean).pop() || workdir || "";
      txt.textContent = seg;
      txt.title = workdir || "";
    } else {
      dot.classList.remove("on");
      txt.textContent = window.t("workspace.unmounted");
      txt.title = "";
    }
  }

  // ── API helpers ───────────────────────────────────────────────────
  async function _fetchStatus() {
    const r = await fetch(`/api/session/${state.SID}/workspace`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  async function _mount(path) {
    const r = await fetch(`/api/session/${state.SID}/workspace/mount`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`);
    return d;  // 完整响应：{ ok, workspace, added, errors, sources }
  }

  async function _unmount() {
    const r = await fetch(`/api/session/${state.SID}/workspace/unmount`, {
      method: "POST",
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`);
    return d;  // 完整响应：{ ok, sources }
  }

  // ── Sync Vue island state + sidebar from a workspace object ───────
  function _syncFromWorkspace(ws) {
    const mounted = !!(ws && ws.mounted);
    const workdir = mounted ? ws.workdir : "";
    const artifacts = mounted ? (ws.artifacts_dir || "") : "";

    _setSidebarState(mounted, workdir);

    if (window.BAA.vueWorkspace && window.BAA.vueWorkspace.isAvailable()) {
      window.BAA.vueWorkspace.setState({
        mounted,
        workdir,
        artifacts_dir: artifacts,
        mounted_at: (ws && ws.mounted_at) || null,
      });
    }
  }

  // ── Public actions ────────────────────────────────────────────────
  async function loadStatus() {
    try {
      const d = await _fetchStatus();
      _syncFromWorkspace(d.workspace);
    } catch (e) {
      _setSidebarState(false, "");
      console.warn("[workspace] loadStatus failed:", e);
    }
  }

  async function doMount() {
    const input = $("ws-path-input");
    const errEl = $("ws-err");
    const okEl = $("ws-ok");
    if (errEl) errEl.textContent = "";
    if (okEl) okEl.textContent = "";

    const path = (input && input.value || "").trim();
    if (!path) {
      if (errEl) errEl.textContent = window.t("workspace.path_required");
      return;
    }

    if (window.BAA.vueWorkspace) window.BAA.vueWorkspace.setBusy(true, "mount");
    const btn = $("ws-mount-btn");
    if (btn) btn.disabled = true;

    try {
      const d = await _mount(path);
      const ws = d.workspace;
      _syncFromWorkspace(ws);

      // A5+：同步数据源列表到 sidebar（持久化 source + 缓存复用）
      const added = d.added || [];
      const reused = d.reused || 0;
      const sources = d.sources || [];
      const sourceName = d.source_name || (added.length > 0 ? added[0].source_name : "");
      const hasData = added.length > 0 || reused > 0;

      if (hasData && window.BAA.datasource && window.BAA.datasource.onSourcesUpdated) {
        // schema_preview 从响应取（持久化 source 的完整 schema）
        if (d.schema_preview) {
          state.schemaText = d.schema_preview;
        }
        window.BAA.datasource.onSourcesUpdated(sources, sourceName, 'src.hint.file');
        // 关闭 modal
        if (window.BAA.overlay && window.BAA.overlay.closeOverlay) {
          window.BAA.overlay.closeOverlay("ov-workspace");
        }
        // 提示：区分"新加载"和"缓存复用"
        let msg;
        if (added.length > 0 && reused > 0) {
          msg = `已挂载工作目录，新加载 ${added.length} 个文件，${reused} 个缓存复用`;
        } else if (added.length > 1) {
          msg = `已挂载工作目录，加载 ${added.length} 个数据文件`;
        } else if (added.length === 1) {
          msg = `已挂载工作目录，加载 ${added[0].source_name}`;
        } else {
          msg = `已挂载工作目录，${reused} 个文件缓存复用（秒开）`;
        }
        if (window.BAA.overlay && window.BAA.overlay.toast) {
          window.BAA.overlay.toast(msg, "ok");
        }
        if (window.sysMsg) {
          window.sysMsg(msg);
        }
        if (okEl) okEl.textContent = window.t("workspace.mount_ok", { path: ws.workdir });
      } else {
        // 挂载成功但没注册到数据文件
        if (okEl) okEl.textContent = window.t("workspace.mount_ok", { path: ws.workdir });
        // 显示部分错误（如果有）
        if (d.errors && d.errors.length && errEl) {
          errEl.textContent = "部分文件失败: " + d.errors.join("; ");
        }
        // 提示用户目录内无数据文件
        if (window.BAA.overlay && window.BAA.overlay.toast) {
          window.BAA.overlay.toast("工作目录已挂载，但未识别到数据文件（csv/xlsx/xls）", "warn");
        }
      }
      if (input) input.value = "";
    } catch (e) {
      if (errEl) errEl.textContent = window.t("workspace.mount_fail", { err: String(e.message || e) });
    } finally {
      if (btn) btn.disabled = false;
      if (window.BAA.vueWorkspace) window.BAA.vueWorkspace.setBusy(false);
    }
  }

  async function doUnmount() {
    const errEl = $("ws-err");
    const okEl = $("ws-ok");
    if (errEl) errEl.textContent = "";
    if (okEl) okEl.textContent = "";

    if (window.BAA.vueWorkspace) window.BAA.vueWorkspace.setBusy(true, "unmount");

    try {
      const d = await _unmount();
      _syncFromWorkspace({ mounted: false });

      // A4 修复：卸载后同步移除工作目录注册的数据源，更新 sidebar
      const sources = d.sources || [];
      if (window.BAA.datasource) {
        if (sources.length === 0) {
          // 没有其他数据源了，重置 sidebar
          if (window.BAA.datasource.resetSourceState) {
            window.BAA.datasource.resetSourceState();
          }
        } else {
          // 还有其他数据源（用户上传的），只更新列表
          if (window.BAA.datasource.onSourcesUpdated) {
            window.BAA.datasource.onSourcesUpdated(sources, null, 'src.hint.file');
          }
        }
      }

      if (okEl) okEl.textContent = window.t("workspace.unmount_ok");
      if (window.BAA.overlay && window.BAA.overlay.toast) {
        window.BAA.overlay.toast("工作目录已卸载", "ok");
      }
    } catch (e) {
      if (errEl) errEl.textContent = window.t("workspace.unmount_fail", { err: String(e.message || e) });
    } finally {
      if (window.BAA.vueWorkspace) window.BAA.vueWorkspace.setBusy(false);
    }
  }

  // ── Browse button (webkitdirectory) ───────────────────────────────
  // Browsers return fakepath for security; we try common base paths and let
  // the user confirm/complete.
  function pickWorkdir() {
    const input = $("ws-file-input");
    if (!input) return;
    input.value = "";
    input.onchange = () => {
      const files = input.files;
      if (!files || !files.length) return;
      // webkitRelativePath looks like "FolderName/sub/file.csv" on most browsers.
      const rel = files[0].webkitRelativePath || files[0].name || "";
      const folderName = rel.split("/")[0] || rel;
      const pathInput = $("ws-path-input");
      const hint = $("ws-path-hint");

      // Try to guess a plausible full path by checking common Windows bases.
      const guessed = _guessFullPath(folderName);
      if (pathInput && guessed && !pathInput.value) {
        pathInput.value = guessed;
        if (hint) {
          hint.textContent = window.t("workspace.browse_hint", { name: folderName }) +
            "  " + window.t("modal.workspace.path_ph");
          hint.style.color = "#059669";
        }
      } else if (!guessed) {
        // Fallback: no guess worked — show hint only.
        if (pathInput && !pathInput.value) {
          pathInput.focus();
        }
        if (hint) {
          hint.textContent = window.t("workspace.browse_hint", { name: folderName });
          hint.style.color = "#f59e0b";
        }
      }
      // Focus the input so user sees the value and can edit it.
      if (pathInput) {
        pathInput.focus();
        pathInput.select();
      }
    };
    input.click();
  }

  // Try to find an existing directory matching folderName under common Windows bases.
  function _guessFullPath(folderName) {
    // Common base directories to search (in priority order).
    const candidates = [
      _homePath(),                          // C:\Users\<username>
      _homePath() + "\\Documents",
      _homePath() + "\\Desktop",
      _homePath() + "\\Downloads",
      _homePath() + "\\OneDrive\\Documents",
      _homePath() + "\\OneDrive\\Desktop",
      "D:\\",
      "D:\\tmp",
      "D:\\Projects",
      "D:\\projects",
      "C:\\Users\\" + (typeof navigator !== "undefined" ? "" : "") + "\\Documents",
    ];
    for (const base of candidates) {
      if (!base) continue;
      const candidate = base + "\\" + folderName;
      // We cannot check filesystem from browser; instead we use heuristics:
      // If candidate matches patterns like D:\Users\xxx\Documents\Bain, it's likely correct.
      // Return the most plausible guess (first one with a real-looking structure).
      if (_looksLikeRealPath(candidate)) return candidate.replace(/\//g, "\\");
    }
    return null;  // No good guess
  }

  function _homePath() {
    // Best effort: browser doesn't expose user home reliably.
    // Fall back to C:\Users\<username> pattern.
    if (typeof process !== "undefined" && process.env.USERPROFILE) {
      return process.env.USERPROFILE;
    }
    // On Windows, the username is often in the app data path.
    try {
      // This won't work in browsers but serves as documentation of intent.
      return "C:\Users\\" + (typeof location !== "undefined"
        ? location.hostname || ""
        : "");
    } catch (_) {
      return "";
    }
  }

  function _looksLikeRealPath(path) {
    // Heuristic: a real Windows absolute path should have at least 2 segments
    // after the drive letter, e.g. D:\Users\xxx\Bain or C:\Users\xxx\Desktop\Bain.
    // Also reject obviously fake patterns.
    if (!path || path.length < 8) return false;
    // Must start with drive letter
    if (!/^[A-Za-z]:/.test(path)) return false;
    // Must have enough depth (at least drive:\one\two)
    const parts = path.split(/[\\/]/).filter(Boolean);
    return parts.length >= 3 && !path.includes("fakepath") && !path.includes("::");
  }

  // ── Open modal: refresh state on every open ───────────────────────
  function openModal() {
    window.openOverlay("ov-workspace");
    // Reset hint color/text on open.
    const hint = $("ws-path-hint");
    if (hint) {
      hint.textContent = window.t("modal.workspace.hint");
      hint.style.color = "";
    }
    const errEl = $("ws-err");
    const okEl = $("ws-ok");
    if (errEl) errEl.textContent = "";
    if (okEl) okEl.textContent = "";
    loadStatus();
  }

  // ── Bootstrap: sync sidebar on page load ──────────────────────────
  // Called from app.js bootstrap after session is established.

  window.BAA.workspace = {
    loadStatus,
    doMount,
    doUnmount,
    pickWorkdir,
    openModal,
  };
})();
