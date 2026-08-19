// Scrolling through SCROLLBACK must travel exactly as far as the wheel pushed, same as scrolling the
// container does.
//
// Reported as "scroll up is smooth, scroll down jumps over some rows". The asymmetry is real: going up,
// the container scrolls natively and pixel-accurately until it bottoms out at 0; going down from a
// scrolled-up view, every event is handed to the scrollback bridge, which converts pixels to whole lines.
// A mouse notch is not a whole number of rows, and the bridge rounded each event AWAY from zero and threw
// the remainder away, so the view gained a fraction of a line per event, always in the direction of
// travel.
//
//   node tools/scroll-tests/scrollback_wheel_travel.cjs [port]
const { chromium } = require('playwright');
const PORT = process.argv[2] || '8536';
const BASE = `http://127.0.0.1:${PORT}`;
const NOTCH = 100;
const EVENTS = 12;

const READ = (i) => {
  const v = window.__td.views.get(i);
  const b = v.term.buffer.active;
  const cell = v.term._core?._renderService?.dimensions?.css?.cell?.height || 21;
  return { cell, viewportY: b.viewportY, baseY: b.baseY, top: Math.round(v.container.scrollTop),
           // Absolute buffer row at the top of the pane: the only position that means anything when the
           // gesture can move either the container or the buffer viewport.
           row: b.viewportY + v.container.scrollTop / cell };
};

(async () => {
  const id = (await fetch(`${BASE}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'none', permission: 'default',
      cwd: '/Users/dan/workspace/height-probe-root', title: 'scrollback-wheel' }),
  }).then((r) => r.json())).session_id;

  const br = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await br.newPage({ viewport: { width: 1400, height: 850 } });
  await p.goto(`${BASE}/p/height-probe-root`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
  await p.waitForTimeout(1500);
  await p.evaluate((i) => window.__td.activate(i), id);
  await p.waitForTimeout(2500);
  // More than the 1000-row screen, so there is real scrollback to travel through.
  await p.evaluate(({ i, s }) => window.__td.sendInput(window.__td.views.get(i), s),
    { i: id, s: 'clear; seq 1 3000 | sed "s/^/line /"\n' });
  await p.waitForTimeout(7000);

  const box = await p.evaluate((i) => {
    const r = window.__td.views.get(i).container.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, id);
  await p.mouse.move(box.x, box.y);

  // Setup, not measurement: put the container at its top directly rather than wheeling through 20000px
  // of it, then wheel the rest of the way so the gesture crosses into scrollback for real.
  await p.evaluate((i) => { window.__td.views.get(i).container.scrollTop = 0; }, id);
  await p.waitForTimeout(800);
  for (let n = 0; n < 10; n += 1) { await p.mouse.wheel(0, -NOTCH); await p.waitForTimeout(60); }
  await p.waitForTimeout(1000);
  const parked = await p.evaluate(READ, id);
  console.log('in scrollback:', JSON.stringify(parked));
  if (!(parked.viewportY < parked.baseY)) {
    console.log('\nDID NOT REACH SCROLLBACK -- nothing to measure.');
    await br.close(); process.exit(2);
  }

  const measure = async (direction, label) => {
    const before = await p.evaluate(READ, id);
    for (let n = 0; n < EVENTS; n += 1) { await p.mouse.wheel(0, direction * NOTCH); await p.waitForTimeout(90); }
    await p.waitForTimeout(500);
    const after = await p.evaluate(READ, id);
    const travelled = after.row - before.row;
    const pushed = direction * EVENTS * NOTCH / before.cell;
    console.log(`\n${label}`);
    console.log(`  ${JSON.stringify(before)}  ->  ${JSON.stringify(after)}`);
    console.log(`  wheel pushed ${pushed.toFixed(1)} rows, view travelled ${travelled.toFixed(1)}  (error ${(travelled - pushed).toFixed(1)})`);
    return Math.abs(travelled - pushed);
  };

  const down = await measure(1, 'DOWN through scrollback');
  await p.waitForTimeout(600);
  const up = await measure(-1, 'UP through scrollback');

  // One row of slack: a single row of rounding is invisible, an accumulating drift is the complaint.
  const ok = down <= 1 && up <= 1;
  console.log(`\n  down within a row: ${down <= 1 ? 'PASS' : `FAIL (${down.toFixed(1)} rows)`}`);
  console.log(`  up within a row:   ${up <= 1 ? 'PASS' : `FAIL (${up.toFixed(1)} rows)`}`);
  await br.close();
  await fetch(`${BASE}/api/sessions/${id}`, { method: 'DELETE' }).catch(() => {});
  process.exit(ok ? 0 : 1);
})();
