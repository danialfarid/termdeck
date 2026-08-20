// Dragging to the very bottom reaches a row or two past the last line (the blank rows the fixed-height
// canvas always has). The complaint is not that it goes there -- it is that it visibly jumps BACK.
// So: a small overshoot must be left where it lands; a large one must still be corrected.
const { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:8536';

const run = async (p, id, overshootPx, label) => {
  const out = await p.evaluate(async ({ i, over }) => {
    const v = window.__td.views.get(i);
    const c = v.container;
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    const ceiling = v.tallMaxScrollTop;
    const target = Math.min(c.scrollHeight - c.clientHeight, ceiling + over);
    // Drag there with the pointer down, then release -- the real gesture.
    c.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 1390, clientY: 400 }));
    desc.set.call(c, target);
    await new Promise((r) => setTimeout(r, 500));
    const whileHeld = Math.round(desc.get.call(c));
    c.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 1390, clientY: 400 }));
    await new Promise((r) => setTimeout(r, 900));
    return { ceiling, requested: target, whileHeld, afterRelease: Math.round(desc.get.call(c)) };
  }, { i: id, over: overshootPx });
  const jumped = Math.abs(out.afterRelease - out.whileHeld) > 2;
  console.log(`${label} ceiling=${out.ceiling} landed=${out.whileHeld} afterRelease=${out.afterRelease} ` +
              `jumpedBack=${jumped ? Math.abs(out.afterRelease - out.whileHeld) + 'px' : 'no'}`);
  return { out, jumped };
};

(async () => {
  const r = await fetch(`${BASE}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'none', permission: 'default',
      cwd: '/Users/dan/workspace/height-probe-root', title: 'snapback' }),
  });
  const id = (await r.json()).session_id;
  const br = await chromium.launch({ headless: true, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
  const p = await br.newPage({ viewport: { width: 1400, height: 850 } });
  await p.goto(`${BASE}/p/height-probe-root`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3000);
  await p.evaluate((i) => window.__td.activate(i), id);
  await p.waitForTimeout(2500);
  await p.evaluate((i) => window.__td.sendInput(window.__td.views.get(i), 'clear; seq 1 600\n'), id);
  for (let k = 0; k < 40; k++) {
    const c = await p.evaluate((i) => window.__td.views.get(i)?.tallMaxScrollTop || 0, id);
    if (c > 1000) break;
    await p.waitForTimeout(500);
  }
  await p.waitForTimeout(1500);

  const small = await run(p, id, 42, 'small overshoot (2 lines):');
  await p.waitForTimeout(1500);
  const large = await run(p, id, 4000, 'large overshoot (sparse) :');

  const ok = !small.jumped && large.out.afterRelease === large.out.ceiling;
  console.log(`\n  small overshoot stays put:      ${!small.jumped ? 'PASS' : 'FAIL (visible snap back)'}`);
  console.log(`  large overshoot still corrected: ${large.out.afterRelease === large.out.ceiling ? 'PASS' : 'FAIL'}`);
  await br.close();
  process.exit(ok ? 0 : 1);
})();
