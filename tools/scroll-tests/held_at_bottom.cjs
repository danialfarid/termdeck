// Exact repro: drag the thumb FAST to the bottom and HOLD it there.
//
// The self-sustaining part is what a naive model misses: while the pointer stays down, the browser keeps
// re-deriving scrollTop from it, so the moment the app clamps, the browser puts it back -- which looks
// like fresh scrolling, schedules another settle, and pulses forever. This reproduces that by re-asserting
// the drag position whenever the app moves it, exactly as a held thumb does, and counts app moves.
const { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:8536';

(async () => {
  const r = await fetch(`${BASE}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'none', permission: 'default',
      cwd: '/Users/dan/workspace/height-probe-root', title: 'held-at-bottom' }),
  });
  const id = (await r.json()).session_id;
  const br = await chromium.launch({ headless: true, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
  const p = await br.newPage({ viewport: { width: 1400, height: 850 } });
  await p.goto(`${BASE}/p/height-probe-root`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3000);
  await p.evaluate((i) => window.__td.activate(i), id);
  await p.waitForTimeout(2500);
  await p.evaluate((i) => window.__td.sendInput(window.__td.views.get(i), 'clear; seq 1 150\n'), id);
  await p.waitForTimeout(4500);

  const out = await p.evaluate(async (i) => {
    const v = window.__td.views.get(i);
    const c = v.container;
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    const held = Math.min(c.scrollHeight - c.clientHeight, (v.tallMaxScrollTop || 0) + 8000);
    let appMoves = 0, holding = true;

    // Tell the app a pointer is down, as a real scrollbar grab does.
    c.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 1390, clientY: 400 }));

    Object.defineProperty(c, 'scrollTop', {
      configurable: true,
      get() { return desc.get.call(this); },
      set(val) {
        const cur = desc.get.call(this);
        const mine = Math.round(val) === held;
        if (holding && !mine && Math.abs(Math.round(val) - cur) > 2) {
          appMoves++;
          desc.set.call(this, val);
          // The browser re-asserts the held pointer position on the next frame.
          requestAnimationFrame(() => { if (holding) desc.set.call(this, held); });
          return;
        }
        return desc.set.call(this, val);
      },
    });

    desc.set.call(c, held);                       // fast drag to the bottom
    await new Promise((res) => setTimeout(res, 2500));   // ...and hold
    holding = false;
    c.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 1390, clientY: 400 }));
    await new Promise((res) => setTimeout(res, 900));    // release settles once
    return { appMovesWhileHeld: appMoves, ceiling: v.tallMaxScrollTop,
             afterRelease: Math.round(desc.get.call(c)), following: v.tallFollowing };
  }, id);

  console.log(JSON.stringify(out, null, 1));
  const ok = out.appMovesWhileHeld === 0 && out.afterRelease === out.ceiling;
  console.log(ok ? '\nPASS: nothing moved while held; clamped once on release'
                 : `\nFAIL: ${out.appMovesWhileHeld} app moves while held (that is the flicker)`);
  await br.close();
  process.exit(ok ? 0 : 1);
})();
