// Scrolling up into history has to be reversible.
//
// A session with less than a screen of output has a ceiling of 0, and the downward-overscroll clamp
// matched every downward wheel event and returned before the scrollback bridge could hand the history
// back. So the view could be scrolled up and never brought down again -- reported as "shows up at the
// top, cannot scroll down", on a tab holding barely 40 lines.
//
//   node tools/scroll-tests/short_session_scrollback.cjs [port]
const { chromium } = require('playwright');
const PORT = process.argv[2] || '8536';
const BASE = `http://127.0.0.1:${PORT}`;

const READ = (i) => {
  const v = window.__td.views.get(i);
  const b = v.term.buffer.active;
  const cell = v.term._core?._renderService?.dimensions?.css?.cell?.height || 21;
  // Anchored at the rendered window's offset so the row is right in both scroll modes -- offsetTop is 0
  // in the default mode, viewportY*cell in whole-buffer mode where scrollTop already spans scrollback.
  const first = b.viewportY + Math.floor((v.container.scrollTop - v.term.element.offsetTop) / cell);
  return { top: Math.round(v.container.scrollTop), ceiling: v.tallMaxScrollTop,
           viewportY: b.viewportY, baseY: b.baseY,
           firstVisibleRow: first,
           firstVisibleText: (b.getLine(first)?.translateToString(true) || '').trim().slice(0, 30) };
};

(async () => {
  const id = (await fetch(`${BASE}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'none', permission: 'default',
      cwd: '/Users/dan/workspace/height-probe-root', title: 'short-session' }),
  }).then((r) => r.json())).session_id;

  const br = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await br.newPage({ viewport: { width: 1400, height: 850 } });
  await p.goto(`${BASE}/p/height-probe-root`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
  await p.waitForTimeout(1500);
  await p.evaluate((i) => window.__td.activate(i), id);
  await p.waitForTimeout(2500);

  // The shape that breaks, and it takes both halves: real scrollback (so scrolling up has somewhere to
  // go) AND a near-empty screen (so the ceiling is ~0 and the clamp matches every downward event). An
  // agent that prints a lot and then clears lands exactly here -- output past the 1000-row screen leaves
  // lines in scrollback, and the clear puts the cursor back on row 0.
  await p.evaluate(({ i, s }) => window.__td.sendInput(window.__td.views.get(i), s),
    { i: id, s: 'seq 1 4100 | sed "s/^/line /"\n' });
  await p.waitForTimeout(11000);
  // ED2+home, NOT `clear`: zsh's clear also sends ED3, which erases the scrollback -- the very history
  // this test needs to scroll into. An agent's own screen-clear is ED2, which keeps it.
  await p.evaluate(({ i, s }) => window.__td.sendInput(window.__td.views.get(i), s), { i: id, s: "printf '\\033[2J\\033[H'\n" });
  await p.waitForTimeout(3000);

  const start = await p.evaluate(READ, id);
  console.log('at rest:  ', JSON.stringify(start));

  const box = await p.evaluate((i) => {
    const r = window.__td.views.get(i).container.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, id);
  await p.mouse.move(box.x, box.y);

  for (let n = 0; n < 6; n += 1) { await p.mouse.wheel(0, -120); await p.waitForTimeout(80); }
  await p.waitForTimeout(600);
  const up = await p.evaluate(READ, id);
  console.log('after up: ', JSON.stringify(up));

  for (let n = 0; n < 10; n += 1) { await p.mouse.wheel(0, 120); await p.waitForTimeout(80); }
  await p.waitForTimeout(800);
  const down = await p.evaluate(READ, id);
  console.log('after down:', JSON.stringify(down));

  const wentUp = up.firstVisibleRow < start.firstVisibleRow;
  // "Returns from history" means the bottom is reachable again -- measured against the CURRENT ceiling,
  // not the starting row: the at-rest position can sit in stale blank space that a gesture-time ceiling
  // refresh then legitimately reclaims, so the exact starting row is not a stable reference.
  const cameBack = down.ceiling != null && down.top >= down.ceiling - 50;
  console.log(`\n  scrolling up reaches history:     ${wentUp ? 'PASS' : `FAIL (${start.firstVisibleRow} -> ${up.firstVisibleRow})`}`);
  console.log(`  scrolling down returns from it:   ${cameBack ? 'PASS' : `FAIL (stopped at ${down.top}, ceiling ${down.ceiling})`}`);
  await br.close();
  await fetch(`${BASE}/api/sessions/${id}`, { method: 'DELETE' }).catch(() => {});
  process.exit(wentUp && cameBack ? 0 : 1);
})();
