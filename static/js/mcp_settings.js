/* MCP Settings UI — loaded after modules/overlay.js (depends on window.openOverlay / closeOverlay / toast) */

const MCP_STATUS_ICON = {
  connected:    "🟢",
  connecting:   "🟡",
  disconnected: "⚪",
  error:        "🔴",
};

let _mcpFormOpen = false;
let _mcpEditId   = null; // server_id currently being edited (null = add mode)

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
  } else {
    stdioEl.style.display = "none";
    sseEl.style.display = "flex";
    sseEl.style.flexDirection = "column";
    sseEl.style.gap = "8px";
  }
}

/* ── list ─────────────────────────────────────────────────────── */

async function loadMcpServers() {
  const listEl = document.getElementById("mcp-server-list");
  listEl.innerHTML = '<div style="font-size:12px;color:#64748b;padding:4px 0">加载中…</div>';
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
    return `
    <div class="custom-model-item" style="display:flex;align-items:flex-start;gap:8px;padding:8px 10px">
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
        <button class="btn-sm btn-sm-ghost" style="padding:2px 8px;font-size:11px"
          onclick='openMcpEditForm(${serverJson})'>编辑</button>
        ${s.status !== "connected" && s.status !== "connecting"
          ? `<button class="btn-sm btn-sm-ghost" style="padding:2px 8px;font-size:11px" onclick="connectMcpServer('${_esc(s.server_id)}')">连接</button>`
          : ""}
        <button class="btn-sm" style="padding:2px 8px;font-size:11px;background:#fee2e2;color:#dc2626;border:none;border-radius:5px;cursor:pointer"
          onclick="removeMcpServer('${_esc(s.server_id)}')">删除</button>
      </div>
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
}
