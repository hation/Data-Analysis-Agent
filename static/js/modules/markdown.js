// Markdown rendering — backed by marked + DOMPurify (loaded from /static/vendor/).
// Replaces the previous handcrafted regex renderer.
(function () {
  if (typeof marked === "undefined" || typeof DOMPurify === "undefined") {
    console.error("[BAA] marked/DOMPurify not loaded — markdown will render as plain text");
    window.renderMd = (text) => window.BAA.dom.esc(text || "");
    return;
  }

  // Custom renderer: open /dashboard/* and external links in a new tab (mirrors previous behaviour).
  const renderer = new marked.Renderer();
  const origLink = renderer.link.bind(renderer);
  renderer.link = (href, title, text) => {
    const html = origLink(href, title, text);
    if (!href) return html;
    const newTab = /^https?:\/\//i.test(href) || href.startsWith("/dashboard/");
    if (!newTab) return html;
    return html.replace(/^<a /, '<a target="_blank" rel="noopener" ');
  };

  marked.setOptions({
    renderer,
    breaks: true,
    gfm: true,
    headerIds: false,
    mangle: false,
  });

  function renderMd(text) {
    if (!text) return "";
    const raw = marked.parse(String(text));
    return DOMPurify.sanitize(raw, { ADD_ATTR: ["target"] });
  }

  window.BAA = window.BAA || {};
  window.BAA.markdown = { renderMd };
  window.renderMd = renderMd;
})();
