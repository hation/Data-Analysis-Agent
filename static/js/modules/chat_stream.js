// Chat send / stop + SSE stream + handleEvent (object-table dispatch).
(function () {
  const { $, esc, scrollBottom, hideWelcome, showWelcome } = window.BAA.dom;
  const state = window.BAA.state;
  const { appendMsg, sysMsg, updateTokenBar, showStatus } = window.BAA.msg;
  const { clearCmd } = window.BAA.slash;

  // ── Send / Stop ────────────────────────────────────────────────────
  function onSendOrStop() { state.isStreaming ? stopStreaming() : sendMessage(); }

  async function stopStreaming() {
    if (!state.isStreaming || !state.SID) return;
    try { await fetch(`/api/session/${state.SID}/stop`, { method: "POST" }); } catch (_) {}
    if (state._streamReader) {
      try { state._streamReader.cancel(); } catch (_) {}
    }
  }

  function _setSendBtnStopping(stopping) {
    // The button now contains an SVG arrow; the .stopping class swaps it for a
    // stop-square rendered via ::before (CSS only). No textContent mutation —
    // that would wipe out the SVG.
    const btn = $("send-btn");
    btn.classList.toggle("stopping", stopping);
    btn.title    = stopping ? (t('send.stop') || "停止 (Stop)") : t('send.title');
    btn.disabled = false;
  }

  async function sendMessage() {
    if (state.isStreaming) return;
    const input = $("msg-input");
    const text  = input.value.trim();
    if (!text && state.activeCommand !== "status") return;

    if (state.activeCommand === "status") {
      input.value = ""; input.style.height = "auto";
      hideWelcome(); clearCmd();
      appendMsg("user", "/status");
      showStatus();
      return;
    }

    input.value = ""; input.style.height = "auto";
    hideWelcome();

    const displayText = state.activeCommand ? `/${state.activeCommand} ${text}` : text;
    appendMsg("user", displayText);
    const aEl      = appendMsg("assistant", null);
    const stepsEl  = aEl.querySelector(".tool-steps");
    const bubbleEl = aEl.querySelector(".msg-bubble");

    const typing = document.createElement("div");
    typing.className = "typing-dots";
    typing.innerHTML = "<span></span><span></span><span></span>";
    bubbleEl.appendChild(typing);

    state.isStreaming = true;
    _setSendBtnStopping(true);

    const payload = { message: text };
    if (state.activeCommand) payload.command = state.activeCommand;
    clearCmd();

    await _streamChat(payload, stepsEl, bubbleEl, typing);
  }

  // Confirm / revise stream for ppt/excel/report/dashboard outline cards.
  async function sendConfirmStream(payload) {
    if (state.isStreaming) return;
    hideWelcome();

    appendMsg("user", payload.message || "确认");
    const aEl      = appendMsg("assistant", null);
    const stepsEl  = aEl.querySelector(".tool-steps");
    const bubbleEl = aEl.querySelector(".msg-bubble");

    const typing = document.createElement("div");
    typing.className = "typing-dots";
    typing.innerHTML = "<span></span><span></span><span></span>";
    bubbleEl.appendChild(typing);

    state.isStreaming = true;
    _setSendBtnStopping(true);

    await _streamChat(payload, stepsEl, bubbleEl, typing);
  }

  async function _streamChat(payload, stepsEl, bubbleEl, typing) {
    const resp = await fetch(`/api/session/${state.SID}/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const reader = resp.body.getReader();
    state._streamReader = reader;
    const dec = new TextDecoder();
    let buf = "";

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try { handleEvent(JSON.parse(line.slice(6)), stepsEl, bubbleEl, typing); }
          catch (_) {}
        }
      }
    } catch (_) {
      // reader.cancel() throws — expected when stopStreaming() is called.
    } finally {
      state._streamReader = null;
      state.isStreaming   = false;
      _setSendBtnStopping(false);
      scrollBottom();
    }
  }

  // ── Tool-step ticker helpers ───────────────────────────────────────
  function _finishStep(s) {
    if (s.classList.contains("tool-step-compaction")) {
      s.classList.add("done-compaction");
      const iconEl = s.querySelector(".compaction-spin");
      if (iconEl) { iconEl.classList.remove("compaction-spin"); iconEl.textContent = "✦"; }
    } else {
      s.classList.add("done");
      const spinEl = s.querySelector(".spin");
      if (spinEl) { spinEl.classList.remove("spin"); spinEl.textContent = "✓"; }
    }
  }
  function _tickFinishedSteps(stepsEl) {
    stepsEl.querySelectorAll('.tool-step[data-finished]:not(.done):not(.done-compaction)').forEach(_finishStep);
  }
  function _tickAllSteps(stepsEl) {
    stepsEl.querySelectorAll(".tool-step:not(.done):not(.done-compaction)").forEach(_finishStep);
  }

  // ── SSE event handlers (object-table dispatch) ─────────────────────
  function _onToolStart(ev, ctx) {
    _tickFinishedSteps(ctx.stepsEl);
    const s = document.createElement("div");
    const isCompaction = ev.tool === "compaction";
    s.className = isCompaction ? "tool-step tool-step-compaction" : "tool-step";
    const shortText = esc(ev.display);
    const fullText  = esc(ev.detail || ev.display);
    const hasMore   = !isCompaction && ev.detail && ev.detail !== ev.display;
    const icon      = isCompaction ? `<span class="compaction-spin">⟳</span>` : `<span class="spin">⟳</span>`;
    s.innerHTML = `${icon}<span class="tool-step-text">${shortText}</span>${hasMore ? '<span class="tool-step-toggle">⋯</span>' : ''}`;
    if (hasMore) {
      s.dataset.short = shortText;
      s.dataset.full  = fullText;
      s.addEventListener("click", () => {
        const expanded = s.classList.toggle("expanded");
        s.querySelector(".tool-step-text").innerHTML = expanded ? s.dataset.full : s.dataset.short;
        s.querySelector(".tool-step-toggle").textContent = expanded ? "▲" : "⋯";
      });
    }
    ctx.stepsEl.appendChild(s);
    scrollBottom();
  }

  function _onToolEnd(ev, ctx) {
    const step = ctx.stepsEl.querySelector(".tool-step:not(.done):not([data-finished])");
    if (!step) return;
    step.dataset.finished = "1";
    if (step.classList.contains("tool-step-compaction")) {
      step.classList.add("done-compaction");
      const iconEl = step.querySelector(".compaction-spin");
      if (iconEl) { iconEl.classList.remove("compaction-spin"); iconEl.textContent = "✦"; }
    }
  }

  function _buildChartFrame(chartId) {
    const wrap = document.createElement("div");
    wrap.className = "chart-frame";
    const expandBtn = document.createElement("button");
    expandBtn.className = "chart-expand-btn";
    expandBtn.title = "在新标签页打开";
    expandBtn.textContent = "⛶";
    expandBtn.addEventListener("click", () => window.open(`/api/chart/${chartId}`, "_blank"));
    const iframe = document.createElement("iframe");
    iframe.src = `/api/chart/${chartId}`;
    iframe.loading = "lazy";
    iframe.addEventListener("load", () => {
      try {
        const h = iframe.contentDocument.body.scrollHeight;
        if (h > 100) iframe.style.height = (h + 20) + "px";
      } catch (_) {}
    });
    wrap.appendChild(expandBtn);
    wrap.appendChild(iframe);
    return wrap;
  }

  function _onChartRef(ev, ctx) {
    // Insert chart inside the msg-body, just before the text bubble,
    // so it shares the same left-border / background visual context.
    const wrap = _buildChartFrame(ev.chart_id);
    ctx.bubbleEl.before(wrap);
    scrollBottom();
  }

  function _onTextDelta(ev, ctx) {
    if (ctx.typing.parentNode) ctx.typing.remove();
    ctx.bubbleEl.insertAdjacentText("beforeend", ev.content || "");
    scrollBottom();
  }

  function _onReasoning(ev, ctx) {
    if (ctx.typing.parentNode) ctx.typing.remove();
    const block = document.createElement("div");
    block.className = "reasoning-block";
    const toggle = document.createElement("div");
    toggle.className = "reasoning-toggle";
    toggle.innerHTML = `<span class="reasoning-arrow">▶</span> ${t('reasoning_toggle')}`;
    const body = document.createElement("div");
    body.className = "reasoning-body";
    body.textContent = ev.content || "";
    toggle.addEventListener("click", () => {
      toggle.classList.toggle("open");
      body.classList.toggle("open");
    });
    block.appendChild(toggle);
    block.appendChild(body);
    ctx.bubbleEl.before(block);
    scrollBottom();
  }

  function _onText(ev, ctx) {
    if (ctx.typing.parentNode) ctx.typing.remove();
    _tickAllSteps(ctx.stepsEl);
    const md = ev.content || "";
    ctx.bubbleEl.innerHTML = window.renderMd(md);
    // Attach hover-revealed action bar (copy) to the assistant message body.
    // The body persists across the bubble innerHTML rewrite, so we attach there.
    _ensureMsgActions(ctx.bubbleEl, md);
    scrollBottom();
  }

  // Build / refresh the "copy" action bar at the bottom of an assistant message body.
  function _ensureMsgActions(bubbleEl, markdownText) {
    const body = bubbleEl.parentNode;
    if (!body) return;
    let bar = body.querySelector(":scope > .msg-actions");
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "msg-actions";
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.textContent = t('msg.copy') || "复制";
      copyBtn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(bar._currentText || "");
          copyBtn.textContent = t('msg.copied') || "已复制 ✓";
          copyBtn.classList.add("copied");
          setTimeout(() => {
            copyBtn.textContent = t('msg.copy') || "复制";
            copyBtn.classList.remove("copied");
          }, 1400);
        } catch (_) { /* clipboard blocked — fail silently */ }
      });
      bar.appendChild(copyBtn);
      body.appendChild(bar);
    }
    bar._currentText = markdownText;
  }

  function _onUsage(ev) {
    state.tokenState.promptTokens  = ev.prompt_tokens || 0;
    state.tokenState.totalInput    = ev.session_total_input  || 0;
    state.tokenState.totalOutput   = ev.session_total_output || 0;
    state.tokenState.contextWindow = ev.context_window || state.tokenState.contextWindow;
    updateTokenBar();
  }

  function _onCtxEstimate(ev) {
    state.tokenState.promptTokens  = ev.prompt_tokens || 0;
    state.tokenState.contextWindow = ev.context_window || state.tokenState.contextWindow;
    updateTokenBar();
  }

  function _onError(ev, ctx) {
    if (ctx.typing.parentNode) ctx.typing.remove();
    ctx.bubbleEl.innerHTML = `<span style="color:#ef4444">⚠ ${esc(ev.message)}</span>`;
  }

  function _onStopped(ev, ctx) {
    if (ctx.typing.parentNode) ctx.typing.remove();
    _tickAllSteps(ctx.stepsEl);
    const stopNote = document.createElement("div");
    stopNote.className = "stop-note";
    stopNote.textContent = t('stop_note');
    ctx.bubbleEl.before(stopNote);
    if (!ctx.bubbleEl.textContent.trim()) ctx.bubbleEl.remove();
  }

  function _onOutline(ev, ctx) {
    if (ctx.typing.parentNode) ctx.typing.remove();
    _tickAllSteps(ctx.stepsEl);

    // Determine outline variant.
    let icon, confirmCmd, reviseCmd, confirmPayload, headerTitle;
    if (ev.type === "ppt_outline") {
      icon = "🎯"; confirmCmd = "ppt_confirm"; reviseCmd = "ppt_revise";
      headerTitle = esc(ev.title || "PPT 大纲");
      confirmPayload = { ppt_title: ev.title, ppt_slides: ev.slides };
    } else if (ev.type === "excel_outline") {
      icon = "📥"; confirmCmd = "excel_confirm"; reviseCmd = "excel_revise";
      headerTitle = esc(ev.filename || "Excel 导出");
      confirmPayload = { excel_tables: ev.tables, excel_filename: ev.filename };
    } else if (ev.type === "dashboard_outline") {
      icon = "📊"; confirmCmd = "dashboard_confirm"; reviseCmd = "dashboard_revise";
      headerTitle = esc(ev.name || "数据看板");
      confirmPayload = { dashboard_name: ev.name, dashboard_widgets: ev.widgets };
    } else { // report_outline
      icon = "📄"; confirmCmd = "report_confirm"; reviseCmd = "report_revise";
      headerTitle = esc(ev.title || "分析报告");
      confirmPayload = { report_title: ev.title, report_sections: ev.sections };
    }

    const card = document.createElement("div");
    card.className = "ppt-outline-card";
    card.innerHTML = `
      <div class="ppt-outline-header">
        <span class="ppt-outline-icon">${icon}</span>
        <span>${headerTitle}</span>
      </div>
      <div class="ppt-outline-content">${window.renderMd(ev.markdown || "")}</div>
      <div class="ppt-outline-edit-wrap" style="display:none">
        <div class="ppt-outline-edit-hint">请说明希望如何修改：</div>
        <textarea class="ppt-outline-edit" rows="3" placeholder="例如：把第3张换成双栏文字，增加一张市场份额环形图…"></textarea>
      </div>
      <div class="ppt-outline-btns">
        <button class="ppt-btn ppt-btn-confirm">✅ 确认生成</button>
        <button class="ppt-btn ppt-btn-revise">✏️ 修改大纲</button>
        <button class="ppt-btn ppt-btn-cancel">✕ 取消</button>
      </div>`;
    ctx.bubbleEl.appendChild(card);
    scrollBottom();

    const editWrap   = card.querySelector(".ppt-outline-edit-wrap");
    const btnConfirm = card.querySelector(".ppt-btn-confirm");
    const btnRevise  = card.querySelector(".ppt-btn-revise");
    const btnCancel  = card.querySelector(".ppt-btn-cancel");
    const editTA     = card.querySelector(".ppt-outline-edit");

    function _lockCard() {
      [btnConfirm, btnRevise, btnCancel].forEach(b => b.disabled = true);
      editTA.disabled = true;
    }

    btnConfirm.addEventListener("click", () => {
      _lockCard();
      sendConfirmStream({ command: confirmCmd, message: "确认", ...confirmPayload });
    });

    btnRevise.addEventListener("click", () => {
      const open = editWrap.style.display !== "none";
      editWrap.style.display = open ? "none" : "";
      if (!open) editTA.focus();
    });

    btnCancel.addEventListener("click", () => {
      _lockCard();
      card.querySelector(".ppt-outline-btns").remove();
      const note = document.createElement("div");
      note.className = "ppt-cancelled-note";
      note.textContent = "已取消。";
      card.appendChild(note);
    });

    editTA.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const txt = editTA.value.trim();
        if (!txt) return;
        _lockCard();
        let revisePayload = { command: reviseCmd, message: txt };
        if (reviseCmd === "ppt_revise" && confirmPayload.ppt_slides)
          revisePayload.message = `${txt}\n\n[CURRENT_SLIDES_JSON]\n${JSON.stringify(confirmPayload.ppt_slides)}`;
        else if (reviseCmd === "report_revise" && confirmPayload.report_sections)
          revisePayload.message = `${txt}\n\n[CURRENT_REPORT_JSON]\n${JSON.stringify({ title: confirmPayload.report_title, sections: confirmPayload.report_sections })}`;
        else if (reviseCmd === "dashboard_revise" && confirmPayload.dashboard_widgets)
          revisePayload.message = `${txt}\n\n[CURRENT_DASHBOARD_JSON]\n${JSON.stringify({ name: confirmPayload.dashboard_name, widgets: confirmPayload.dashboard_widgets })}`;
        sendConfirmStream(revisePayload);
      }
    });
  }

  const SSE_HANDLERS = {
    tool_start:         _onToolStart,
    tool_end:           _onToolEnd,
    chart_ref:          _onChartRef,
    text_delta:         _onTextDelta,
    reasoning:          _onReasoning,
    text:               _onText,
    usage:              _onUsage,
    context_estimate:   _onCtxEstimate,
    error:              _onError,
    stopped:            _onStopped,
    ppt_outline:        _onOutline,
    excel_outline:      _onOutline,
    report_outline:     _onOutline,
    dashboard_outline:  _onOutline,
  };

  function handleEvent(ev, stepsEl, bubbleEl, typing) {
    const fn = SSE_HANDLERS[ev.type];
    if (fn) fn(ev, { stepsEl, bubbleEl, typing });
  }

  // ── New chat ───────────────────────────────────────────────────────
  async function newChat() {
    try {
      const r = await fetch("/api/session/new", { method: "POST" });
      const data = await r.json();
      state.SID = data.session_id;
      sessionStorage.setItem("baa_session_id", state.SID);
    } catch (_) {
      // Front-end resets either way; backend will rebuild on next send.
    }

    // 新 session 创建后立即将前端当前选中的模型同步给后端，
    // 否则后端 session 会用默认模型（deepseek）响应第一条消息。
    const currentProvider = $("model-sel")?.value;
    if (currentProvider && state.SID) {
      fetch(`/api/session/${state.SID}/model`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: currentProvider }),
      }).catch(() => {});
    }

    state.activeCommand = "";
    document.querySelectorAll(".msg, .sys-msg").forEach(el => el.remove());
    state.tokenState = { promptTokens: 0, totalInput: 0, totalOutput: 0, contextWindow: null };
    updateTokenBar();
    showWelcome();
  }

  window.BAA.chatStream = {
    onSendOrStop, sendMessage, sendConfirmStream, stopStreaming,
    handleEvent, newChat, buildChartFrame: _buildChartFrame,
  };
})();
