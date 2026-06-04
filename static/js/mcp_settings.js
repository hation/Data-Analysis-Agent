/* MCP Settings UI — loaded after modules/overlay.js (depends on window.openOverlay / closeOverlay / toast) */

const MCP_STATUS_ICON = {
  connected:    "🟢",
  connecting:   "🟡",
  disconnected: "⚪",
  error:        "🔴",
};

let _mcpFormOpen = false;
let _mcpEditId   = null; // server_id currently being edited (null = add mode)
let _mcpActiveTab = "local"; // "local" | "paste"

function switchMcpTab(tab) {
  _mcpActiveTab = tab;
  document.getElementById("mcp-panel-local").style.display = tab === "local" ? "flex" : "none";
  document.getElementById("mcp-panel-paste").style.display = tab === "paste" ? "flex" : "none";
  document.getElementById("mcp-tab-local").classList.toggle("active", tab === "local");
  document.getElementById("mcp-tab-paste").classList.toggle("active", tab === "paste");
}

function openMcpSettings() {
  loadMcpServers();
  openOverlay("ov-mcp");
}

function toggleMcpAddForm() {
  _mcpFormOpen = !_mcpFormOpen;
  _mcpEditId   = null;
  const form   = document.getElementById("mcp-add-form");
  const toggle = document.getElementById("mcp-add-toggle");
  form.style.display = _mcpFormOpen ? "flex" : "none";
  toggle.textContent = _mcpFormOpen ? "▲ 折叠" : "＋ 添加 MCP 服务器";
  document.getElementById("mcp-form-title").textContent = "添加服务器";
  document.getElementById("mcp-id-row").style.display = "";
  if (_mcpFormOpen) {
    document.getElementById("mcp-add-err").textContent = "";
    document.getElementById("mcp-add-ok").textContent  = "";
  } else {
    _clearMcpForm();
  }
}

