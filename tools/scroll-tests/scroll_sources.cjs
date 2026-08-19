// Covers the scroll sources that emit no wheel events -- scrollbar drag and middle-click autoscroll --
// which is exactly what the wheel-only follow logic used to miss.
//   A. drag to the bottom while output streams: must not tear (no write may move the view mid-gesture)
//   B. autoscroll up then back down: the newest line must end up visible again
const { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:8536';

const state = (p, id, label) => p.evaluate((i) => {
  const v = window.__td.views.get(i);
  const b = v.term.buffer.active;
  const cell = v.term._core._renderService.dimensions.css.cell.height;
  // Count a row visible if any part of it is inside the viewport (the container shows a partial row).
  const firstRow = b.viewportY + Math.floor(v.container.scrollTop / cell);
  const lastRow = b.viewportY + Math.ceil((v.container.scrollTop + v.container.clientHeight) / cell) - 1;
  let lastContent = -1;
  for (let y = b.length - 1; y >= 0; y--) {
    if ((b.getLine(y)?.translateToString(true) || '').trim()) { lastContent = y; break; }
  }
  return { scrollTop: Math.round(v.container.scrollTop), ceiling: v.tallMaxScrollTop,
           viewportY: b.viewportY, baseY: b.baseY, following: v.tallFollowing,
           pinned: v.tallPinnedViewportY, lastContent, lastRow,
           lastLineVisible: lastRow >= lastContent };
}, id).then((s) => { console.log(label, JSON.stringify(s)); return s; });

(async () => {
  const mk = async (title) => {
    const r = await fetch(`${BASE}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'none', permission: 'default', cwd: '/Users/dan/workspace/height-probe-root', title }) });
    return (await r.json()).session_id;
  };
  const id = await mk('scroll-sources');
  const br = await chromium.launch({ headless: true, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
  const p = await br.newPage({ viewport: { width: 1400, height: 850 } });
  await p.goto(`${BASE}/p/height-probe-root`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3000);
  await p.evaluate((i) => window.__td.activate(i), id);
  await p.waitForTimeout(2500);
  await p.evaluate((i) => window.__td.sendInput(window.__td.views.get(i), 'clear; seq 1 4400\n'), id);
  await p.waitForTimeout(7000);

  // ---- A: scrollbar-style drag to the bottom WHILE output streams ----
  await p.evaluate((i) => window.__td.sendInput(window.__td.views.get(i),
    'for i in $(seq 1 200); do echo streaming-$i; sleep 0.03; done\n'), id);
  await p.waitForTimeout(1500);
  const tear = await p.evaluate(async (i) => {
    const v = window.__td.views.get(i);
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    let movedByApp = 0, dragging = true;
    Object.defineProperty(v.container, 'scrollTop', {
      configurable: true,
      get() { return desc.get.call(this); },
      set(val) {
        // Only a write that actually DISPLACES the view is a tear. A write of the value the
        // container already holds paints nothing and cannot be seen.
        const cur = desc.get.call(this);
        if (dragging && Math.round(val) !== window.__dragTarget && Math.abs(Math.round(val) - cur) > 2) {
          movedByApp++; (window.__when = window.__when || []).push({ f: window.__frame, from: cur, to: Math.round(val) });
        }
        return desc.set.call(this, val);
      },
    });
    // Thumb dragged downward across the whole range, 40 frames of continuous motion.
    const ceil = v.tallMaxScrollTop || 0;
    await new Promise((resolve) => {
      let n = 0;
      const tick = () => {
        window.__frame = n;
        window.__dragTarget = Math.round((ceil + 4000) * (n / 39));
        v.container.scrollTop = window.__dragTarget;
        if (++n >= 40) return resolve();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    dragging = false;
    await new Promise((r) => setTimeout(r, 900));
    return { movedByApp, whenFrames: (window.__when || []).slice(0, 12), following: v.tallFollowing, settled: Math.round(v.container.scrollTop), ceiling: v.tallMaxScrollTop };
  }, id);
  console.log('A drag-while-streaming:', JSON.stringify(tear));
  const aOk = tear.movedByApp === 0;
  console.log(`  no writes moved the view mid-drag: ${aOk ? 'PASS' : `FAIL (${tear.movedByApp} moves = tearing)`}`);

  await p.waitForTimeout(3000);

  // ---- B: autoscroll (no wheel events at all) up, then back down ----
  await p.evaluate((i) => {
    const v = window.__td.views.get(i);
    v.container.scrollTop = 0;                     // "middle-click drag to the top"
  }, id);
  await p.waitForTimeout(900);
  await state(p, id, 'B after autoscroll up  ');
  // Then wheel further up so it enters xterm scrollback, as the user described.
  const box = await p.locator('.term-container.visible').boundingBox();
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let k = 0; k < 6; k++) { await p.mouse.wheel(0, -3000); await p.waitForTimeout(100); }
  await p.waitForTimeout(700);
  await state(p, id, 'B after wheel into back');
  // Now autoscroll straight back to the bottom (again, no wheel events).
  await p.evaluate((i) => {
    const v = window.__td.views.get(i);
    v.container.scrollTop = v.container.scrollHeight;
  }, id);
  await p.waitForTimeout(1200);
  const b = await state(p, id, 'B after autoscroll down');
  console.log(`  newest line reachable: ${b.lastLineVisible ? 'PASS' : 'FAIL (bottom invisible)'}`);
  console.log(`  stale pin cleared:     ${b.pinned === null ? 'PASS' : `FAIL (pinned=${b.pinned})`}`);

  await br.close();
  process.exit(aOk && b.lastLineVisible && b.pinned === null ? 0 : 1);
})();
