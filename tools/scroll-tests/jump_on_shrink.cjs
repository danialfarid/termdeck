// A composer that redraws (Codex re-rendering as you type, or recalling a long prompt) momentarily
// reports fewer content rows. Since .term-inner is now sized to the content, that shrinks the scrollable
// box -- and if scrollTop was near the bottom, the browser must clamp it, which the user sees as the view
// jumping up. This drives that oscillation directly and counts scroll jumps nobody asked for.
const { chromium } = require('playwright');
const PORT = process.argv[2] || process.env.TERMDECK_TEST_PORT || '8536';
const BASE = `http://127.0.0.1:${PORT}`;

(async () => {
  const r = await fetch(`${BASE}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'none', permission: 'default',
      cwd: '/Users/dan/workspace/height-probe-root', title: 'jump-on-shrink' }),
  });
  const id = (await r.json()).session_id;
  const br = await chromium.launch({ headless: true, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
  const p = await br.newPage({ viewport: { width: 1400, height: 850 } });
  await p.goto(`${BASE}/p/height-probe-root`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3000);
  await p.evaluate((i) => window.__td.activate(i), id);
  await p.waitForTimeout(2500);
  await p.evaluate((i) => window.__td.sendInput(window.__td.views.get(i), 'clear; seq 1 400\n'), id);
  for (let k = 0; k < 40; k++) {
    const c = await p.evaluate((i) => window.__td.views.get(i)?.tallMaxScrollTop || 0, id);
    if (c > 500) break;
    await p.waitForTimeout(500);
  }
  await p.waitForTimeout(2000);

  // Watch inner height and scrollTop every frame.
  await p.evaluate((i) => {
    const v = window.__td.views.get(i);
    const inner = v.container.querySelector('.term-inner');
    window.__m = { heights: [], jumps: 0, maxJump: 0, lastTop: Math.round(v.container.scrollTop), lastH: inner.offsetHeight, shrinks: 0 };
    const tick = () => {
      const h = inner.offsetHeight;
      const top = Math.round(v.container.scrollTop);
      if (h !== window.__m.lastH) { if (h < window.__m.lastH) window.__m.shrinks++; window.__m.heights.push(h); window.__m.lastH = h; }
      // Following DOWN by a row as new output arrives is correct terminal behaviour, not jutter. What
      // the user sees as jutter is the view moving UP, or moving by more than a row at a time.
      // Moving DOWN is following new output, however many rows arrive in one frame -- correct.
      // Moving UP without the user asking is the jutter: the view retreating from the prompt.
      const d = top - window.__m.lastTop;
      if (d < -2) { window.__m.jumps++; window.__m.maxJump = Math.max(window.__m.maxJump, -d); }
      window.__m.lastTop = top;
      window.__m.raf = requestAnimationFrame(tick);
    };
    tick();
  }, id);

  // Oscillate the last content row: print a line, then move up and erase it, repeatedly -- exactly the
  // shape of a composer redrawing itself while you type.
  await p.evaluate((i) => window.__td.sendInput(window.__td.views.get(i),
    "for i in $(seq 1 25); do printf 'composer-line-%s\\n' $i; sleep 0.12; printf '\\033[A\\033[K'; sleep 0.12; done\n"), id);
  await p.waitForTimeout(9000);

  const m = await p.evaluate(() => { cancelAnimationFrame(window.__m.raf); return window.__m; });
  console.log(JSON.stringify({ innerShrinks: m.shrinks, distinctHeights: [...new Set(m.heights)].slice(0, 8),
                               scrollJumps: m.jumps, maxJumpPx: m.maxJump }, null, 1));
  console.log(m.jumps === 0 ? '\nPASS: no unrequested scroll jumps'
                            : `\nJUMPING: ${m.jumps} jumps, worst ${m.maxJump}px (this is the jutter)`);
  await br.close();
  process.exit(m.jumps === 0 ? 0 : 1);
})();
