// Chat send / stop + SSE stream + handleEvent (object-table dispatch).
(function () {
  const { $, esc, scrollBottom, scrollReset, hideWelcome, showWelcome } = window.BAA.dom;
  const state = window.BAA.state;
  const { appendMsg, clearMessages, updateTokenBar, showStatus } = window.BAA.msg;
  const { clearCmd } = window.BAA.slash;
  const clearSkill = () => window.BAA.skills?.clearSkill?.();

  // ── Send / Stop ────────────────────────────────────────────────────
  function onSendOrStop() {
    const hasDraft = !!$("msg-input").value.trim() || !!state.activeCommand || !!state.activeSkill;
    if (state.isStreaming && !hasDraft) stopStreaming();
    else sendMessage();
  }

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

  function syncSendButton() {
    const hasDraft = !!$("msg-input").value.trim() || !!state.activeCommand || !!state.activeSkill;
    _setSendBtnStopping(state.isStreaming && !hasDraft);
    if (state.isStreaming && hasDraft) {
      $("send-btn").title = t("send.queue") || "加入等待队列";
    }
  }

  function _queueFacade(target, status, position, callbacks) {
    return !!(window.BAA.vueChat?.setTurnQueueState
      && window.BAA.vueChat.setTurnQueueState(target, status, position, callbacks));
  }

  function _refreshQueuePositions() {
    state.pendingMessages.forEach((item, index) => {
      _queueFacade(item.assistantId, "queued", index + 1, { onCancel: () => _cancelQueued(item.id) });
    });
    if (window.BAA.vueChat?.renderComposerQueue) {
      window.BAA.vueChat.renderComposerQueue(
        state.pendingMessages.map(item => ({ id: item.id, displayText: item.displayText })),
        { onSendNow: _sendQueuedNow, onEdit: _editQueued, onCancel: _cancelQueued },
      );
    }
  }

  function _cancelQueued(queueId) {
    const index = state.pendingMessages.findIndex(item => item.id === queueId);
    if (index < 0) return;
    const [item] = state.pendingMessages.splice(index, 1);
    if (state.editingQueuedId === queueId) state.editingQueuedId = "";
    if (window.BAA.vueChat?.removeMessages) {
      window.BAA.vueChat.removeMessages([item.userId, item.assistantId]);
    } else {
      _queueFacade(item.assistantId, "canceled", 0);
    }
    _refreshQueuePositions();
  }

  async function _sendQueuedNow(queueId) {
    const index = state.pendingMessages.findIndex(item => item.id === queueId);
    if (index < 0) return;
    const [item] = state.pendingMessages.splice(index, 1);
    state.pendingMessages.unshift(item);
    state.editingQueuedId = "";
    _refreshQueuePositions();
    if (state.isStreaming) await stopStreaming();
    else _drainMessageQueue();
  }

  function _editQueued(queueId) {
    const item = state.pendingMessages.find(candidate => candidate.id === queueId);
    const input = $("msg-input");
    if (!item || !input) return;
    state.editingQueuedId = queueId;
    clearCmd();
    clearSkill();
    input.value = item.payload.message;
    if (item.payload.command && window.BAA.slash?.selectCommand) {
      window.BAA.slash.selectCommand(item.payload.command);
    }
    if (item.payload.skill && window.BAA.skills?.selectSkill) {
      window.BAA.skills.selectSkill(item.payload.skill);
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  }

  function _appendTurnShell(displayText) {
    const user = appendMsg("user", displayText);
    const assistant = appendMsg("assistant", null);
    return {
      userId: user?.dataset?.vueMsgId || "",
      assistant,
      assistantId: assistant?.dataset?.vueMsgId || "",
    };
  }

  async function _startTurn(payload, assistant, assistantId = "") {
    if (!assistant && assistantId) {
      assistant = document.querySelector(`[data-vue-msg-id="${assistantId}"]`);
    }
    if (!assistant) return;
    _queueFacade(assistantId || assistant, "", 0);
    const stepsEl = assistant.querySelector(".tool-steps");
    const bubbleEl = assistant.querySelector(".msg-bubble");
    const typing = document.createElement("div");
    typing.className = "typing-dots";
    typing.innerHTML = "<span></span><span></span><span></span>";
    bubbleEl.appendChild(typing);
    state.isStreaming = true;
    syncSendButton();
    scrollReset();
    await _streamChat(payload, stepsEl, bubbleEl, typing);
  }

  function _enqueueTurn(payload, displayText) {
    const shell = _appendTurnShell(displayText);
    const item = {
      id: `queued-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      payload,
      displayText,
      userId: shell.userId,
      assistantId: shell.assistantId,
    };
    state.pendingMessages.push(item);
    _refreshQueuePositions();
    scrollBottom(true);
  }

  function _drainMessageQueue() {
    if (state.isStreaming || !state.pendingMessages.length) return;
    const item = state.pendingMessages.shift();
    // Reserve the single active-turn slot before yielding to the event loop;
    // otherwise a click in this small window could start a parallel request.
    state.isStreaming = true;
    syncSendButton();
    _refreshQueuePositions();
    _queueFacade(item.assistantId, "processing", 0);
    setTimeout(() => _startTurn(item.payload, null, item.assistantId), 0);
  }

  function _localReply(markdown) {
    appendMsg("assistant", markdown);
    scrollBottom(true);
  }

  async function _runLocalCommand(command, text) {
    const action = command.clientAction || command.cmd;
    const arg = String(text || "").trim();
    if (action === "clear") {
      if (state.isStreaming) await stopStreaming();
      const response = await fetch(`/api/session/${state.SID}/clear`, { method: "POST" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok === false) {
        _localReply(result.error || "清除当前对话失败。");
        return;
      }
      state.pendingMessages.length = 0;
      state.editingQueuedId = "";
      _refreshQueuePositions();
      clearCmd(); clearSkill(); clearMessages();
      state.tokenState = {
        promptTokens: 0, totalInput: 0, totalOutput: 0,
        contextWindow: state.tokenState.contextWindow,
      };
      updateTokenBar();
      showWelcome();
      return;
    }
    if (action === "status") { showStatus(); return; }
    if (action === "mcp") { window.openMcpSettings?.(); return; }
    if (action === "memory") { window.openOverlay?.("ov-knowledge"); return; }
    if (action === "permission") { window.BAA.workspace?.openModal?.(); return; }
    if (action === "plan") {
      if (window.tpOpenWithText) await window.tpOpenWithText(arg);
      else window.openOverlay?.("ov-temp-prompt");
      return;
    }
    if (action === "session") {
      if (arg.toLowerCase() === "new") { await newChat(); return; }
      await window.BAA.sessions?.loadSavedList?.();
      _localReply("已刷新左侧的已保存对话。使用 `/sessions new` 可开始新会话。");
      return;
    }
    if (action === "skill") {
      const parts = arg.split(/\s+/).filter(Boolean);
      await window.BAA.skills?.loadSkills?.();
      if (parts[0] === "info" && parts[1]) {
        const skill = window.BAA.skills.SKILLS.find(item => item.name === parts[1]);
        _localReply(skill
          ? `### ${skill.icon || "🧩"} ${skill.name}\n\n${skill.description}\n\n来源：${window.BAA.skills.sourceLabel(skill.source)}`
          : `未找到 Skill：${parts[1]}`);
      } else if (parts[0] === "reload") {
        _localReply(`Skill 已刷新，共 ${window.BAA.skills.SKILLS.length} 个。`);
      } else {
        await window.BAA.skills?.open?.();
      }
      return;
    }
    if (action === "help") {
      const requested = arg.replace(/^\//, "").toLowerCase();
      const commands = window.BAA.slash.COMMANDS;
      const selected = requested ? [window.BAA.slash.getCommand(requested)].filter(Boolean) : commands;
      _localReply(selected.length
        ? `### 可用命令\n\n${selected.map(item => `- \`${item.usage}\` — ${item.description}`).join("\n")}`
        : `未找到命令：/${requested}`);
      return;
    }
    if (action === "compact") {
      if (state.isStreaming) await stopStreaming();
      window.BAA.overlay?.toast?.("正在压缩当前对话上下文…", "info");
      const response = await fetch(`/api/session/${state.SID}/commands/compact`, { method: "POST" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok === false) {
        _localReply(result.error || "上下文压缩失败。");
        return;
      }
      state.tokenState.promptTokens = Number(result.after_tokens) || 0;
      updateTokenBar();
      _localReply(
        `上下文已压缩：约 ${Number(result.before_tokens || 0).toLocaleString()} → `
        + `${Number(result.after_tokens || 0).toLocaleString()} tokens；`
        + `历史消息 ${result.before_messages} → ${result.after_messages} 条。`
      );
      return;
    }
    if (action === "rewind") {
      await window.BAA.checkpoints?.open?.();
      return;
    }
    _localReply(`命令 /${command.cmd} 暂无可用的 Web 处理器。`);
  }

  async function sendMessage() {
    const input = $("msg-input");
    const text  = input.value.trim();
    const commandDef = state.activeCommand ? window.BAA.slash.getCommand(state.activeCommand) : null;
    if (!text && !commandDef) return;

    if (commandDef?.type === "local") {
      const display = `/${commandDef.cmd}${text ? ` ${text}` : ""}`;
      input.value = ""; input.style.height = "auto";
      hideWelcome(); clearCmd(); clearSkill();
      appendMsg("user", display);
      await _runLocalCommand(commandDef, text);
      syncSendButton();
      return;
    }

    input.value = ""; input.style.height = "auto";
    hideWelcome();

    const selectedCommand = state.activeCommand;
    const selectedSkill = state.activeSkill;
    const displayText = selectedCommand
      ? `/${selectedCommand} ${text}`
      : selectedSkill ? `[Skill: ${selectedSkill}] ${text}` : text;
    const payload = { message: text };
    if (selectedCommand) payload.command = selectedCommand;
    if (selectedSkill) payload.skill = selectedSkill;
    clearCmd();
    clearSkill();
    if (state.editingQueuedId) {
      const item = state.pendingMessages.find(candidate => candidate.id === state.editingQueuedId);
      state.editingQueuedId = "";
      if (item) {
        item.payload = payload;
        item.displayText = displayText;
        _refreshQueuePositions();
        window.BAA.vueChat?.setMessageText?.(item.userId, displayText);
        syncSendButton();
        return;
      }
    }
    if (state.isStreaming) {
      _enqueueTurn(payload, displayText);
      syncSendButton();
      return;
    }
    const shell = _appendTurnShell(displayText);
    await _startTurn(payload, shell.assistant, shell.assistantId);
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
    scrollReset();   // reset scroll state for confirm stream

    await _streamChat(payload, stepsEl, bubbleEl, typing);
  }

  async function _streamChat(payload, stepsEl, bubbleEl, typing) {
    if (state.analysisContext && !payload.data_context) {
      payload.data_context = state.analysisContext;
    }
    let reader = null;
    try {
      const resp = await fetch(`/api/session/${state.SID}/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        const failure = await resp.json().catch(() => ({}));
        throw new Error(failure.error || `Chat request failed (${resp.status})`);
      }
      if (!resp.body) throw new Error(`Chat request failed (${resp.status})`);
      reader = resp.body.getReader();
      state._streamReader = reader;
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try { await handleEvent(JSON.parse(line.slice(6)), stepsEl, bubbleEl, typing); }
          catch (_) {}
        }
      }
    } catch (error) {
      // reader.cancel() throws — expected when stopStreaming() is called.
      if (reader && state._streamReader === reader) {
        // A real HTTP failure should not wedge the FIFO; show it in the turn.
        const message = error?.message || String(error);
        if (message && !/cancel/i.test(message)) {
          await handleEvent({ type: "error", message }, stepsEl, bubbleEl, typing);
        }
      } else if (!reader) {
        await handleEvent({ type: "error", message: error?.message || String(error) }, stepsEl, bubbleEl, typing);
      }
    } finally {
      if (!(window.BAA.vueChat && window.BAA.vueChat.finishAllTools && window.BAA.vueChat.finishAllTools(stepsEl))) {
        _tickAllSteps(stepsEl);
      }
      if (window.BAA.vueChat && window.BAA.vueChat.hideToolActivity) {
        window.BAA.vueChat.hideToolActivity(stepsEl);
      }
      if (typing && typing.parentNode) typing.remove();
      state._streamReader = null;
      state.isStreaming   = false;
      syncSendButton();
      scrollBottom(true);   // force-scroll once stream ends regardless of user position
      // Trigger auto-save after every completed AI reply
      if (window.BAA.autosave) window.BAA.autosave.scheduleAutosave();
      _drainMessageQueue();
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

  function _showToolActivity(ctx) {
    return !!(window.BAA.vueChat
      && window.BAA.vueChat.showToolActivity
      && window.BAA.vueChat.showToolActivity(ctx.stepsEl));
  }

  function _hideToolActivity(ctx) {
    return !!(window.BAA.vueChat
      && window.BAA.vueChat.hideToolActivity
      && window.BAA.vueChat.hideToolActivity(ctx.stepsEl));
  }

  async function _cancelJob(jobId) {
    const resp = await fetch(`/api/session/${state.SID}/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST",
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || t("job.cancel_failed") || "Could not cancel job");
    return data;
  }

  function _onJobEvent(ev, ctx) {
    if (ctx.typing && ctx.typing.parentNode) ctx.typing.remove();
    if (window.BAA.vueChat && window.BAA.vueChat.updateJob) {
      window.BAA.vueChat.updateJob(ctx.stepsEl || ctx.bubbleEl, ev, { onCancel: _cancelJob });
    }
    if (window.BAA.jobHistory) window.BAA.jobHistory.applyLiveEvent(ev);
    scrollBottom();
  }

  const _onJobCreated = _onJobEvent;
  const _onJobStarted = _onJobEvent;
  const _onJobProgress = _onJobEvent;
  const _onArtifactCreated = _onJobEvent;
  const _onJobDone = _onJobEvent;
  const _onJobError = _onJobEvent;
  const _onJobCanceled = _onJobEvent;

  // ── SSE event handlers (object-table dispatch) ─────────────────────
  function _onToolStart(ev, ctx) {
    if (ctx.typing && ctx.typing.parentNode) ctx.typing.remove();
    if (window.BAA.vueChat && window.BAA.vueChat.startTool) {
      if (window.BAA.vueChat.startTool(ctx.stepsEl, ev)) {
        scrollBottom();
        return;
      }
    }
    _hideToolActivity(ctx);
    _tickFinishedSteps(ctx.stepsEl);
    const isCompaction = ev.tool === "compaction";
    const s = document.createElement(isCompaction ? "div" : "details");
    s.className = isCompaction ? "tool-step tool-step-compaction" : "tool-step";
    s.dataset.tool = ev.tool || "";
    if (!isCompaction) s.open = false;
    const shortText = esc(String(ev.display || ev.detail || "").replace(/\s+/g, " ").trim());
    const fullText  = esc(ev.detail || ev.display || "");
    const icon      = isCompaction ? `<span class="compaction-spin">⟳</span>` : `<span class="spin">⟳</span>`;
    s.innerHTML = isCompaction
      ? `${icon}<span class="tool-step-text">${fullText}</span>`
      : `<summary class="tool-step-head">${icon}<span class="tool-step-text">${shortText}</span></summary><div class="tool-step-detail">${fullText}</div>`;
    ctx.stepsEl.appendChild(s);
    scrollBottom();
  }

  function _onKnowledgeRefs(ev, ctx) {
    if (window.BAA.vueChat && window.BAA.vueChat.setKnowledgeRefs) {
      if (window.BAA.vueChat.setKnowledgeRefs(ctx.stepsEl, ev)) {
        _showToolActivity(ctx);
        scrollBottom();
        return;
      }
    }
    const refs = Array.isArray(ev.refs) ? ev.refs : [];
    const steps = [...ctx.stepsEl.querySelectorAll('.tool-step[data-tool="query_knowledge"]')];
    const step = steps[steps.length - 1];
    if (!step) return;

    const old = step.nextElementSibling;
    if (old && old.classList.contains("knowledge-refs")) old.remove();

    const panel = document.createElement("details");
    panel.className = "knowledge-refs";
    panel.open = false;

    const summary = document.createElement("summary");
    summary.textContent = refs.length
      ? `引用来源（${refs.length} 条）`
      : "引用来源（未命中）";
    panel.appendChild(summary);

    const list = document.createElement("div");
    list.className = "knowledge-ref-list";
    if (!refs.length) {
      const empty = document.createElement("div");
      empty.className = "knowledge-ref-empty";
      empty.textContent = "本次知识库检索没有命中可引用条目。";
      list.appendChild(empty);
    } else {
      refs.forEach(ref => {
        const item = document.createElement("div");
        item.className = "knowledge-ref-item";
        const score = ref.score !== "" && ref.score !== null && ref.score !== undefined
          ? `<span class="knowledge-ref-score">score ${esc(String(ref.score))}</span>`
          : "";
        item.innerHTML = `
          <div class="knowledge-ref-head">
            <span class="knowledge-ref-type">${esc(ref.type || "来源")}</span>
            <span class="knowledge-ref-title">${esc(ref.title || ref.source || "未命名来源")}</span>
            ${score}
          </div>
          ${ref.source ? `<div class="knowledge-ref-source">${esc(ref.source)}</div>` : ""}
          ${ref.snippet ? `<div class="knowledge-ref-snippet">${esc(ref.snippet)}</div>` : ""}`;
        list.appendChild(item);
      });
    }
    panel.appendChild(list);
    step.after(panel);
    scrollBottom();
  }

  function _attachPanelAfterStep(ctx, toolName, className, panel) {
    const steps = [...ctx.stepsEl.querySelectorAll(`.tool-step[data-tool="${toolName}"]`)];
    const step = steps[steps.length - 1];
    if (!step) return false;
    const old = step.parentElement.querySelector(`.${className}[data-for-step="${step.dataset.stepId || ""}"]`);
    if (old) old.remove();
    if (!step.dataset.stepId) step.dataset.stepId = `${toolName}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    panel.dataset.forStep = step.dataset.stepId;
    step.after(panel);
    scrollBottom();
    return true;
  }

  function _onDataRefs(ev, ctx) {
    if (window.BAA.vueChat && window.BAA.vueChat.setDataRefs) {
      if (window.BAA.vueChat.setDataRefs(ctx.stepsEl, ev)) {
        _showToolActivity(ctx);
        scrollBottom();
        return;
      }
    }
    const refs = Array.isArray(ev.refs) ? ev.refs : [];
    if (!refs.length) return;
    const panel = document.createElement("details");
    panel.className = "data-refs";
    panel.open = false;
    const summary = document.createElement("summary");
    summary.textContent = `数据依据（${refs.length} 条）`;
    panel.appendChild(summary);

    const list = document.createElement("div");
    list.className = "knowledge-ref-list";
    refs.forEach(ref => {
      const item = document.createElement("div");
      item.className = "knowledge-ref-item";
      const rows = ref.rows !== null && ref.rows !== undefined
        ? `<span class="knowledge-ref-score">${esc(String(ref.rows))} rows</span>`
        : "";
      item.innerHTML = `
        <div class="knowledge-ref-head">
          <span class="knowledge-ref-type">${esc(ref.type || "数据")}</span>
          <span class="knowledge-ref-title">${esc(ref.title || "SQL 查询")}</span>
          ${rows}
        </div>
        ${ref.source ? `<div class="knowledge-ref-source">${esc(ref.source)}</div>` : ""}
        ${ref.snippet ? `<div class="knowledge-ref-snippet">${esc(ref.snippet)}</div>` : ""}`;
      list.appendChild(item);
    });
    panel.appendChild(list);
    _attachPanelAfterStep(ctx, "query_data", "data-refs", panel)
      || _attachPanelAfterStep(ctx, "create_analysis_table", "data-refs", panel)
      || _attachPanelAfterStep(ctx, "run_analysis", "data-refs", panel)
      || _attachPanelAfterStep(ctx, "generate_chart", "data-refs", panel);
  }

  function _onToolAudit(ev, ctx) {
    if (window.BAA.vueChat && window.BAA.vueChat.setToolAudit) {
      if (window.BAA.vueChat.setToolAudit(ctx.stepsEl, ev)) {
        _showToolActivity(ctx);
        scrollBottom();
        return;
      }
    }
    const tool = ev.tool || "";
    if (!tool) return;
    const panel = document.createElement(ev.content || ev.summary ? "details" : "div");
    panel.className = ev.ok === false ? "tool-audit tool-audit-error" : "tool-audit";
    panel.dataset.tool = tool;
    if (panel.tagName === "DETAILS") panel.open = false;
    const elapsed = ev.elapsed_seconds !== undefined ? `${ev.elapsed_seconds}s` : "";
    const sourceCount = Array.isArray(ev.sources) ? ev.sources.length : 0;
    const artifactCount = Array.isArray(ev.artifacts) ? ev.artifacts.length : 0;
    const bits = [
      ev.parallel ? "并行" : "",
      elapsed && `耗时 ${esc(elapsed)}`,
      sourceCount ? `来源 ${sourceCount}` : "",
      artifactCount ? `产物 ${artifactCount}` : "",
      ev.error ? `错误 ${esc(ev.error)}` : "",
    ].filter(Boolean);
    const statusLine = document.createElement(panel.tagName === "DETAILS" ? "summary" : "span");
    statusLine.className = "tool-audit-status";
    statusLine.textContent = bits.length ? bits.join(" · ") : "工具执行完成";
    panel.appendChild(statusLine);
    const content = ev.content ?? ev.data ?? ev.summary;
    if (content) {
      panel.classList.add("tool-audit-has-summary");
      const body = document.createElement("div");
      body.className = "tool-audit-summary";
      body.textContent = String(content);
      panel.appendChild(body);
    }
    if (ev.args_preview) {
      try { panel.title = JSON.stringify(ev.args_preview, null, 2); } catch (_) {}
    }
    _attachPanelAfterStep(ctx, tool, "tool-audit", panel);
  }

  function _onToolEnd(ev, ctx) {
    if (window.BAA.vueChat && window.BAA.vueChat.endTool) {
      if (window.BAA.vueChat.endTool(ctx.stepsEl, ev)) {
        _showToolActivity(ctx);
        scrollBottom();
        return;
      }
    }
    const step = ctx.stepsEl.querySelector(".tool-step:not(.done):not([data-finished])");
    if (!step) return;
    step.dataset.finished = "1";
    if (step.classList.contains("tool-step-compaction")) {
      step.classList.add("done-compaction");
      const iconEl = step.querySelector(".compaction-spin");
      if (iconEl) { iconEl.classList.remove("compaction-spin"); iconEl.textContent = "✦"; }
    }
  }

  // IntersectionObserver: 统一管理所有图表 iframe 的懒加载。
  // 浏览器原生 loading="lazy" 的问题是：SSE 流结束时第二个图表可能尚未进入
  // 视口，浏览器永远不会发起请求，导致空白。改用 IO 可以精确控制触发时机，
  // 并在 iframe 加载完成后自动断开观察，避免内存泄漏。
  const _chartObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const iframe = entry.target;
      if (!iframe.src) {
        iframe.src = iframe.dataset.src;
      }
      _chartObserver.unobserve(iframe);
    });
  }, { rootMargin: "200px" }); // 提前 200px 预加载，消除滚动白屏

  function _syncChartFrameHeight(iframe) {
    try {
      const doc = iframe.contentDocument;
      if (!doc?.body) return;

      // Plotly.newPlot() may still be laying out when the iframe load event fires.
      // Keep the frame from collapsing to the title-only height, and repair old
      // saved charts whose graph div used height:100% without a definite parent.
      const plotly = iframe.contentWindow?.Plotly;
      doc.querySelectorAll(".plotly-graph-div").forEach(plot => {
        if (plot.getBoundingClientRect().height < 240) {
          plot.style.minHeight = "360px";
        }
        if (plotly?.Plots?.resize && plot.classList.contains("js-plotly-plot")) {
          plotly.Plots.resize(plot);
        }
      });

      const contentHeight = Math.max(
        doc.body.scrollHeight,
        doc.documentElement?.scrollHeight || 0,
      );
      iframe.style.height = Math.max(420, contentHeight + 20) + "px";
    } catch (_) {}
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
    // 不设置 src，先存入 data-src；由 IntersectionObserver 在进入视口时赋值。
    // 这样视口内的图表立即加载，视口外的在滚动到附近时才发请求，避免同时并发
    // 多个 iframe 请求阻塞浏览器连接池。
    iframe.dataset.src = `/api/chart/${chartId}`;
    iframe.addEventListener("load", () => {
      requestAnimationFrame(() => _syncChartFrameHeight(iframe));
      setTimeout(() => _syncChartFrameHeight(iframe), 250);
    });
    wrap.appendChild(expandBtn);
    wrap.appendChild(iframe);
    _chartObserver.observe(iframe);
    return wrap;
  }

  function _onChartRef(ev, ctx) {
    _hideToolActivity(ctx);
    if (window.BAA.vueChat && window.BAA.vueChat.addChartRef) {
      if (window.BAA.vueChat.addChartRef(ctx.bubbleEl, ev.chart_id)) {
        scrollBottom();
        return;
      }
    }
    // Insert chart inside the msg-body, just before the text bubble,
    // so it shares the same left-border / background visual context.
    const wrap = _buildChartFrame(ev.chart_id);
    ctx.bubbleEl.before(wrap);
    scrollBottom();
  }

  function _onTextDelta(ev, ctx) {
    _hideToolActivity(ctx);
    if (window.BAA.vueChat && window.BAA.vueChat.appendTextDelta) {
      if (window.BAA.vueChat.appendTextDelta(ctx.bubbleEl, ev.content, ctx.typing)) {
        scrollBottom();
        return;
      }
    }
    if (ctx.typing.parentNode) ctx.typing.remove();
    ctx.bubbleEl.insertAdjacentText("beforeend", ev.content || "");
    scrollBottom();
  }

  function _buildReasoningBlock(content) {
    const block = document.createElement("div");
    block.className = "reasoning-block";
    const toggle = document.createElement("div");
    toggle.className = "reasoning-toggle";
    toggle.innerHTML = `<span class="reasoning-arrow">▶</span> ${t('reasoning_toggle')}`;
    const body = document.createElement("div");
    body.className = "reasoning-body";
    body.textContent = content || "";
    toggle.addEventListener("click", () => {
      toggle.classList.toggle("open");
      body.classList.toggle("open");
    });
    block.appendChild(toggle);
    block.appendChild(body);
    return block;
  }

  function _onReasoning(ev, ctx) {
    if (window.BAA.vueChat && window.BAA.vueChat.addReasoning) {
      if (window.BAA.vueChat.addReasoning(ctx.bubbleEl, ev.content, ctx.typing)) {
        scrollBottom();
        return;
      }
    }
    if (ctx.typing.parentNode) ctx.typing.remove();
    const block = _buildReasoningBlock(ev.content);
    ctx.bubbleEl.before(block);
    _showToolActivity(ctx);
    scrollBottom();
  }

  function _onText(ev, ctx) {
    const md = ev.content || "";
    _hideToolActivity(ctx);
    if (!md.trim()) return;
    if (ctx.typing.parentNode) ctx.typing.remove();
    if (!(window.BAA.vueChat && window.BAA.vueChat.finishAllTools && window.BAA.vueChat.finishAllTools(ctx.stepsEl))) {
      _tickAllSteps(ctx.stepsEl);
    }
    const renderedByVue = window.BAA.vueChat && window.BAA.vueChat.setMarkdown
      ? window.BAA.vueChat.setMarkdown(ctx.bubbleEl, md, ctx.typing)
      : false;
    if (!renderedByVue) ctx.bubbleEl.innerHTML = window.renderMd(md);
    // Attach hover-revealed action bar (copy) to the assistant message body.
    // The body persists across the bubble innerHTML rewrite, so we attach there.
    _ensureMsgActions(ctx.bubbleEl, md);
    // 绑定气泡内图片：点击新标签打开原图、加载失败时标注
    if (window.BAA.msg && window.BAA.msg.bindBubbleImages) {
      window.BAA.msg.bindBubbleImages(ctx.bubbleEl);
    }
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
    _hideToolActivity(ctx);
    if (window.BAA.vueChat && window.BAA.vueChat.setError) {
      if (window.BAA.vueChat.setError(ctx.bubbleEl, ev.message, ctx.typing)) return;
    }
    if (ctx.typing.parentNode) ctx.typing.remove();
    ctx.bubbleEl.innerHTML = `<span style="color:#ef4444">⚠ ${esc(ev.message)}</span>`;
  }

  function _onStopped(ev, ctx) {
    _hideToolActivity(ctx);
    if (!(window.BAA.vueChat && window.BAA.vueChat.finishAllTools && window.BAA.vueChat.finishAllTools(ctx.stepsEl))) {
      _tickAllSteps(ctx.stepsEl);
    }
    if (window.BAA.vueChat && window.BAA.vueChat.markStopped) {
      if (window.BAA.vueChat.markStopped(ctx.bubbleEl, t('stop_note'), ctx.typing)) return;
    }
    if (ctx.typing.parentNode) ctx.typing.remove();
    const stopNote = document.createElement("div");
    stopNote.className = "stop-note";
    stopNote.textContent = t('stop_note');
    ctx.bubbleEl.before(stopNote);
    if (!ctx.bubbleEl.textContent.trim()) ctx.bubbleEl.remove();
  }

  function _outlineMeta(ev) {
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
    return { icon, confirmCmd, reviseCmd, confirmPayload, headerTitle };
  }

  function _onOutline(ev, ctx) {
    _hideToolActivity(ctx);
    if (ctx.typing.parentNode) ctx.typing.remove();
    if (!(window.BAA.vueChat && window.BAA.vueChat.finishAllTools && window.BAA.vueChat.finishAllTools(ctx.stepsEl))) {
      _tickAllSteps(ctx.stepsEl);
    }

    const meta = _outlineMeta(ev);

    if (window.BAA.vueChat && window.BAA.vueChat.addOutlineCard) {
      if (window.BAA.vueChat.addOutlineCard(ctx.bubbleEl, {
        icon: meta.icon,
        headerTitle: meta.headerTitle,
        markdown: ev.markdown || "",
      }, {
        onConfirm: () => sendConfirmStream({ internal_action: meta.confirmCmd, message: "确认", ...meta.confirmPayload }),
        onRevise: (editText) => {
          let message = String(editText || "");
          if (meta.reviseCmd === "ppt_revise" && meta.confirmPayload.ppt_slides)
            message = `${message}\n\n[CURRENT_SLIDES_JSON]\n${JSON.stringify(meta.confirmPayload.ppt_slides)}`;
          else if (meta.reviseCmd === "report_revise" && meta.confirmPayload.report_sections)
            message = `${message}\n\n[CURRENT_REPORT_JSON]\n${JSON.stringify({ title: meta.confirmPayload.report_title, sections: meta.confirmPayload.report_sections })}`;
          else if (meta.reviseCmd === "dashboard_revise" && meta.confirmPayload.dashboard_widgets)
            message = `${message}\n\n[CURRENT_DASHBOARD_JSON]\n${JSON.stringify({ name: meta.confirmPayload.dashboard_name, widgets: meta.confirmPayload.dashboard_widgets })}`;
          sendConfirmStream({ internal_action: meta.reviseCmd, message });
        },
        onCancel: () => {},
      })) {
        scrollBottom();
        return;
      }
    }

    _legacyOutlineBody(ev, ctx, meta);
  }

  function _legacyOutlineBody(ev, ctx, meta) {
    const { icon, confirmCmd, reviseCmd, confirmPayload, headerTitle } = meta;

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
      sendConfirmStream({ internal_action: confirmCmd, message: "确认", ...confirmPayload });
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
        let revisePayload = { internal_action: reviseCmd, message: txt };
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

  function _onAskUser(ev, ctx) {
    _hideToolActivity(ctx);
    if (ctx.typing.parentNode) ctx.typing.remove();
    if (!(window.BAA.vueChat && window.BAA.vueChat.finishAllTools && window.BAA.vueChat.finishAllTools(ctx.stepsEl))) {
      _tickAllSteps(ctx.stepsEl);
    }

    if (window.BAA.vueChat && window.BAA.vueChat.addAskUserCard) {
      if (window.BAA.vueChat.addAskUserCard(ctx.bubbleEl, ev, {
        onSubmit: (answer) => sendConfirmStream({ message: answer }),
      })) {
        scrollBottom();
        return;
      }
    }

    _legacyAskUserBody(ev, ctx);
  }

  function _legacyAskUserBody(ev, ctx) {
    const multiSelect = !!ev.multi_select;
    const options = Array.isArray(ev.options) ? ev.options : [];

    const card = document.createElement("div");
    card.className = "ask-user-card";

    const qEl = document.createElement("div");
    qEl.className = "ask-user-question";
    qEl.textContent = ev.question || "";
    card.appendChild(qEl);

    const chipsEl = document.createElement("div");
    chipsEl.className = "ask-user-chips";
    card.appendChild(chipsEl);

    const selected = new Set();

    function _renderChips() {
      chipsEl.innerHTML = "";
      [...options, "__other__"].forEach(opt => {
        const chip = document.createElement("button");
        chip.className = "ask-user-chip";
        chip.type = "button";
        if (opt === "__other__") {
          chip.textContent = t('ask_user.other') || "其他…";
          chip.dataset.other = "1";
        } else {
          chip.textContent = opt;
          chip.dataset.value = opt;
        }
        if (selected.has(opt)) chip.classList.add("selected");
        chip.addEventListener("click", () => {
          if (locked) return;
          if (chip.dataset.other) {
            otherWrap.style.display = otherWrap.style.display === "none" ? "" : "none";
            if (otherWrap.style.display !== "none") otherInput.focus();
            return;
          }
          if (multiSelect) {
            if (selected.has(opt)) selected.delete(opt);
            else selected.add(opt);
            chip.classList.toggle("selected", selected.has(opt));
          } else {
            _submit(opt);
          }
        });
        chipsEl.appendChild(chip);
      });
    }

    const otherWrap = document.createElement("div");
    otherWrap.className = "ask-user-other-wrap";
    otherWrap.style.display = "none";
    const otherInput = document.createElement("input");
    otherInput.type = "text";
    otherInput.className = "ask-user-other-input";
    otherInput.placeholder = t('ask_user.other_placeholder') || "请输入您的回答…";
    const otherBtn = document.createElement("button");
    otherBtn.type = "button";
    otherBtn.className = "ask-user-other-btn";
    otherBtn.textContent = t('ask_user.submit') || "提交";
    otherWrap.appendChild(otherInput);
    otherWrap.appendChild(otherBtn);
    card.appendChild(otherWrap);

    let submitBtn = null;
    if (multiSelect) {
      submitBtn = document.createElement("button");
      submitBtn.type = "button";
      submitBtn.className = "ask-user-submit-btn";
      submitBtn.textContent = t('ask_user.confirm') || "确认选择";
      card.appendChild(submitBtn);
    }

    ctx.bubbleEl.appendChild(card);
    scrollBottom();

    let locked = false;
    function _lock() {
      locked = true;
      card.querySelectorAll("button, input").forEach(el => { el.disabled = true; });
    }

    function _submit(answer) {
      _lock();
      sendConfirmStream({ message: answer });
    }

    otherBtn.addEventListener("click", () => {
      if (locked) return;
      const val = otherInput.value.trim();
      if (val) _submit(val);
    });
    otherInput.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); otherBtn.click(); }
    });

    if (submitBtn) {
      submitBtn.addEventListener("click", () => {
        if (locked) return;
        const vals = [...selected];
        const otherVal = otherWrap.style.display !== "none" ? otherInput.value.trim() : "";
        if (otherVal) vals.push(otherVal);
        if (!vals.length) return;
        _submit(vals.join("、"));
      });
    }

    _renderChips();
  }

  const SSE_HANDLERS = {
    tool_start:         _onToolStart,
    tool_end:           _onToolEnd,
    knowledge_refs:     _onKnowledgeRefs,
    data_refs:          _onDataRefs,
    tool_audit:         _onToolAudit,
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
    ask_user:           _onAskUser,
    job_created:        _onJobCreated,
    job_started:        _onJobStarted,
    job_progress:       _onJobProgress,
    artifact_created:   _onArtifactCreated,
    job_done:           _onJobDone,
    job_error:          _onJobError,
    job_canceled:       _onJobCanceled,
  };

  const PAINT_BREAK_EVENTS = new Set(["tool_start", "tool_end", "knowledge_refs", "data_refs", "tool_audit", "job_created", "job_started", "artifact_created", "job_done", "job_error", "job_canceled"]);
  const STREAM_PAINT_EVENTS = new Set(["text_delta", "job_progress"]);
  let lastStreamPaintAt = 0;

  function _nextPaint() {
    return new Promise(resolve => {
      if (window.requestAnimationFrame) {
        requestAnimationFrame(() => setTimeout(resolve, 0));
      } else {
        setTimeout(resolve, 0);
      }
    });
  }

  async function handleEvent(ev, stepsEl, bubbleEl, typing) {
    const fn = SSE_HANDLERS[ev.type];
    if (fn) fn(ev, { stepsEl, bubbleEl, typing });
    if (PAINT_BREAK_EVENTS.has(ev.type)) await _nextPaint();
    else if (STREAM_PAINT_EVENTS.has(ev.type) && Date.now() - lastStreamPaintAt > 50) {
      lastStreamPaintAt = Date.now();
      await _nextPaint();
    }
  }

  // ── New chat ───────────────────────────────────────────────────────
  async function newChat() {
    state.pendingMessages.length = 0;
    state.editingQueuedId = "";
    _refreshQueuePositions();
    try {
      const r = await fetch("/api/session/new", { method: "POST" });
      const data = await r.json();
      state.SID = data.session_id;
      localStorage.setItem("baa_session_id", state.SID);
    sessionStorage.setItem("baa_session_id", state.SID);
    if (window.BAA.jobHistory) await window.BAA.jobHistory.switchSession(state.SID);
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

    clearCmd();
    clearSkill();
    await Promise.all([
      window.BAA.slash?.loadCommands?.(),
      window.BAA.skills?.loadSkills?.(),
    ]);
    if (window.BAA.datasource) window.BAA.datasource.resetSourceState();
    if (window.BAA.autosave) window.BAA.autosave.setLoadedName("", "");
    clearMessages();
    state.tokenState = { promptTokens: 0, totalInput: 0, totalOutput: 0, contextWindow: null };
    updateTokenBar();
    showWelcome();
  }

  window.BAA.chatStream = {
    onSendOrStop, sendMessage, sendConfirmStream, stopStreaming,
    handleEvent, newChat, syncSendButton, buildChartFrame: _buildChartFrame,
    buildReasoningBlock: _buildReasoningBlock,
  };
})();