function openMcpEditForm(server) {
  _mcpEditId   = server.server_id;
  _mcpFormOpen = true;

  const form   = document.getElementById("mcp-add-form");
  const toggle = document.getElementById("mcp-add-toggle");
  form.style.display = "flex";
  toggle.textContent = "▲ 折叠";
  document.getElementById("mcp-form-title").textContent = `编辑：${_esc(server.label)}`;
  document.getElementById("mcp-id-row").style.display   = "none"; // ID is immutable

  document.getElementById("mcp-label").value = server.label || "";
  document.getElementById("mcp-id").value    = server.server_id || "";
  document.getElementById("mcp-desc").value  = server.description || "";

  const transport = server.transport || "stdio";
  document.querySelector(`input[name="mcp-transport"][value="${transport}"]`).checked = true;
  onMcpTransportChange();

  if (transport === "stdio") {
    document.getElementById("mcp-command").value = server.command || "";
    document.getElementById("mcp-args").value    = (server.args || []).join(" ");
    document.getElementById("mcp-env").value     = Object.entries(server.env || {}).map(([k,v]) => `${k}=${v}`).join(", ");
  } else {
    document.getElementById("mcp-url").value     = server.url || "";
    document.getElementById("mcp-headers").value = Object.entries(server.headers || {}).map(([k,v]) => `${k}:${v}`).join(", ");
  }

  document.getElementById("mcp-add-err").textContent = "";
  document.getElementById("mcp-add-ok").textContent  = "";

  if (transport === "stdio") updateMcpCmdPreview();

  form.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function onMcpTransportChange() {
  const transport = document.querySelector('input[name="mcp-transport"]:checked').value;
  const stdioEl = document.getElementById("mcp-stdio-fields");
  const sseEl   = document.getElementById("mcp-sse-fields");
  if (transport === "stdio") {
    stdioEl.style.display = "flex";
    stdioEl.style.flexDirection = "column";
    stdioEl.style.gap = "8px";
    sseEl.style.display = "none";
    updateMcpCmdPreview();
  } else {
    stdioEl.style.display = "none";
    sseEl.style.display = "flex";
    sseEl.style.flexDirection = "column";
    sseEl.style.gap = "8px";
    const previewEl = document.getElementById("mcp-cmd-preview");
    if (previewEl) previewEl.style.display = "none";
  }
}

/* ── list ─────────────────────────────────────────────────────── */

async function loadMcpServers() {
  const listEl = document.getElementById("mcp-server-list");
  listEl.innerHTML = '<div style="font-size:12px;color:#64748b;padding:4px 0">加载中…</div>';
  // Invalidate tool cache so expanded views refresh after reconnect
  Object.keys(_mcpToolsCache).forEach(k => delete _mcpToolsCache[k]);
  try {
    const res = await fetch("/api/mcp/servers");
    const data = await res.json();
    renderMcpServerList(data.servers || []);
    _updateMcpSidebarStatus(data.servers || []);
  } catch (e) {
    listEl.innerHTML = `<div style="font-size:12px;color:#ef4444;padding:4px 0">加载失败: ${e.message}</div>`;
  }
}

function _updateMcpSidebarStatus(servers) {
  const dot      = document.getElementById("mcp-dot");
  const textEl   = document.getElementById("mcp-status-text");
  const hintEl   = document.getElementById("mcp-status-hint");
  if (!dot) return;
  const connected = servers.filter(s => s.status === "connected");
  // Only toggle the .on modifier so the dot keeps its base class (.sb-status-dot
  // in the new sidebar; was .source-dot in the legacy layout).
  if (connected.length > 0) {
    dot.classList.add("on");
    textEl.textContent = `${connected.length} 个服务器已连接`;
    const toolCount = connected.reduce((n, s) => n + (s.tool_count || 0), 0);
    hintEl.textContent = toolCount ? `共 ${toolCount} 个工具可用` : "点击管理 MCP 工具服务器";
  } else if (servers.length > 0) {
    dot.classList.remove("on");
    textEl.textContent = `${servers.length} 个服务器未连接`;
    hintEl.textContent = "点击管理 MCP 工具服务器";
  } else {
    dot.classList.remove("on");
    textEl.textContent = "未配置";
    hintEl.textContent = "点击管理 MCP 工具服务器";
  }
}

function renderMcpServerList(servers) {
  const listEl = document.getElementById("mcp-server-list");
  if (!servers.length) {
    listEl.innerHTML = '<div style="font-size:12px;color:#94a3b8;padding:4px 0">暂无配置的服务器</div>';
    return;
  }
  listEl.innerHTML = servers.map(s => {
    const icon = MCP_STATUS_ICON[s.status] || "⚪";
    const toolCount = s.tool_count != null ? `${s.tool_count} 个工具` : "";
    const errMsg = s.last_error ? `<div style="font-size:11px;color:#ef4444;margin-top:2px">${_esc(s.last_error)}</div>` : "";
    const enabledChecked = s.enabled ? "checked" : "";
    const serverJson = _esc(JSON.stringify(s));
    const canShowTools = s.status === "connected" && s.tool_count > 0;
    return `
    <div class="custom-model-item" style="display:flex;flex-direction:column;gap:0;padding:8px 10px">
      <div style="display:flex;align-items:flex-start;gap:8px">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <span style="font-size:14px">${icon}</span>
            <strong style="font-size:13px">${_esc(s.label)}</strong>
            <code style="font-size:11px;color:#64748b;background:#f1f5f9;padding:1px 5px;border-radius:4px">${_esc(s.server_id)}</code>
            <span style="font-size:11px;color:#94a3b8">${_esc(s.transport)}</span>
            ${toolCount ? `<span style="font-size:11px;color:#10b981">${toolCount}</span>` : ""}
          </div>
          ${s.description ? `<div style="font-size:12px;color:#64748b;margin-top:2px">${_esc(s.description)}</div>` : ""}
          ${errMsg}
        </div>
        <div style="display:flex;gap:6px;align-items:center;flex-shrink:0">
          <label style="display:flex;align-items:center;gap:4px;font-size:12px;color:#475569;cursor:pointer" title="启用/禁用">
            <input type="checkbox" ${enabledChecked} onchange="toggleMcpEnabled('${_esc(s.server_id)}', this.checked)">
            启用
          </label>
          ${canShowTools ? `<button class="btn-sm btn-sm-ghost" style="padding:2px 8px;font-size:11px" onclick="toggleMcpTools('${_esc(s.server_id)}', this)">查看工具 ▾</button>` : ""}
          <button class="btn-sm btn-sm-ghost" style="padding:2px 8px;font-size:11px"
            onclick='openMcpEditForm(${serverJson})'>编辑</button>
          ${s.status !== "connected" && s.status !== "connecting"
            ? `<button class="btn-sm btn-sm-ghost" style="padding:2px 8px;font-size:11px" onclick="connectMcpServer('${_esc(s.server_id)}')">连接</button>`
            : ""}
          <button class="btn-sm" style="padding:2px 8px;font-size:11px;background:#fee2e2;color:#dc2626;border:none;border-radius:5px;cursor:pointer"
            onclick="removeMcpServer('${_esc(s.server_id)}')">删除</button>
        </div>
      </div>
      <div id="mcp-tools-${_esc(s.server_id)}" class="mcp-tool-list" style="display:none"></div>
    </div>`;
  }).join("");
}

/* ── tool detail expand ───────────────────────────────────────── */

const _mcpToolsCache = {};

async function toggleMcpTools(serverId, btn) {
  const toolsEl = document.getElementById(`mcp-tools-${serverId}`);
  if (!toolsEl) return;

  const isOpen = toolsEl.style.display !== "none";
  if (isOpen) {
    toolsEl.style.display = "none";
    btn.textContent = "查看工具 ▾";
    return;
  }

  btn.textContent = "收起工具 ▴";
  toolsEl.style.display = "flex";

  if (_mcpToolsCache[serverId]) {
    _renderMcpTools(toolsEl, _mcpToolsCache[serverId]);
    return;
  }

  toolsEl.innerHTML = '<div style="font-size:11px;color:#64748b">加载中…</div>';
  try {
    const res  = await fetch(`/api/mcp/servers/${encodeURIComponent(serverId)}/tools`);
    const data = await res.json();
    const tools = data.tools || [];
    _mcpToolsCache[serverId] = tools;
    _renderMcpTools(toolsEl, tools);
  } catch (e) {
    toolsEl.innerHTML = `<div style="font-size:11px;color:#ef4444">加载失败: ${_esc(e.message)}</div>`;
  }
}

function _renderMcpTools(container, tools) {
  if (!tools.length) {
    container.innerHTML = '<div style="font-size:11px;color:#94a3b8">暂无工具</div>';
    return;
  }
  container.innerHTML = tools.map(t => {
    const schema   = t.inputSchema || {};
    const props    = schema.properties || {};
    const required = new Set(schema.required || []);
    const params   = Object.entries(props).map(([k, v]) => {
      const cls = required.has(k) ? "mcp-tool-param required" : "mcp-tool-param";
      const tip = v.description ? ` title="${_esc(v.description)}"` : "";
      return `<span class="${cls}"${tip}>${_esc(k)}${required.has(k) ? "*" : ""}</span>`;
    }).join("");
    return `
    <div class="mcp-tool-item">
      <div class="mcp-tool-name">${_esc(t.name)}</div>
      ${t.description ? `<div class="mcp-tool-desc">${_esc(t.description)}</div>` : ""}
      ${params ? `<div class="mcp-tool-params">${params}</div>` : ""}
    </div>`;
  }).join("");
}

/* ── add / edit ───────────────────────────────────────────────── */

async function addMcpServer() {
  const errEl = document.getElementById("mcp-add-err");
  const okEl  = document.getElementById("mcp-add-ok");
  errEl.textContent = "";
  okEl.textContent  = "";

  const transport = document.querySelector('input[name="mcp-transport"]:checked').value;
  const label     = document.getElementById("mcp-label").value.trim();
  const server_id = document.getElementById("mcp-id").value.trim();
  const desc      = document.getElementById("mcp-desc").value.trim();

  const isEdit = _mcpEditId !== null;

  if (!label)                           { errEl.textContent = "请填写服务器名称"; return; }
  if (!isEdit && !server_id)            { errEl.textContent = "请填写服务器 ID";  return; }
  if (!isEdit && !/^[a-zA-Z0-9_]+$/.test(server_id)) {
    errEl.textContent = "服务器 ID 只能包含字母、数字和下划线";
    return;
  }

  const payload = { label, description: desc, transport };

  if (transport === "stdio") {
    const command = document.getElementById("mcp-command").value.trim();
    const argsRaw = document.getElementById("mcp-args").value.trim();
    const envRaw  = document.getElementById("mcp-env").value.trim();
    if (!command) { errEl.textContent = "请填写命令"; return; }
    payload.command = command;
    payload.args    = argsRaw ? argsRaw.split(/\s+/).filter(Boolean) : [];
    payload.env     = _parseKV(envRaw, "=");
  } else {
    const url     = document.getElementById("mcp-url").value.trim();
    const hdrsRaw = document.getElementById("mcp-headers").value.trim();
    if (!url) { errEl.textContent = "请填写 SSE 端点 URL"; return; }
    payload.url     = url;
    payload.headers = _parseKV(hdrsRaw, ":");
  }

  try {
    let res;
    if (isEdit) {
      res = await fetch(`/api/mcp/servers/${encodeURIComponent(_mcpEditId)}`, {
        method:  "PUT",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
      });
    } else {
      payload.server_id = server_id;
      res = await fetch("/api/mcp/servers", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
      });
    }
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || (isEdit ? "更新失败" : "添加失败"); return; }
    okEl.textContent = isEdit ? "已更新，正在重连…" : "已保存，正在尝试连接…";
    setTimeout(() => {
      if (_mcpFormOpen) toggleMcpAddForm();
      _clearMcpForm();
      loadMcpServers();
    }, 800);
  } catch (e) {
    errEl.textContent = "请求失败: " + e.message;
  }
}

