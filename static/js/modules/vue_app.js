// Progressive Vue app islands: global UI + chat message list.
// Still exposes compatibility facades on window.BAA.ui and window.BAA.vueChat.
(function () {
  window.BAA = window.BAA || {};

  const Vue = window.Vue;
  const root = document.getElementById("global-ui-root");
  const hasVue = root && Vue && Vue.h && Vue.render;
  const toastTimers = new Map();

  function legacyToast(message, type = "") {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = message;
    el.className = "toast show" + (type ? " " + type : "");
    setTimeout(() => { el.className = "toast"; }, 2800);
  }

  function legacyShowLoading(options = {}) {
    const mask = document.getElementById(options.legacyId || "session-load-mask");
    if (!mask) return null;
    const nameEl = document.getElementById("session-load-name");
    const elapsedEl = document.getElementById("session-load-elapsed");
    if (nameEl) nameEl.textContent = options.name || "";
    if (elapsedEl) elapsedEl.textContent = options.elapsed || "0s";
    mask.hidden = false;
    mask.classList.add("open");
    return options.id || "legacy-loading";
  }

  function legacyHideLoading() {
    const mask = document.getElementById("session-load-mask");
    if (!mask) return;
    mask.classList.remove("open");
    mask.hidden = true;
  }

  if (!hasVue) {
    window.BAA.ui = {
      isVue: false,
      toast: legacyToast,
      showLoading: legacyShowLoading,
      hideLoading: legacyHideLoading,
      updateLoading() {},
      confirm() {
        legacyToast("当前界面尚未就绪，请稍后重试", "err");
        return Promise.resolve(false);
      },
    };
    return;
  }

  const { h, render } = Vue;
  const state = {
    toasts: [],
    loading: {
      visible: false,
      id: "",
      title: "",
      name: "",
      message: "",
      elapsedLabel: "",
      elapsed: "",
      cancelText: "",
      cancellable: false,
      onCancel: null,
      startedAt: 0,
      timer: null,
    },
    confirm: {
      visible: false,
      title: "",
      message: "",
      confirmText: "",
      cancelText: "",
      danger: false,
      resolve: null,
    },
  };
  let toastSeq = 0;

  function elapsedText(startedAt) {
    if (!startedAt) return "";
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }

  function clearLoadingTimer() {
    if (state.loading.timer) {
      clearInterval(state.loading.timer);
      state.loading.timer = null;
    }
  }

  function removeToast(id) {
    const idx = state.toasts.findIndex(item => item.id === id);
    if (idx >= 0) state.toasts.splice(idx, 1);
    const timer = toastTimers.get(id);
    if (timer) clearTimeout(timer);
    toastTimers.delete(id);
    renderUi();
  }

  function renderToast(item) {
    const classes = ["global-toast"];
    if (item.type) classes.push(item.type);
    return h("div", { key: item.id, class: classes.join(" ") }, [
      h("div", { class: "global-toast-icon", "aria-hidden": "true" }, item.type === "err" ? "!" : "✓"),
      h("div", { class: "global-toast-text" }, item.message),
      h("button", {
        class: "global-toast-close",
        type: "button",
        title: "Close",
        onClick: () => removeToast(item.id),
      }, "×"),
    ]);
  }

  function renderLoading() {
    const loading = state.loading;
    if (!loading.visible) return null;
    const meta = loading.elapsedLabel && loading.elapsed
      ? h("div", { class: "global-loading-meta" }, [
          h("span", null, loading.elapsedLabel),
          h("strong", null, loading.elapsed),
        ])
      : null;
    const cancel = loading.cancellable
      ? h("button", {
          class: "btn-sm btn-sm-ghost global-loading-cancel",
          type: "button",
          onClick: () => {
            if (typeof loading.onCancel === "function") loading.onCancel();
          },
        }, loading.cancelText || "Cancel")
      : null;

    return h("div", { class: "global-loading-mask", role: "status", "aria-live": "polite" }, [
      h("div", { class: "global-loading-panel" }, [
        h("div", { class: "global-loading-spinner", "aria-hidden": "true" }),
        h("div", { class: "global-loading-copy" }, [
          h("div", { class: "global-loading-title" }, loading.title),
          loading.name ? h("div", { class: "global-loading-name" }, loading.name) : null,
          loading.message ? h("div", { class: "global-loading-sub" }, loading.message) : null,
          meta,
        ]),
        cancel,
      ]),
    ]);
  }

  function settleConfirm(accepted) {
    const resolve = state.confirm.resolve;
    Object.assign(state.confirm, {
      visible: false,
      title: "",
      message: "",
      confirmText: "",
      cancelText: "",
      danger: false,
      resolve: null,
    });
    renderUi();
    if (typeof resolve === "function") resolve(Boolean(accepted));
  }

  function renderConfirm() {
    const dialog = state.confirm;
    if (!dialog.visible) return null;
    return h("div", {
      class: "global-confirm-mask",
      role: "presentation",
      onClick: () => settleConfirm(false),
      onKeydown: event => {
        if (event.key === "Escape") settleConfirm(false);
      },
    }, [
      h("section", {
        class: "global-confirm-panel",
        role: "alertdialog",
        "aria-modal": "true",
        "aria-labelledby": "global-confirm-title",
        "aria-describedby": "global-confirm-message",
        onClick: event => event.stopPropagation(),
      }, [
        h("div", { class: "global-confirm-copy" }, [
          h("h3", { id: "global-confirm-title", class: "global-confirm-title" }, dialog.title),
          h("p", { id: "global-confirm-message", class: "global-confirm-message" }, dialog.message),
        ]),
        h("div", { class: "global-confirm-actions" }, [
          h("button", {
            class: "btn-sm btn-sm-ghost",
            type: "button",
            onClick: () => settleConfirm(false),
          }, dialog.cancelText || "取消"),
          h("button", {
            class: dialog.danger ? "btn-sm global-confirm-danger" : "btn-sm btn-sm-primary",
            type: "button",
            autofocus: true,
            onClick: () => settleConfirm(true),
          }, dialog.confirmText || "确认"),
        ]),
      ]),
    ]);
  }

  function renderUi() {
    render(h("div", { class: "global-ui" }, [
      h("div", { class: "global-toast-stack", "aria-live": "polite" }, state.toasts.map(renderToast)),
      renderLoading(),
      renderConfirm(),
    ]), root);
  }

  function toast(message, type = "") {
    const id = ++toastSeq;
    state.toasts.push({ id, message: String(message || ""), type });
    renderUi();
    toastTimers.set(id, setTimeout(() => removeToast(id), 3200));
    return id;
  }

  function showLoading(options = {}) {
    clearLoadingTimer();
    const startedAt = options.startedAt || Date.now();
    Object.assign(state.loading, {
      visible: true,
      id: options.id || "global-loading",
      title: options.title || "",
      name: options.name || "",
      message: options.message || "",
      elapsedLabel: options.elapsedLabel || "",
      elapsed: options.elapsed || elapsedText(startedAt),
      cancelText: options.cancelText || "",
      cancellable: Boolean(options.cancellable),
      onCancel: options.onCancel || null,
      startedAt,
      timer: null,
    });
    if (state.loading.elapsedLabel) {
      state.loading.timer = setInterval(() => {
        state.loading.elapsed = elapsedText(state.loading.startedAt);
        renderUi();
      }, 500);
    }
    renderUi();
    return state.loading.id;
  }

  function hideLoading(id) {
    if (id && state.loading.id && id !== state.loading.id) return;
    clearLoadingTimer();
    Object.assign(state.loading, {
      visible: false,
      id: "",
      title: "",
      name: "",
      message: "",
      elapsedLabel: "",
      elapsed: "",
      cancelText: "",
      cancellable: false,
      onCancel: null,
      startedAt: 0,
    });
    renderUi();
  }

  function updateLoading(options = {}) {
    Object.assign(state.loading, options);
    if (state.loading.startedAt && state.loading.elapsedLabel) {
      state.loading.elapsed = elapsedText(state.loading.startedAt);
    }
    renderUi();
  }

  function confirm(options = {}) {
    if (state.confirm.visible) settleConfirm(false);
    return new Promise(resolve => {
      Object.assign(state.confirm, {
        visible: true,
        title: String(options.title || "请确认操作"),
        message: String(options.message || ""),
        confirmText: String(options.confirmText || "确认"),
        cancelText: String(options.cancelText || "取消"),
        danger: Boolean(options.danger),
        resolve,
      });
      renderUi();
    });
  }

  window.BAA.ui = { isVue: true, toast, showLoading, hideLoading, updateLoading, confirm };
  renderUi();
})();

