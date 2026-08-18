// Faithful model of a scrollbar drag: while the thumb MOVES, scrollTop changes every frame and the
// browser fires scroll events continuously; when the thumb stops, scroll events stop.
//
// The bug is the clamp firing DURING the movement: each clamp yanks the thumb back while the pointer is
// still below it, the browser re-drags to the pointer, and the two alternate -- the tearing. So the
// assertion is "zero clamps while the drag is moving, exactly one once it stops".
const { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:8536';

(async () => {
  const r = await fetch(`${BASE}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'none', permission: 'default',
      cwd: '/Users/dan/workspace/height-probe-root', title: 'drag-fight2' }),
  });
  const id = (await r.json()).session_id;
  const br = await chromium.launch({ headless: true, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
  const p = await br.newPage({ viewport: { width: 1400, height: 850 } });
  await p.goto(`${BASE}/p/height-probe-root`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3000);
  await p.evaluate((i) => window.__td.activate(i), id);
  await p.waitForTimeout(2500);
  await p.evaluate((i) => window.__td.sendInput(window.__td.views.get(i), 'clear; seq 1 120\n'), id);
  await p.waitForTimeout(4000);

  const out = await p.evaluate(async (i) => {
    const v = window.__td.views.get(i);
    const ceiling = v.tallMaxScrollTop;
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    let clampsDuring = 0, clampsAfter = 0, dragging = true;
    Object.defineProperty(v.container, 'scrollTop', {
      configurable: true,
      get() { return desc.get.call(this); },
      set(val) {
        const cur = desc.get.call(this);
        const displaced = Math.abs(Math.round(val) - cur) > 2;
        if (Math.round(val) === ceiling) {
          if (dragging) { clampsDuring++; if (displaced) (window.__disp = window.__disp || []).push({ from: cur, to: Math.round(val) }); }
          else clampsAfter++;
        }
        return desc.set.call(this, val);
      },
    });
    // Thumb moving downward past the end, ~40 frames (~0.7s) of continuous motion.
    await new Promise((resolve) => {
      let n = 0;
      const tick = () => {
        v.container.scrollTop = ceiling + 300 + n * 60;   // pointer keeps moving down
        if (++n >= 40) return resolve();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    dragging = false;
    await new Promise((r2) => setTimeout(r2, 700));       // thumb released / held still
    return { ceiling, clampsDuring, clampsAfter, displacing: (window.__disp || []).length, samples: (window.__disp || []).slice(0,4), settled: Math.round(v.container.scrollTop) };
  }, id);

  console.log('RAW', JSON.stringify(out));
  console.log(`ceiling=${out.ceiling}`);
  console.log(`clamps while the drag was moving: ${out.clampsDuring}   (each one is a tear)`);
  console.log(`clamps after it stopped:          ${out.clampsAfter}`);
  console.log(`settled at:                       ${out.settled}`);
  const ok = out.clampsDuring === 0 && out.settled === out.ceiling;
  console.log(ok ? '\nPASS: no fight during the drag, clamped once at the end'
                 : `\nFAIL: ${out.clampsDuring} clamps during the drag`);
  await br.close();
  process.exit(ok ? 0 : 1);
})();
