// Main bootstrap + global event delegation.
// Replaces all HTML inline on* handlers. Modules under /static/js/modules/ register
// their public API on window.BAA.* and (where needed) on window.* for back-compat.
(function () {
  const { $ } = window.BAA.dom;
  const state = window.BAA.state;

  // ── Action registry (data-action="name[:arg]") ─────────────────────
  // Resolved at click time so modules registered after app.js still work.
  const ACTIONS = {
    // Slash / chat
    onSendOrStop: ()    => window.BAA.chatStream.onSendOrStop(),
    clearCmd:     ()    => window.BAA.slash.clearCmd(),
    fillHint:     (el)  => window.BAA.slash.fillHint(el),
    newChat:      ()    => window.BAA.chatStream.newChat(),

    // Overlay
    openOverlay:  (_el, id) => window.openOverlay(id),
    closeOverlay: (_el, id) => window.BAA.overlay.closeOverlay(id),

    // Sidebar / header
    disconnectSrc:     () => window.BAA.datasource.disconnectSrc(),
    openSchemaView:    () => window.BAA.preview.openSchemaView(),
    openSaveDialog:    () => window.BAA.sessions.openSaveDialog(),
    loadSavedList:     () => window.BAA.sessions.loadSavedList(),
    openMcpSettings:   () => window.openMcpSettings(),
    loadMcpServers:    () => window.loadMcpServers(),
    toggleLang:        () => window.setLang(window.getLang() === 'zh' ? 'en' : 'zh'),
    toggleTheme:       () => window.BAA.theme.toggleTheme(),

    // Data source modals
    uploadXl:          () => window.BAA.datasource.uploadXl(),
    connectDB:         () => window.BAA.datasource.connectDB(),
    connectGSheets:    () => window.BAA.datasource.connectGSheets(),
    connectAPI:        () => window.BAA.datasource.connectAPI(),

    // Settings — model providers
    toggleAddCustom:   () => window.BAA.models.toggleAddCustom(),
    addCustomModel:    () => window.BAA.models.addCustomModel(),
    saveBuiltin:       (_el, key) => window.BAA.models.saveBuiltin(key),
    clearBuiltin:      (_el, key) => window.BAA.models.clearBuiltin(key),
    editCustom:        (_el, key) => window.BAA.models.editCustomModel(key),
    deleteCustom:      (_el, key) => window.BAA.models.deleteCustom(key),
    toggleThinkBudget: (_el, key) => window.BAA.models.toggleThinkBudget(key),
    testProvider:      (_el, key) => window.BAA.models.testModel(key),
    toggleAcBudget:    ()         => {
      const cb  = $("ac-think");
      const row = $("ac-budget-row");
      if (cb && row) row.style.display = cb.checked ? "flex" : "none";
    },

    // Saved sessions
    saveSession:   () => window.BAA.sessions.saveSession(),
    loadSession:   (el) => window.BAA.sessions.loadSavedSession(el.dataset.filename, el.dataset.name),
    deleteSession: (el) => window.BAA.sessions.deleteSavedSession(el.dataset.filename, el.dataset.name),

    // Update modal
    runUpdate:   () => window.BAA.update.runUpdate(),

    // MCP server form
    toggleMcpAddForm: () => window.toggleMcpAddForm(),
    addMcpServer:     () => window.addMcpServer(),

    // Knowledge base
    kbOpenForm:      (_el, type) => window.kbOpenForm(type),
    kbRefresh:       (_el, type) => window.kbRefresh(type),
    kbSwitchTab:     (el, tab)   => window.kbSwitchTab(tab, el),
    kbLoadFiles:     () => window.kbLoadFiles(),
    kbCancelImport:  () => window.kbCancelImport(),
    kbConfirmImport: () => window.kbConfirmImport(),
    kbSubmitForm:    () => window.kbSubmitForm(),
    kbPickFile:      () => $("kb-file-input").click(),

    // Data-source modal sub-controls
    toggleApiAuthValue: () => window.BAA.datasource.toggleApiAuthValue(),

    // Sidebar — open the user-facing Instruction.md doc in a modal,
    // rendered with marked + DOMPurify (same pipeline as chat messages).
    openInstruction: async () => {
      const body = $("instruction-body");
      window.openOverlay("ov-instruction");
      // Fetch on every open so doc edits show up without a page reload.
      try {
        const r = await fetch("/api/instruction");
        const d = await r.json();
        if (d.ok && d.markdown) {
          body.innerHTML = window.renderMd(d.markdown);
        } else {
          body.innerHTML = `<div class="instruction-loading">${
            window.BAA.dom.esc(d.error || "Instruction.md not found")
          }</div>`;
        }
      } catch (e) {
        body.innerHTML = `<div class="instruction-loading">${
          window.BAA.dom.esc(String(e))
        }</div>`;
      }
    },

    // Sidebar — "Add data source" dropdown
    toggleAddSrc: () => {
      const dd  = $("sb-add-src");
      if (!dd) return;
      const btn = dd.querySelector(".sb-btn-primary");
      const open = dd.classList.toggle("open");
      if (btn) btn.setAttribute("aria-expanded", String(open));
    },

    // Sidebar — datasource row click. Behaviour depends on connection state:
    //   connected    → open data preview modal
    //   disconnected → open the "Add data source" dropdown
    openDataSource: () => {
      if (window.BAA.state.srcConnected) window.BAA.preview.openSchemaView();
      else {
        const dd = $("sb-add-src");
        if (dd && !dd.classList.contains("open")) {
          dd.classList.add("open");
          const btn = dd.querySelector(".sb-btn-primary");
          if (btn) btn.setAttribute("aria-expanded", "true");
        }
      }
    },
  };

  // "Add data source" dropdown — close on outside click, Esc, or menu-item pick.
  function _closeAddSrcDropdown() {
    const dd = $("sb-add-src");
    if (!dd) return;
    dd.classList.remove("open");
    const btn = dd.querySelector(".sb-btn-primary");
    if (btn) btn.setAttribute("aria-expanded", "false");
  }
  document.addEventListener("click", e => {
    const dd = $("sb-add-src");
    if (!dd || !dd.classList.contains("open")) return;
    // Click on a menu item — close the menu after letting the action fire.
    if (e.target.closest(".sb-dropdown-item")) {
      setTimeout(_closeAddSrcDropdown, 0);
      return;
    }
    // Click anywhere outside the dropdown — close.
    if (!dd.contains(e.target)) _closeAddSrcDropdown();
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") _closeAddSrcDropdown();
  });

  // Click delegation
  document.addEventListener("click", e => {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    const [name, ...args] = el.dataset.action.split(":");
    const fn = ACTIONS[name];
    if (!fn) { console.warn("[BAA] unknown action:", name); return; }
    fn(el, ...args);
  });

  // Change delegation (selects / checkboxes / file inputs)
  document.addEventListener("change", e => {
    const el = e.target.closest("[data-change]");
    if (!el) return;
    const [name, ...args] = el.dataset.change.split(":");
    const fn = ACTIONS[name];
    if (!fn) { console.warn("[BAA] unknown change action:", name); return; }
    fn(el, ...args);
  });

  // Overlay backdrop click → close
  document.addEventListener("click", e => {
    const ov = e.target.closest(".overlay");
    if (!ov || e.target !== ov) return;
    window.BAA.overlay.closeOutside(e, ov.id);
  }, true);

  // Drag & drop on knowledge base import zone
  const dropZone = document.getElementById("kb-drop-zone");
  if (dropZone) {
    dropZone.addEventListener("dragover", e => e.preventDefault());
    dropZone.addEventListener("drop",     e => window.kbOnDrop && window.kbOnDrop(e));
  }
  const kbFileInput = document.getElementById("kb-file-input");
  if (kbFileInput) {
    kbFileInput.addEventListener("change", e => window.kbOnFileSelect && window.kbOnFileSelect(e));
  }

  // Textarea — slash popup driver
  const msgInput = document.getElementById("msg-input");
  if (msgInput) {
    msgInput.addEventListener("input",   e => window.BAA.slash.onInput(e));
    msgInput.addEventListener("keydown", e => window.BAA.slash.onKeyDown(e));
  }

  // Model select change
  const modelSel = document.getElementById("model-sel");
  if (modelSel) {
    modelSel.addEventListener("change", () => window.BAA.models.onModelChange());
  }

  // Excel file picker change
  const xlFile = document.getElementById("xl-file");
  if (xlFile) {
    xlFile.addEventListener("change", () => window.BAA.datasource.onXlFile());
  }

  // API auth-type select change
  const apiAuthType = document.getElementById("api-auth-type");
  if (apiAuthType) {
    apiAuthType.addEventListener("change", () => window.BAA.datasource.toggleApiAuthValue());
  }

  // MCP transport radios
  document.querySelectorAll('input[name="mcp-transport"]').forEach(r => {
    r.addEventListener("change", () => window.onMcpTransportChange && window.onMcpTransportChange());
  });

  // Language change — re-sync dynamic UI state.
  document.addEventListener('langchange', () => {
    if (!state.srcConnected) {
      $('src-name').textContent = t('sidebar.disconnected');
      $('src-hint').textContent = t('sidebar.hint.noconn');
      $('hdr-sub').textContent  = t('header.subtitle');
    } else {
      $('src-hint').textContent = t(state.srcHintKey);
      $('hdr-sub').textContent  = t('connected_to', { name: state.srcName });
    }
    const sel = $('model-sel');
    if (sel && sel.options.length > 0 && sel.options[0].value === '') {
      sel.options[0].textContent = t('sidebar.model_placeholder');
    }
    const sendBtn = $('send-btn');
    if (sendBtn && !sendBtn.classList.contains('stopping')) sendBtn.title = t('send.title');
    const input = $('msg-input');
    if (input) input.placeholder = t('input.placeholder');
    const savedEmpty = document.querySelector('#saved-list .saved-empty');
    if (savedEmpty) savedEmpty.textContent = t('saved_empty');
    if (window.BAA.slash.isSlashOpen()) window.BAA.slash.buildSlashPopup();
  });

  // ── Bootstrap ─────────────────────────────────────────────────────
  (async () => {
    window.BAA.slash.buildSlashPopup();
    const r = await fetch("/api/session/new", { method: "POST" });
    state.SID = (await r.json()).session_id;
    sessionStorage.setItem("baa_session_id", state.SID);
    await window.BAA.models.loadModels();
    await window.BAA.models.loadBuiltinProviders();
    await window.BAA.sessions.loadSavedList();
    await window.BAA.datasource.loadDatasourceConfigs();
  })();
})();
