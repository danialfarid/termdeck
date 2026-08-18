// Proves the wheel-accounting detector in tools/watch_symptoms.cjs fires when the content travels
// further than the wheel pushed it, and stays quiet on a clean gesture.
//
// The fault it watches for ("scrolling down speeds up and skips a couple of lines") does not reproduce
// synthetically -- five configurations measured exact -- so the detector has to work on the real tab. A
// detector nobody has seen fire is worth nothing, hence this: the interference is faked, the accounting
// is real.
//
//   node tools/scroll-tests/overtravel_detector.cjs [port]
const { chromium } = require('playwright');
const { RECORDER } = require('../watch_symptoms.cjs');
const PORT = process.argv[2] || '8536';
const BASE = `http://127.0.0.1:${PORT}`;

(async () => {
  const id = (await fetch(`${BASE}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'none', permission: 'default',
      cwd: '/Users/dan/workspace/height-probe-root', title: 'overtravel-detector' }),
  }).then((r) => r.json())).session_id;

  const br = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await br.newPage({ viewport: { width: 1400, height: 850 } });
  await p.goto(`${BASE}/p/height-probe-root`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3000);
  await p.evaluate((i) => window.__td.activate(i), id);
  await p.waitForTimeout(2500);
  await p.evaluate(({ i, s }) => window.__td.sendInput(window.__td.views.get(i), s), { i: id, s: 'clear; seq 1 1500\n' });
  await p.waitForTimeout(5000);
  await p.evaluate(RECORDER, { ring: 400, before: 20, after: 6 });

  const box = await p.evaluate((i) => {
    const r = window.__td.views.get(i).container.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, id);
  await p.mouse.move(box.x, box.y);
  for (let n = 0; n < 30; n += 1) { await p.mouse.wheel(0, -100); await p.waitForTimeout(50); }
  await p.waitForTimeout(1500);

  const countAfter = async (label, interfere) => {
    const seen = await p.evaluate(() => window.__tdWatch.events.length);
    for (let n = 0; n < 8; n += 1) {
      await p.mouse.wheel(0, 100);
      if (interfere && n === 4) {
        // Something other than the gesture moves the view -- exactly the shape of the reported fault.
        await p.evaluate((i) => { window.__td.views.get(i).container.scrollTop += 400; }, id);
      }
      await p.waitForTimeout(60);
    }
    await p.waitForTimeout(1200);
    const events = await p.evaluate((from) => window.__tdWatch.events.slice(from), seen);
    const hits = events.filter((e) => e.kind === 'overtravel');
    console.log(`  ${label}: ${hits.length} overtravel event${hits.length === 1 ? '' : 's'}`);
    for (const h of hits) console.log(`      ${h.detail}`);
    return hits.length;
  };

  const clean = await countAfter('clean gesture           ', false);
  await p.waitForTimeout(800);
  for (let n = 0; n < 10; n += 1) { await p.mouse.wheel(0, -100); await p.waitForTimeout(50); }
  await p.waitForTimeout(1200);
  const dirty = await countAfter('gesture with interference', true);

  const ok = clean === 0 && dirty > 0;
  console.log(`\n  quiet on a clean gesture:  ${clean === 0 ? 'PASS' : 'FAIL'}`);
  console.log(`  fires when the view is moved out from under the gesture: ${dirty > 0 ? 'PASS' : 'FAIL'}`);
  await br.close();
  await fetch(`${BASE}/api/sessions/${id}`, { method: 'DELETE' }).catch(() => {});
  process.exit(ok ? 0 : 1);
})();
