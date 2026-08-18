// Watches the Chrome you are actually using and records the two scroll faults that only ever show up in
// real use, so they no longer have to be caught in the act.
//
// Both are state-dependent and neither reproduces synthetically -- a freshly made session has no history
// to park in and goes idle before the measurement window closes, which is why they stayed open on
// "reproduce it and tell me when". This runs alongside normal use instead: it samples the active view ten
// times a second, keeps a rolling window, and when it sees one of the faults it prints the window either
// side of it. Nothing at all is printed while things are healthy.
//
//   stuck   the container is at its own scroll limit, yet content continues below the fold -- the last
//           lines are unreachable no matter how far you scroll ("wouldn't scroll to the bottom until I
//           typed something")
//   drift   the view is parked with no gesture in flight, and the line under the reader changed anyway
//           ("as it adds more content it keeps losing the scroll position I am in")
//
// Start the testing Chrome once:
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//     --remote-debugging-port=9222 --user-data-dir="$HOME/.termdeck-testing-chrome" \
//     --no-first-run --no-default-browser-check http://127.0.0.1:8530/p/stock &
//
// Then leave this running and use TermDeck normally:
//   node tools/watch_symptoms.cjs 30        watch for 30 minutes
//
// It never clicks, scrolls, or switches tabs -- whatever you do is what gets measured. It reinstalls
// itself after a page reload, so refreshing the tab does not end the session.
const { chromium } = require('playwright');

const MINUTES = Number(process.argv[2] || 30);
const RING = 400;          // ~40s of history at 100ms
const BEFORE = 20, AFTER = 6;

// Runs in the page. Bounded work only: the last-content scan covers the tail of the buffer rather than
// all of it, so the cost does not grow with scrollback.
const RECORDER = ({ ring, before, after }) => {
  if (window.__tdWatch) return 'already installed';
  const state = { samples: [], events: [], seq: 0 };
  window.__tdWatch = state;

  const sample = () => {
    const app = window.__td;
    if (!app || !app.activeId) return null;
    const view = app.views.get(app.activeId);
    if (!view || !view.container || view.closed || !view.term) return null;
    const buffer = view.term.buffer.active;
    const cell = view.term._core?._renderService?.dimensions?.css?.cell?.height || 21;
    const container = view.container;
    if (!container.clientHeight) return null;
    let lastContent = buffer.baseY + buffer.cursorY;
    const floor = Math.max(0, buffer.length - 300);
    for (let y = buffer.length - 1; y >= floor; y--) {
      if ((buffer.getLine(y)?.translateToString(true) || '').trim()) { lastContent = y; break; }
    }
    const firstVisible = buffer.viewportY + Math.floor(container.scrollTop / cell);
    const lastVisible = buffer.viewportY + Math.ceil((container.scrollTop + container.clientHeight) / cell) - 1;
    const now = Date.now();
    return {
      t: now, id: app.activeId, title: (app.session(app.activeId) || {}).title,
      top: Math.round(container.scrollTop), ceiling: view.tallMaxScrollTop,
      nativeMax: Math.round(container.scrollHeight - container.clientHeight),
      innerH: container.querySelector('.term-inner')?.offsetHeight,
      following: view.tallFollowing, pinned: view.tallPinnedViewportY, anchor: view.tallAnchorRow,
      mode: view.scrollMode, replaying: !!view.replaying,
      viewportY: buffer.viewportY, baseY: buffer.baseY, cursorY: buffer.cursorY,
      lastContent, showing: `${firstVisible}..${lastVisible}`, rowsBelow: lastContent - lastVisible,
      // A gesture owns the view while it runs, so anything that moves during one is not a fault.
      gesture: !!view.tallPointerHeld ||
        now < Math.max(view.tallWheelActiveUntil || 0, view.tallScrollActiveUntil || 0) + 400,
      // The first line the reader can actually read, not literally the top row: an agent's UI leaves
      // blank rows scattered through the view, and on a blank top row a literal reading is "" for every
      // sample, which silently disables drift detection exactly where it is needed.
      topRow: readerLine(buffer, firstVisible, lastVisible),
    };
  };

  const readerLine = (buffer, from, to) => {
    for (let y = from; y <= to; y += 1) {
      const text = (buffer.getLine(y)?.translateToString(true) || '').trim();
      if (text) return text.slice(0, 48);
    }
    return '';
  };

  // Kept a pure-ish function of (previous sample, this sample) so it can be exercised with fabricated
  // samples -- a detector nobody has ever seen fire is indistinguishable from one that cannot.
  state.detect = (prev, s) => {
    if (!prev || prev.id !== s.id || s.replaying || s.gesture) { state.stuckSince = 0; return null; }

    // At the very bottom of what the container can scroll, with content still below it. Held for a beat
    // before it counts: a single frame mid-redraw legitimately looks like this.
    if (s.nativeMax - s.top <= 2 && s.rowsBelow > 2 && prev.nativeMax - prev.top <= 2 && prev.rowsBelow > 2) {
      if (!state.stuckSince) state.stuckSince = s.t;
      if (s.t - state.stuckSince > 1500 && !state.stuckFlagged) {
        state.stuckFlagged = true;
        return { kind: 'stuck', detail: `${s.rowsBelow} rows below the fold with the scrollbar already at its limit` };
      }
    } else { state.stuckSince = 0; state.stuckFlagged = false; }

    // Parked, hands off, and the line the reader was looking at is no longer there.
    if (s.following === false && prev.following === false && s.topRow && prev.topRow && s.topRow !== prev.topRow) {
      return { kind: 'drift', detail: `line under the reader changed: "${prev.topRow}" -> "${s.topRow}"` };
    }
    return null;
  };

  setInterval(() => {
    const s = sample();
    if (!s) return;
    const prev = state.samples[state.samples.length - 1];
    state.samples.push(s);
    if (state.samples.length > ring) state.samples.shift();
    const found = state.detect(prev, s);
    if (!found) return;
    // The window is copied out now, not referenced by index: the ring is full within 40s and shifts on
    // every sample, so an index recorded here would point somewhere else by the time it is read. What
    // happened just after matters as much as what led up to it, so that half is filled in a beat later.
    const event = { seq: state.seq++, ...found, t: s.t, window: state.samples.slice(-before) };
    state.events.push(event);
    if (state.events.length > 200) state.events.shift();
    setTimeout(() => { event.window = event.window.concat(state.samples.slice(-after)); }, after * 100);
  }, 100);
  return 'installed';
};

