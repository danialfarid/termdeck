// 1. A SLOW scroll up from the bottom must detach and stay detached (it used to be swallowed by the
//    at-bottom tolerance and yanked straight back down).
// 2. The scroll-to-bottom button must actually return the container to the bottom.
const { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:8536';

(async () => {
  const r = await fetch(`${BASE}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'none', permission: 'default',
      cwd: '/Users/dan/workspace/height-probe-root', title: 'slow-scroll' }),
  });
  const id = (await r.json()).session_id;
  const br = await chromium.launch({ headless: true, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
  const p = await br.newPage({ viewport: { width: 1400, height: 850 } });
  await p.goto(`${BASE}/p/height-probe-root`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3000);
  await p.evaluate((i) => window.__td.activate(i), id);
  await p.waitForTimeout(2500);
  await p.evaluate((i) => window.__td.sendInput(window.__td.views.get(i), 'clear; seq 1 600\n'), id);
  // Wait for a real ceiling rather than a fixed delay: on a cold instance the shell can take a while,
  // and testing against an empty terminal silently measures nothing.
  for (let k = 0; k < 40; k++) {
    const c = await p.evaluate((i) => window.__td.views.get(i)?.tallMaxScrollTop || 0, id);
    if (c > 1000) break;
    await p.waitForTimeout(500);
  }
  await p.waitForTimeout(1500);

  const st = async () => p.evaluate((i) => {
    const v = window.__td.views.get(i);
    return { scrollTop: Math.round(v.container.scrollTop), ceiling: v.tallMaxScrollTop, following: v.tallFollowing };
  }, id);

  const start = await st();
  console.log('at bottom:            ', JSON.stringify(start));

  // Slow scroll: small deltas, well spaced, the way a careful mouse wheel behaves.
  const box = await p.locator('.term-container.visible').boundingBox();
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let k = 0; k < 3; k++) { await p.mouse.wheel(0, -20); await p.waitForTimeout(400); }
  await p.waitForTimeout(900);   // let the settle handler run and possibly yank it back
  const slow = await st();
  console.log('after slow scroll up: ', JSON.stringify(slow));
  const detached = slow.scrollTop < start.scrollTop && slow.following === false;
  console.log(`  slow scroll detaches and stays: ${detached ? 'PASS' : 'FAIL (snapped back to bottom)'}`);

  // Scroll further away, then use the button to come back.
  await p.mouse.wheel(0, -4000);
  await p.waitForTimeout(800);
  const away = await st();
  console.log('scrolled away:        ', JSON.stringify(away));
  await p.click('#scroll-bottom-btn');
  await p.waitForTimeout(1200);
  const after = await st();
  console.log('after button:         ', JSON.stringify(after));
  const buttonWorks = after.scrollTop === after.ceiling && after.following === true;
  console.log(`  scroll-to-bottom button works:  ${buttonWorks ? 'PASS' : 'FAIL'}`);

  await br.close();
  process.exit(detached && buttonWorks ? 0 : 1);
})();
