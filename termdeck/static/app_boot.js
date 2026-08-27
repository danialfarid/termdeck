// Split from app.js (2026-08-26): bootstrap. Must load LAST.
// TEMPORARY debug hook for the scroll-position investigation -- read-only ground truth access to
// live view/xterm state from outside (e.g. a Playwright script), since DOM proxies like
// .xterm-viewport.scrollTop/scrollHeight do not reliably correspond to xterm's real internal
// buffer.viewportY/baseY in V2 scroll mode. Remove once that investigation concludes.
window.__td = new TermdeckApp();
window.__td.init();
