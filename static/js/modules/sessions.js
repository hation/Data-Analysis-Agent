// Saved sessions: save / list / load / delete.
(function () {
  const { $, esc, hideWelcome } = window.BAA.dom;
  const { openOverlay, closeOverlay, toast } = window.BAA.overlay;
  const { appendMsg, sysMsg, updateTokenBar } = window.BAA.msg;
  const state = window.BAA.state;

  function openSaveDialog() {
    $("save-name").value = "";
    $("save-err").textContent = "";
    openOverlay("ov-save");
    setTimeout(() => $("save-name").focus(), 80);
  }

  async function saveSession() {
    const name  = $("save-name").value.trim();
    const errEl = $("save-err");
    errEl.textContent = "";
    const r = await fetch(`/api/session/${state.SID}/save`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const d = await r.json();
    if (d.error) { errEl.textContent = d.error; return; }
    closeOverlay("ov-save");
    toast(t('toast.saved', { name: d.name }), "ok");
    await loadSavedList();
  }

  async function loadSavedList() {
    const box = $("saved-list");
    const r = await fetch("/api/saved-sessions");
    const list = await r.json();
    if (!list.length) {
      box.innerHTML = `<div class="saved-empty">${t('saved_empty')}</div>`;
      return;
    }
    box.innerHTML = list.map(s => {
      const date = s.saved_at ? s.saved_at.slice(0, 16).replace("T", " ") : "";
      // Encode filename/name in data attributes to avoid quote escaping bugs.
      return `
        <div class="saved-item">
          <div class="saved-info" data-action="loadSession"
               data-filename="${esc(s.filename)}" data-name="${esc(s.name)}">
            <div class="saved-name">${esc(s.name)}</div>
            <div class="saved-meta">${date} · ${s.msg_count} 条${s.ds_name ? " · " + esc(s.ds_name) : ""}</div>
          </div>
          <button class="saved-del" title="✕" data-action="deleteSession"
                  data-filename="${esc(s.filename)}" data-name="${esc(s.name)}">✕</button>
        </div>`;
    }).join("");
  }

  async function loadSavedSession(filename, name) {
    if (!confirm(t('confirm.load', { name }))) return;

    // 告诉后端保留当前 session 已设的模型（keep_provider），
    // 历史文件中的 model_provider 不会覆盖 session。
    const r = await fetch(`/api/session/${state.SID}/load`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename, keep_provider: true }),
    });
    const d = await r.json();
    if (d.error) { toast(d.error, "err"); return; }

    document.querySelectorAll(".msg, .sys-msg").forEach(el => el.remove());
    hideWelcome();

    if (d.ds_connected) {
      window.setSrc(d.ds_name, 'src.restored', true);
      toast(t('src.restored_toast', { name: d.ds_name }), "ok");
    } else if (d.ds_lost) {
      window.setSrc(d.ds_name + t('src.lost_suffix'), 'src.lost_hint', false);
      toast(t('src.lost_hint'), "err");
    } else {
      window.setSrc(null, 'sidebar.hint.noconn', false);
    }

    // 不再从历史文件恢复模型 — 前端选择与后端 session 均保持不变。

    state.tokenState = {
      promptTokens:  0,
      totalInput:    d.total_input  || 0,
      totalOutput:   d.total_output || 0,
      contextWindow: state.tokenState.contextWindow,
    };
    updateTokenBar();

    for (const msg of d.history) {
      if (msg.role === "user") {
        appendMsg("user", msg.content);
      } else if (msg.role === "assistant" && msg.content) {
        const el = appendMsg("assistant", null);
        const bubble = el.querySelector(".msg-bubble");
        bubble.innerHTML = window.renderMd(msg.content);
        for (const cid of (msg.chart_ids || [])) {
          const wrap = window.BAA.chatStream.buildChartFrame(cid);
          bubble.before(wrap);
        }
      }
    }

    sysMsg(t('sys.loaded', { name: d.name }));
    toast(t('toast.loaded', { name: d.name }), "ok");
  }

  async function deleteSavedSession(filename, name) {
    if (!confirm(t('confirm.delete_session', { name }))) return;
    const r = await fetch(`/api/saved-sessions/${encodeURIComponent(filename)}`, { method: "DELETE" });
    const d = await r.json();
    if (d.error) { toast(d.error, "err"); return; }
    toast(t('toast.deleted', { name }));
    await loadSavedList();
  }

  window.BAA.sessions = { openSaveDialog, saveSession, loadSavedList, loadSavedSession, deleteSavedSession };
})();