// ── IIFE #7: durable Job history panel (B5) ─────────────────────────────
(function () {
  window.BAA = window.BAA || {};
  const Vue = window.Vue;
  const root = document.getElementById("job-history-root");
  if (!root || !Vue?.h || !Vue?.render || !Vue?.reactive) {
    window.BAA.vueJobHistory = null;
    return;
  }

  const { h, render, reactive } = Vue;
  const state = reactive({ open: false, loading: false, error: "", jobs: [] });
  let callbacks = {};

  function text(key, fallback, params) {
    if (!window.t) return fallback;
    const value = window.t(key, params);
    return value && value !== key ? value : fallback;
  }

  function normalizeSteps(events) {
    const steps = new Map();
    for (const event of (Array.isArray(events) ? events : [])) {
      const id = event.step_id || `step-${event.step_number || steps.size + 1}`;
      const current = steps.get(id) || {
        id, number: Number(event.step_number) || steps.size + 1,
        tool: event.tool || "unknown", display: event.display || event.tool || "unknown",
        status: "running", elapsed: null, error: "",
      };
      if (event.type === "conversation_step_finished") {
        current.status = event.status || "succeeded";
        current.elapsed = Number(event.elapsed_seconds) || 0;
        current.error = event.error || "";
      }
      steps.set(id, current);
    }
    return [...steps.values()].sort((a, b) => a.number - b.number);
  }

  function normalize(job) {
    return {
      id: job.id || job.job_id || "",
      type: job.type || job.job_type || "",
      label: job.label || "",
      status: job.status || "created",
      progress: Number(job.progress) || 0,
      message: job.message || "",
      error: job.error || "",
      result: job.result || null,
      activation: job.activation || job.result?.activation || null,
      workspace: job.workspace || null,
      workspaceId: job.workspace_id || "",
      artifacts: Array.isArray(job.artifacts) ? [...job.artifacts] : [],
      steps: normalizeSteps(job.steps),
      createdAt: job.created_at || "",
      updatedAt: job.updated_at || "",
      finishedAt: job.finished_at || "",
      cancelPending: false,
      expanded: Boolean(job.expanded),
    };
  }

  function findJob(jobId) {
    return state.jobs.find(job => job.id === jobId);
  }

  function sortJobs() {
    state.jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  function setJobs(jobs, nextCallbacks = {}) {
    const old = new Map(state.jobs.map(job => [job.id, job]));
    state.jobs = (Array.isArray(jobs) ? jobs : []).map(raw => {
      const job = normalize(raw);
      const previous = old.get(job.id);
      if (previous?.artifacts?.length) job.artifacts = previous.artifacts;
      if (previous) job.expanded = previous.expanded;
      return job;
    });
    callbacks = nextCallbacks || callbacks;
    sortJobs();
    draw();
  }

  function applyEvent(ev) {
    if (!ev?.job_id) return false;
    let job = findJob(ev.job_id);
    if (!job) {
      job = normalize({
        id: ev.job_id,
        type: ev.job_type,
        label: ev.label,
        status: ev.status,
        created_at: ev.created_at,
      });
      state.jobs.unshift(job);
    }
    if (ev.job_type) job.type = ev.job_type;
    if (ev.label) job.label = ev.label;
    if (ev.status) job.status = ev.status;
    if (ev.progress !== undefined) job.progress = Number(ev.progress) || 0;
    if (ev.message !== undefined) job.message = ev.message || "";
    if (ev.type === "conversation_activation" && ev.activation) job.activation = ev.activation;
    if (ev.created_at && !job.createdAt) job.createdAt = ev.created_at;
    if (ev.type === "conversation_step_started") {
      if (!job.steps.some(step => step.id === ev.step_id)) {
        job.steps.push({
          id: ev.step_id, number: Number(ev.step_number) || job.steps.length + 1,
          tool: ev.tool || "unknown", display: ev.display || ev.tool || "unknown",
          status: "running", elapsed: null, error: "",
        });
      }
    } else if (ev.type === "conversation_step_finished") {
      const step = job.steps.find(item => item.id === ev.step_id);
      if (step) {
        step.status = ev.status || "succeeded";
        step.elapsed = Number(ev.elapsed_seconds) || 0;
        step.error = ev.error || "";
      }
    }
    if (ev.type === "artifact_created" && ev.artifact) {
      const signature = JSON.stringify(ev.artifact);
      if (!job.artifacts.some(item => JSON.stringify(item) === signature)) {
        job.artifacts.push(ev.artifact);
      }
    } else if (ev.type === "job_done") {
      job.status = ev.status || "succeeded";
      job.progress = 100;
      job.result = ev.result;
      if (ev.result?.activation) job.activation = ev.result.activation;
      job.cancelPending = false;
    } else if (ev.type === "job_error") {
      job.status = ev.status || "failed";
      job.error = ev.error || "Job failed";
      job.cancelPending = false;
    } else if (ev.type === "job_canceled") {
      job.status = ev.status || "canceled";
      job.cancelPending = false;
    }
    sortJobs();
    draw();
    return true;
  }

  function formatTime(value) {
    if (!value) return "";
    try { return new Date(value).toLocaleString(); } catch (_) { return value; }
  }

  function renderArtifact(artifact, index) {
    const typeName = {
      chart: "分析图表", file: "生成文件", export: "导出文件",
      tool_result: "完整工具结果", schema: "数据结构", report: "分析报告",
      ppt: "演示文稿", dashboard: "仪表盘", checkpoint: "工作目录检查点",
    }[String(artifact.type || "").toLowerCase()] || "任务结果";
    const name = artifact.filename || artifact.name || artifact.label || `${typeName} ${index + 1}`;
    const href = artifact.url || artifact.download_url || "";
    return href
      ? h("a", { class: "job-history-artifact", href, target: "_blank", rel: "noopener" }, `↗ ${name}`)
      : h("span", { class: "job-history-artifact" }, `✓ ${name}`);
  }

  function renderStep(step) {
    const duration = step.elapsed === null ? "" : `${step.elapsed.toFixed(2)}s`;
    return h("li", { class: `job-history-step job-history-step-${step.status}` }, [
      h("span", { class: "job-history-step-state", "aria-hidden": "true" },
        step.status === "running" ? "⟳" : step.status === "succeeded" ? "✓" : "!"),
      h("span", { class: "job-history-step-name" }, step.display || step.tool),
      h("code", { class: "job-history-step-tool" }, step.tool),
      duration ? h("span", { class: "job-history-step-duration" }, duration) : null,
      step.error ? h("div", { class: "job-history-step-error" }, step.error) : null,
    ]);
  }

  function renderJob(job) {
    const terminal = ["succeeded", "failed", "canceled"].includes(job.status);
    const canCancel = !terminal && job.status !== "canceling" && job.type !== "filehistory_rewind";
    const progress = Math.max(0, Math.min(100, Number(job.progress) || 0));
    const title = job.label || job.type || text("job.default_label", "Background job");
    const isConversation = job.type === "conversation_analysis";
    const answer = typeof job.result === "object" ? (job.result?.answer || "") : "";
    const detailCount = job.steps.length || Number(job.result?.step_count) || 0;
    const activation = job.activation || job.result?.activation;
    const children = [
      h("div", { class: "job-history-card-head" }, [
        h("div", { class: "job-history-card-title" }, title),
        h("span", { class: `job-status job-status-${job.status}` },
          text(`job.status.${job.status}`, job.status)),
      ]),
      h("div", { class: "job-history-time" }, formatTime(job.createdAt)),
      job.workspaceId ? h("div", {
        class: "job-history-workspace",
        title: job.workspace?.path || job.workspaceId,
      }, `📁 ${text("job.workspace", "工作目录")}：${job.workspace?.name || job.workspaceId.slice(0, 8)}`) : null,
      h("div", { class: "job-progress", role: "progressbar", "aria-valuenow": String(progress) }, [
        h("span", { class: "job-progress-fill", style: { width: `${progress}%` } }),
      ]),
      h("div", { class: "job-card-meta" }, [
        h("span", { class: "job-progress-value" },
          isConversation ? `已执行 ${detailCount} 个步骤` : `${progress}%`),
        job.message && !isConversation ? h("span", { class: "job-message" }, job.message) : null,
      ]),
    ];
    if (activation?.kind && activation.kind !== "none") {
      const prefix = activation.kind === "skill" ? "分析技能" : activation.kind === "command" ? "命令" : "内部操作";
      children.splice(2, 0, h("div", {
        class: `job-activation job-activation-${activation.kind}`,
      }, `${prefix}: ${activation.name || ""}`));
    }
    if (job.artifacts.length) {
      children.push(h("div", { class: "job-history-artifacts" }, [
        h("div", { class: "job-history-artifacts-title" }, "任务结果"),
        ...job.artifacts.map(renderArtifact),
      ]));
    }
    if (job.error) children.push(h("div", { class: "job-error" }, job.error));
    if (isConversation && (job.steps.length || answer)) {
      children.push(h("button", {
        class: "job-history-expand", type: "button",
        "aria-expanded": String(job.expanded),
        onClick: () => { job.expanded = !job.expanded; draw(); },
      }, `${job.expanded ? "收起" : "展开"}执行详情 (${detailCount})`));
      if (job.expanded) {
        children.push(h("div", { class: "job-history-detail" }, [
          job.steps.length
            ? h("ol", { class: "job-history-steps" }, job.steps.map(renderStep))
            : null,
          answer ? h("div", { class: "job-history-answer" }, [
            h("div", { class: "job-history-answer-title" }, "最终答案"),
            h("div", { class: "job-history-answer-body" }, answer),
          ]) : null,
        ]));
      }
    }
    if (canCancel) {
      children.push(h("button", {
        class: "job-cancel-btn",
        type: "button",
        disabled: job.cancelPending,
        onClick: async () => {
          if (!callbacks.onCancel || job.cancelPending) return;
          job.cancelPending = true;
          job.status = "canceling";
          draw();
          try { await callbacks.onCancel(job.id); }
          catch (error) {
            job.cancelPending = false;
            job.error = error?.message || text("job.cancel_failed", "Could not cancel job");
            draw();
          }
        },
      }, text("job.cancel", "Cancel")));
    }
    return h("article", { class: `job-history-card job-history-card-${job.status}`, key: job.id }, children);
  }

  function draw() {
    if (!state.open) {
      render(null, root);
      return;
    }
    const body = state.loading && !state.jobs.length
      ? h("div", { class: "job-history-empty" }, text("job.history.loading", "Loading…"))
      : state.error
        ? h("div", { class: "job-history-error" }, state.error)
        : state.jobs.length
          ? h("div", { class: "job-history-list" }, state.jobs.map(renderJob))
          : h("div", { class: "job-history-empty" }, text("job.history.empty", "No background jobs yet"));
    render(h("div", {
      class: "overlay open",
      role: "dialog",
      "aria-modal": "true",
      onClick: event => { if (event.target === event.currentTarget) setOpen(false); },
    }, [h("section", { class: "modal job-history-modal" }, [
      h("header", { class: "job-history-head" }, [
        h("div", null, [
          h("div", { class: "modal-title" }, text("job.history.title", "Job history")),
          h("div", { class: "job-history-summary" },
            text("job.history.summary", `${state.jobs.length} jobs`, { count: state.jobs.length })),
        ]),
        h("div", { class: "job-history-actions" }, [
          h("button", { class: "btn-sm btn-sm-danger", type: "button", disabled: state.loading,
            onClick: () => callbacks.onClearCompleted?.() },
          text("job.history.clear_completed", "清除已完成")),
          h("button", { class: "btn-sm btn-sm-ghost", type: "button", disabled: state.loading,
            onClick: () => callbacks.onRefresh?.() }, text("job.history.refresh", "Refresh")),
          h("button", { class: "job-history-close", type: "button", onClick: () => setOpen(false),
            "aria-label": text("modal.close", "Close") }, "×"),
        ]),
      ]),
      body,
    ])]), root);
  }

  function setOpen(open) { state.open = Boolean(open); draw(); }
  function setLoading(loading) { state.loading = Boolean(loading); draw(); }
  function setError(error) { state.error = error || ""; draw(); }
  function reset() { state.jobs = []; state.error = ""; state.loading = false; draw(); }

  window.BAA.vueJobHistory = {
    setOpen, setLoading, setError, setJobs, applyEvent, reset,
    isOpen: () => state.open,
  };
})();

// Progressive Vue island for the chat message list.
// It renders the outer message shell and now owns basic text-stream state.
// Charts, outline cards, and ask_user still use legacy DOM handlers.
(function () {
  window.BAA = window.BAA || {};

  const root = document.getElementById("chat-vue-root");
  const composerQueueRoot = document.getElementById("composer-queue-root");
  const Vue = window.Vue;
  if (!root || !Vue || !Vue.h || !Vue.render) {
    window.BAA.vueChat = null;
    return;
  }

  const { h, render, Fragment } = Vue;
  const messages = [];
  let seq = 0;
  let toolSeq = 0;
  let chartSeq = 0;
  let cardSeq = 0;
  let jobSeq = 0;
  const MIN_TOOL_VISIBLE_MS = 650;
  const ACTIVITY_KIND = "activity";

  const chartObserver = window.IntersectionObserver
    ? new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (!entry.isIntersecting) return;
          const iframe = entry.target;
          if (!iframe.src) iframe.src = iframe.dataset.src;
          chartObserver.unobserve(iframe);
        });
      }, { rootMargin: "200px" })
    : null;

  function _assistantAvatar() {
    return h("img", {
      class: "assistant-avatar-img",
      src: "/static/Images/icon.png",
      alt: "AI",
    });
  }

  function _messageNode(msg) {
    if (msg.kind === "system") {
      return h("div", {
        key: msg.id,
        class: "sys-msg",
        "data-vue-msg-id": msg.id,
        style: "text-align:center;font-size:12px;color:#94a3b8;padding:3px 0;",
      }, msg.text || "");
    }

    return h("div", {
      key: msg.id,
      class: `msg ${msg.role}`,
      "data-vue-msg-id": msg.id,
    }, [
      h("div", { class: "msg-avatar" }, [
        msg.role === "user" ? "👤" : _assistantAvatar(),
      ]),
      h("div", { class: "msg-body" }, [
        _renderTurnQueueState(msg),
        h("div", { class: "tool-steps" }),
        h("div", { class: "job-list" }),
        h("div", { class: "chart-list" }),
        h("div", { class: "msg-bubble" }),
        h("div", { class: "card-list" }),
      ]),
    ]);
  }

  function _queueText(key, fallback, params) {
    if (!window.t) return fallback;
    const value = t(key, params);
    return value && value !== key ? value : fallback;
  }

  function _renderTurnQueueState(msg) {
    if (!msg.queueStatus) return null;
    let label = _queueText("queue.processing", "Starting…");
    if (msg.queueStatus === "queued") {
      label = _queueText("queue.waiting", `Waiting · position ${msg.queuePosition}`, {
        position: msg.queuePosition,
      });
    } else if (msg.queueStatus === "canceled") {
      label = _queueText("queue.canceled", "Removed from queue");
    }
    const children = [
      h("span", { class: "turn-queue-icon", "aria-hidden": "true" }, msg.queueStatus === "queued" ? "⏳" : "·"),
      h("span", { class: "turn-queue-label" }, label),
    ];
    if (msg.queueStatus === "queued" && msg.queueCallbacks?.onCancel) {
      children.push(h("button", {
        type: "button",
        class: "turn-queue-cancel",
        onClick: () => msg.queueCallbacks.onCancel(),
      }, _queueText("queue.cancel", "Cancel queued message")));
    }
    return h("div", {
      class: `turn-queue-state turn-queue-${msg.queueStatus}`,
      role: "status",
      "aria-live": "polite",
    }, children);
  }

  function renderComposerQueue(items, callbacks) {
    if (!composerQueueRoot) return false;
    const queue = Array.isArray(items) ? items : [];
    if (!queue.length) {
      render(null, composerQueueRoot);
      return true;
    }
    const first = queue[0];
    const countText = _queueText("queue.count", `${queue.length} messages queued`, { count: queue.length });
    const icon = (paths) => h("svg", {
      viewBox: "0 0 24 24",
      width: "20",
      height: "20",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.9",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
    }, paths.map(path => h("path", { d: path })));
    const children = [
      h("span", { class: "composer-queue-grip", "aria-hidden": "true" }, "⠿"),
      h("div", { class: "composer-queue-copy" }, [
        h("span", { class: "composer-queue-message" }, first.displayText || first.message || ""),
        h("span", { class: "composer-queue-count" }, countText),
      ]),
      h("div", { class: "composer-queue-actions" }, [
        h("button", {
          type: "button",
          class: "composer-queue-action composer-queue-send-now",
          title: _queueText("queue.send_now", "Send now and stop the current response"),
          "aria-label": _queueText("queue.send_now", "Send now and stop the current response"),
          onClick: () => callbacks?.onSendNow?.(first.id),
        }, [icon(["M5 4h14", "M12 20V8", "m7.5 12.5 4.5-4.5 4.5 4.5"])]),
        h("button", {
          type: "button",
          class: "composer-queue-action composer-queue-edit",
          title: _queueText("queue.edit", "Edit queued message"),
          "aria-label": _queueText("queue.edit", "Edit queued message"),
          onClick: () => callbacks?.onEdit?.(first.id),
        }, [icon(["M12 20h9", "M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"])]),
        h("button", {
          type: "button",
          class: "composer-queue-action composer-queue-delete",
          title: _queueText("queue.delete", "Delete queued message"),
          "aria-label": _queueText("queue.delete", "Delete queued message"),
          onClick: () => callbacks?.onCancel?.(first.id),
        }, [icon(["M3 6h18", "M8 6V4h8v2", "M19 6l-1 14H6L5 6", "M10 11v5", "M14 11v5"])]),
      ]),
    ];
    render(h("div", {
      class: "composer-queue-bar",
      role: "status",
      "aria-live": "polite",
    }, children), composerQueueRoot);
    return true;
  }

  function _render() {
    render(h("div", { class: "chat-vue-list" }, messages.map(_messageNode)), root);
    messages.forEach(_renderToolsFor);
    messages.forEach(_renderJobsFor);
    messages.forEach(_renderChartsFor);
    messages.forEach(_renderCardsFor);
  }

  function _find(id) {
    return root.querySelector(`[data-vue-msg-id="${id}"]`);
  }

  function _messageIdFrom(target) {
    if (!target) return "";
    if (typeof target === "string") return target;
    const node = target.closest ? target.closest("[data-vue-msg-id]") : null;
    return node ? node.dataset.vueMsgId : "";
  }

  function _stateFor(target) {
    const id = _messageIdFrom(target);
    if (!id) return null;
    return messages.find(m => m.id === id) || null;
  }

  function _bubbleFor(target) {
    const id = _messageIdFrom(target);
    const el = id ? _find(id) : null;
    return el ? el.querySelector(".msg-bubble") : null;
  }

  function _bodyFor(target) {
    const id = _messageIdFrom(target);
    const el = id ? _find(id) : null;
    return el ? el.querySelector(".msg-body") : null;
  }

  function _chartListFor(target) {
    const id = _messageIdFrom(target);
    const el = id ? _find(id) : null;
    return el ? el.querySelector(".chart-list") : null;
  }

  function _cardListFor(target) {
    const id = _messageIdFrom(target);
    const el = id ? _find(id) : null;
    return el ? el.querySelector(".card-list") : null;
  }

  function _jobListFor(target) {
    const id = _messageIdFrom(target);
    const el = id ? _find(id) : null;
    return el ? el.querySelector(".job-list") : null;
  }

  function _removeTyping(typing) {
    if (typing && typing.parentNode) typing.remove();
  }

  function _bindImages(bubble) {
    if (window.BAA.msg && window.BAA.msg.bindBubbleImages) {
      window.BAA.msg.bindBubbleImages(bubble);
    }
  }

  function _stepsFor(target) {
    const id = _messageIdFrom(target);
    const el = id ? _find(id) : null;
    return el ? el.querySelector(".tool-steps") : null;
  }

  function _toolSummary(ev) {
    return String(ev.display || ev.detail || "").replace(/\s+/g, " ").trim();
  }

  function _toolDetail(ev) {
    return String(ev.detail || ev.display || "");
  }

  function _activityText(text) {
    if (text) return String(text);
    if (window.t) return t("tool.next_step") || "正在思考下一步…";
    return "正在思考下一步…";
  }

  function _renderToolStep(item) {
    const iconClass = item.compaction ? "compaction-spin" : "spin";
    const doneClass = item.compaction ? "done-compaction" : "done";
    const classes = ["tool-step"];
    if (item.compaction) classes.push("tool-step-compaction");
    if (!item.finished) classes.push("running");
    if (item.finished) classes.push(doneClass);
    const icon = item.finished ? (item.compaction ? "✦" : "✓") : "⟳";
    const attrs = {
      key: item.id,
      class: classes.join(" "),
      "data-tool": item.tool || "",
      "data-step-id": item.id,
    };
    if (item.finished) attrs["data-finished"] = "1";

    if (item.compaction) {
      return h("div", attrs, [
        h("span", { class: iconClass }, icon),
        h("span", { class: "tool-step-text" }, item.detail),
      ]);
    }

    return h("details", {
      ...attrs,
      open: item.open,
      onToggle: e => { item.open = e.currentTarget.open; },
    }, [
      h("summary", { class: "tool-step-head" }, [
        h("span", { class: iconClass }, icon),
        h("span", { class: "tool-step-text" }, item.summary),
      ]),
      h("div", { class: "tool-step-detail" }, item.detail),
    ]);
  }

  function _renderActivity(item) {
    return h("div", {
      key: item.id,
      class: "tool-step tool-step-activity running",
      "data-step-id": item.id,
    }, [
      h("span", { class: "spin" }, "⟳"),
      h("span", { class: "tool-step-text" }, item.text),
    ]);
  }

  function _renderRefItem(ref) {
    const headChildren = [
      h("span", { class: "knowledge-ref-type" }, ref.type || "来源"),
      h("span", { class: "knowledge-ref-title" }, ref.title || ref.source || "未命名来源"),
    ];
    if (ref.score !== "" && ref.score !== null && ref.score !== undefined) {
      headChildren.push(h("span", { class: "knowledge-ref-score" }, `score ${ref.score}`));
    }
    if (ref.rows !== null && ref.rows !== undefined) {
      headChildren.push(h("span", { class: "knowledge-ref-score" }, `${ref.rows} rows`));
    }
    const children = [
      h("div", { class: "knowledge-ref-head" }, headChildren),
    ];
    if (ref.source) children.push(h("div", { class: "knowledge-ref-source" }, ref.source));
    if (ref.snippet) children.push(h("div", { class: "knowledge-ref-snippet" }, ref.snippet));
    return h("div", { class: "knowledge-ref-item" }, children);
  }

  function _renderRefsPanel(item) {
    const refs = item.refs || [];
    const list = refs.length
      ? refs.map(_renderRefItem)
      : [h("div", { class: "knowledge-ref-empty" }, "本次知识库检索没有命中可引用条目。")];
    return h("details", {
      key: item.id,
      class: item.panelClass,
      "data-for-step": item.forStep || "",
      open: item.open,
      onToggle: e => { item.open = e.currentTarget.open; },
    }, [
      h("summary", null, item.title),
      h("div", { class: "knowledge-ref-list" }, list),
    ]);
  }

  function _renderAuditPanel(item) {
    const classes = ["tool-audit"];
    if (item.ok === false) classes.push("tool-audit-error");
    if (item.content) classes.push("tool-audit-has-summary");
    const attrs = {
      key: item.id,
      class: classes.join(" "),
      "data-tool": item.tool || "",
      "data-for-step": item.forStep || "",
      title: item.argsTitle || "",
    };
    const status = h(item.content ? "summary" : "span", { class: "tool-audit-status" }, item.status);
    const body = item.content
      ? h("div", { class: "tool-audit-summary" }, item.content)
      : null;
    if (item.content) {
      return h("details", {
        ...attrs,
        open: item.open,
        onToggle: e => { item.open = e.currentTarget.open; },
      }, [status, body]);
    }
    return h("div", attrs, [status]);
  }

  function _renderToolItem(item) {
    if (item.kind === ACTIVITY_KIND) return _renderActivity(item);
    if (item.kind === "step") return _renderToolStep(item);
    if (item.kind === "refs") return _renderRefsPanel(item);
    if (item.kind === "audit") return _renderAuditPanel(item);
    return null;
  }

  function _syncChartFrameHeight(iframe) {
    try {
      const doc = iframe.contentDocument;
      if (!doc?.body) return;

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

  function _mountChartIframe(iframe) {
    if (!iframe) return;
    if (chartObserver) {
      chartObserver.observe(iframe);
    } else if (!iframe.src) {
      iframe.src = iframe.dataset.src;
    }
  }

  function _renderChartFrame(item) {
    return h("div", { key: item.id, class: "chart-frame", "data-chart-id": item.chartId }, [
      h("button", {
        class: "chart-expand-btn",
        type: "button",
        title: "在新标签页打开",
        onClick: () => window.open(`/api/chart/${item.chartId}`, "_blank"),
      }, "⛶"),
      h("iframe", {
        "data-src": `/api/chart/${item.chartId}`,
        onVnodeMounted: vnode => _mountChartIframe(vnode.el),
        onLoad: e => {
          const iframe = e.currentTarget;
          requestAnimationFrame(() => _syncChartFrameHeight(iframe));
          setTimeout(() => _syncChartFrameHeight(iframe), 250);
        },
      }),
    ]);
  }

  function _renderChartsFor(msg) {
    if (!msg || msg.kind !== "message") return;
    const list = _chartListFor(msg.id);
    if (!list) return;
    const charts = msg.charts || [];
    if (!charts.length) {
      render(null, list);
      return;
    }
    render(h(Fragment, null, charts.map(_renderChartFrame)), list);
  }

  function _jobText(key, fallback) {
    if (!window.t) return fallback;
    const value = t(key);
    return value && value !== key ? value : fallback;
  }

  function _artifactNode(artifact, index) {
    const typeName = {
      chart: "分析图表", file: "生成文件", export: "导出文件",
      tool_result: "完整工具结果", schema: "数据结构", report: "分析报告",
      ppt: "演示文稿", dashboard: "仪表盘", checkpoint: "工作目录检查点",
    }[String(artifact.type || "").toLowerCase()] || "任务结果";
    const name = artifact.filename || artifact.name || artifact.label || `${typeName} ${index + 1}`;
    const href = artifact.url || artifact.download_url || "";
    const attrs = { class: "job-artifact", key: `${name}-${index}` };
    if (href) {
      return h("a", { ...attrs, href, target: "_blank", rel: "noopener noreferrer" }, `↗ ${name}`);
    }
    return h("span", attrs, `✓ ${name}`);
  }

  function _renderJobCard(job) {
    const terminal = ["succeeded", "failed", "canceled"].includes(job.status);
    const canCancel = !terminal && job.status !== "canceling" && job.jobType !== "filehistory_rewind";
    const progress = Math.max(0, Math.min(100, Number(job.progress) || 0));
    const statusText = _jobText(`job.status.${job.status}`, job.status || "created");
    const children = [
      h("div", { class: "job-card-head" }, [
        h("div", { class: "job-card-title" }, [
          h("span", { class: "job-card-icon", "aria-hidden": "true" }, terminal ? (job.status === "succeeded" ? "✓" : "!") : "⟳"),
          h("span", null, job.label || job.jobType || _jobText("job.default_label", "Background job")),
        ]),
        h("span", { class: `job-status job-status-${job.status}` }, statusText),
      ]),
      h("div", {
        class: "job-progress",
        role: "progressbar",
        "aria-label": job.label || job.jobType || "Job progress",
        "aria-valuemin": "0",
        "aria-valuemax": "100",
        "aria-valuenow": String(progress),
      }, [h("span", { class: "job-progress-fill", style: { width: `${progress}%` } })]),
      h("div", { class: "job-card-meta" }, [
        h("span", { class: "job-progress-value" }, `${progress}%`),
        job.message ? h("span", { class: "job-message" }, job.message) : null,
      ]),
    ];
    if (job.artifacts.length) {
      children.push(h("div", { class: "job-artifacts" }, job.artifacts.map(_artifactNode)));
    }
    if (job.error) children.push(h("div", { class: "job-error", role: "alert" }, job.error));
    if (canCancel) {
      children.push(h("button", {
        type: "button",
        class: "job-cancel-btn",
        disabled: job.cancelPending,
        onClick: async () => {
          if (job.cancelPending || !job.callbacks?.onCancel) return;
          job.previousStatus = job.status;
          job.cancelPending = true;
          job.status = "canceling";
          _renderJobsFor(job._msg);
          try {
            await job.callbacks.onCancel(job.jobId);
          } catch (error) {
            job.cancelPending = false;
            job.status = job.previousStatus || "running";
            job.error = error?.message || _jobText("job.cancel_failed", "Could not cancel job");
            _renderJobsFor(job._msg);
          }
        },
      }, _jobText("job.cancel", "Cancel")));
    }
    return h("section", {
      key: job.id,
      class: `job-card job-card-${job.status}`,
      "data-job-id": job.jobId,
    }, children);
  }

  function _renderJobsFor(msg) {
    if (!msg || msg.kind !== "message") return;
    const list = _jobListFor(msg.id);
    if (!list) return;
    const jobs = msg.jobs || [];
    render(jobs.length ? h(Fragment, null, jobs.map(_renderJobCard)) : null, list);
  }

  function updateJob(target, ev, callbacks) {
    const msg = _stateFor(target);
    if (!msg || !ev || !ev.job_id) return false;
    msg.jobs = msg.jobs || [];
    let job = msg.jobs.find(item => item.jobId === ev.job_id);
    if (!job) {
      job = {
        id: `job-${++jobSeq}`,
        jobId: ev.job_id,
        jobType: ev.job_type || "",
        label: ev.label || "",
        status: ev.status || "created",
        progress: 0,
        message: "",
        artifacts: [],
        result: null,
        error: "",
        cancelPending: false,
        callbacks: callbacks || {},
        _msg: msg,
      };
      msg.jobs.push(job);
    }
    job.previousStatus = job.status;
    if (callbacks) job.callbacks = callbacks;
    if (ev.job_type) job.jobType = ev.job_type;
    if (ev.label) job.label = ev.label;
    if (ev.status) job.status = ev.status;
    if (ev.progress !== undefined) job.progress = ev.progress;
    if (ev.message !== undefined) job.message = ev.message || "";
    if (ev.type === "artifact_created" && ev.artifact) job.artifacts.push(ev.artifact);
    if (ev.type === "job_done") {
      job.status = ev.status || "succeeded";
      job.progress = 100;
      job.result = ev.result;
      job.cancelPending = false;
    }
    if (ev.type === "job_error") {
      job.status = ev.status || "failed";
      job.error = ev.error || "Job failed";
      job.cancelPending = false;
    }
    if (ev.type === "job_canceled") {
      job.status = ev.status || "canceled";
      job.cancelPending = false;
    }
    _renderJobsFor(msg);
    return true;
  }

  function _renderOutlineCard(item) {
    const children = [
      h("div", { class: "ppt-outline-header" }, [
        h("span", { class: "ppt-outline-icon" }, item.icon),
        h("span", null, item.headerTitle),
      ]),
      h("div", {
        class: "ppt-outline-content",
        innerHTML: window.renderMd(item.markdown || ""),
      }),
    ];

    if (item.editOpen) {
      children.push(h("div", { class: "ppt-outline-edit-wrap" }, [
        h("div", { class: "ppt-outline-edit-hint" }, "请说明希望如何修改："),
        h("textarea", {
          class: "ppt-outline-edit",
          rows: 3,
          placeholder: "例如：把第3张换成双栏文字，增加一张市场份额环形图…",
          value: item.editText,
          disabled: item.locked,
          onInput: e => { item.editText = e.currentTarget.value; },
          onKeydown: e => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              const txt = (e.currentTarget.value || "").trim();
              if (!txt || item.locked) return;
              item.locked = true;
              _renderCardsFor(item._msg);
              if (item.callbacks && item.callbacks.onRevise) item.callbacks.onRevise(txt);
            }
          },
        }),
      ]));
    }

    if (item.cancelled) {
      children.push(h("div", { class: "ppt-cancelled-note" }, "已取消。"));
    } else {
      children.push(h("div", { class: "ppt-outline-btns" }, [
        h("button", {
          class: "ppt-btn ppt-btn-confirm",
          type: "button",
          disabled: item.locked,
          onClick: () => {
            if (item.locked) return;
            item.locked = true;
            _renderCardsFor(item._msg);
            if (item.callbacks && item.callbacks.onConfirm) item.callbacks.onConfirm();
          },
        }, "✅ 确认生成"),
        h("button", {
          class: "ppt-btn ppt-btn-revise",
          type: "button",
          disabled: item.locked,
          onClick: () => {
            if (item.locked) return;
            item.editOpen = !item.editOpen;
            _renderCardsFor(item._msg);
          },
        }, "✏️ 修改大纲"),
        h("button", {
          class: "ppt-btn ppt-btn-cancel",
          type: "button",
          disabled: item.locked,
          onClick: () => {
            if (item.locked) return;
            item.locked = true;
            item.cancelled = true;
            _renderCardsFor(item._msg);
            if (item.callbacks && item.callbacks.onCancel) item.callbacks.onCancel();
          },
        }, "✕ 取消"),
      ]));
    }

    return h("div", { key: item.id, class: "ppt-outline-card" }, children);
  }

  function _renderAskUserCard(item) {
    const options = item.options || [];
    const allOpts = options.concat(["__other__"]);

    const chips = allOpts.map(opt => {
      const isOther = opt === "__other__";
      const selected = item.selected.includes(opt);
      const classes = ["ask-user-chip"];
      if (selected) classes.push("selected");
      return h("button", {
        key: opt,
        class: classes.join(" "),
        type: "button",
        disabled: item.locked,
        onClick: () => {
          if (item.locked) return;
          if (isOther) {
            item.otherOpen = !item.otherOpen;
            _renderCardsFor(item._msg);
            return;
          }
          if (item.multiSelect) {
            const idx = item.selected.indexOf(opt);
            if (idx >= 0) item.selected.splice(idx, 1);
            else item.selected.push(opt);
            _renderCardsFor(item._msg);
          } else {
            item.locked = true;
            _renderCardsFor(item._msg);
            if (item.callbacks && item.callbacks.onSubmit) item.callbacks.onSubmit(opt);
          }
        },
      }, isOther ? (window.t ? (t("ask_user.other") || "其他…") : "其他…") : opt);
    });

    const children = [
      h("div", { class: "ask-user-question" }, item.question || ""),
      h("div", { class: "ask-user-chips" }, chips),
    ];

    if (item.otherOpen) {
      children.push(h("div", { class: "ask-user-other-wrap" }, [
        h("input", {
          type: "text",
          class: "ask-user-other-input",
          placeholder: window.t ? (t("ask_user.other_placeholder") || "请输入您的回答…") : "请输入您的回答…",
          value: item.otherText,
          disabled: item.locked,
          onInput: e => { item.otherText = e.currentTarget.value; },
          onKeydown: e => {
            if (e.key === "Enter") {
              e.preventDefault();
              const val = (e.currentTarget.value || "").trim();
              if (!val || item.locked) return;
              item.locked = true;
              _renderCardsFor(item._msg);
              if (item.callbacks && item.callbacks.onSubmit) item.callbacks.onSubmit(val);
            }
          },
        }),
        h("button", {
          type: "button",
          class: "ask-user-other-btn",
          disabled: item.locked,
          onClick: () => {
            const val = (item.otherText || "").trim();
            if (!val || item.locked) return;
            item.locked = true;
            _renderCardsFor(item._msg);
            if (item.callbacks && item.callbacks.onSubmit) item.callbacks.onSubmit(val);
          },
        }, window.t ? (t("ask_user.submit") || "提交") : "提交"),
      ]));
    }

    if (item.multiSelect) {
      children.push(h("button", {
        type: "button",
        class: "ask-user-submit-btn",
        disabled: item.locked,
        onClick: () => {
          if (item.locked) return;
          const vals = [...item.selected];
          if (item.otherOpen && item.otherText) vals.push(item.otherText.trim());
          if (!vals.length) return;
          item.locked = true;
          _renderCardsFor(item._msg);
          if (item.callbacks && item.callbacks.onSubmit) item.callbacks.onSubmit(vals.join("、"));
        },
      }, window.t ? (t("ask_user.confirm") || "确认选择") : "确认选择"));
    }

    return h("div", { key: item.id, class: "ask-user-card" }, children);
  }

  function _renderCard(item) {
    if (item.kind === "outline") return _renderOutlineCard(item);
    if (item.kind === "ask_user") return _renderAskUserCard(item);
    return null;
  }

  function _renderCardsFor(msg) {
    if (!msg || msg.kind !== "message") return;
    const list = _cardListFor(msg.id);
    if (!list) return;
    const cards = msg.cards || [];
    if (!cards.length) {
      render(null, list);
      return;
    }
    render(h(Fragment, null, cards.map(_renderCard)), list);
  }

  function _renderToolsFor(msg) {
    if (!msg || msg.kind !== "message") return;
    const steps = _stepsFor(msg.id);
    if (!steps) return;
    const items = msg.tools || [];
    if (!items.length) {
      render(null, steps);
      return;
    }
    render(h(Fragment, null, items.map(_renderToolItem)), steps);
  }

  function _latestStep(msg, toolName) {
    if (!msg || !Array.isArray(msg.tools)) return null;
    for (let i = msg.tools.length - 1; i >= 0; i--) {
      const item = msg.tools[i];
      if (item.kind === "step" && item.tool === toolName) return item;
    }
    return null;
  }

  function _upsertPanel(msg, step, panel) {
    if (!msg || !step) return false;
    msg.tools = msg.tools || [];
    const idx = msg.tools.findIndex(item =>
      item.kind === panel.kind &&
      item.panelClass === panel.panelClass &&
      item.forStep === step.id
    );
    if (idx >= 0) msg.tools.splice(idx, 1);
    const stepIdx = msg.tools.findIndex(item => item.id === step.id);
    panel.forStep = step.id;
    msg.tools.splice(stepIdx + 1, 0, panel);
    _renderToolsFor(msg);
    return true;
  }

  function appendMsg(role, text) {
    const id = `m${++seq}`;
    messages.push({
      id,
      kind: "message",
      role,
      text: text || "",
      reasoning: [],
      tools: [],
      charts: [],
      cards: [],
      jobs: [],
      queueStatus: "",
      queuePosition: 0,
      queueCallbacks: null,
      error: "",
      stopped: false,
    });
    _render();
    const el = _find(id);
    const bubble = el && el.querySelector(".msg-bubble");
    if (bubble && text !== null) {
      bubble.innerHTML = window.renderMd(text);
      _bindImages(bubble);
    }
    return el;
  }

  function sysMsg(text) {
    const id = `m${++seq}`;
    messages.push({ id, kind: "system", text: text || "" });
    _render();
    return _find(id);
  }

  function clear() {
    messages.forEach(msg => {
      (msg.tools || []).forEach(item => {
        if (item.finishTimer) clearTimeout(item.finishTimer);
      });
    });
    messages.length = 0;
    _render();
  }

  function countMessages() {
    return messages.filter(m => m.kind === "message").length;
  }

  function setTurnQueueState(target, status, position, callbacks) {
    const msg = _stateFor(target);
    if (!msg || msg.kind !== "message") return false;
    msg.queueStatus = status || "";
    msg.queuePosition = Number(position) || 0;
    msg.queueCallbacks = callbacks || null;
    _render();
    return true;
  }

  function setMessageText(target, text) {
    const msg = _stateFor(target);
    if (!msg || msg.kind !== "message") return false;
    msg.text = String(text || "");
    _render();
    const bubble = _bubbleFor(msg.id);
    if (bubble) {
      bubble.innerHTML = window.renderMd(msg.text);
      _bindImages(bubble);
    }
    return true;
  }

  function removeMessages(targets) {
    const ids = new Set((Array.isArray(targets) ? targets : [targets]).map(_messageIdFrom).filter(Boolean));
    if (!ids.size) return false;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (ids.has(messages[index].id)) messages.splice(index, 1);
    }
    _render();
    return true;
  }

  function appendTextDelta(target, content, typing) {
    const msg = _stateFor(target);
    const bubble = _bubbleFor(target);
    if (!msg || !bubble) return false;
    hideToolActivity(target);
    _removeTyping(typing);
    const chunk = String(content || "");
    msg.text += chunk;
    bubble.insertAdjacentText("beforeend", chunk);
    return true;
  }

  function setMarkdown(target, markdownText, typing) {
    const msg = _stateFor(target);
    const bubble = _bubbleFor(target);
    if (!msg || !bubble) return false;
    hideToolActivity(target);
    _removeTyping(typing);
    msg.text = String(markdownText || "");
    msg.error = "";
    bubble.innerHTML = window.renderMd(msg.text);
    _bindImages(bubble);
    return true;
  }

  function setError(target, message, typing) {
    const msg = _stateFor(target);
    const bubble = _bubbleFor(target);
    if (!msg || !bubble) return false;
    hideToolActivity(target);
    _removeTyping(typing);
    msg.error = String(message || "");
    bubble.innerHTML = "";
    const span = document.createElement("span");
    span.className = "stream-error";
    span.textContent = `⚠ ${msg.error}`;
    bubble.appendChild(span);
    return true;
  }

  function addReasoning(target, content, typing) {
    const msg = _stateFor(target);
    const bubble = _bubbleFor(target);
    if (!msg || !bubble) return false;
    _removeTyping(typing);
    const text = String(content || "");
    msg.reasoning.push(text);

    const block = document.createElement("div");
    block.className = "reasoning-block";
    const toggle = document.createElement("div");
    toggle.className = "reasoning-toggle";
    toggle.innerHTML = `<span class="reasoning-arrow">▶</span> ${window.t ? t('reasoning_toggle') : "Reasoning"}`;
    const body = document.createElement("div");
    body.className = "reasoning-body";
    body.textContent = text;
    toggle.addEventListener("click", () => {
      toggle.classList.toggle("open");
      body.classList.toggle("open");
    });
    block.appendChild(toggle);
    block.appendChild(body);
    bubble.before(block);
    // Reasoning has finished rendering, but the backend may still be deciding
    // whether to call another tool. Keep a visible hand-off state until the
    // next tool_start or final output replaces it.
    showToolActivity(target);
    return true;
  }

  function markStopped(target, noteText, typing) {
    const msg = _stateFor(target);
    const bubble = _bubbleFor(target);
    const body = _bodyFor(target);
    if (!msg || !bubble || !body) return false;
    hideToolActivity(target);
    _removeTyping(typing);
    msg.stopped = true;
    const stopNote = document.createElement("div");
    stopNote.className = "stop-note";
    stopNote.textContent = noteText || "";
    bubble.before(stopNote);
    if (!bubble.textContent.trim()) bubble.remove();
    return true;
  }

  function finishFinishedTools(target) {
    const msg = _stateFor(target);
    if (!msg || !Array.isArray(msg.tools)) return false;
    let changed = false;
    msg.tools.forEach(item => {
      if (item.kind === "step" && item.markedFinished && !item.finished && !item.finishTimer) {
        if (_finishToolItem(msg, item)) changed = true;
      }
    });
    if (changed) _renderToolsFor(msg);
    return true;
  }

  function showToolActivity(target, text) {
    const msg = _stateFor(target);
    if (!msg) return false;
    msg.tools = msg.tools || [];
    const hasActiveStep = msg.tools.some(item =>
      item.kind === "step" && !item.finished && !item.markedFinished
    );
    if (hasActiveStep) return true;
    const existing = msg.tools.find(item => item.kind === ACTIVITY_KIND);
    if (existing) {
      existing.text = _activityText(text);
    } else {
      msg.tools.push({
        id: `activity-${++toolSeq}`,
        kind: ACTIVITY_KIND,
        text: _activityText(text),
        startedAt: Date.now(),
      });
    }
    _renderToolsFor(msg);
    return true;
  }

  function hideToolActivity(target) {
    const msg = _stateFor(target);
    if (!msg || !Array.isArray(msg.tools)) return false;
    const before = msg.tools.length;
    msg.tools = msg.tools.filter(item => item.kind !== ACTIVITY_KIND);
    if (msg.tools.length !== before) _renderToolsFor(msg);
    return true;
  }

  function finishAllTools(target) {
    const msg = _stateFor(target);
    if (!msg || !Array.isArray(msg.tools)) return false;
    let changed = false;
    msg.tools.forEach(item => {
      if (item.kind === "step" && !item.finished) {
        item.markedFinished = true;
        if (_finishToolItem(msg, item)) changed = true;
      }
    });
    if (changed) _renderToolsFor(msg);
    return true;
  }

  function _finishToolItem(msg, item) {
    if (!item || item.finished) return false;
    const elapsed = Date.now() - (item.startedAt || Date.now());
    const remaining = MIN_TOOL_VISIBLE_MS - elapsed;
    if (remaining > 0) {
      item.markedFinished = true;
      if (!item.finishTimer) {
        item.finishTimer = setTimeout(() => {
          item.finishTimer = null;
          item.finished = true;
          item.markedFinished = true;
          _renderToolsFor(msg);
        }, remaining);
      }
      return false;
    }
    if (item.finishTimer) {
      clearTimeout(item.finishTimer);
      item.finishTimer = null;
    }
    item.finished = true;
    item.markedFinished = true;
    return true;
  }

  function startTool(target, ev) {
    const msg = _stateFor(target);
    if (!msg) return false;
    msg.tools = msg.tools || [];
    // Replace the inter-step activity row and add the real tool in one render.
    // Calling hideToolActivity() here would render an empty intermediate state
    // that can become visible when the browser is under load.
    msg.tools = msg.tools.filter(item => item.kind !== ACTIVITY_KIND);
    msg.tools.forEach(item => {
      if (item.kind === "step" && item.markedFinished && !item.finished && !item.finishTimer) {
        _finishToolItem(msg, item);
      }
    });
    const tool = ev.tool || "";
    msg.tools.push({
      id: `tool-${++toolSeq}`,
      kind: "step",
      tool,
      compaction: tool === "compaction",
      summary: _toolSummary(ev),
      detail: _toolDetail(ev),
      startedAt: Date.now(),
      open: false,
      markedFinished: false,
      finished: false,
    });
    _renderToolsFor(msg);
    return true;
  }

  function endTool(target) {
    const msg = _stateFor(target);
    if (!msg || !Array.isArray(msg.tools)) return false;
    const tool = arguments.length > 1 && arguments[1] ? arguments[1].tool : "";
    const step = msg.tools.find(item =>
      item.kind === "step" &&
      !item.finished &&
      !item.markedFinished &&
      (!tool || item.tool === tool)
    ) || msg.tools.find(item => item.kind === "step" && !item.finished && !item.markedFinished);
    if (!step) return true;
    step.markedFinished = true;
    if (_finishToolItem(msg, step)) _renderToolsFor(msg);
    return true;
  }

  function setKnowledgeRefs(target, ev) {
    const msg = _stateFor(target);
    const step = _latestStep(msg, "query_knowledge");
    if (!step) return false;
    const refs = Array.isArray(ev.refs) ? ev.refs : [];
    return _upsertPanel(msg, step, {
      id: `panel-${++toolSeq}`,
      kind: "refs",
      panelClass: "knowledge-refs",
      refs,
      title: refs.length ? `引用来源（${refs.length} 条）` : "引用来源（未命中）",
      open: false,
    });
  }

  function setDataRefs(target, ev) {
    const msg = _stateFor(target);
    const refs = Array.isArray(ev.refs) ? ev.refs : [];
    if (!refs.length) return true;
    const step = _latestStep(msg, "query_data")
      || _latestStep(msg, "create_analysis_table")
      || _latestStep(msg, "run_analysis")
      || _latestStep(msg, "generate_chart");
    if (!step) return false;
    return _upsertPanel(msg, step, {
      id: `panel-${++toolSeq}`,
      kind: "refs",
      panelClass: "data-refs",
      refs,
      title: `数据依据（${refs.length} 条）`,
      open: false,
    });
  }

  function setToolAudit(target, ev) {
    const msg = _stateFor(target);
    const tool = ev.tool || "";
    if (!tool) return false;
    const step = _latestStep(msg, tool);
    if (!step) return false;
    const elapsed = ev.elapsed_seconds !== undefined ? `${ev.elapsed_seconds}s` : "";
    const sourceCount = Array.isArray(ev.sources) ? ev.sources.length : 0;
    const artifactCount = Array.isArray(ev.artifacts) ? ev.artifacts.length : 0;
    const bits = [
      ev.parallel ? "并行" : "",
      elapsed && `耗时 ${elapsed}`,
      sourceCount ? `来源 ${sourceCount}` : "",
      artifactCount ? `产物 ${artifactCount}` : "",
      ev.error ? `错误 ${ev.error}` : "",
    ].filter(Boolean);
    let argsTitle = "";
    if (ev.args_preview) {
      try { argsTitle = JSON.stringify(ev.args_preview, null, 2); } catch (_) {}
    }
    return _upsertPanel(msg, step, {
      id: `panel-${++toolSeq}`,
      kind: "audit",
      panelClass: "tool-audit",
      tool,
      ok: ev.ok,
      status: bits.length ? bits.join(" · ") : "工具执行完成",
      content: ev.content ?? ev.data ?? ev.summary ?? "",
      argsTitle,
      open: false,
    });
  }

  function addChartRef(target, chartId) {
    const msg = _stateFor(target);
    if (!msg || !chartId) return false;
    hideToolActivity(target);
    msg.charts = msg.charts || [];
    if (msg.charts.some(item => item.chartId === chartId)) return true;
    msg.charts.push({
      id: `chart-${++chartSeq}`,
      chartId,
    });
    _renderChartsFor(msg);
    return true;
  }

  function addOutlineCard(target, data, callbacks) {
    const msg = _stateFor(target);
    if (!msg || !data) return false;
    hideToolActivity(target);
    msg.cards = msg.cards || [];
    const card = {
      id: `card-${++cardSeq}`,
      kind: "outline",
      icon: data.icon || "📄",
      headerTitle: data.headerTitle || "",
      markdown: data.markdown || "",
      editOpen: false,
      editText: "",
      locked: false,
      cancelled: false,
      callbacks: callbacks || {},
      _msg: msg,
    };
    msg.cards.push(card);
    _renderCardsFor(msg);
    return true;
  }

  function addAskUserCard(target, ev, callbacks) {
    const msg = _stateFor(target);
    if (!msg || !ev) return false;
    hideToolActivity(target);
    msg.cards = msg.cards || [];
    const card = {
      id: `card-${++cardSeq}`,
      kind: "ask_user",
      question: ev.question || "",
      options: Array.isArray(ev.options) ? ev.options.slice() : [],
      multiSelect: !!ev.multi_select,
      selected: [],
      otherOpen: false,
      otherText: "",
      locked: false,
      callbacks: callbacks || {},
      _msg: msg,
    };
    msg.cards.push(card);
    _renderCardsFor(msg);
    return true;
  }

  window.BAA.vueChat = {
    appendMsg,
    sysMsg,
    clear,
    countMessages,
    setTurnQueueState,
    renderComposerQueue,
    setMessageText,
    removeMessages,
    appendTextDelta,
    setMarkdown,
    setError,
    addReasoning,
    markStopped,
    finishFinishedTools,
    finishAllTools,
    showToolActivity,
    hideToolActivity,
    startTool,
    endTool,
    setKnowledgeRefs,
    setDataRefs,
    setToolAudit,
    addChartRef,
    updateJob,
    addOutlineCard,
    addAskUserCard,
  };
})();

