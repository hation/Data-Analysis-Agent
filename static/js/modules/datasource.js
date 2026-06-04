// Data source: Excel/CSV upload, SQL DB, Google Sheets, Custom REST API + multi-source management.
(function () {
  const { $ } = window.BAA.dom;
  const { closeOverlay, toast } = window.BAA.overlay;
  const state = window.BAA.state;

  // ── Type icon map ──────────────────────────────────────────────────────────
  const TYPE_ICON = {
    excel: "📊", csv: "📄", sql: "🗄️", gsheets: "📋", http: "🔗",
  };
  const TYPE_LABEL = {
    excel: "Excel", csv: "CSV", sql: "SQL", gsheets: "Sheets", http: "API",
  };

  // ── Render the source list in the sidebar ─────────────────────────────────
  function renderSourceList(sources) {
    state.sources = sources || [];
    const wrap = $("source-list-wrap");
    const ul   = $("source-list");
    if (!wrap || !ul) return;

    if (!sources || sources.length === 0) {
      wrap.hidden = true;
      ul.innerHTML = "";
      return;
    }

    wrap.hidden = false;
    ul.innerHTML = sources.map(src => {
      const icon  = TYPE_ICON[src.type] || "📁";
      const label = TYPE_LABEL[src.type] || src.type;
      const activeClass = src.active ? " source-item--active" : "";
      const toggleTitle = src.active ? "点击取消激活" : "点击激活此数据源";
      return `
        <li class="source-item${activeClass}" data-source-id="${src.id}">
          <button class="source-item-toggle" data-sid="${src.id}" title="${toggleTitle}" aria-pressed="${src.active}">
            <span class="source-toggle-track">
              <span class="source-toggle-thumb"></span>
            </span>
          </button>
          <span class="source-item-icon">${icon}</span>
          <span class="source-item-info">
            <span class="source-item-name" title="${src.name}">${src.name}</span>
            <span class="source-item-type">${label}${src.active ? " · 已激活" : " · 未激活"}</span>
          </span>
          <button class="source-item-btn source-item-btn--remove" data-sid="${src.id}" title="移除此数据源">✕</button>
        </li>`;
    }).join("");

    // Toggle active state
    ul.querySelectorAll(".source-item-toggle").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleSource(btn.dataset.sid);
      });
    });
    // Remove
    ul.querySelectorAll(".source-item-btn--remove").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        removeSource(btn.dataset.sid);
      });
    });
  }

  // ── Update sidebar status row ──────────────────────────────────────────────
  function setSrc(name, hintKey, connected) {
    state.srcConnected = connected;
    state.srcName      = connected ? (name || "") : "";
    state.srcHintKey   = connected ? hintKey : 'sidebar.hint.noconn';

    if (window.BAA.preview) window.BAA.preview.invalidate();

    const dot = $("src-dot");
    if (dot) dot.classList.toggle("on", connected);

    // Status text: show active count
    const total = state.sources.length;
    const activeCount = state.sources.filter(s => s.active).length;
    let displayName = name || "";
    if (total > 1) {
      displayName = activeCount > 0
        ? `${activeCount}/${total} 个数据源已激活`
        : `${total} 个数据源（均未激活）`;
    }
    $("src-name").textContent = connected ? displayName : t('sidebar.disconnected');

    const hint = $("src-hint");
    if (hint) hint.textContent = t(hintKey);

    const disc = $("btn-disc");
    if (disc) {
      disc.hidden = !connected;
      const sep = $("sb-disc-sep");
      if (sep) sep.hidden = !connected;
    }

    $("btn-schema").style.display = connected ? "" : "none";
    $("hdr-sub").textContent = connected
      ? t('connected_to', { name: displayName })
      : t('header.subtitle');

    document.querySelector(".sidebar")?.classList.toggle("has-source", connected);
    if (connected) window.BAA.dom.hideWelcome();
  }

  // ── After any connect/add operation ───────────────────────────────────────
  function onSourcesUpdated(sources, newSourceName, hintKey) {
    renderSourceList(sources);
    const active = sources.find(s => s.active);
    const displayName = active ? active.name : (newSourceName || "");
    setSrc(displayName, hintKey || 'src.hint.file', sources.length > 0);
  }

  // ── Toggle a source active/inactive ───────────────────────────────────────
  async function toggleSource(sourceId) {
    const r = await fetch(`/api/session/${state.SID}/sources/${sourceId}/toggle`, { method: "POST" });
    const d = await r.json();
    if (d.error) { toast(d.error, "err"); return; }
    state.schemaText = "";
    onSourcesUpdated(d.sources, null, 'src.hint.file');
    const msg = d.active
      ? (t('toast.source_activated') || "已激活数据源")
      : (t('toast.source_deactivated') || "已取消激活");
    toast(msg, "ok");
  }

  // ── Remove one source ──────────────────────────────────────────────────────
  async function removeSource(sourceId) {
    const r = await fetch(`/api/session/${state.SID}/sources/${sourceId}`, { method: "DELETE" });
    const d = await r.json();
    if (d.error) { toast(d.error, "err"); return; }
    state.schemaText = "";
    if (d.sources.length === 0) {
      setSrc(null, 'sidebar.hint.noconn', false);
      renderSourceList([]);
      toast(t('toast.disconnected'));
    } else {
      onSourcesUpdated(d.sources, null, 'src.hint.file');
      toast(t('toast.source_removed') || "已移除数据源");
    }
  }

  // ── Disconnect ALL sources ─────────────────────────────────────────────────
  async function disconnectSrc() {
    await fetch(`/api/session/${state.SID}/datasource`, { method: "DELETE" });
    state.schemaText = "";
    state.sources = [];
    setSrc(null, 'sidebar.hint.noconn', false);
    renderSourceList([]);
    toast(t('toast.disconnected'));
  }

  // ── Load saved datasource configs (autofill forms) ────────────────────────
  function _showDsStatus(elId, name) {
    const el = $(elId);
    if (el) { el.textContent = t('ds.configured', { name }); el.style.display = ""; }
  }

  async function loadDatasourceConfigs() {
    let cfgs;
    try {
      const r = await fetch("/api/datasource-configs");
      cfgs = await r.json();
    } catch { return; }

    const sql = cfgs.sql || {};
    if (sql.has_connection_string) {
      $("db-conn").placeholder        = t('ds.conn_saved_ph');
      $("db-conn").dataset.hasSaved   = "1";
      if (sql.name) $("db-name").value = sql.name;
      _showDsStatus("db-status", sql.name || "SQL DB");
    }

    const gs = cfgs.gsheets || {};
    if (gs.has_creds_json) {
      $("gsheets-creds").placeholder      = t('ds.conn_saved_ph');
      $("gsheets-creds").dataset.hasSaved = "1";
      if (gs.spreadsheet) $("gsheets-sheet").value = gs.spreadsheet;
      if (gs.name)         $("gsheets-name").value = gs.name;
      _showDsStatus("gsheets-status", gs.name || "Google Sheets");
    }

    const api = cfgs.api || {};
    if (api.url) {
      $("api-url").value = api.url;
      if (api.auth_type) $("api-auth-type").value = api.auth_type;
      if (api.auth_type && api.auth_type !== "none") {
        $("api-auth-row").style.display = "";
      }
      if (api.has_auth_value) {
        $("api-auth-value").placeholder      = t('ds.conn_saved_ph');
        $("api-auth-value").dataset.hasSaved = "1";
      }
      if (api.name) $("api-name").value = api.name;
      _showDsStatus("api-status", api.name || api.url);
    }
  }

  // ── File upload (multi-file) ───────────────────────────────────────────────
  function onXlFile() {
    const files = $("xl-file").files;
    $("xl-btn").disabled        = files.length === 0;
    $("xl-err").textContent     = "";
    $("xl-schema").style.display = "none";
    // Show selected file names
    const label = $("xl-file-label");
    if (label) {
      label.textContent = files.length === 0 ? ""
        : files.length === 1 ? files[0].name
        : `${files.length} 个文件`;
    }
  }

  async function uploadXl() {
    const files = $("xl-file").files;
    if (!files || files.length === 0) return;

    const btn           = $("xl-btn");
    const cancelBtn     = $("xl-cancel-btn");
    const progressWrap  = $("xl-progress");
    const progressBar   = $("xl-progress-bar");
    const progressLabel = $("xl-progress-label");
    const errEl         = $("xl-err");

    btn.disabled       = true;
    cancelBtn.disabled = true;
    errEl.textContent  = "";
    progressWrap.style.display = "";
    progressBar.style.width    = "0%";

    const form = new FormData();
    for (const f of files) form.append("file", f);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/session/${state.SID}/upload`);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = Math.round(e.loaded / e.total * 100);
        progressBar.style.width = pct + "%";
        progressBar.classList.remove("indeterminate");
        progressLabel.textContent = `${t('btn.uploading')} ${pct}%`;
      } else {
        progressBar.classList.add("indeterminate");
      }
    };

    xhr.upload.onloadend = () => {
      progressWrap.style.display = "none";
      progressBar.classList.remove("indeterminate");
      $("xl-parsing").style.display = "";
    };

    const d = await new Promise((resolve, reject) => {
      xhr.onload  = () => { try { resolve(JSON.parse(xhr.responseText)); } catch { reject(new Error("服务器响应异常")); } };
      xhr.onerror = () => reject(new Error("网络错误"));
      xhr.send(form);
    }).catch(err => ({ error: err.message }));

    progressWrap.style.display = "none";
    progressBar.classList.remove("indeterminate");
    $("xl-parsing").style.display = "none";
    btn.disabled       = false;
    cancelBtn.disabled = false;

    if (d.error) { errEl.textContent = d.error; return; }

    // Show partial errors if any
    if (d.errors && d.errors.length) {
      errEl.textContent = "部分文件失败: " + d.errors.join("; ");
    }

    // Update schema display (first added file)
    if (d.added && d.added.length > 0) {
      state.schemaText = d.added[0].schema_preview || "";
      $("xl-schema").textContent  = state.schemaText;
      $("xl-schema").style.display = "block";
    }

    onSourcesUpdated(d.sources || [], d.source_name, 'src.hint.file');
    closeOverlay("ov-excel");

    const msg = d.added && d.added.length > 1
      ? `已上传 ${d.added.length} 个文件`
      : t('toast.upload_ok');
    toast(msg, "ok");
    window.sysMsg(t('sys.connected', { name: d.source_name }));
  }

  // ── SQL DB ─────────────────────────────────────────────────────────────────
  async function connectDB() {
    const conn = $("db-conn").value.trim();
    const name = $("db-name").value.trim();
    const hasSaved = $("db-conn").dataset.hasSaved === "1";
    if (!conn && !hasSaved) { $("db-err").textContent = t('conn_err'); return; }
    $("db-err").textContent = "";
    const loadingEl = $("db-loading");
    const btn       = $("db-btn");
    const cancelBtn = $("db-cancel-btn");
    loadingEl.style.display = "";
    btn.disabled       = true;
    cancelBtn.disabled = true;
    const r = await fetch(`/api/session/${state.SID}/connect-db`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connection_string: conn, name }),
    });
    const d = await r.json();
    loadingEl.style.display = "none";
    btn.disabled       = false;
    cancelBtn.disabled = false;
    if (d.error) { $("db-err").textContent = d.error; return; }
    state.schemaText = d.schema_preview || "";
    $("db-schema").textContent  = state.schemaText;
    $("db-schema").style.display = "block";
    onSourcesUpdated(d.sources || [], d.source_name, 'src.hint.db');
    closeOverlay("ov-db");
    toast(t('toast.db_ok'), "ok");
    window.sysMsg(t('sys.connected', { name: d.source_name }));
  }

  // ── Google Sheets ──────────────────────────────────────────────────────────
  async function connectGSheets() {
    const creds = $("gsheets-creds").value.trim();
    const sheet = $("gsheets-sheet").value.trim();
    const name  = $("gsheets-name").value.trim();
    const errEl = $("gsheets-err");
    const hasSavedCreds = $("gsheets-creds").dataset.hasSaved === "1";
    if (!creds && !hasSavedCreds) { errEl.textContent = t('gsheets_err.no_creds'); return; }
    if (!sheet)                   { errEl.textContent = t('gsheets_err.no_sheet'); return; }
    errEl.textContent = "";
    const loadingEl = $("gsheets-loading");
    const btn       = $("gsheets-btn");
    const cancelBtn = $("gsheets-cancel-btn");
    loadingEl.style.display = "";
    btn.disabled       = true;
    cancelBtn.disabled = true;
    const r = await fetch(`/api/session/${state.SID}/connect-gsheets`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ creds_json: creds, spreadsheet: sheet, name }),
    });
    const d = await r.json();
    loadingEl.style.display = "none";
    btn.disabled       = false;
    cancelBtn.disabled = false;
    if (d.error) { errEl.textContent = d.error; return; }
    state.schemaText = d.schema_preview || "";
    $("gsheets-schema").textContent  = state.schemaText;
    $("gsheets-schema").style.display = "block";
    onSourcesUpdated(d.sources || [], d.source_name, 'src.hint.gsheets');
    closeOverlay("ov-gsheets");
    toast(t('toast.gsheets_ok'), "ok");
    window.sysMsg(t('sys.connected', { name: d.source_name }));
  }

  // ── Custom API ─────────────────────────────────────────────────────────────
  function toggleApiAuthValue() {
    const type = $("api-auth-type").value;
    $("api-auth-row").style.display = type === "none" ? "none" : "";
  }

  async function connectAPI() {
    const url       = $("api-url").value.trim();
    const authType  = $("api-auth-type").value;
    const authValue = $("api-auth-value").value.trim();
    const name      = $("api-name").value.trim();
    const errEl     = $("api-err");
    if (!url) { errEl.textContent = t('api_err.no_url'); return; }
    errEl.textContent = "";
    const loadingEl = $("api-loading");
    const btn       = $("api-btn");
    const cancelBtn = $("api-cancel-btn");
    loadingEl.style.display = "";
    btn.disabled       = true;
    cancelBtn.disabled = true;
    const r = await fetch(`/api/session/${state.SID}/connect-api`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, auth_type: authType, auth_value: authValue, name }),
    });
    const d = await r.json();
    loadingEl.style.display = "none";
    btn.disabled       = false;
    cancelBtn.disabled = false;
    if (d.error) { errEl.textContent = d.error; return; }
    state.schemaText = d.schema_preview || "";
    $("api-schema").textContent  = state.schemaText;
    $("api-schema").style.display = "block";
    onSourcesUpdated(d.sources || [], d.source_name, 'src.hint.api');
    closeOverlay("ov-api");
    toast(t('toast.api_ok'), "ok");
    window.sysMsg(t('sys.connected', { name: d.source_name }));
  }

  window.BAA.datasource = {
    setSrc, renderSourceList, onSourcesUpdated,
    loadDatasourceConfigs, disconnectSrc,
    onXlFile, uploadXl, connectDB, connectGSheets, connectAPI, toggleApiAuthValue,
  };

  // Backward-compat (used by sessions.js and language change handler).
  window.setSrc = setSrc;
})();