/* ── remove ───────────────────────────────────────────────────── */

async function removeMcpServer(serverId) {
  if (!confirm(`确定要删除服务器 "${serverId}" 吗？`)) return;
  try {
    const res = await fetch(`/api/mcp/servers/${encodeURIComponent(serverId)}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json();
      showToast(data.error || "删除失败", "error");
      return;
    }
    loadMcpServers();
  } catch (e) {
    showToast("请求失败: " + e.message, "error");
  }
}

/* ── connect ──────────────────────────────────────────────────── */

async function connectMcpServer(serverId) {
  try {
    await fetch(`/api/mcp/servers/${encodeURIComponent(serverId)}/connect`, { method: "POST" });
    showToast("正在连接…", "info");
    setTimeout(loadMcpServers, 1500);
  } catch (e) {
    showToast("连接请求失败: " + e.message, "error");
  }
}

/* ── enable/disable ───────────────────────────────────────────── */

async function toggleMcpEnabled(serverId, enabled) {
  const action = enabled ? "enable" : "disable";
  try {
    await fetch(`/api/mcp/servers/${encodeURIComponent(serverId)}/${action}`, { method: "POST" });
    if (!enabled) setTimeout(loadMcpServers, 300);
  } catch (e) {
    showToast("操作失败: " + e.message, "error");
  }
}

/* ── helpers ──────────────────────────────────────────────────── */

function _esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function _parseKV(raw, sep) {
  if (!raw) return {};
  return Object.fromEntries(
    raw.split(",")
       .map(s => s.trim())
       .filter(Boolean)
       .map(s => {
         const idx = s.indexOf(sep);
         if (idx === -1) return [s.trim(), ""];
         return [s.slice(0, idx).trim(), s.slice(idx + sep.length).trim()];
       })
  );
}

function _clearMcpForm() {
  ["mcp-label","mcp-id","mcp-desc","mcp-command","mcp-args","mcp-env","mcp-url","mcp-headers"]
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });
  const radios = document.querySelectorAll('input[name="mcp-transport"]');
  if (radios.length) radios[0].checked = true;
  onMcpTransportChange();
  _mcpEditId = null;
  updateMcpCmdPreview();
  // Reset tab to default
  switchMcpTab("local");
  // Reset scan area
  const sp = document.getElementById("mcp-scan-path");
  if (sp) sp.value = "";
  const sc = document.getElementById("mcp-scan-status");
  if (sc) { sc.textContent = ""; sc.style.color = ""; sc.innerHTML = ""; }
  const scw = document.getElementById("mcp-scan-warnings");
  if (scw) scw.style.display = "none";
  // Reset smart parse area
  const si = document.getElementById("mcp-smart-input");
  if (si) si.value = "";
  const ss = document.getElementById("mcp-smart-status");
  if (ss) { ss.textContent = ""; ss.style.color = ""; }
  const sw = document.getElementById("mcp-smart-warnings");
  if (sw) sw.style.display = "none";
  const sh = document.getElementById("mcp-smart-llm-hint");
  if (sh) sh.style.display = "none";
}

/* ── command preview ──────────────────────────────────────────── */

function updateMcpCmdPreview() {
  const previewEl = document.getElementById("mcp-cmd-preview");
  const textEl    = document.getElementById("mcp-cmd-preview-text");
  if (!previewEl || !textEl) return;

  const cmd  = (document.getElementById("mcp-command")?.value || "").trim();
  const args = (document.getElementById("mcp-args")?.value   || "").trim();

  if (!cmd) {
    previewEl.style.display = "none";
    return;
  }

  const parts = [cmd, ...args.split(/\s+/).filter(Boolean)];
  textEl.textContent = parts.join(" ");
  previewEl.style.display = "";
}

/* ── local scan ───────────────────────────────────────────────── */

async function scanLocalMcp() {
  const pathEl  = document.getElementById("mcp-scan-path");
  const statusEl = document.getElementById("mcp-scan-status");
  const warnEl   = document.getElementById("mcp-scan-warnings");
  const btn      = document.getElementById("mcp-scan-btn");

  const path = (pathEl?.value || "").trim();
  if (!path) {
    statusEl.textContent = "请先填写目录路径";
    statusEl.style.color = "#ef4444";
    return;
  }

  statusEl.textContent = "扫描中…";
  statusEl.style.color = "#64748b";
  warnEl.style.display = "none";
  btn.disabled = true;

  try {
    const res  = await fetch("/api/mcp/scan-local", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ path }),
    });
    const data = await res.json();

    if (!res.ok) {
      statusEl.textContent = data.error || "扫描失败";
      statusEl.style.color = "#ef4444";
      if (data.hint) {
        warnEl.innerHTML = `💡 ${_esc(data.hint)}`;
        warnEl.style.color = "#64748b";
        warnEl.style.background = "#f8fafc";
        warnEl.style.display = "";
      }
      return;
    }

    _applyMcpConfig(data.config);

    // Show confidence badge in status
    const pct = data.confidence ?? 0;
    const confColor = pct >= 80 ? "#10b981" : pct >= 50 ? "#f59e0b" : "#ef4444";
    statusEl.innerHTML =
      `✓ 已识别 <strong style="color:${confColor}">${_esc(data.pkg_name)}</strong>` +
      `（置信度 ${pct}%）— 请检查命令预览`;
    statusEl.style.color = "#475569";

    if (data.warnings && data.warnings.length) {
      warnEl.style.color = "#f59e0b";
      warnEl.style.background = "#fef3c7";
      warnEl.innerHTML = "⚠️ 注意：<br>" +
        data.warnings.map(w => `• ${_esc(w)}`).join("<br>");
      warnEl.style.display = "";
    }

  } catch (e) {
    statusEl.textContent = "请求失败: " + e.message;
    statusEl.style.color = "#ef4444";
  } finally {
    btn.disabled = false;
  }
}

// Shared helper: apply a parsed/scanned config object into the form fields
function _applyMcpConfig(cfg, { overwriteLabel = true } = {}) {
  const radio = document.querySelector(`input[name="mcp-transport"][value="${cfg.transport}"]`);
  if (radio) { radio.checked = true; onMcpTransportChange(); }

  // server_id only fillable in add mode (immutable when editing)
  if (_mcpEditId === null && cfg.server_id) {
    _setIfEmpty("mcp-id", cfg.server_id);
  }

  // Scan always overwrites; smart-parse only fills if empty (user may have typed already)
  if (overwriteLabel) {
    if (cfg.label)       document.getElementById("mcp-label").value = cfg.label;
    if (cfg.description) document.getElementById("mcp-desc").value  = cfg.description;
  } else {
    _setIfEmpty("mcp-label", cfg.label);
    _setIfEmpty("mcp-desc",  cfg.description);
  }

  if (cfg.transport === "stdio") {
    document.getElementById("mcp-command").value = cfg.command || "";
    document.getElementById("mcp-args").value    = (cfg.args || []).join(" ");
    document.getElementById("mcp-env").value     =
      Object.entries(cfg.env || {}).map(([k, v]) => `${k}=${v}`).join(", ");
    updateMcpCmdPreview();
  } else {
    document.getElementById("mcp-url").value     = cfg.url || "";
    document.getElementById("mcp-headers").value =
      Object.entries(cfg.headers || {}).map(([k, v]) => `${k}:${v}`).join(", ");
  }
}

/* ── smart parse ──────────────────────────────────────────────── */

async function parseMcpConfig() {
  const text     = (document.getElementById("mcp-smart-input")?.value || "").trim();
  const statusEl = document.getElementById("mcp-smart-status");
  const warnEl   = document.getElementById("mcp-smart-warnings");
  const hintEl   = document.getElementById("mcp-smart-llm-hint");
  const btn      = document.getElementById("mcp-smart-btn");

  if (!text) {
    statusEl.textContent = "请先粘贴配置内容";
    statusEl.style.color = "#ef4444";
    return;
  }

  // reset UI
  statusEl.textContent = "解析中…";
  statusEl.style.color = "#64748b";
  warnEl.style.display = "none";
  hintEl.style.display = "none";
  btn.disabled = true;

  try {
    const res  = await fetch("/api/mcp/parse", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ text }),
    });
    const data = await res.json();

    if (!res.ok) {
      statusEl.textContent = data.error || "解析失败";
      statusEl.style.color = "#ef4444";
      // If LLM not configured, show hint
      if (res.status === 503) {
        hintEl.textContent = "💡 请先在「模型设置」中配置 LLM，再使用智能填充功能";
        hintEl.style.display = "";
      }
      return;
    }

    _applyMcpConfig(data.config, { overwriteLabel: false });

    // Show warnings if any
    if (data.warnings && data.warnings.length) {
      warnEl.innerHTML = "⚠️ 注意：<br>" +
        data.warnings.map(w => `• ${_esc(w)}`).join("<br>");
      warnEl.style.display = "";
    }

    statusEl.textContent = "✓ 已填充，请检查并补全标红的必填项";
    statusEl.style.color = "#10b981";

    // Scroll form into view so user sees the filled fields
    document.getElementById("mcp-label")?.scrollIntoView({ behavior: "smooth", block: "nearest" });

  } catch (e) {
    statusEl.textContent = "请求失败: " + e.message;
    statusEl.style.color = "#ef4444";
  } finally {
    btn.disabled = false;
  }
}

function _setIfEmpty(id, value) {
  const el = document.getElementById(id);
  if (el && !el.value.trim()) el.value = value || "";
}