// Progressive Vue island #4: Settings modal (built-in providers + custom models + add-custom form).
// Mount points: #builtin-providers, #custom-list, #add-custom-form (three roots, one state).
// Exposes window.BAA.vueSettings. Falls back to models.js legacy innerHTML when unavailable.
(function () {
  window.BAA = window.BAA || {};
  const Vue = window.Vue;
  const root1 = document.getElementById("builtin-providers");
  const root2 = document.getElementById("custom-list");
  const root3 = document.getElementById("add-custom-form");
  if (!Vue || !Vue.h || !Vue.render || !root1 || !root2 || !root3) return;

  // 立即清空三个挂载点的原始静态 HTML，防止 Vue 渲染与静态内容叠加
  root1.innerHTML = "";
  root2.innerHTML = "";
  root3.innerHTML = "";

  const { h, render, Fragment, reactive } = Vue;

  const COMMON_ICON = "/static/Images/icon.png";
  const BUILTIN_META = {
    deepseek:   { label: "DeepSeek",         icon: COMMON_ICON },
    openai:     { label: "OpenAI / ChatGPT", icon: COMMON_ICON },
    atlascloud: { label: "AtlasCloud",       icon: COMMON_ICON },
  };

  const state = reactive({
    providers: [],       // { key, label, icon, hasKey, defaults, cfg, fields, msg, busy }
    customs: [],         // { key, name, model, baseUrl }
    formOpen: false,     // add-custom-form 展开
    editingKey: null,    // 正在编辑的 custom key（null = 添加模式）
    form: {              // add + edit 共用表单
      name: "", url: "", model: "", key: "",
      ctx: "", output: "",
      think: false, budget: "8000",
    },
    formMsg: { err: "", ok: "" },
  });

  let callbacks = {};    // { onSave, onTest, onClear, onFieldChange, onSubmitForm, onCancelForm, onEditCustom, onDeleteCustom, onTestCustom }

  // ── 渲染分发 ───────────────────────────────────────────────────
  function renderAll() {
    _renderProviders();
    _renderCustoms();
    _renderForm();
  }

  function _renderProviders() {
    if (!state.providers.length) { render(null, root1); return; }
    render(h(Fragment, null, state.providers.map(_renderProviderCard)), root1);
  }

  function _renderCustoms() {
    if (!state.customs.length) {
      render(h("div", { class: "custom-empty" }, t('custom_empty')), root2);
      return;
    }
    render(h(Fragment, null, state.customs.map(_renderCustomItem)), root2);
  }

  function _renderForm() {
    // .show class 控制显隐，由 toggleAddCustom/openForm/closeForm 管理
    root3.classList.toggle("show", state.formOpen);
    if (!state.formOpen) { render(null, root3); return; }
    render(h(Fragment, null, [
      h("input", {
        type: "text", placeholder: t('add_custom.name_ph') || "供应商名称（显示用），例如 DeepSeek",
        value: state.form.name,
        onInput: e => { state.form.name = e.target.value; },
      }),
      h("input", {
        type: "text", placeholder: t('add_custom.url_ph') || "API Base URL，例如 https://api.deepseek.com",
        value: state.form.url,
        onInput: e => { state.form.url = e.target.value; },
      }),
      h("input", {
        type: "text", placeholder: t('add_custom.model_ph') || "Model ID（传入 API 的模型名），例如 deepseek-chat",
        value: state.form.model,
        onInput: e => { state.form.model = e.target.value; },
      }),
      h("input", {
        type: "password", placeholder: t('add_custom.key_ph') || "API Key",
        value: state.form.key,
        onInput: e => { state.form.key = e.target.value; },
      }),
      h("div", { style: "display:flex;gap:8px;" }, [
        h("input", {
          type: "number",
          placeholder: t('add_custom.ctx_ph') || "上下文窗口（tokens，选填）",
          style: "flex:1",
          value: state.form.ctx,
          onInput: e => { state.form.ctx = e.target.value; },
        }),
        h("input", {
          type: "number",
          placeholder: t('add_custom.out_ph') || "最大输出（tokens，选填）",
          style: "flex:1",
          value: state.form.output,
          onInput: e => { state.form.output = e.target.value; },
        }),
      ]),
      h("label", {
        style: "display:flex;align-items:center;gap:6px;font-size:13px;color:#475569;cursor:pointer;padding:2px 0",
      }, [
        h("input", {
          type: "checkbox",
          checked: state.form.think,
          onChange: e => { state.form.think = e.target.checked; _renderForm(); },
        }),
        h("span", null, t('add_custom.think') || "启用思考模式"),
      ]),
      state.form.think ? h("div", {
        style: "display:flex;align-items:center;gap:8px;font-size:13px;color:#475569",
      }, [
        h("label", { style: "white-space:nowrap" }, t('add_custom.budget') || "思考预算（tokens）"),
        h("input", {
          type: "number", min: "1000", max: "100000", step: "1000",
          style: "flex:1",
          value: state.form.budget,
          onInput: e => { state.form.budget = e.target.value; },
        }),
      ]) : null,
      h("div", { class: "msg-err" }, state.formMsg.err),
      h("div", { class: "msg-ok" }, state.formMsg.ok),
      h("div", { style: "display:flex;gap:7px;justify-content:flex-end;" }, [
        h("button", {
          class: "btn-sm btn-sm-ghost",
          onClick: () => callbacks.onCancelForm && callbacks.onCancelForm(),
        }, t('modal.cancel') || "取消"),
        h("button", {
          class: "btn-sm btn-sm-primary",
          onClick: () => callbacks.onSubmitForm && callbacks.onSubmitForm(),
        }, t('modal.save_btn') || "保存"),
      ]),
    ]), root3);
  }

  // ── provider 卡片 ──────────────────────────────────────────────
  function _renderProviderCard(p) {
    const isBusy = !!p.busy;
    return h("div", { class: "provider-card" }, [
      h("div", { class: "provider-head" }, [
        h("img", { class: "provider-icon", src: p.icon, alt: p.label }),
        h("span", { class: "provider-name" }, p.label),
        h("span", {
          class: `provider-status ${p.hasKey ? "set" : "unset"}`,
        }, p.hasKey ? t('settings.configured') : t('settings.not_configured')),
      ]),
      h("div", { class: "provider-fields" }, [
        _pfRow(t('settings.api_key'),
          h("input", {
            type: "password",
            placeholder: t('settings.api_key_ph'),
            value: p.fields.apiKey,
            onInput: e => { p.fields.apiKey = e.target.value; },
          })
        ),
        _pfRow(t('settings.base_url'),
          h("input", {
            type: "text",
            placeholder: p.defaults.base_url,
            value: p.fields.baseUrl,
            onInput: e => { p.fields.baseUrl = e.target.value; },
          })
        ),
        _pfRow(t('settings.model'),
          h("input", {
            type: "text",
            placeholder: p.defaults.model,
            value: p.fields.model,
            onInput: e => { p.fields.model = e.target.value; },
          })
        ),
        _pfRow(t('settings.ctx_window'),
          h("input", {
            type: "number",
            placeholder: t('settings.ctx_ph'),
            value: p.fields.ctx,
            onInput: e => { p.fields.ctx = e.target.value; },
          })
        ),
        _pfRow(t('settings.max_output'),
          h("input", {
            type: "number",
            placeholder: t('settings.out_ph'),
            value: p.fields.output,
            onInput: e => { p.fields.output = e.target.value; },
          })
        ),
        h("div", { class: "pf-row", style: "align-items:center" }, [
          h("label", null, t('settings.thinking')),
          h("label", {
            style: "display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;color:#475569",
          }, [
            h("input", {
              type: "checkbox",
              checked: p.fields.think,
              onChange: e => {
                p.fields.think = e.target.checked;
                _renderProviders();
              },
            }),
            t('settings.thinking_label'),
          ]),
        ]),
        p.fields.think ? h("div", { class: "pf-row", style: "align-items:center" }, [
          h("label", null, t('settings.budget') || "思考预算（tokens）"),
          h("input", {
            type: "number", min: "1000", max: "100000", step: "1000",
            value: p.fields.budget,
            onInput: e => { p.fields.budget = e.target.value; },
          }),
        ]) : null,
      ]),
      h("div", { class: "provider-actions" }, [
        h("button", {
          class: "btn-sm btn-sm-danger",
          disabled: isBusy,
          onClick: () => callbacks.onClear && callbacks.onClear(p.key),
        }, t('settings.clear')),
        h("button", {
          class: "btn-sm btn-sm-ghost",
          disabled: isBusy,
          onClick: () => callbacks.onTest && callbacks.onTest(p.key),
        }, p.busy === "test" ? (t('settings.testing') || "测试中…") : (t('settings.test') || "测试")),
        h("button", {
          class: "btn-sm btn-sm-primary",
          disabled: isBusy,
          onClick: () => callbacks.onSave && callbacks.onSave(p.key),
        }, p.busy === "save" ? (t('settings.saving') || "保存中…") : t('settings.save')),
      ]),
      p.msg.text ? h("div", { class: `provider-msg ${p.msg.type}` }, p.msg.text) : null,
    ]);
  }

  function _pfRow(labelText, inputEl) {
    return h("div", { class: "pf-row" }, [
      h("label", null, labelText),
      inputEl,
    ]);
  }

  // ── custom 列表项 ─────────────────────────────────────────────
  function _renderCustomItem(c) {
    return h("div", { class: "custom-item" }, [
      h("span", { class: "ci-name" }, c.name || c.model || c.key),
      h("span", { class: "ci-model" }, c.model || c.baseUrl || ""),
      h("button", {
        class: "btn-sm btn-sm-ghost",
        onClick: () => callbacks.onTestCustom && callbacks.onTestCustom(c.key),
      }, t('settings.test') || "测试"),
      h("button", {
        class: "btn-sm btn-sm-ghost",
        onClick: () => callbacks.onEditCustom && callbacks.onEditCustom(c.key),
      }, t('settings.edit_custom') || "编辑"),
      h("button", {
        class: "btn-sm btn-sm-danger",
        onClick: () => callbacks.onDeleteCustom && callbacks.onDeleteCustom(c.key),
      }, t('settings.del_custom')),
    ]);
  }

  // ── state 操作 API ────────────────────────────────────────────
  function _initFields(cfg, def) {
    return {
      apiKey:  "",
      baseUrl: cfg.base_url || def.base_url || "",
      model:   cfg.model || def.model || "",
      ctx:     cfg.context_window != null ? String(cfg.context_window) : (def.context_window != null ? String(def.context_window) : ""),
      output:  cfg.max_output_tokens != null ? String(cfg.max_output_tokens) : (def.max_output_tokens != null ? String(def.max_output_tokens) : ""),
      think:   !!cfg.enable_thinking,
      budget:  cfg.thinking_budget != null ? String(cfg.thinking_budget) : "8000",
    };
  }

  function setProviders(configs, defaults) {
    // 保留现有 fields（用户正在输入的未保存值），仅刷新 hasKey/cfg。
    // 例外：hasKey 从 true→false（刚清除）时重置 fields 为 defaults。
    state.providers = Object.entries(defaults).map(([key, def]) => {
      const meta = BUILTIN_META[key] || { label: key, icon: COMMON_ICON };
      const cfg = configs[key] || {};
      const newHasKey = !!cfg.has_api_key;
      const existing = state.providers.find(p => p.key === key);
      const wasCleared = existing && existing.hasKey && !newHasKey;
      return {
        key,
        label: meta.label,
        icon: meta.icon,
        hasKey: newHasKey,
        defaults: def,
        cfg,
        fields: (existing && !wasCleared) ? existing.fields : _initFields(cfg, def),
        msg: existing ? existing.msg : { text: "", type: "" },
        busy: existing ? existing.busy : null,
      };
    });
    _renderProviders();
  }

  function clearProviderApiKey(key) {
    const p = state.providers.find(x => x.key === key);
    if (!p) return;
    p.fields.apiKey = "";
    p.hasKey = true;
    _renderProviders();
  }

  function setCustoms(configs) {
    state.customs = Object.entries(configs)
      .filter(([, v]) => v.is_custom)
      .map(([key, cfg]) => ({
        key,
        name: cfg.name || "",
        model: cfg.model || "",
        baseUrl: cfg.base_url || "",
      }));
    _renderCustoms();
  }

  function setProviderStatus(key, type, text) {
    const p = state.providers.find(x => x.key === key);
    if (!p) return;
    p.msg = { type, text };
    _renderProviders();
  }

  function setProviderBusy(key, busy) {
    const p = state.providers.find(x => x.key === key);
    if (!p) return;
    p.busy = busy || null;
    _renderProviders();
  }

  function openForm(editingKey, cfg) {
    state.editingKey = editingKey || null;
    state.formMsg = { err: "", ok: "" };
    if (editingKey && cfg) {
      // 编辑模式：用完整 cfg 预填
      state.form = {
        name: cfg.name || "",
        url: cfg.base_url || "",
        model: cfg.model || "",
        key: "",
        ctx: cfg.context_window != null ? String(cfg.context_window) : "",
        output: cfg.max_output_tokens != null ? String(cfg.max_output_tokens) : "",
        think: !!cfg.enable_thinking,
        budget: cfg.thinking_budget != null ? String(cfg.thinking_budget) : "8000",
      };
    } else {
      // 添加模式：清空
      state.form = { name: "", url: "", model: "", key: "", ctx: "", output: "", think: false, budget: "8000" };
    }
    state.formOpen = true;
    _renderForm();
  }

  function closeForm() {
    state.formOpen = false;
    state.editingKey = null;
    state.formMsg = { err: "", ok: "" };
    _renderForm();
  }

  function toggleForm() {
    if (state.formOpen) closeForm();
    else openForm(null);
  }

  function setFormField(name, value) {
    state.form[name] = value;
    // think 切换需要重渲染（budget row 显隐）
    if (name === "think") _renderForm();
  }

  function setFormMsg(err, ok) {
    state.formMsg = { err: err || "", ok: ok || "" };
    _renderForm();
  }

  function getFormValues() {
    return {
      name: state.form.name,
      url: state.form.url,
      model: state.form.model,
      key: state.form.key,
      ctx: state.form.ctx,
      output: state.form.output,
      think: state.form.think,
      budget: state.form.budget,
      editingKey: state.editingKey,
    };
  }

  function getProviderFields(key) {
    const p = state.providers.find(x => x.key === key);
    if (!p) return null;
    return { ...p.fields };
  }

  function refreshCustoms(configs) {
    setCustoms(configs);
  }

  function sync(configs, defaults, cbs) {
    callbacks = cbs || {};
    setProviders(configs, defaults);
    setCustoms(configs);
  }

  // 初始化时立即清空三个挂载点的原始静态 HTML（否则 Vue 渲染会叠加在静态内容上）
  renderAll();

  window.BAA.vueSettings = {
    isAvailable: () => true,
    sync,
    setProviders,
    setCustoms,
    refreshCustoms,
    setProviderStatus,
    setProviderBusy,
    clearProviderApiKey,
    openForm,
    closeForm,
    toggleForm,
    setFormField,
    setFormMsg,
    getFormValues,
    getProviderFields,
  };
})();

