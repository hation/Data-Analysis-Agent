// Light / dark theme toggle.
// - Default: light (regardless of OS preference)
// - Persists choice in localStorage under 'baa_theme'
// - Sets <html data-theme="dark"> when active (CSS keys off this)
(function () {
  const STORAGE_KEY = 'baa_theme';
  const html = document.documentElement;

  function getTheme() {
    return localStorage.getItem(STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  }

  function applyTheme(theme) {
    if (theme === 'dark') html.setAttribute('data-theme', 'dark');
    else                  html.removeAttribute('data-theme');
    const btn = document.getElementById('theme-toggle');
    if (btn) {
      btn.textContent = theme === 'dark' ? '☀' : '🌙';
      btn.title = theme === 'dark'
        ? (window.t ? t('theme.to_light') : 'Light mode')
        : (window.t ? t('theme.to_dark')  : 'Dark mode');
    }
  }

  function setTheme(theme) {
    localStorage.setItem(STORAGE_KEY, theme);
    applyTheme(theme);
  }

  function toggleTheme() {
    setTheme(getTheme() === 'dark' ? 'light' : 'dark');
  }

  // Apply ASAP to avoid a flash of unstyled (light) content on dark sessions.
  applyTheme(getTheme());

  // Re-sync the button label when the language changes.
  document.addEventListener('langchange', () => applyTheme(getTheme()));

  window.BAA = window.BAA || {};
  window.BAA.theme = { getTheme, setTheme, toggleTheme, applyTheme };
})();
