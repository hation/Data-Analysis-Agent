// Overlay / modal / toast helpers.
// Globally exposed because mcp_settings.js, knowledge_panel.js and HTML data-actions all call them.
(function () {
  const { $ } = window.BAA.dom;
  const state = window.BAA.state;

  function openOverlay(id) {
    const el = $(id);
    if (!el) return;
    el.classList.add("open");
    // Side effects tied to specific overlays:
    if (id === "ov-settings" && window.BAA.models) window.BAA.models.loadBuiltinProviders();
    if ((id === "ov-db" || id === "ov-gsheets" || id === "ov-api") && window.BAA.datasource) {
      window.BAA.datasource.loadDatasourceConfigs();
    }
  }

  function closeOverlay(id) {
    const el = $(id);
    if (el) el.classList.remove("open");
  }

  // Guard: clicking outside the modal closes it, EXCEPT when the user was
  // dragging a resize handle that left the modal mid-drag.
  document.addEventListener("mousedown", e => {
    if (e.target.closest && e.target.closest(".modal")) state._modalResizing = true;
  });
  document.addEventListener("mouseup", () => {
    setTimeout(() => { state._modalResizing = false; }, 50);
  });

  function closeOutside(e, id) {
    if (state._modalResizing) return;
    if (e.target.id === id) closeOverlay(id);
  }

  function toast(msg, type = "") {
    const el = $("toast");
    if (!el) return;
    el.textContent = msg;
    el.className = "toast show" + (type ? " " + type : "");
    setTimeout(() => { el.className = "toast"; }, 2800);
  }

  window.BAA.overlay = { openOverlay, closeOverlay, closeOutside, toast };

  // Backward-compat globals.
  window.openOverlay  = openOverlay;
  window.closeOverlay = closeOverlay;
  window.closeOutside = closeOutside;
  window.toast        = toast;
})();
