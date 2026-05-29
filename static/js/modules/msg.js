// Assistant / user / system message helpers + token bar + /status renderer.
(function () {
  const { $, esc, scrollBottom } = window.BAA.dom;
  const state = window.BAA.state;

  function appendMsg(role, text) {
    const msgs = $("messages");
    const div  = document.createElement("div");
    div.className = `msg ${role}`;
    const avatar = role === "user"
      ? "👤"
      : `<img class="assistant-avatar-img" src="/static/Images/icon.png" alt="AI">`;
    div.innerHTML = `
      <div class="msg-avatar">${avatar}</div>
      <div class="msg-body">
        <div class="tool-steps"></div>
        <div class="msg-bubble">${text !== null ? window.renderMd(text) : ""}</div>
      </div>`;
    msgs.appendChild(div);
    scrollBottom();
    return div;
  }

  function sysMsg(text) {
    const msgs = $("messages");
    const d = document.createElement("div");
    d.className = "sys-msg";
    d.style.cssText = "text-align:center;font-size:12px;color:#94a3b8;padding:3px 0;";
    d.textContent = text;
    msgs.appendChild(d);
  }

  function fmtK(n) { return n >= 1000 ? (n / 1000).toFixed(1) + "K" : String(n); }

  function updateTokenBar() {
    const wrap  = $("token-bar-wrap");
    const fill  = $("token-bar-fill");
    const label = $("token-bar-label");
    const { promptTokens, totalInput, totalOutput, contextWindow } = state.tokenState;

    if (!promptTokens && !totalInput) { wrap.classList.remove("visible"); return; }
    wrap.classList.add("visible");

    // Toggle warn/crit modifiers without touching the base class, so the same
    // function works for both the legacy .token-bar-fill and the new
    // .token-pill-fill (only the modifier classes need to flip).
    fill.classList.remove("warn", "crit");

    if (contextWindow) {
      const pct = Math.min(promptTokens / contextWindow * 100, 100);
      fill.style.width = pct + "%";
      if      (pct >= 85) fill.classList.add("crit");
      else if (pct >= 60) fill.classList.add("warn");
      label.textContent = t('ctx.bar', {
        used:  fmtK(promptTokens),
        total: fmtK(contextWindow),
        pct:   pct.toFixed(1),
      });
    } else {
      fill.style.width = "0%";
      label.textContent = t('token.bar', { input: fmtK(totalInput), output: fmtK(totalOutput) });
    }
  }

  function showStatus() {
    const provKey   = $("model-sel").value;
    const cfg       = state.modelConfigs[provKey] || {};
    const modelName = cfg.model || provKey || t('status.no_model');
    const ctx       = state.tokenState.contextWindow;
    const pct       = (ctx && state.tokenState.promptTokens)
      ? ` (${(state.tokenState.promptTokens / ctx * 100).toFixed(1)}%)`
      : "";

    const lines = [
      t('status.line.model', { v: modelName }),
      t('status.line.src',   { v: state.srcConnected ? state.srcName : t('sidebar.disconnected') }),
      ``,
      t('status.line.usage'),
      t('status.line.input',  { v: state.tokenState.totalInput.toLocaleString() }),
      t('status.line.output', { v: state.tokenState.totalOutput.toLocaleString() }),
      ctx
        ? t('status.line.ctx',      { used: state.tokenState.promptTokens.toLocaleString(), total: ctx.toLocaleString(), pct })
        : t('status.line.ctx_none', { used: state.tokenState.promptTokens.toLocaleString() }),
    ];

    const aEl = appendMsg("assistant", null);
    aEl.querySelector(".msg-bubble").innerHTML = window.renderMd(lines.join("\n"));
    scrollBottom();
  }

  window.BAA.msg = { appendMsg, sysMsg, updateTokenBar, showStatus, fmtK };

  // Backward-compat globals (used by chat_stream / sessions / status command).
  window.appendMsg      = appendMsg;
  window.sysMsg         = sysMsg;
  window.updateTokenBar = updateTokenBar;
})();
