// Data preview modal: left sidebar tabs + resizable splitter + lazy table loading.
// Multi-source aware: tables grouped by source with sheet-count badge.
(function () {
  const { $, esc } = window.BAA.dom;
  const { openOverlay } = window.BAA.overlay;
  const state = window.BAA.state;

  // ── Cache invalidation ────────────────────────────────────────────────────
  function invalidate() {
    state._previewData  = null;
    state._previewCache = {};
    state._previewSid   = null;
  }

  // ── Drag-to-resize splitter ───────────────────────────────────────────────
  function _initResizeHandle() {
    const handle  = $("preview-resize-handle");
    const sidebar = $("preview-sidebar");
    if (!handle || !sidebar) return;

    let dragging = false, startX = 0, startW = 0;

    handle.addEventListener("mousedown", (e) => {
      dragging = true;
      startX = e.clientX;
      startW = sidebar.getBoundingClientRect().width;
      handle.classList.add("dragging");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const delta = e.clientX - startX;
      const newW  = Math.max(120, Math.min(420, startW + delta));
      sidebar.style.width = newW + "px";
    });

    document.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    });
  }

  // ── Open preview ──────────────────────────────────────────────────────────
  function openSchemaView() {
    openOverlay("ov-schema");
    _initResizeHandle();

    if (state._previewData && state._previewSid === state.SID && state._previewData.tables?.length) {
      _renderSidebar(state._previewData.tables);
      const first = state._previewData.tables[0];
      const cacheKey = _cacheKey(first);
      if (state._previewCache[cacheKey]) {
        _renderTable(state._previewCache[cacheKey]);
      } else {
        _renderSkeleton(first);
        _loadTable(first);
      }
      return;
    }
    _loadPreview();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function _cacheKey(tb) {
    return `${tb.source_id || ""}:${tb.name}`;
  }

  // ── Render left sidebar ───────────────────────────────────────────────────
  function _renderSidebar(tables) {
    const tabs  = $("preview-tabs");
    const title = $("preview-title");

    // Title in header — always show sheet count
    const sourceNames = [...new Set(tables.map(t => t.source_name).filter(Boolean))];
    const sourceName  = state._previewData.source_name || sourceNames[0] || "";
    title.textContent = sourceNames.length > 1
      ? `数据预览 · ${sourceNames.length} 个数据源 · 共 ${tables.length} 张表`
      : `数据预览 · ${sourceName} · 共 ${tables.length} 张表`;

    tabs.innerHTML = "";
    const multiSource = sourceNames.length > 1;
    let currentSource = null;
    let sourceCount   = 0;   // sheets in current source group
    let groupEl       = null;

    tables.forEach((tb, i) => {
      // New source group — close old, open new
      if (multiSource && tb.source_name !== currentSource) {
        // Backfill badge into previous group header
        if (groupEl && sourceCount > 0) {
          const badge = groupEl.querySelector(".preview-tab-group-badge");
          if (badge) badge.textContent = `${sourceCount} 张表`;
        }

        currentSource = tb.source_name;
        sourceCount   = 0;

        groupEl = document.createElement("div");
        groupEl.className = "preview-tab-group";
        groupEl.innerHTML = `
          <span>${esc(tb.source_name)}</span>
          <span class="preview-tab-group-badge">…</span>`;
        tabs.appendChild(groupEl);
      }

      sourceCount++;

      const tab = document.createElement("button");
      tab.className = "preview-tab" + (i === 0 ? " active" : "");
      tab.dataset.idx = i;
      const rowHint = tb.total_rows != null
        ? tb.total_rows.toLocaleString()
        : "";
      tab.innerHTML = `
        <span style="overflow:hidden;text-overflow:ellipsis;flex:1">${esc(tb.name)}</span>
        ${rowHint ? `<span class="preview-tab-rows">${rowHint}</span>` : ""}`;
      tab.title = tb.name + (rowHint ? ` (${rowHint} 行)` : "");
      tab.addEventListener("click", () => _switchTab(i, tab));
      tabs.appendChild(tab);
    });

    // Backfill last group badge
    if (groupEl && sourceCount > 0) {
      const badge = groupEl.querySelector(".preview-tab-group-badge");
      if (badge) badge.textContent = `${sourceCount} 张表`;
    }

    // (sheet count is already shown in the title for both single and multi-source)
  }

  // ── Load all previews ─────────────────────────────────────────────────────
  async function _loadPreview() {
    const wrap = $("preview-table-wrap");
    const foot = $("preview-footer");
    wrap.innerHTML = `<div class="preview-loading">加载中…</div>`;
    if (foot) foot.textContent = "";
    invalidate();

    const r = await fetch(`/api/session/${state.SID}/preview`);
    if (!r.ok) {
      wrap.innerHTML = `<div class="preview-loading" style="color:#ef4444">加载失败，请重试</div>`;
      return;
    }
    state._previewData = await r.json();
    state._previewSid  = state.SID;

    const tables = state._previewData.tables || [];
    if (!tables.length) {
      wrap.innerHTML = `<div class="preview-loading">暂无数据</div>`;
      return;
    }

    _renderSidebar(tables);
    await _loadTable(tables[0]);
  }

  // ── Switch tab ────────────────────────────────────────────────────────────
  function _switchTab(idx, clickedBtn) {
    $("preview-tabs").querySelectorAll(".preview-tab")
      .forEach(b => b.classList.toggle("active", b === clickedBtn));
    _loadTable(state._previewData.tables[idx]);
  }

  // ── Load one table ────────────────────────────────────────────────────────
  async function _loadTable(tableMeta) {
    const wrap = $("preview-table-wrap");
    const key  = _cacheKey(tableMeta);
    if (state._previewCache[key]) { _renderTable(state._previewCache[key]); return; }

    _renderSkeleton(tableMeta);

    const params = new URLSearchParams({ table: tableMeta.name });
    if (tableMeta.source_id) params.set("source_id", tableMeta.source_id);

    const r = await fetch(`/api/session/${state.SID}/preview-table?${params}`);
    if (!r.ok) {
      wrap.innerHTML = `<div class="preview-loading" style="color:#ef4444">加载失败</div>`;
      return;
    }
    const data = await r.json();
    state._previewCache[key] = data;
    _renderTable(data);
  }

  // ── Skeleton (while loading) ──────────────────────────────────────────────
  function _renderSkeleton(tableMeta) {
    const wrap = $("preview-table-wrap");
    const foot = $("preview-footer");
    const cols = tableMeta.columns || [];
    let html = '<table class="preview-table"><thead><tr>';
    html += '<th class="preview-rn">#</th>';
    html += cols.map(c => `<th title="${esc(c)}">${esc(c)}</th>`).join("");
    html += `</tr></thead><tbody><tr>
      <td colspan="${cols.length + 1}" style="text-align:center;padding:24px;color:#999">
        加载中…
      </td></tr></tbody></table>`;
    wrap.innerHTML = html;
    if (foot) foot.textContent = "";
  }

  // ── Render data table ─────────────────────────────────────────────────────
  function _renderTable(table) {
    const wrap  = $("preview-table-wrap");
    const foot  = $("preview-footer");
    const shown = (table.rows || []).length;
    const total = table.total_rows ?? shown;

    let html = '<table class="preview-table"><thead><tr>';
    html += '<th class="preview-rn">#</th>';
    html += (table.columns || []).map(c => `<th title="${esc(c)}">${esc(c)}</th>`).join("");
    html += "</tr></thead><tbody>";
    (table.rows || []).forEach((row, i) => {
      html += `<tr><td class="preview-rn">${i + 1}</td>`;
      html += row.map(cell => {
        const s = esc(String(cell ?? ""));
        return `<td title="${s}">${s}</td>`;
      }).join("");
      html += "</tr>";
    });
    html += "</tbody></table>";
    wrap.innerHTML = html;

    if (foot) {
      const cols = (table.columns || []).length;
      foot.textContent = total > shown
        ? `${cols} 列 · 显示 ${shown} / ${total.toLocaleString()} 行`
        : `${cols} 列 · ${total.toLocaleString()} 行`;
    }
  }

  window.BAA.preview = { invalidate, openSchemaView };
})();
