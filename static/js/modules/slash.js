// Slash command registry + popup logic + input handlers.
(function () {
  const { $ } = window.BAA.dom;
  const state = window.BAA.state;

  // descKey / groupKey reference i18n.js keys; t() is resolved at render time.
  const COMMANDS = [
    // Analysis & charts
    { cmd: "chart",      icon: "📊",  descKey: "cmd.chart.desc",      groupKey: "group.analysis", available: true },
    { cmd: "sql",        icon: "🗄️",  descKey: "cmd.sql.desc",        groupKey: "group.analysis", available: true },
    { cmd: "decile",     icon: "📉",  descKey: "cmd.decile.desc",     groupKey: "group.analysis", available: true },
    { cmd: "tree",       icon: "🌳",  descKey: "cmd.tree.desc",       groupKey: "group.analysis", available: true },
    { cmd: "kmeans",     icon: "🔵",  descKey: "cmd.kmeans.desc",     groupKey: "group.analysis", available: true },
    { cmd: "logistic",   icon: "📈",  descKey: "cmd.logistic.desc",   groupKey: "group.analysis", available: true },
    { cmd: "regression", icon: "📐",  descKey: "cmd.regression.desc", groupKey: "group.analysis", available: true },
    { cmd: "arima",      icon: "〰️",  descKey: "cmd.arima.desc",      groupKey: "group.analysis", available: true },
    { cmd: "sarima",     icon: "🌊",  descKey: "cmd.sarima.desc",     groupKey: "group.analysis", available: true },
    { cmd: "var",        icon: "🔗",  descKey: "cmd.var.desc",        groupKey: "group.analysis", available: true },
    { cmd: "prophet",    icon: "🔮",  descKey: "cmd.prophet.desc",    groupKey: "group.analysis", available: true },
    { cmd: "gru",        icon: "🧠",  descKey: "cmd.gru.desc",        groupKey: "group.analysis", available: true },
    // Data cleaning
    { cmd: "data",       icon: "🔍",  descKey: "cmd.data.desc",       groupKey: "group.clean",    available: true },
    { cmd: "inset",      icon: "🩹",  descKey: "cmd.inset.desc",      groupKey: "group.clean",    available: true },
    { cmd: "winsorize",  icon: "✂️",  descKey: "cmd.winsorize.desc",  groupKey: "group.clean",    available: true },
    { cmd: "trimming",   icon: "🔪",  descKey: "cmd.trimming.desc",   groupKey: "group.clean",    available: true },
    // Export
    { cmd: "export",     icon: "📥",  descKey: "cmd.export.desc",     groupKey: "group.export",   available: true },
    { cmd: "report",     icon: "📄",  descKey: "cmd.report.desc",     groupKey: "group.export",   available: true },
    { cmd: "ppt",        icon: "🎯",  descKey: "cmd.ppt.desc",        groupKey: "group.export",   available: true },
    { cmd: "dashboard",  icon: "📊",  descKey: "cmd.dashboard.desc",  groupKey: "group.export",   available: true },
    // Tools
    { cmd: "status",     icon: "📡",  descKey: "cmd.status.desc",     groupKey: "group.tools",    available: true },
  ];

  function _highlightMatch(text, term) {
    if (!term) return `/${text}`;
    const idx = text.indexOf(term);
    if (idx < 0) return `/${text}`;
    return `/${text.slice(0, idx)}<mark>${text.slice(idx, idx + term.length)}</mark>${text.slice(idx + term.length)}`;
  }

  function buildSlashPopup(filter = "") {
    const pop    = $("slash-popup");
    const scroll = $("slash-popup-scroll");
    scroll.querySelectorAll(".slash-item, .slash-group-label, .slash-empty").forEach(el => el.remove());

    const term    = filter.toLowerCase();
    const matched = COMMANDS.filter(c =>
      !term || c.cmd.includes(term) || t(c.descKey).toLowerCase().includes(term)
    );

    const header = pop.querySelector(".slash-pop-header");
    if (header) {
      header.textContent = term ? t('slash.searching', { term }) : t('slash.header');
    }

    if (matched.length === 0) {
      const empty = document.createElement("div");
      empty.className = "slash-empty";
      empty.textContent = t('slash.empty', { term });
      scroll.appendChild(empty);
      return;
    }

    let lastGroup = null;
    matched.forEach((c, i) => {
      if (c.groupKey && c.groupKey !== lastGroup) {
        const gl = document.createElement("div");
        gl.className = "slash-group-label";
        gl.textContent = t(c.groupKey);
        scroll.appendChild(gl);
        lastGroup = c.groupKey;
      }
      const div = document.createElement("div");
      div.className = "slash-item" + (c.available ? "" : " disabled") + (i === 0 ? " active" : "");
      div.dataset.cmd = c.cmd;
      div.innerHTML = `
        <span class="slash-icon">${c.icon}</span>
        <div class="slash-info">
          <div class="slash-name">${_highlightMatch(c.cmd, term)}
            ${!c.available ? `<span class="slash-soon">${t('slash.soon')}</span>` : ""}
          </div>
          <div class="slash-desc">${t(c.descKey)}</div>
        </div>`;
      if (c.available) div.addEventListener("click", () => selectCommand(c.cmd));
      scroll.appendChild(div);
    });
  }

  function openSlashPopup(filter = "") {
    buildSlashPopup(filter);
    state.slashPopupIndex = 0;
    updateSlashActive();
    $("slash-popup").classList.add("open");
  }
  function closeSlashPopup() { $("slash-popup").classList.remove("open"); }
  function isSlashOpen()     { return $("slash-popup").classList.contains("open"); }

  function updateSlashActive() {
    const scroll = $("slash-popup-scroll");
    if (!scroll) return;
    const items = [...scroll.querySelectorAll(".slash-item:not(.disabled)")];
    scroll.querySelectorAll(".slash-item").forEach(el => el.classList.remove("active"));
    if (items[state.slashPopupIndex]) {
      items[state.slashPopupIndex].classList.add("active");
      items[state.slashPopupIndex].scrollIntoView({ block: "nearest" });
    }
  }

  function selectCommand(cmd) {
    state.activeCommand = cmd;
    const c = COMMANDS.find(x => x.cmd === cmd);
    const badge = $("cmd-badge");
    $("cmd-badge-text").textContent = `${c.icon} /${cmd}`;
    badge.classList.add("show");
    const input = $("msg-input");
    input.value = input.value.replace(/^\/\S*\s*/, "");
    closeSlashPopup();
    input.focus();
  }

  function clearCmd() {
    state.activeCommand = "";
    $("cmd-badge").classList.remove("show");
  }

  function autoResize(el) {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 140) + "px";
  }

  function onInput(e) {
    autoResize(e.target);
    const v = e.target.value;

    if (v === "/stop" && state.isStreaming) {
      e.target.value = "";
      autoResize(e.target);
      window.BAA.chatStream.stopStreaming();
      return;
    }

    // "/cmd " (no args) — select command, clear input
    const mFull = v.match(/^\/(\w+)\s$/);
    if (mFull) {
      const found = COMMANDS.find(c => c.cmd === mFull[1] && c.available);
      if (found) {
        selectCommand(found.cmd);
        e.target.value = "";
        autoResize(e.target);
        return;
      }
    }

    // "/cmd args..." — select command, keep args as input text
    const mFullCmd = v.match(/^\/(\w+)\s+(.+)/);
    if (mFullCmd) {
      const found = COMMANDS.find(c => c.cmd === mFullCmd[1] && c.available);
      if (found) {
        selectCommand(found.cmd);
        e.target.value = mFullCmd[2];
        autoResize(e.target);
        return;
      }
    }

    const mSlash = v.match(/^\/([\w]*)$/);
    if (mSlash) {
      const term = mSlash[1];
      if (isSlashOpen()) {
        buildSlashPopup(term);
        state.slashPopupIndex = 0;
        updateSlashActive();
      } else {
        openSlashPopup(term);
      }
      return;
    }

    if (isSlashOpen()) closeSlashPopup();
  }

  function onKeyDown(e) {
    if (isSlashOpen()) {
      const sc = $("slash-popup-scroll");
      const available = sc ? [...sc.querySelectorAll(".slash-item:not(.disabled)")] : [];
      if (e.key === "ArrowDown") {
        e.preventDefault();
        state.slashPopupIndex = Math.min(state.slashPopupIndex + 1, available.length - 1);
        updateSlashActive(); return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        state.slashPopupIndex = Math.max(state.slashPopupIndex - 1, 0);
        updateSlashActive(); return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const item = available[state.slashPopupIndex];
        if (item) selectCommand(item.dataset.cmd);
        return;
      }
      if (e.key === "Escape") { closeSlashPopup(); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      window.BAA.chatStream.sendMessage();
    }
  }

  // Click outside the input area closes the slash popup.
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".input-area")) closeSlashPopup();
  });

  function fillHint(el) {
    const txt = el.textContent;
    const m = txt.match(/^\/(\w+)\s?(.*)/);
    if (m) {
      const found = COMMANDS.find(c => c.cmd === m[1] && c.available);
      if (found) {
        selectCommand(found.cmd);
        $("msg-input").value = m[2];
        return;
      }
    }
    $("msg-input").value = txt;
    window.BAA.chatStream.sendMessage();
  }

  window.BAA.slash = {
    COMMANDS, buildSlashPopup, openSlashPopup, closeSlashPopup, isSlashOpen,
    selectCommand, clearCmd, onInput, onKeyDown, autoResize, fillHint,
  };

  // Backward-compat globals used by HTML data-actions / language change handler.
  window.clearCmd  = clearCmd;
  window.fillHint  = fillHint;
})();
