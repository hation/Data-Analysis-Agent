// Small DOM helpers shared everywhere.
(function () {
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function scrollBottom() {
    const m = $("messages");
    if (m) m.scrollTop = m.scrollHeight;
  }
  function hideWelcome() { const w = $("welcome"); if (w) w.style.display = "none"; }
  function showWelcome() { const w = $("welcome"); if (w) w.style.display = ""; }

  window.BAA = window.BAA || {};
  window.BAA.dom = { $, esc, scrollBottom, hideWelcome, showWelcome };

  // Backward-compat globals used by other JS files (mcp_settings, knowledge_panel, etc.)
  window.esc = esc;
})();
