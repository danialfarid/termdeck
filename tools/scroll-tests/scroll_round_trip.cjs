// Scroll up N notches, then down N notches: you must land exactly where you started.
//
// The user's test, and a far better one than measuring travel in one direction -- it needs no expected
// value, no cell arithmetic, and no judgement about what "smooth" means. Any asymmetry between the two
// paths through the code shows up as a non-zero difference, whatever causes it.
//
//   node tools/scroll-tests/scroll_round_trip.cjs [port] [session-id] [project]
//
// With no session id it seeds its own, so it can run unattended in the suite; pass one to aim it at a
// real session instead.
const { chromium } = require('playwright');
const PORT = process.argv[2] || '8536';
const GIVEN_ID = process.argv[3];
const PROJECT = process.argv[4] || (GIVEN_ID ? 'stock' : 'height-probe-root');
const BASE = `http://127.0.0.1:${PORT}`;
const NOTCH = 100;

const READ = (i) => {
  const v = window.__td.views.get(i);
  const b = v.term.buffer.active;
  const cell = v.term._core?._renderService?.dimensions?.css?.cell?.height || 21;
  // The visible position, in rows, across both scrolling surfaces at once. Measured from the rendered
  // window's own offset so it is valid in both scroll modes: offsetTop is 0 in the default mode and
  // viewportY*cell in whole-buffer mode, where scrollTop alone already spans the scrollback.
  return { row: b.viewportY + (v.container.scrollTop - v.term.element.offsetTop) / cell,
           viewportY: b.viewportY, top: Math.round(v.container.scrollTop), baseY: b.baseY, cell };
};

(async () => {
  const ID = GIVEN_ID || (await fetch(`${BASE}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'none', permission: 'default',
      cwd: '/Users/dan/workspace/height-probe-root', title: 'round-trip' }),
  }).then((r) => r.json())).session_id;

  const br = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await br.newPage({ viewport: { width: 1600, height: 900 } });
  await p.goto(`http://127.0.0.1:${PORT}/p/${PROJECT}`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
  await p.waitForTimeout(6000);
  await p.evaluate((i) => window.__td.activate(i), ID);
  await p.waitForTimeout(3000);
  if (!GIVEN_ID) {
    // Enough to push past the 4000-row screen, so both halves of the test have somewhere to travel: the
    // container for the shallow round trip, real scrollback for the deep one.
    await p.evaluate(({ i, s }) => window.__td.sendInput(window.__td.views.get(i), s),
      { i: ID, s: 'clear; seq 1 4800 | sed "s/^/line /"\n' });
    await p.waitForTimeout(12000);
  }

  const box = await p.evaluate((i) => {
    const r = window.__td.views.get(i).container.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, ID);
  await p.mouse.move(box.x, box.y);

  const roundTrip = async (label, notches, settleIntoScrollback) => {
    // Detach from the bottom first; optionally go all the way into scrollback, which is the path that
    // splits across two surfaces and where the asymmetry lives. In whole-buffer mode scrollTop 0 IS the
    // absolute top of everything -- no headroom left for the up-notches, which made the trip asymmetric
    // by construction -- so the deep start sits a little below it there instead.
    await p.evaluate(({ i, deep }) => {
      const v = window.__td.views.get(i);
      const whole = window.__td.wholeBufferScrollEnabled && window.__td.wholeBufferScrollEnabled();
      v.container.scrollTop = deep ? (whole ? 1600 : 0) : Math.max(0, (v.tallMaxScrollTop || 0) / 2);
    }, { i: ID, deep: settleIntoScrollback });
    await p.waitForTimeout(700);
    if (settleIntoScrollback) {
      for (let n = 0; n < 6; n += 1) { await p.mouse.wheel(0, -NOTCH); await p.waitForTimeout(70); }
      await p.waitForTimeout(700);
    }

    const start = await p.evaluate(READ, ID);
    for (let n = 0; n < notches; n += 1) { await p.mouse.wheel(0, -NOTCH); await p.waitForTimeout(90); }
    await p.waitForTimeout(600);
    const top = await p.evaluate(READ, ID);
    for (let n = 0; n < notches; n += 1) { await p.mouse.wheel(0, NOTCH); await p.waitForTimeout(90); }
    await p.waitForTimeout(600);
    const back = await p.evaluate(READ, ID);

    // Compared as an ABSOLUTE buffer row, which is what the reader is looking at. Normalising against
    // baseY was tried first and is wrong on a live session: baseY grows as output arrives, so a view that
    // never moved reported drift equal to the number of lines that had turned up during the test.
    const drift = back.row - start.row;
    console.log(`\n${label} (${notches} notches each way)`);
    console.log(`  start: ${JSON.stringify(start)}`);
    console.log(`  up:    ${JSON.stringify(top)}`);
    console.log(`  back:  ${JSON.stringify(back)}`);
    console.log(`  landed ${drift === 0 ? 'exactly where it started' : `${drift.toFixed(2)} rows off`}`);
    return Math.abs(drift);
  };

  const shallow = await roundTrip('CONTAINER ONLY', 4, false);
  const deep = await roundTrip('THROUGH SCROLLBACK', 8, true);

  // Half a row: below what anyone can see, and well under the whole-row snapping this is about.
  const ok = shallow <= 0.5 && deep <= 0.5;
  console.log(`\n  container round trip:  ${shallow <= 0.5 ? 'PASS' : `FAIL (${shallow.toFixed(2)} rows)`}`);
  console.log(`  scrollback round trip: ${deep <= 0.5 ? 'PASS' : `FAIL (${deep.toFixed(2)} rows)`}`);
  await br.close();
  if (!GIVEN_ID) await fetch(`${BASE}/api/sessions/${ID}`, { method: 'DELETE' }).catch(() => {});
  process.exit(ok ? 0 : 1);
})();
