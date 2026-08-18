// Attaches to the Chrome you are actually using and reports what the terminal is doing, so a problem you
// reproduce by hand can be measured instead of guessed at.
//
// Start that Chrome once:
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//     --remote-debugging-port=9222 --user-data-dir="$HOME/.termdeck-testing-chrome" \
//     --no-first-run --no-default-browser-check http://127.0.0.1:8530/p/stock &
//
// Then:
//   node tools/watch_live.cjs            snapshot of the active terminal
//   node tools/watch_live.cjs 20         watch for 20s, printing only what changes
//
// It never drives the browser -- no clicking, no switching tabs, no scrolling -- so whatever you do is
// what gets measured.
const { chromium } = require('playwright');

const SECONDS = Number(process.argv[2] || 0);

const SAMPLE = () => {
  const app = window.__td;
  if (!app || !app.activeId) return { noApp: true };
  const view = app.views.get(app.activeId);
  if (!view || !view.container) return { noView: true, activeId: app.activeId };
  const session = app.session(app.activeId) || {};
  const buffer = view.term.buffer.active;
  const cell = view.term._core?._renderService?.dimensions?.css?.cell?.height || 21;
  let lastContent = -1;
  for (let y = buffer.length - 1; y >= 0; y--) {
    if ((buffer.getLine(y)?.translateToString(true) || '').trim()) { lastContent = y; break; }
  }
  const firstVisible = buffer.viewportY + Math.floor(view.container.scrollTop / cell);
  const lastVisible = buffer.viewportY + Math.ceil((view.container.scrollTop + view.container.clientHeight) / cell) - 1;
  return {
    title: session.title, agent: session.agent_kind, processing: session.processing,
    top: Math.round(view.container.scrollTop), ceiling: view.tallMaxScrollTop,
    innerH: view.container.querySelector('.term-inner')?.offsetHeight,
    following: view.tallFollowing, pinned: view.tallPinnedViewportY, anchor: view.tallAnchorRow,
    cols: view.term.cols, rows: view.term.rows,
    viewportY: buffer.viewportY, baseY: buffer.baseY, cursorY: buffer.cursorY,
    lastContent, showing: `${firstVisible}..${lastVisible}`,
    atEnd: lastVisible >= lastContent, rowsBelow: lastContent - lastVisible,
    sizeOwnedElsewhere: view.sizeOwnedElsewhere || null,
    replaying: view.replaying, awaitingSnapshot: view.awaitingSnapshot,
  };
};

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();
  const pages = contexts.flatMap((c) => c.pages()).filter((p) => p.url().includes('/p/'));
  if (!pages.length) { console.log('No TermDeck tab open in the testing Chrome.'); await browser.close(); return; }
  const page = pages[0];
  console.log(`attached: ${page.url()}\n`);

  if (!SECONDS) {
    console.log(JSON.stringify(await page.evaluate(SAMPLE), null, 1));
    await browser.close();
    return;
  }

  let previous = '';
  const started = Date.now();
  while (Date.now() - started < SECONDS * 1000) {
    const sample = await page.evaluate(SAMPLE).catch((e) => ({ error: String(e).slice(0, 80) }));
    const key = JSON.stringify(sample);
    if (key !== previous) {
      console.log(`${String(Math.round((Date.now() - started) / 100) / 10).padStart(5)}s ${JSON.stringify(sample)}`);
      previous = key;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  await browser.close();
})();