// Progressive Vue island #5: Knowledge base modal (tabs + 3 list panels + form body).
// Mount points: #kb-tabs, #kb-panel-metrics, #kb-panel-rules, #kb-panel-notes, #kb-form-body.
// Import panel (#kb-panel-import) is NOT managed by Vue — it keeps legacy DOM.
// Exposes window.BAA.vueKb. Falls back to knowledge_panel.js legacy innerHTML when unavailable.
(function () {
  window.BAA = window.BAA || {};
  const Vue = window.Vue;
  const root1 = document.getElementById("kb-tabs");
  const root2 = document.getElementById("kb-panel-metrics");
  const root3 = document.getElementById("kb-panel-rules");
  const root4 = document.getElementById("kb-panel-notes");
  const root5 = document.getElementById("kb-form-body");
  if (!Vue || !Vue.h || !Vue.render || !Vue.Fragment ||
      !root1 || !root2 || !root3 || !root4 || !root5) return;

  // 清空 5 个挂载点的静态 HTML（#kb-panel-import 不清空，保留旧 DOM）
  root1.innerHTML = "";
  root2.innerHTML = "";
  root3.innerHTML = "";
  root4.innerHTML = "";
  root5.innerHTML = "";

  const { h, render, Fragment, reactive } = Vue;

  const TABS = [
    { key: "metrics", icon: "📐", label: "指标定义" },
    { key: "rules",   icon: "🛡", label: "业务规则" },
    { key: "notes",   icon: "📝", label: "背景知识" },
    { key: "import",  icon: "⬆", label: "导入文件", importTab: true },
  ];

  const TYPE_LABELS = {
    metrics: "指标", rules: "规则", notes: "背景知识",
  };

  const state = reactive({
    tab: "metrics",
    lists: {
      metrics: { items: [], count: "—", loading: false, err: "" },
      rules:   { items: [], count: "—", loading: false, err: "" },
      notes:   { items: [], count: "—", loading: false, err: "" },
    },
    form: {
      mode: "add",       // add | edit
      type: "metrics",   // metrics | rules | notes
      editId: null,
      fields: {
        name: "", alias: "", definition: "", sql_template: "", notes: "",
        rule_id: "", description: "", condition: "", severity: "warning",
        topic: "", content: "", tags: "",
      },
      err: "", busy: false,
    },
  });

  let callbacks = {};  // { onSwitchTab, onToggle, onOpenForm, onSubmitForm, onCancelForm, onDelete }

  // ── 渲染分发 ───────────────────────────────────────────────────
  function renderAll() {
    _renderTabs();
    _renderPanel("metrics");
    _renderPanel("rules");
    _renderPanel("notes");
    _renderForm();
    // import panel 不由 Vue 渲染，但显隐由 Vue 管（切到 import tab 时显示）
    const importPanel = document.getElementById("kb-panel-import");
    if (importPanel) importPanel.style.display = state.tab === "import" ? "flex" : "none";
  }

  function _renderTabs() {
    render(h("div", { class: "kb-tabs" }, TABS.map(tb => {
      const active = state.tab === tb.key;
      const cls = ["kb-tab"];
      if (active) cls.push("active");
      if (tb.importTab) cls.push("kb-tab-import");
      return h("button", {
        class: cls,
        onClick: () => callbacks.onSwitchTab && callbacks.onSwitchTab(tb.key),
      }, `${tb.icon} ${tb.label}`);
    })), root1);
  }

  function _renderPanel(type) {
    const root = { metrics: root2, rules: root3, notes: root4 }[type];
    if (!root) return;
    const L = state.lists[type];
    // 显隐：直接控制 root 元素（#kb-panel-* 本身就是 .kb-panel）
    root.style.display = state.tab === type ? "flex" : "none";

    const toolbar = h("div", { class: "kb-toolbar" }, [
      h("span", { class: "kb-count" }, L.count),
      h("div", { style: "display:flex;gap:6px" }, [
        h("button", {
          class: "btn-sm btn-sm-ghost",
          title: "刷新列表",
          onClick: () => callbacks.onSwitchTab && callbacks.onSwitchTab(type),
        }, "↻ 刷新"),
        h("button", {
          class: "btn-sm btn-sm-primary",
          onClick: () => callbacks.onOpenForm && callbacks.onOpenForm(type, null),
        }, `＋ 新增${TYPE_LABELS[type]}`),
      ]),
    ]);

    let listContent;
    if (L.loading) {
      listContent = h("div", { class: "kb-empty" }, "加载中…");
    } else if (L.err) {
      listContent = h("div", { class: "kb-empty", style: "color:#ef4444" }, `加载失败: ${L.err}`);
    } else if (!L.items.length) {
      const emptyText = `暂无${TYPE_LABELS[type]}${type === "metrics" ? "定义" : ""}`;
      listContent = h("div", { class: "kb-empty" }, emptyText);
    } else {
      listContent = h(Fragment, null, L.items.map(item => _renderCard(type, item)));
    }

    const list = h("div", { class: "kb-list", id: `kb-list-${type}` }, listContent);
    render(h(Fragment, null, [toolbar, list]), root);
  }

  function _renderCard(type, item) {
    const cardStyle = item.enabled ? {} : { style: "opacity:.45" };
    const actions = h("div", { class: "kb-card-actions" }, [
      _renderToggle(item.enabled, () => callbacks.onToggle && callbacks.onToggle(type, item.id)),
      h("button", {
        class: "kb-act-btn",
        onClick: () => callbacks.onOpenForm && callbacks.onOpenForm(type, item.id),
      }, "编辑"),
      h("button", {
        class: "kb-act-btn danger",
        onClick: () => callbacks.onDelete && callbacks.onDelete(type, item.id),
      }, "删除"),
    ]);

    if (type === "metrics") {
      return h("div", Object.assign({ class: "kb-card", id: `kbc-metrics-${item.id}` }, cardStyle), [
        h("div", { class: "kb-card-head" }, [
          h("div", { class: "kb-card-name" }, [
            h("span", { class: "kb-badge kb-badge-metric" }, "指标"),
            ` ${item.name || ""}`,
            item.alias ? h("span", { style: "font-size:12px;color:#94a3b8;font-weight:400" }, ` · ${item.alias}`) : null,
          ]),
          actions,
        ]),
        item.definition ? h("div", { class: "kb-card-meta" }, item.definition) : null,
        item.sql_template ? h("div", { class: "kb-card-sql" }, item.sql_template) : null,
        item.notes ? h("div", { class: "kb-card-meta", style: "color:#94a3b8;font-size:11px" }, `备注：${item.notes}`) : null,
      ]);
    }

    if (type === "rules") {
      const badgeCls = item.severity === "error" ? "kb-badge kb-badge-rule-error" : "kb-badge kb-badge-rule-warning";
      return h("div", Object.assign({ class: "kb-card", id: `kbc-rules-${item.id}` }, cardStyle), [
        h("div", { class: "kb-card-head" }, [
          h("div", { class: "kb-card-name" }, [
            h("span", { class: badgeCls }, item.severity || "warning"),
            ` ${item.rule_id || ""}`,
          ]),
          actions,
        ]),
        item.description ? h("div", { class: "kb-card-meta" }, item.description) : null,
        item.condition ? h("div", { class: "kb-card-sql" }, item.condition) : null,
      ]);
    }

    // notes
    return h("div", Object.assign({ class: "kb-card", id: `kbc-notes-${item.id}` }, cardStyle), [
      h("div", { class: "kb-card-head" }, [
        h("div", { class: "kb-card-name" }, [
          h("span", { class: "kb-badge kb-badge-note" }, "背景"),
          ` ${item.topic || ""}`,
          item.tags ? h("span", { style: "font-size:11px;color:#94a3b8;font-weight:400" }, ` ${item.tags}`) : null,
        ]),
        actions,
      ]),
      item.content ? h("div", { class: "kb-card-meta" }, item.content) : null,
    ]);
  }

  function _renderToggle(enabled, onClick) {
    return h("div", {
      class: `kb-toggle ${enabled ? "on" : ""}`,
      title: enabled ? "已启用，点击禁用" : "已禁用，点击启用",
      onClick,
    }, [h("div", { class: "kb-toggle-knob" })]);
  }

  function _renderForm() {
    const f = state.form;
    const type = f.type;
    const fields = f.fields;

    let fieldNodes;
    if (type === "metrics") {
      fieldNodes = [
        _renderField("指标名称", true, "text", fields.name, v => { fields.name = v; }, "例如：DAU"),
        _renderField("别名（逗号分隔）", false, "text", fields.alias, v => { fields.alias = v; }, "日活, 日活跃用户"),
        _renderField("业务定义", false, "textarea", fields.definition, v => { fields.definition = v; }, "当日启动游戏一次及以上的独立设备数", 2),
        _renderField("SQL 模板", false, "textarea", fields.sql_template, v => { fields.sql_template = v; }, "SELECT COUNT(DISTINCT device_id) FROM events WHERE date='{date}'", 3),
        _renderField("口径备注", false, "textarea", fields.notes, v => { fields.notes = v; }, "剔除机器人流量；iOS/Android 分开统计", 2),
      ];
    } else if (type === "rules") {
      fieldNodes = [
        _renderField("规则 ID", true, "text", fields.rule_id, v => { fields.rule_id = v; }, "例如：retention_sanity"),
        _renderField("描述", false, "text", fields.description, v => { fields.description = v; }, "次日留存不能超过首日 DAU"),
        _renderField("违反条件", false, "textarea", fields.condition, v => { fields.condition = v; }, "day2_retention > day1_dau", 2),
        _renderSelect("严重程度", fields.severity, v => { fields.severity = v; }, [
          { value: "warning", label: "warning" },
          { value: "error", label: "error" },
        ]),
      ];
    } else {
      // notes
      fieldNodes = [
        _renderField("主题", true, "text", fields.topic, v => { fields.topic = v; }, "例如：流失分析"),
        _renderField("内容", false, "textarea", fields.content, v => { fields.content = v; }, "分析流失时需检查：版本更新、服务器波动、竞品上线…", 4),
        _renderField("标签（逗号分隔）", false, "text", fields.tags, v => { fields.tags = v; }, "流失, churn, 留存"),
      ];
    }

    const errNode = f.err ? h("div", { class: "msg-err" }, f.err) : null;
    render(h(Fragment, null, [...fieldNodes, errNode]), root5);
  }

  function _renderField(label, required, inputType, value, onInput, placeholder, rows) {
    const labelNode = required
      ? h("label", null, [label, " ", h("span", { style: "color:#ef4444" }, "*")])
      : h("label", null, label);
    const inputNode = inputType === "textarea"
      ? h("textarea", { rows: rows || 2, placeholder, onInput: e => onInput(e.target.value) }, value)
      : h("input", { type: inputType, value, placeholder, onInput: e => onInput(e.target.value) });
    return h("div", { class: "f-row" }, [labelNode, inputNode]);
  }

  function _renderSelect(label, value, onChange, options) {
    return h("div", { class: "f-row" }, [
      h("label", null, label),
      h("select", { value, onChange: e => onChange(e.target.value) },
        options.map(o => h("option", { value: o.value }, o.label))),
    ]);
  }

  // ── facade API ────────────────────────────────────────────────
  function sync(cbs) {
    callbacks = cbs || {};
  }

  function onOpen() {
    callbacks.onSwitchTab && callbacks.onSwitchTab(state.tab);
  }

  function setTab(tab) {
    state.tab = tab;
    renderAll();
  }

  function getTab() {
    return state.tab;
  }

  function _recalcCount(type) {
    const L = state.lists[type];
    if (!L) return;
    const enabled = L.items.filter(r => r.enabled).length;
    L.count = `共 ${L.items.length} 条 · ${enabled} 条已启用`;
  }

  function setItems(type, items) {
    if (!state.lists[type]) return;
    const L = state.lists[type];
    L.items = items || [];
    L.loading = false;
    L.err = "";
    _recalcCount(type);
    _renderPanel(type);
  }

  function setListStatus(type, opts) {
    if (!state.lists[type]) return;
    const L = state.lists[type];
    if (!opts) return;
    if (opts.loading !== undefined) L.loading = opts.loading;
    if (opts.err !== undefined) L.err = opts.err;
    if (opts.count !== undefined) L.count = opts.count;
    _renderPanel(type);
  }

  function getItem(type, id) {
    const L = state.lists[type];
    if (!L) return null;
    return L.items.find(x => x.id === id) || null;
  }

  function updateItem(type, id, patch) {
    const L = state.lists[type];
    if (!L) return;
    const item = L.items.find(x => x.id === id);
    if (!item) return;
    Object.assign(item, patch);
    _recalcCount(type);
    _renderPanel(type);
  }

  function removeItem(type, id) {
    const L = state.lists[type];
    if (!L) return;
    const idx = L.items.findIndex(x => x.id === id);
    if (idx < 0) return;
    L.items.splice(idx, 1);
    _recalcCount(type);
    _renderPanel(type);
  }

  function openForm(opts) {
    const f = state.form;
    const type = opts.type;
    const mode = opts.mode || "add";
    const editId = opts.editId != null ? opts.editId : null;
    const rec = opts.rec;

    f.type = type;
    f.mode = mode;
    f.editId = editId;
    f.err = "";
    f.busy = false;
    // 重置 fields
    f.fields = {
      name: "", alias: "", definition: "", sql_template: "", notes: "",
      rule_id: "", description: "", condition: "", severity: "warning",
      topic: "", content: "", tags: "",
    };
    // 编辑模式预填
    if (rec) {
      if (type === "metrics") {
        f.fields.name = rec.name || "";
        f.fields.alias = rec.alias || "";
        f.fields.definition = rec.definition || "";
        f.fields.sql_template = rec.sql_template || "";
        f.fields.notes = rec.notes || "";
      } else if (type === "rules") {
        f.fields.rule_id = rec.rule_id || "";
        f.fields.description = rec.description || "";
        f.fields.condition = rec.condition || "";
        f.fields.severity = rec.severity || "warning";
      } else if (type === "notes") {
        f.fields.topic = rec.topic || "";
        f.fields.content = rec.content || "";
        f.fields.tags = rec.tags || "";
      }
    }
    // 设置 form title（#kb-form-title 在 #kb-form-body 外，由 Vue island 代管）
    const titleEl = document.getElementById("kb-form-title");
    if (titleEl) {
      titleEl.textContent = (mode === "edit" ? "编辑" : "新增") + TYPE_LABELS[type];
    }
    _renderForm();
  }

  function closeForm() {
    state.form.err = "";
    state.form.busy = false;
  }

  function setFormField(key, val) {
    state.form.fields[key] = val;
  }

  function setFormErr(msg) {
    state.form.err = msg || "";
    _renderForm();
  }

  function setFormBusy(b) {
    state.form.busy = !!b;
  }

  function getFormValues() {
    const f = state.form;
    const fields = f.fields;
    if (f.type === "metrics") {
      return {
        type: f.type, mode: f.mode, editId: f.editId,
        body: {
          name: (fields.name || "").trim(),
          alias: (fields.alias || "").trim(),
          definition: (fields.definition || "").trim(),
          sql_template: (fields.sql_template || "").trim(),
          notes: (fields.notes || "").trim(),
        },
      };
    }
    if (f.type === "rules") {
      return {
        type: f.type, mode: f.mode, editId: f.editId,
        body: {
          rule_id: (fields.rule_id || "").trim(),
          description: (fields.description || "").trim(),
          condition: (fields.condition || "").trim(),
          severity: fields.severity || "warning",
        },
      };
    }
    return {
      type: f.type, mode: f.mode, editId: f.editId,
      body: {
        topic: (fields.topic || "").trim(),
        content: (fields.content || "").trim(),
        tags: (fields.tags || "").trim(),
      },
    };
  }

  // 初始化渲染
  renderAll();

  window.BAA.vueKb = {
    isAvailable: () => true,
    sync,
    onOpen,
    setTab,
    getTab,
    setItems,
    setListStatus,
    getItem,
    updateItem,
    removeItem,
    openForm,
    closeForm,
    setFormField,
    setFormErr,
    setFormBusy,
    getFormValues,
  };
})();

