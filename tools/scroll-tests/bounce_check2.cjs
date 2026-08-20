// Detects bottom overscroll at the moment the browser reports it, BEFORE the app's clamp corrects it.
// rAF sampling misses this: the clamp runs inside the scroll handler, so by the next frame the value is
// already corrected. A capture-phase scroll listener runs ahead of the app's own bubble-phase clamp, so
// it sees the raw position the browser actually scrolled to.
const { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:8536';

(async () => {
  const mk = async (title) => {
    const r = await fetch(`${BASE}/api/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'none', permission: 'default',
        cwd: '/Users/dan/workspace/height-probe-root', title }),
    });
    return (await r.json()).session_id;
  };
  const emptyId = await mk('bounce2-empty');
  const fullId = await mk('bounce2-full');

  const br = await chromium.launch({ headless: true, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
  const p = await br.newPage({ viewport: { width: 1400, height: 850 } });
  await p.goto(`${BASE}/p/height-probe-root`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3000);

  let bad = 0;
  for (const [id, lines, label] of [[emptyId, 0, 'near-empty'], [fullId, 300, '300 lines']]) {
    await p.evaluate((i) => window.__td.activate(i), id);
    await p.waitForTimeout(3000);
    if (lines) {
      await p.evaluate(({ i, n }) => window.__td.sendInput(window.__td.views.get(i), `clear; seq 1 ${n}\n`), { i: id, n: lines });
      await p.waitForTimeout(4000);
    }

    await p.evaluate((i) => {
      const v = window.__td.views.get(i);
      window.__o = { seen: 0, maxOver: 0, ceiling: v.tallMaxScrollTop, events: 0 };
      v.container.addEventListener('scroll', () => {
        const ceil = v.tallMaxScrollTop;
        if (ceil == null) return;
        window.__o.events++;
        const over = v.container.scrollTop - ceil;
        if (over > 1) { window.__o.seen++; window.__o.maxOver = Math.max(window.__o.maxOver, Math.round(over)); }
      }, { capture: true });
    }, id);

    const box = await p.locator('.term-container.visible').boundingBox();
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let k = 0; k < 4; k++) { await p.mouse.wheel(0, 6000); await p.waitForTimeout(400); }
    await p.waitForTimeout(1000);

    const r = await p.evaluate(() => window.__o);
    const ok = r.seen === 0;
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'OVERSCROLL'}  ${label.padEnd(12)} overscrolledEvents=${r.seen}/${r.events} ` +
                `maxOvershoot=${r.maxOver}px ceiling=${r.ceiling}`);
  }
  console.log(bad ? '\nOVERSCROLL PRESENT (this is the bounce)' : '\nNO OVERSCROLL: browser never scrolled past the last line');
  await br.close();
  process.exit(bad ? 1 : 0);
})();