module.exports = { RECORDER };
if (require.main !== module) return;

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const pages = browser.contexts().flatMap((c) => c.pages()).filter((p) => p.url().includes('/p/'));
  if (!pages.length) { console.log('No TermDeck tab open in the testing Chrome.'); await browser.close(); return; }
  const page = pages[0];
  console.log(`attached: ${page.url()}`);
  console.log(`watching for ${MINUTES} min -- use TermDeck normally; nothing prints unless a fault appears.\n`);

  let seen = 0;
  const install = async () => {
    const status = await page.evaluate(RECORDER, { ring: RING, before: BEFORE, after: AFTER }).catch(() => 'page busy');
    if (status === 'installed') { seen = 0; console.log(`${new Date().toLocaleTimeString()}  recorder installed`); }
  };
  await install();

  const deadline = Date.now() + MINUTES * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const live = await page.evaluate(() => !!window.__tdWatch).catch(() => false);
    if (!live) { await install(); continue; }
    // Anything too fresh to have its trailing half yet is left for the next pass, complete.
    const fresh = await page.evaluate(({ from, settle }) => {
      const now = Date.now();
      return window.__tdWatch.events.filter((e) => e.seq >= from && now - e.t > settle);
    }, { from: seen, settle: AFTER * 100 + 200 }).catch(() => []);
    for (const event of fresh) {
      seen = event.seq + 1;
      console.log(`\n${new Date(event.t).toLocaleTimeString()}  ${event.kind.toUpperCase()}  ${event.detail}`);
      for (const s of event.window) {
        const rel = String(s.t - event.t).padStart(6);
        console.log(`  ${rel}ms ${JSON.stringify(s)}`);
      }
    }
  }
  console.log(`\nwatch finished; ${seen} fault${seen === 1 ? '' : 's'} recorded.`);
  await browser.close();
})();