// Progressive Vue island #6: MCP settings modal (server list + form fields).
// Mount points: #mcp-server-list, #mcp-form-fields.
// Smart-fill area (.mcp-smart-area) is NOT managed by Vue — it keeps legacy DOM.
// Exposes window.BAA.vueMcp. Falls back to mcp_settings.js legacy innerHTML when unavailable.
(function () {
  window.BAA = window.BAA || {};
  const Vue = window.Vue;
  const root1 = document.getElementById("mcp-server-list");
  const root2 = document.getElementById("mcp-form-fields");
  const hasVue = root1 && root2 && Vue && Vue.h && Vue.render;
  if (!hasVue) { window.BAA.vueMcp = null; return; }

  const { h, render, reactive, Fragment } = Vue;
  const STATUS_ICON = {
    connected: "🟢", connecting: "🟡", disconnected: "⚪", error: "🔴",
  };

  const state = reactive({
    listStatus: { loading: false, err: "" },
    servers: [],
    form: {
      open: false,
      mode: "add",
      editId: null,
      fields: {
        label: "", id: "", desc: "",
        transport: "stdio",
        command: "", args: "", env: "",
        url: "", headers: "",
      },
      err: "", ok: "", busy: false,
    },
  });
  let callbacks = {};

  // ── 渲染分发 ───────────────────────────────────────────────────
  function renderAll() {
    root1.innerHTML = "";
    root2.innerHTML = "";  // 清空静态 HTML（Vue 接管 #mcp-form-fields）
    _renderList();
    _renderForm();
  }

  function _renderList() {
    const L = state.listStatus;
    let content;
    if (L.loading) {
      content = h("div", { style: "font-size:12px;color:#64748b;padding:4px 0" }, "加载中…");
    } else if (L.err) {
      content = h("div", { style: "font-size:12px;color:#ef4444;padding:4px 0" }, `加载失败: ${L.err}`);
    } else if (!state.servers.length) {
      content = h("div", { style: "font-size:12px;color:#94a3b8;padding:4px 0" }, "暂无配置的服务器");
    } else {
      content = h(Fragment, null, state.servers.map(s => _renderServerCard(s)));
    }
    render(content, root1);
  }

  function _renderServerCard(s) {
    const icon = STATUS_ICON[s.status] || "⚪";
    const toolCount = s.tool_count != null ? `${s.tool_count} 个工具` : "";
    const canShowTools = s.status === "connected" && s.tool_count > 0;
    const showConnect = s.status !== "connected" && s.status !== "connecting";

    const headerChildren = [
      h("span", { style: "font-size:14px" }, icon),
      h("strong", { style: "font-size:13px" }, s.label || ""),
      h("code", { style: "font-size:11px;color:#64748b;background:#f1f5f9;padding:1px 5px;border-radius:4px" }, s.server_id || ""),
      h("span", { style: "font-size:11px;color:#94a3b8" }, s.transport || ""),
    ];
    if (toolCount) {
      headerChildren.push(h("span", { style: "font-size:11px;color:#10b981" }, toolCount));
    }

    const leftChildren = [
      h("div", { style: "display:flex;align-items:center;gap:6px;flex-wrap:wrap" }, headerChildren),
    ];
    if (s.description) {
      leftChildren.push(h("div", { style: "font-size:12px;color:#64748b;margin-top:2px" }, s.description));
    }
    if (s.last_error) {
      leftChildren.push(h("div", { style: "font-size:11px;color:#ef4444;margin-top:2px" }, s.last_error));
    }

    const actionChildren = [
      h("label", {
        style: "display:flex;align-items:center;gap:4px;font-size:12px;color:#475569;cursor:pointer",
        title: "启用/禁用",
      }, [
        h("input", {
          type: "checkbox",
          checked: s.enabled,
          onChange: (e) => callbacks.onToggleEnabled && callbacks.onToggleEnabled(s.server_id, e.target.checked),
        }),
        "启用",
      ]),
    ];
    if (canShowTools) {
      actionChildren.push(h("button", {
        class: "btn-sm btn-sm-ghost",
        style: "padding:2px 8px;font-size:11px",
        onClick: () => callbacks.onToggleTools && callbacks.onToggleTools(s.server_id),
      }, s.toolsOpen ? "收起工具 ▴" : "查看工具 ▾"));
    }
    actionChildren.push(h("button", {
      class: "btn-sm btn-sm-ghost",
      style: "padding:2px 8px;font-size:11px",
      onClick: () => callbacks.onOpenEdit && callbacks.onOpenEdit(s.server_id),
    }, "编辑"));
    if (showConnect) {
      actionChildren.push(h("button", {
        class: "btn-sm btn-sm-ghost",
        style: "padding:2px 8px;font-size:11px",
        onClick: () => callbacks.onConnect && callbacks.onConnect(s.server_id),
      }, "连接"));
    }
    actionChildren.push(h("button", {
      style: "padding:2px 8px;font-size:11px;background:#fee2e2;color:#dc2626;border:none;border-radius:5px;cursor:pointer",
      onClick: () => callbacks.onRemove && callbacks.onRemove(s.server_id),
    }, "删除"));

    const cardChildren = [
      h("div", { style: "display:flex;align-items:flex-start;gap:8px" }, [
        h("div", { style: "flex:1;min-width:0" }, leftChildren),
        h("div", { style: "display:flex;gap:6px;align-items:center;flex-shrink:0" }, actionChildren),
      ]),
    ];

    // 工具展开区（嵌套）
    if (s.toolsOpen) {
      cardChildren.push(_renderTools(s));
    }

    return h("div", {
      class: "custom-model-item",
      style: "display:flex;flex-direction:column;gap:0;padding:8px 10px",
    }, cardChildren);
  }

  function _renderTools(s) {
    let content;
    if (s.toolsLoading) {
      content = h("div", { style: "font-size:11px;color:#64748b" }, "加载中…");
    } else if (s.toolsErr) {
      content = h("div", { style: "font-size:11px;color:#ef4444" }, `加载失败: ${s.toolsErr}`);
    } else if (!s.tools || !s.tools.length) {
      content = h("div", { style: "font-size:11px;color:#94a3b8" }, "暂无工具");
    } else {
      content = h(Fragment, null, s.tools.map(t => {
        const schema = t.inputSchema || {};
        const props = schema.properties || {};
        const required = new Set(schema.required || []);
        const params = Object.entries(props).map(([k, v]) => {
          const cls = required.has(k) ? "mcp-tool-param required" : "mcp-tool-param";
          const attrs = {};
          if (v.description) attrs.title = v.description;
          return h("span", { class: cls, ...attrs }, `${k}${required.has(k) ? "*" : ""}`);
        });
        const toolChildren = [
          h("div", { class: "mcp-tool-name" }, t.name),
        ];
        if (t.description) {
          toolChildren.push(h("div", { class: "mcp-tool-desc" }, t.description));
        }
        if (params.length) {
          toolChildren.push(h("div", { class: "mcp-tool-params" }, params));
        }
        return h("div", { class: "mcp-tool-item" }, toolChildren);
      }));
    }
    return h("div", { class: "mcp-tool-list", style: "display:flex" }, content);
  }

  function _renderForm() {
    // 控制 #mcp-add-form（父容器）和 #mcp-add-toggle（兄弟）显隐
    const formWrap = document.getElementById("mcp-add-form");
    const toggleEl = document.getElementById("mcp-add-toggle");
    if (formWrap) formWrap.style.display = state.form.open ? "flex" : "none";
    if (toggleEl) toggleEl.textContent = state.form.open ? "▲ 折叠" : "＋ 添加 MCP 服务器";

    if (!state.form.open) {
      render(null, root2);
      return;
    }

    const F = state.form.fields;
    const isEdit = state.form.mode === "edit";
    const title = isEdit ? `编辑：${F.label}` : "添加服务器";

    // 命令预览（computed）
    const cmd = (F.command || "").trim();
    const args = (F.args || "").trim();
    const cmdParts = cmd ? [cmd, ...args.split(/\s+/).filter(Boolean)] : [];
    const showPreview = F.transport === "stdio" && cmd;

    const children = [
      h("div", { style: "font-size:13px;font-weight:600;color:#1e293b;margin-bottom:4px", id: "mcp-form-title" }, title),
      h("input", {
        type: "text", id: "mcp-label",
        placeholder: "服务器名称（显示用）",
        value: F.label,
        onInput: (e) => { F.label = e.target.value; },
      }),
    ];

    // id-row（edit 模式隐藏）
    if (!isEdit) {
      children.push(h("div", { id: "mcp-id-row" },
        h("input", {
          type: "text", id: "mcp-id",
          placeholder: "服务器 ID（字母/数字/下划线，唯一）",
          style: "width:100%",
          value: F.id,
          onInput: (e) => { F.id = e.target.value; },
        })
      ));
    }

    children.push(
      h("input", {
        type: "text", id: "mcp-desc",
        placeholder: "描述（可选）",
        value: F.desc,
        onInput: (e) => { F.desc = e.target.value; },
      }),
      // transport selector
      h("div", { style: "display:flex;gap:16px;align-items:center;font-size:13px;color:#475569;padding:4px 0" }, [
        h("label", { style: "display:flex;align-items:center;gap:5px;cursor:pointer" }, [
          h("input", {
            type: "radio", name: "mcp-transport", value: "stdio",
            checked: F.transport === "stdio",
            onChange: () => { F.transport = "stdio"; _renderForm(); },
          }),
          "stdio（本地命令）",
        ]),
        h("label", { style: "display:flex;align-items:center;gap:5px;cursor:pointer" }, [
          h("input", {
            type: "radio", name: "mcp-transport", value: "sse",
            checked: F.transport === "sse",
            onChange: () => { F.transport = "sse"; _renderForm(); },
          }),
          "SSE（远程 HTTP）",
        ]),
      ])
    );

    // stdio fields
    if (F.transport === "stdio") {
      const stdioChildren = [
        h("div", { style: "font-size:11px;color:#f59e0b;background:#fef3c7;border-radius:6px;padding:6px 10px" },
          "⚠️ 安全提示：仅允许运行 uvx / uv / npx / node / python / python3 / deno 命令。args 和 env 中不得含有 Shell 元字符或危险环境变量。"),
        h("input", {
          type: "text", id: "mcp-command",
          placeholder: "命令，例如 npx 或 uvx",
          value: F.command,
          onInput: (e) => { F.command = e.target.value; },
        }),
        h("input", {
          type: "text", id: "mcp-args",
          placeholder: "参数（空格分隔），例如 -y @modelcontextprotocol/server-filesystem /tmp",
          value: F.args,
          onInput: (e) => { F.args = e.target.value; },
        }),
        h("input", {
          type: "text", id: "mcp-env",
          placeholder: "环境变量（变量名=值，逗号分隔），例如：ATLASCLOUD_API_KEY=apikey-xxx, OTHER_KEY=yyy",
          value: F.env,
          onInput: (e) => { F.env = e.target.value; },
        }),
      ];
      if (showPreview) {
        stdioChildren.push(h("div", { class: "mcp-cmd-preview", style: "display:block" }, [
          h("div", { class: "cmd-label" }, "命令预览"),
          h("span", {}, cmdParts.join(" ")),
        ]));
      }
      children.push(h("div", { id: "mcp-stdio-fields", style: "display:flex;flex-direction:column;gap:8px" }, stdioChildren));
    }

    // sse fields
    if (F.transport === "sse") {
      children.push(h("div", { id: "mcp-sse-fields", style: "display:flex;flex-direction:column;gap:8px" }, [
        h("input", {
          type: "text", id: "mcp-url",
          placeholder: "SSE 端点 URL，例如 http://localhost:8000/sse",
          value: F.url,
          onInput: (e) => { F.url = e.target.value; },
        }),
        h("input", {
          type: "text", id: "mcp-headers",
          placeholder: "HTTP 头（KEY:VALUE，逗号分隔，可选）",
          value: F.headers,
          onInput: (e) => { F.headers = e.target.value; },
        }),
        h("div", { class: "f-hint", style: "font-size:11px;color:#64748b;margin-top:-4px" },
          "示例：Authorization:Bearer sk-xxx, X-Custom:value"),
      ]));
    }

    // err / ok
    if (state.form.err) {
      children.push(h("div", { class: "msg-err", id: "mcp-add-err" }, state.form.err));
    } else {
      children.push(h("div", { class: "msg-err", id: "mcp-add-err" }));
    }
    if (state.form.ok) {
      children.push(h("div", { class: "msg-ok", id: "mcp-add-ok" }, state.form.ok));
    } else {
      children.push(h("div", { class: "msg-ok", id: "mcp-add-ok" }));
    }

    render(h(Fragment, null, children), root2);
  }

  // ── lifecycle ──────────────────────────────────────────────────
  function isAvailable() { return true; }

  function sync(cbs) {
    callbacks = cbs || {};
    renderAll();
    // 清空静态 HTML（root1/root2 已由 renderAll 接管）
    // 注意：smart-fill 区（.mcp-smart-area）不在 root1/root2 内，不清空
  }

  function onOpen() {
    if (callbacks.onOpen) callbacks.onOpen();
  }

  // ── list API ───────────────────────────────────────────────────
  function setServers(servers) {
    // 保留已有 toolsOpen/tools/toolsLoading 状态（如果 server 还在列表里）
    const oldMap = {};
    state.servers.forEach(s => { oldMap[s.server_id] = s; });
    state.servers = (servers || []).map(s => {
      const old = oldMap[s.server_id];
      return {
        ...s,
        toolsOpen: old ? old.toolsOpen : false,
        tools: old ? old.tools : [],
        toolsLoading: old ? old.toolsLoading : false,
        toolsErr: old ? old.toolsErr : "",
        busy: false,
      };
    });
    _renderList();
  }

  function setListStatus(opts) {
    if (opts.loading != null) state.listStatus.loading = opts.loading;
    if (opts.err != null) state.listStatus.err = opts.err;
    _renderList();
  }

  function updateServer(id, patch) {
    const s = state.servers.find(x => x.server_id === id);
    if (!s) return null;
    Object.assign(s, patch);
    _renderList();
    return s;
  }

  function removeServer(id) {
    const idx = state.servers.findIndex(x => x.server_id === id);
    if (idx === -1) return;
    state.servers.splice(idx, 1);
    _renderList();
  }

  function getServer(id) {
    return state.servers.find(x => x.server_id === id) || null;
  }

  // ── tools API ──────────────────────────────────────────────────
  function setTools(id, tools) {
    updateServer(id, { tools: tools || [], toolsLoading: false, toolsErr: "" });
  }

  function setToolsLoading(id, b) {
    updateServer(id, { toolsLoading: b });
  }

  function setToolsErr(id, err) {
    updateServer(id, { toolsErr: err, toolsLoading: false });
  }

  function toggleToolsOpen(id) {
    const s = getServer(id);
    if (!s) return;
    s.toolsOpen = !s.toolsOpen;
    _renderList();
  }

  // ── form API ───────────────────────────────────────────────────
  function openForm(opts) {
    opts = opts || {};
    state.form.mode = opts.mode || "add";
    state.form.editId = opts.editId || null;
    state.form.err = "";
    state.form.ok = "";
    state.form.busy = false;
    if (opts.server) {
      const s = opts.server;
      const transport = s.transport || "stdio";
      state.form.fields = {
        label: s.label || "",
        id: s.server_id || "",
        desc: s.description || "",
        transport,
        command: s.command || "",
        args: (s.args || []).join(" "),
        env: Object.entries(s.env || {}).map(([k, v]) => `${k}=${v}`).join(", "),
        url: s.url || "",
        headers: Object.entries(s.headers || {}).map(([k, v]) => `${k}:${v}`).join(", "),
      };
    } else {
      state.form.fields = {
        label: "", id: "", desc: "",
        transport: "stdio",
        command: "", args: "", env: "",
        url: "", headers: "",
      };
    }
    state.form.open = true;
    _renderForm();
  }

  function closeForm() {
    state.form.open = false;
    state.form.editId = null;
    state.form.err = "";
    state.form.ok = "";
    _renderForm();
  }

  function toggleForm() {
    if (state.form.open) {
      closeForm();
      if (callbacks.onCancel) callbacks.onCancel();
    } else {
      openForm({ mode: "add" });
    }
  }

  function setFields(cfg) {
    // 桥接：smart-fill 区写入 Vue state
    cfg = cfg || {};
    if (cfg.transport) state.form.fields.transport = cfg.transport;
    if (cfg.label != null) state.form.fields.label = cfg.label;
    if (cfg.description != null) state.form.fields.desc = cfg.description;
    if (cfg.server_id != null && state.form.mode === "add") {
      if (!state.form.fields.id) state.form.fields.id = cfg.server_id;
    }
    if (cfg.transport === "stdio") {
      if (cfg.command != null) state.form.fields.command = cfg.command;
      if (cfg.args != null) state.form.fields.args = (cfg.args || []).join(" ");
      if (cfg.env != null) state.form.fields.env = Object.entries(cfg.env || {}).map(([k, v]) => `${k}=${v}`).join(", ");
    } else {
      if (cfg.url != null) state.form.fields.url = cfg.url;
      if (cfg.headers != null) state.form.fields.headers = Object.entries(cfg.headers || {}).map(([k, v]) => `${k}:${v}`).join(", ");
    }
    _renderForm();
  }

  function setField(key, val) {
    if (key in state.form.fields) {
      state.form.fields[key] = val;
      _renderForm();
    }
  }

  function setTransport(t) {
    state.form.fields.transport = t;
    _renderForm();
  }

  function setFormErr(msg) {
    state.form.err = msg || "";
    _renderForm();
  }

  function setFormOk(msg) {
    state.form.ok = msg || "";
    _renderForm();
  }

  function setFormBusy(b) {
    state.form.busy = !!b;
    // busy 禁用保存按钮（按钮在 root2 外，由 data-action 委托，需手动操作）
    const btns = document.querySelectorAll("#mcp-add-form button[data-action='addMcpServer']");
    btns.forEach(b2 => { b2.disabled = state.form.busy; });
  }

  function getFormValues() {
    const F = state.form.fields;
    return {
      label: (F.label || "").trim(),
      id: (F.id || "").trim(),
      desc: (F.desc || "").trim(),
      transport: F.transport,
      command: (F.command || "").trim(),
      args: (F.args || "").trim(),
      env: (F.env || "").trim(),
      url: (F.url || "").trim(),
      headers: (F.headers || "").trim(),
    };
  }

  function getFormState() {
    return { mode: state.form.mode, editId: state.form.editId, open: state.form.open };
  }

  function resetForm() {
    state.form.fields = {
      label: "", id: "", desc: "",
      transport: "stdio",
      command: "", args: "", env: "",
      url: "", headers: "",
    };
    state.form.err = "";
    state.form.ok = "";
    state.form.busy = false;
    _renderForm();
  }

  // ── 暴露 facade ────────────────────────────────────────────────
  window.BAA.vueMcp = {
    isAvailable,
    sync,
    onOpen,
    setServers,
    setListStatus,
    updateServer,
    removeServer,
    getServer,
    setTools,
    setToolsLoading,
    setToolsErr,
    toggleToolsOpen,
    openForm,
    closeForm,
    toggleForm,
    setFields,
    setField,
    setTransport,
    setFormErr,
    setFormOk,
    setFormBusy,
    getFormValues,
    getFormState,
    resetForm,
  };
})();

