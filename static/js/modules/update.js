// System update: download main.zip from GitHub, overwrite code, prompt restart.
(function () {
  const { $, esc } = window.BAA.dom;

  async function runUpdate() {
    const btn     = $("update-btn");
    const stateEl = $("update-state");
    const outEl   = $("update-output");
    const hintEl  = $("update-restart-hint");

    btn.disabled        = true;
    outEl.style.display = "none";
    outEl.textContent   = "";
    hintEl.style.display = "none";
    stateEl.className   = "update-state update-loading";
    stateEl.innerHTML   = `<span class="update-spinner"></span><span class="update-state-text">${t('update.loading')}</span>`;

    try {
      const r = await fetch("/api/system/update", { method: "POST", signal: AbortSignal.timeout(120000) });
      const d = await r.json();

      outEl.textContent   = d.output || t('update.no_output');
      outEl.style.display = "block";

      if (d.ok && d.already_up_to_date) {
        stateEl.className = "update-state update-ok";
        stateEl.innerHTML = `<span class="update-state-icon">✅</span><span class="update-state-text">${t('update.ok_latest')}</span>`;
      } else if (d.ok) {
        stateEl.className = "update-state update-ok";
        stateEl.innerHTML = `<span class="update-state-icon">✅</span><span class="update-state-text">${t('update.ok')}</span>`;
        hintEl.style.display = "block";
      } else {
        stateEl.className = "update-state update-err";
        stateEl.innerHTML = `<span class="update-state-icon">❌</span><span class="update-state-text">${t('update.fail')}</span>`;
      }
    } catch (e) {
      // The server may restart mid-update (file overwrite), which aborts the fetch.
      // That outcome means the update actually succeeded — prompt the user to refresh.
      if (e.name === "TypeError" || e.name === "AbortError") {
        stateEl.className = "update-state update-ok";
        stateEl.innerHTML = `<span class="update-state-icon">✅</span><span class="update-state-text">${t('update.ok_restart')}</span>`;
        hintEl.style.display = "block";
      } else {
        stateEl.className = "update-state update-err";
        stateEl.innerHTML = `<span class="update-state-icon">❌</span><span class="update-state-text">${t('update.req_fail')}${esc(String(e))}</span>`;
      }
    } finally {
      btn.disabled = false;
    }
  }

  window.BAA.update = { runUpdate };
})();
