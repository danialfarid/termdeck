// A wheel gesture must move the content by exactly as far as it was pushed.
//
// Reported as "scrolling down speeds up and skips a couple of lines, and the numbers under my mouse get
// bigger" -- with the view parked, every downward wheel event is handed to the scrollback bridge, and the
// bridge rounded each one AWAY from zero. A mouse notch is not a whole number of rows, so each event
// gained a fraction of a line, in the direction of travel, every time.
//
//   node tools/scroll-tests/wheel_travel.cjs [port]
const { chromium } = require('playwright');
const PORT = process.argv[2] || '8536';
const BASE = `http://127.0.0.1:${PORT}`;
const NOTCH = 100;      // what a mouse wheel sends per notch in Chrome
const EVENTS = 12;

const READ = (i) => {
  const v = window.__td.views.get(i);
  const b = v.term.buffer.active;
  const cell = v.term._core?._renderService?.dimensions?.css?.cell?.height || 21;
  return { cell, viewportY: b.viewportY, baseY: b.baseY, top: Math.round(v.container.scrollTop),
           row: b.viewportY + Math.round(v.container.scrollTop / cell),
           text: (b.getLine(b.viewportY + Math.round(v.container.scrollTop / cell))?.translateToString(true) || '').trim() };
};

(async () => {
  const id = (await fetch(`${BASE}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'none', permission: 'default',
      cwd: '/Users/dan/workspace/height-probe-root', title: 'wheel-travel' }),
  }).then((r) => r.json())).session_id;

  const br = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await br.newPage({ viewport: { width: 1400, height: 850 } });
  await p.goto(`${BASE}/p/height-probe-root`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3000);
  await p.evaluate((i) => window.__td.activate(i), id);
  await p.waitForTimeout(2500);
  await p.evaluate(({ i, s }) => window.__td.sendInput(window.__td.views.get(i), s), { i: id, s: 'clear; seq 1 1500\n' });
  await p.waitForTimeout(5000);

  const box = await p.evaluate((i) => {
    const r = window.__td.views.get(i).container.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, id);
  await p.mouse.move(box.x, box.y);

  // Park well above the end: far enough that a full downward run cannot reach the ceiling and be
  // clamped, which would measure the clamp rather than the gesture.
  for (let n = 0; n < 30; n += 1) { await p.mouse.wheel(0, -NOTCH); await p.waitForTimeout(60); }
  await p.waitForTimeout(1000);

  const measure = async (direction, label) => {
    const before = await p.evaluate(READ, id);
    for (let n = 0; n < EVENTS; n += 1) { await p.mouse.wheel(0, direction * NOTCH); await p.waitForTimeout(90); }
    await p.waitForTimeout(400);
    const after = await p.evaluate(READ, id);
    // Rows the content actually travelled, counting both surfaces: the buffer viewport and the container.
    const movedRows = (after.viewportY - before.viewportY) + (after.top - before.top) / before.cell;
    const expected = direction * EVENTS * NOTCH / before.cell;
    console.log(`\n${label}`);
    console.log(`  before: ${JSON.stringify(before)}`);
    console.log(`  after:  ${JSON.stringify(after)}`);
    console.log(`  expected ${expected.toFixed(1)} rows, moved ${movedRows.toFixed(1)} rows  (error ${(movedRows - expected).toFixed(1)})`);
    return Math.abs(movedRows - expected);
  };

  const downError = await measure(1, 'SCROLLING DOWN');
  await p.waitForTimeout(800);
  for (let n = 0; n < 12; n += 1) { await p.mouse.wheel(0, -NOTCH); await p.waitForTimeout(60); }
  await p.waitForTimeout(1000);
  const upError = await measure(-1, 'SCROLLING UP');

  // One row of slack: the reader cannot see less than a row of error, and rounding the reported position
  // to the nearest row costs part of one on its own.
  const ok = downError <= 1 && upError <= 1;
  console.log(`\n  travel matches the gesture (<=1 row):  down ${downError <= 1 ? 'PASS' : `FAIL (${downError.toFixed(1)})`}   up ${upError <= 1 ? 'PASS' : `FAIL (${upError.toFixed(1)})`}`);
  await br.close();
  await fetch(`${BASE}/api/sessions/${id}`, { method: 'DELETE' }).catch(() => {});
  process.exit(ok ? 0 : 1);
})();