// ── IIFE #6: Workspace island (ov-workspace modal current-state card) ──────
// Renders the current mount state (mounted path + artifacts dir + unmount/switch
// buttons) inside the ov-workspace modal. Mount/unmount HTTP calls stay in
// modules/workspace.js (business module). Sidebar status row is plain DOM
// (consistent with src-name / mcp-status-text pattern).
(function () {
  window.BAA = window.BAA || {};
  const Vue = window.Vue;
  const root = document.getElementById("ws-current-state");
  const hasVue = root && Vue && Vue.h && Vue.render;
  if (!hasVue) { window.BAA.vueWorkspace = null; return; }

  const { h, render, reactive } = Vue;

  const state = reactive({
    mounted: false,
    workspace_id: "",
    name: "",
    workdir: "",
    artifacts_dir: "",
    permission: "read_only",
    mounted_at: null,
    busy: false,        // true while mount/unmount in flight
    busyKind: "",       // "mount" | "unmount"
    knownWorkspaces: [],
    knownError: "",
    editingWorkspaceId: "",
    editingWorkspaceName: "",
    renameBusy: false,
    renameError: "",
    removingWorkspaceId: "",
  });

  function isAvailable() { return true; }

  function _fmtTime(ts) {
    if (!ts) return "";
    try {
      const d = new Date(ts * 1000);
      return d.toLocaleString();
    } catch (_) { return ""; }
  }

  function _renderEmpty() {
    return h("div", { class: "ws-empty" }, window.t("workspace.empty_hint"));
  }

  function _renderMounted() {
    return h("div", { class: "ws-state-card" }, [
      h("div", { class: "ws-state-row" }, [
        h("span", { class: "ws-state-label" }, window.t("workspace.state_label")),
        h("span", { class: "ws-state-value" }, [
          h("span", { style: "color: var(--color-success); font-weight: 600" }, "● "),
          window.t("workspace.mounted_short"),
        ]),
      ]),
      h("div", { class: "ws-state-row" }, [
        h("span", { class: "ws-state-label" }, window.t("workspace.path_label")),
        h("span", { class: "ws-state-path" }, state.workdir || ""),
      ]),
      state.name ? h("div", { class: "ws-state-row" }, [
        h("span", { class: "ws-state-label" }, window.t("workspace.name_label")),
        h("span", { class: "ws-state-value" }, state.name),
      ]) : null,
      state.artifacts_dir
        ? h("div", { class: "ws-state-row" }, [
            h("span", { class: "ws-state-label" }, window.t("workspace.artifacts_label")),
            h("span", { class: "ws-state-path" }, state.artifacts_dir),
          ])
        : null,
      h("div", { class: "ws-state-row" }, [
        h("span", { class: "ws-state-label" }, window.t("workspace.permission_label")),
        h("span", { class: "ws-state-value" }, window.t(`workspace.permission.${state.permission}`)),
      ]),
      state.mounted_at
        ? h("div", { class: "ws-state-row" }, [
            h("span", { class: "ws-state-label" }, "mounted at"),
            h("span", { class: "ws-state-value", style: "font-size: 12px; color: var(--color-fg-muted)" }, _fmtTime(state.mounted_at)),
          ])
        : null,
      h("div", { class: "ws-state-actions" }, [
        h("button", {
          class: "btn-sm btn-sm-ghost",
          disabled: state.busy,
          onClick: () => {
            // "Switch directory" just focuses the path input — actual mount
            // happens via the primary "Mount" button at the bottom of the modal.
            const inp = document.getElementById("ws-path-input");
            if (inp) { inp.focus(); inp.select(); }
          },
        }, window.t("modal.workspace.remount_btn")),
        h("button", {
          class: "btn-sm btn-sm-ghost",
          style: "color: #ef4444",
          disabled: state.busy,
          onClick: () => {
            if (window.BAA.workspace && typeof window.BAA.workspace.doUnmount === "function") {
              window.BAA.workspace.doUnmount();
            }
          },
        }, state.busy && state.busyKind === "unmount"
          ? window.t("workspace.unmounting")
          : window.t("modal.workspace.unmount_btn")),
      ]),
    ]);
  }

  function _renderKnownWorkspaces() {
    const rows = state.knownWorkspaces || [];
    return h("section", { class: "ws-known" }, [
      h("div", { class: "ws-known-title" }, window.t("workspace.known_title")),
      state.knownError
        ? h("div", { class: "ws-known-error" }, state.knownError)
        : rows.length
          ? h("div", { class: "ws-known-list" }, rows.map(workspace => {
            const editing = state.editingWorkspaceId === workspace.workspace_id;
            return h("div", {
              class: `ws-known-item${workspace.current ? " current" : ""}${workspace.available ? "" : " unavailable"}`,
              key: workspace.workspace_id,
            }, [
              h("div", { class: "ws-known-main" }, [
                editing
                  ? h("div", { class: "ws-rename-editor" }, [
                      h("input", {
                        class: "ws-rename-input",
                        value: state.editingWorkspaceName,
                        maxlength: 80,
                        disabled: state.renameBusy,
                        "aria-label": window.t("workspace.rename_input_label"),
                        onInput: event => { state.editingWorkspaceName = event.target.value; },
                        onKeydown: event => {
                          if (event.key === "Enter") _saveWorkspaceRename(workspace);
                          if (event.key === "Escape") _cancelWorkspaceRename();
                        },
                      }),
                      h("button", { class: "btn-sm btn-sm-primary", type: "button",
                        disabled: state.renameBusy || !state.editingWorkspaceName.trim(),
                        onClick: () => _saveWorkspaceRename(workspace),
                      }, window.t("common.save")),
                      h("button", { class: "btn-sm btn-sm-ghost", type: "button",
                        disabled: state.renameBusy, onClick: _cancelWorkspaceRename,
                      }, window.t("common.cancel")),
                    ])
                  : h("div", { class: "ws-known-name" }, [
                      workspace.name || workspace.workspace_id.slice(0, 8),
                      workspace.current ? h("span", { class: "ws-known-badge" }, window.t("workspace.known_current")) : null,
                    ]),
                editing && state.renameError
                  ? h("div", { class: "ws-rename-error" }, state.renameError)
                  : null,
                h("div", { class: "ws-known-path", title: workspace.root_path }, workspace.root_path),
                h("div", { class: "ws-known-meta" }, [
                  h("span", null, window.t(`workspace.permission.${workspace.permission || "read_only"}`)),
                  workspace.active_job_count
                    ? h("span", null, window.t("workspace.known_active_jobs", { count: workspace.active_job_count }))
                    : null,
                  !workspace.available
                    ? h("span", { class: "ws-known-missing" }, window.t("workspace.known_unavailable"))
                    : null,
                ]),
              ]),
              editing ? null : h("div", { class: "ws-known-actions" }, [
                h("button", {
                  class: "btn-sm btn-sm-ghost",
                  type: "button",
                  disabled: !workspace.available || workspace.current || state.busy,
                  onClick: () => window.BAA.workspace?.activateKnownWorkspace?.(workspace),
                }, workspace.current
                  ? window.t("workspace.known_connected")
                  : state.mounted
                    ? window.t("workspace.known_switch")
                    : window.t("workspace.known_connect")),
                h("button", {
                  class: "btn-sm btn-sm-ghost",
                  type: "button",
                  disabled: !workspace.available || state.busy,
                  onClick: () => _startWorkspaceRename(workspace),
                }, window.t("workspace.rename_action")),
                h("button", {
                  class: "btn-sm btn-sm-ghost ws-known-remove",
                  type: "button",
                  disabled: workspace.current || state.busy || !!state.removingWorkspaceId,
                  title: workspace.current ? window.t("workspace.remove_current_hint") : "",
                  onClick: () => _removeKnownWorkspace(workspace),
                }, state.removingWorkspaceId === workspace.workspace_id
                  ? window.t("workspace.remove_running")
                  : window.t("workspace.remove_action")),
              ]),
            ]);
          }))
          : h("div", { class: "ws-known-empty" }, window.t("workspace.known_empty")),
    ]);
  }

  function _startWorkspaceRename(workspace) {
    state.editingWorkspaceId = workspace.workspace_id;
    state.editingWorkspaceName = workspace.name || "";
    state.renameError = "";
    _render();
  }

  function _cancelWorkspaceRename() {
    state.editingWorkspaceId = "";
    state.editingWorkspaceName = "";
    state.renameError = "";
    _render();
  }

  async function _saveWorkspaceRename(workspace) {
    const name = state.editingWorkspaceName.trim();
    if (!name || state.renameBusy) return;
    state.renameBusy = true;
    state.renameError = "";
    _render();
    try {
      await window.BAA.workspace?.renameKnownWorkspace?.(workspace.workspace_id, name);
      _cancelWorkspaceRename();
    } catch (error) {
      state.renameError = String(error.message || error);
      _render();
    } finally {
      state.renameBusy = false;
      _render();
    }
  }

  async function _removeKnownWorkspace(workspace) {
    if (state.removingWorkspaceId) return;
    state.removingWorkspaceId = workspace.workspace_id;
    state.knownError = "";
    _render();
    try {
      await window.BAA.workspace?.removeKnownWorkspace?.(workspace);
    } catch (error) {
      state.knownError = String(error.message || error);
      window.BAA.overlay?.toast?.(state.knownError, "err");
    } finally {
      state.removingWorkspaceId = "";
      _render();
    }
  }

  function _render() {
    let body;
    if (state.mounted) {
      body = _renderMounted();
    } else {
      body = _renderEmpty();
    }
    render(h("div", null, [body, _renderKnownWorkspaces()]), root);
  }

  function renderAll() {
    root.innerHTML = "";  // clear static HTML to prevent double-render
    _render();
  }

  // ── facade ──────────────────────────────────────────────────────
  function setState(payload) {
    if (!payload) return;
    if (typeof payload.mounted === "boolean") state.mounted = payload.mounted;
    if (typeof payload.workspace_id === "string") state.workspace_id = payload.workspace_id;
    if (typeof payload.name === "string") state.name = payload.name;
    if (typeof payload.workdir === "string") state.workdir = payload.workdir;
    if (typeof payload.artifacts_dir === "string") state.artifacts_dir = payload.artifacts_dir;
    if (["read_only", "read_write"].includes(payload.permission)) state.permission = payload.permission;
    if (payload.mounted_at !== undefined) state.mounted_at = payload.mounted_at;
    _render();
  }

  function setBusy(busy, kind) {
    state.busy = !!busy;
    state.busyKind = kind || "";
    _render();
  }

  function setKnownWorkspaces(workspaces) {
    state.knownWorkspaces = Array.isArray(workspaces) ? workspaces : [];
    state.knownError = "";
    _render();
  }

  function setKnownError(error) {
    state.knownError = String(error || "");
    _render();
  }

  // Initial render (empty state until loadStatus populates it).
  renderAll();

  window.BAA.vueWorkspace = {
    isAvailable,
    setState,
    setBusy,
    setKnownWorkspaces,
    setKnownError,
    renderAll,
  };
})();
