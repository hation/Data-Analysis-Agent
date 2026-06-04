// Small DOM helpers shared everywhere.
(function () {
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // ── Smart auto-scroll ────────────────────────────────────────────────────
  // During streaming we only auto-scroll when the user is already near the
  // bottom (within THRESHOLD px). The moment the user scrolls up we stop
  // pulling them back. Once streaming ends we do one final scroll.
  const THRESHOLD = 80;   // px from bottom considered "at bottom"
  let _userScrolledUp = false;
  let _scrollLocked   = false;   // set true while we are programmatically scrolling

  function _getMessages() { return $("messages"); }

  function _isNearBottom() {
    const m = _getMessages();
    if (!m) return true;
    return m.scrollHeight - m.scrollTop - m.clientHeight <= THRESHOLD;
  }

  // Called on every user-initiated scroll event
  function _onUserScroll() {
    if (_scrollLocked) return;   // ignore scroll events we caused ourselves
    _userScrolledUp = !_isNearBottom();
  }

  // Wire up the listener once the DOM is ready
  document.addEventListener("DOMContentLoaded", () => {
    const m = _getMessages();
    if (m) m.addEventListener("scroll", _onUserScroll, { passive: true });
  });

  // Smart scroll: only scrolls if user hasn't scrolled up.
  // Pass force=true to scroll regardless (used after stream ends).
  function scrollBottom(force) {
    const m = _getMessages();
    if (!m) return;
    if (force || !_userScrolledUp) {
      _scrollLocked = true;
      m.scrollTop = m.scrollHeight;
      // Release lock after the browser has processed the scroll event
      requestAnimationFrame(() => { _scrollLocked = false; });
    }
  }

  // Call at stream start so new messages always begin at bottom
  function scrollReset() {
    _userScrolledUp = false;
    scrollBottom(true);
  }

  function hideWelcome() { const w = $("welcome"); if (w) w.style.display = "none"; }
  function showWelcome() { const w = $("welcome"); if (w) w.style.display = ""; }

  window.BAA = window.BAA || {};
  window.BAA.dom = { $, esc, scrollBottom, scrollReset, hideWelcome, showWelcome };

  // Backward-compat globals used by other JS files (mcp_settings, knowledge_panel, etc.)
  window.esc = esc;
})();
