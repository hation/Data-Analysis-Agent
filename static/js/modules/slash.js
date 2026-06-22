// Slash command registry + popup logic + input handlers.
(function () {
  const { $ } = window.BAA.dom;
  const state = window.BAA.state;

  // Backend /api/commands is the sole public command catalog.
  const COMMANDS = [];
  const GROUP_KEYS = {
    analysis: "group.analysis", clean: "group.clean",
    export: "group.export", tools: "group.tools", session: "group.tools",
    custom: "group.custom",
  };

  function getCommand(name) {
    const key = String(name || "").toLowerCase();
    return COMMANDS.find(c => c.cmd === key || (c.aliases || []).includes(key));
  }

  function _description(c) {
    return c.description || t(c.descKey);
  }

  function _escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, ch => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[ch]);
  }

  function _highlightMatch(text, term) {
    if (!term) return `/${_escapeHtml(text)}`;
    const idx = text.indexOf(term);
    if (idx < 0) return `/${_escapeHtml(text)}`;
    return `/${_escapeHtml(text.slice(0, idx))}<mark>${_escapeHtml(text.slice(idx, idx + term.length))}</mark>${_escapeHtml(text.slice(idx + term.length))}`;
  }

  function buildSlashPopup(filter = "") {
    const pop    = $("slash-popup");
    const scroll = $("slash-popup-scroll");
    scroll.querySelectorAll(".slash-item, .slash-group-label, .slash-empty").forEach(el => el.remove());

    const term    = filter.toLowerCase();
    const matched = COMMANDS.filter(c =>
      !term || c.cmd.includes(term) || (c.aliases || []).some(a => a.includes(term))
        || _description(c).toLowerCase().includes(term)
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
          <div class="slash-desc">${_escapeHtml(_description(c))}</div>
        </div>`;
      if (c.available) div.addEventListener("click", () => selectCommand(c.cmd));
      scroll.appendChild(div);
    });
  }

  function openSlashPopup(filter = "") {
    window.BAA.skills?.close?.();
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
    window.BAA.skills?.clearSkill?.();
    state.activeCommand = cmd;
    const c = getCommand(cmd) || { cmd, icon: "⌘" };
    cmd = c.cmd;
    state.activeCommand = cmd;
    const badge = $("cmd-badge");
    $("cmd-badge-text").textContent = `${c.icon} /${cmd}`;
    badge.classList.add("show");
    const input = $("msg-input");
    input.value = input.value.replace(/^\/\S*\s*/, "");
    closeSlashPopup();
    input.focus();
    if (window.BAA.chatStream?.syncSendButton) window.BAA.chatStream.syncSendButton();
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
    if (window.BAA.chatStream?.syncSendButton) window.BAA.chatStream.syncSendButton();

    if (v === "/stop" && state.isStreaming) {
      e.target.value = "";
      autoResize(e.target);
      window.BAA.chatStream.stopStreaming();
      return;
    }

    // "/cmd " (no args) — select command, clear input
    const mFull = v.match(/^\/([\w:-]+)\s$/);
    if (mFull) {
      const found = getCommand(mFull[1]);
      if (found) {
        selectCommand(found.cmd);
        e.target.value = "";
        autoResize(e.target);
        return;
      }
    }

    // "/cmd args..." — select command, keep args as input text
    const mFullCmd = v.match(/^\/([\w:-]+)\s+(.+)/);
    if (mFullCmd) {
      const found = getCommand(mFullCmd[1]);
      if (found) {
        selectCommand(found.cmd);
        e.target.value = mFullCmd[2];
        autoResize(e.target);
        return;
      }
    }

    const mSlash = v.match(/^\/([\w:-]*)$/);
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
    const m = txt.match(/^\/([\w:-]+)\s?(.*)/);
    if (m) {
      const found = getCommand(m[1]);
      if (found) {
        selectCommand(found.cmd);
        $("msg-input").value = m[2];
        return;
      }
    }
    $("msg-input").value = txt;
    window.BAA.chatStream.sendMessage();
  }

  async function loadCommands() {
    try {
      const suffix = state.SID ? `?sid=${encodeURIComponent(state.SID)}` : "";
      const response = await fetch(`/api/commands${suffix}`);
      if (!response.ok) return;
      const payload = await response.json();
      COMMANDS.splice(0, COMMANDS.length, ...(payload.commands || []).map(command => ({
        cmd: command.name,
        aliases: command.aliases || [],
        icon: command.icon || "⌘",
        description: command.description || command.name,
        groupKey: GROUP_KEYS[command.category] || "group.custom",
        available: command.available !== false,
        type: command.type,
        usage: command.usage || `/${command.name}`,
        argumentHint: command.argument_hint || "",
        clientAction: command.client_action || "",
      })));
      buildSlashPopup();
    } catch (err) {
      console.warn("[BAA] slash commands unavailable:", err);
    }
  }

  window.BAA.slash = {
    COMMANDS, buildSlashPopup, openSlashPopup, closeSlashPopup, isSlashOpen,
    selectCommand, clearCmd, getCommand, onInput, onKeyDown, autoResize, fillHint, loadCommands,
  };

  // Backward-compat globals used by HTML data-actions / language change handler.
  window.clearCmd  = clearCmd;
  window.fillHint  = fillHint;
})();
