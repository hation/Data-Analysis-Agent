// Data preview modal: metadata + lazy-loaded rows per table tab.
(function () {
  const { $, esc } = window.BAA.dom;
  const { openOverlay } = window.BAA.overlay;
  const state = window.BAA.state;

  function invalidate() {
    state._previewData  = null;
    state._previewCache = {};
    state._previewSid   = null;
  }

  function openSchemaView() {
    openOverlay("ov-schema");
    if (state._previewData && state._previewSid === state.SID && state._previewData.tables?.length) {
      _renderPreviewTabs(state._previewData.tables);
      const first = state._previewData.tables[0];
      if (state._previewCache[first.name]) {
        _renderPreviewTable(state._previewCache[first.name]);
      } else {
        _renderPreviewSkeleton(first);
        _loadAndRenderTable(first);
      }
      return;
    }
    _loadPreview();
  }

  function _renderPreviewTabs(tables) {
    const tabs  = $("preview-tabs");
    const title = $("preview-title");
    title.textContent = `${t('modal.preview.title')} · ${state._previewData.source_name}`;
    tabs.innerHTML = "";
    tables.forEach((tb, i) => {
      const tab = document.createElement("div");
      tab.className = "preview-tab" + (i === 0 ? " active" : "");
      const rowHint = tb.total_rows != null ? ` (${tb.total_rows.toLocaleString()} 行)` : "";
      tab.textContent = tb.name + rowHint;
      tab.addEventListener("click", () => _switchPreviewTab(i));
      tabs.appendChild(tab);
    });
  }

  async function _loadPreview() {
    const wrap = $("preview-table-wrap");
    const foot = $("preview-footer");
    wrap.innerHTML   = `<div class="preview-loading">${t('preview.loading')}</div>`;
    foot.textContent = "";
    invalidate();

    const r = await fetch(`/api/session/${state.SID}/preview`);
    if (!r.ok) {
      wrap.innerHTML = `<div class="preview-loading" style="color:#ef4444">${t('preview.fail')}</div>`;
      return;
    }
    state._previewData = await r.json();
    state._previewSid  = state.SID;

    const tables = state._previewData.tables || [];
    if (!tables.length) {
      wrap.innerHTML = `<div class="preview-loading">${t('preview.empty')}</div>`;
      return;
    }

    _renderPreviewTabs(tables);
    await _loadAndRenderTable(tables[0]);
  }

  async function _switchPreviewTab(idx) {
    document.querySelectorAll(".preview-tab").forEach((tb, i) =>
      tb.classList.toggle("active", i === idx));
    const tb = state._previewData.tables[idx];
    await _loadAndRenderTable(tb);
  }

  async function _loadAndRenderTable(tableMeta) {
    const wrap = $("preview-table-wrap");
    const name = tableMeta.name;
    if (state._previewCache[name]) { _renderPreviewTable(state._previewCache[name]); return; }

    _renderPreviewSkeleton(tableMeta);

    const r = await fetch(`/api/session/${state.SID}/preview-table?table=${encodeURIComponent(name)}`);
    if (!r.ok) {
      wrap.innerHTML = `<div class="preview-loading" style="color:#ef4444">${t('preview.fail')}</div>`;
      return;
    }
    const data = await r.json();
    state._previewCache[name] = data;
    _renderPreviewTable(data);
  }

  function _renderPreviewSkeleton(tableMeta) {
    const wrap = $("preview-table-wrap");
    const foot = $("preview-footer");
    const cols = tableMeta.columns || [];
    let html = '<table class="preview-table"><thead><tr>';
    html += '<th class="preview-rn">#</th>';
    html += cols.map(c => `<th title="${esc(c)}">${esc(c)}</th>`).join("");
    html += '</tr></thead><tbody>';
    html += `<tr><td colspan="${cols.length + 1}" style="text-align:center;padding:20px;color:#999">${t('preview.loading')}</td></tr>`;
    html += '</tbody></table>';
    wrap.innerHTML = html;
    foot.textContent = "";
  }

  function _renderPreviewTable(table) {
    const wrap = $("preview-table-wrap");
    const foot = $("preview-footer");
    const shown = (table.rows || []).length;
    const total = table.total_rows ?? shown;

    let html = '<table class="preview-table"><thead><tr>';
    html += '<th class="preview-rn">#</th>';
    html += (table.columns || []).map(c => `<th title="${esc(c)}">${esc(c)}</th>`).join("");
    html += "</tr></thead><tbody>";
    (table.rows || []).forEach((row, i) => {
      html += `<tr><td class="preview-rn">${i + 1}</td>`;
      html += row.map(cell => {
        const s = esc(String(cell));
        return `<td title="${s}">${s}</td>`;
      }).join("");
      html += "</tr>";
    });
    html += "</tbody></table>";
    wrap.innerHTML = html;

    foot.textContent = total > shown
      ? t('preview.rows_partial', { cols: (table.columns || []).length, total: total.toLocaleString(), shown })
      : t('preview.rows_all',     { cols: (table.columns || []).length, total: total.toLocaleString() });
  }

  window.BAA.preview = { invalidate, openSchemaView };
})();
