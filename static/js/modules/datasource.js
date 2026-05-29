// Data source: Excel/CSV upload, SQL DB, Google Sheets, Custom REST API + disconnect.
(function () {
  const { $ } = window.BAA.dom;
  const { closeOverlay, toast } = window.BAA.overlay;
  const state = window.BAA.state;

  function setSrc(name, hintKey, connected) {
    state.srcConnected = connected;
    state.srcName      = connected ? (name || "") : "";
    state.srcHintKey   = connected ? hintKey : 'sidebar.hint.noconn';

    // Invalidate preview cache whenever data source changes.
    if (window.BAA.preview) window.BAA.preview.invalidate();

    // Status dot — toggle the modifier class (works for both old .source-dot
    // and new .sb-status-dot selectors thanks to the alias in layout.css).
    const dot = $("src-dot");
    if (dot) dot.classList.toggle("on", connected);
    $("src-name").textContent = connected ? name : t('sidebar.disconnected');
    const hint = $("src-hint");
    if (hint) hint.textContent = t(hintKey);

    // Disconnect button — lives inside the dropdown menu now.
    const disc = $("btn-disc");
    if (disc) {
      disc.hidden = !connected;
      const sep = $("sb-disc-sep");
      if (sep) sep.hidden = !connected;
    }

    $("btn-schema").style.display = connected ? "" : "none";
    $("hdr-sub").textContent      = connected ? t('connected_to', { name }) : t('header.subtitle');

    // Sidebar gets .has-source — used to dim the "Add data source" CTA pulse
    // when the user already connected something.
    document.querySelector(".sidebar")?.classList.toggle("has-source", connected);

    if (connected) window.BAA.dom.hideWelcome();
  }

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

  async function disconnectSrc() {
    await fetch(`/api/session/${state.SID}/datasource`, { method: "DELETE" });
    state.schemaText = "";
    setSrc(null, 'sidebar.hint.noconn', false);
    toast(t('toast.disconnected'));
  }

  function onXlFile() {
    const f = $("xl-file").files[0];
    $("xl-btn").disabled        = !f;
    $("xl-err").textContent     = "";
    $("xl-schema").style.display = "none";
  }

  async function uploadXl() {
    const f = $("xl-file").files[0];
    if (!f) return;
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
    form.append("file", f);

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
    state.schemaText = d.schema_preview || "";
    $("xl-schema").textContent  = state.schemaText;
    $("xl-schema").style.display = "block";
    setSrc(d.source_name, 'src.hint.file', true);
    closeOverlay("ov-excel");
    toast(t('toast.upload_ok'), "ok");
    window.sysMsg(t('sys.connected', { name: d.source_name }));
  }

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
    setSrc(d.source_name, 'src.hint.db', true);
    closeOverlay("ov-db");
    toast(t('toast.db_ok'), "ok");
    window.sysMsg(t('sys.connected', { name: d.source_name }));
  }

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
    setSrc(d.source_name, 'src.hint.gsheets', true);
    closeOverlay("ov-gsheets");
    toast(t('toast.gsheets_ok'), "ok");
    window.sysMsg(t('sys.connected', { name: d.source_name }));
  }

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
    setSrc(d.source_name, 'src.hint.api', true);
    closeOverlay("ov-api");
    toast(t('toast.api_ok'), "ok");
    window.sysMsg(t('sys.connected', { name: d.source_name }));
  }

  window.BAA.datasource = {
    setSrc, loadDatasourceConfigs, disconnectSrc,
    onXlFile, uploadXl, connectDB, connectGSheets, connectAPI, toggleApiAuthValue,
  };

  // Backward-compat (used by sessions.js and language change handler).
  window.setSrc = setSrc;
})();
