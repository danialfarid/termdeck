// Cmd+C while scrolled back must not move the view or drop the selection; plain typing still returns
// to the prompt.
const { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:8536';

(async () => {
  const res = await fetch(`${BASE}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'none', permission: 'default',
      cwd: '/Users/dan/workspace/height-probe-root', title: 'copy-test' }),
  });
  const id = (await res.json()).session_id;

  const br = await chromium.launch({ headless: true, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
  const p = await br.newPage({ viewport: { width: 1400, height: 850 } });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(`${BASE}/p/height-probe-root`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3000);
  await p.evaluate((i) => window.__td.activate(i), id);
  await p.waitForTimeout(2500);

  await p.evaluate((i) => window.__td.sendInput(window.__td.views.get(i), 'clear; seq 1 900\n'), id);
  await p.waitForTimeout(6000);

  const st = async () => p.evaluate((i) => {
    const v = window.__td.views.get(i);
    return { scrollTop: Math.round(v.container.scrollTop), following: v.tallFollowing,
             selection: v.term.getSelection().trim().slice(0, 20) };
  }, id);

  // Scroll back, then select some text (as a user would before copying).
  const box = await p.locator('.term-container.visible').boundingBox();
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await p.mouse.wheel(0, -2500);
  await p.waitForTimeout(700);
  await p.evaluate((i) => {
    const v = window.__td.views.get(i);
    const row = v.term.buffer.active.viewportY + Math.round(v.container.scrollTop / 21) + 3;
    v.term.select(0, row, 6);
  }, id);
  await p.waitForTimeout(400);
  const before = await st();
  console.log('scrolled back + selected:', JSON.stringify(before));

  await p.keyboard.press('Meta+c');
  await p.waitForTimeout(900);
  const afterCopy = await st();
  console.log('after Cmd+C:            ', JSON.stringify(afterCopy));

  // Bare modifier presses must also be inert.
  await p.keyboard.down('Meta'); await p.waitForTimeout(200); await p.keyboard.up('Meta');
  await p.keyboard.down('Shift'); await p.waitForTimeout(200); await p.keyboard.up('Shift');
  await p.waitForTimeout(600);
  const afterMods = await st();
  console.log('after bare Cmd/Shift:   ', JSON.stringify(afterMods));

  // Plain typing must still snap back to the prompt.
  await p.evaluate((i) => window.__td.views.get(i).term.focus(), id);
  await p.keyboard.press('x');
  await p.waitForTimeout(900);
  const afterTyping = await st();
  console.log('after typing "x":       ', JSON.stringify(afterTyping));
  await p.keyboard.press('Backspace');

  const held = afterCopy.scrollTop === before.scrollTop && afterCopy.following === false
    && afterCopy.selection === before.selection;
  const modsHeld = afterMods.scrollTop === before.scrollTop && afterMods.following === false;
  const typingSnapped = afterTyping.following === true && afterTyping.scrollTop !== before.scrollTop;
  console.log(`\nCmd+C kept view+selection: ${held ? 'PASS' : 'FAIL'}`);
  console.log(`bare modifiers inert:      ${modsHeld ? 'PASS' : 'FAIL'}`);
  console.log(`typing still snaps back:   ${typingSnapped ? 'PASS' : 'FAIL'}`);
  if (errs.length) console.log('page errors:', errs.slice(0, 4));
  await br.close();
  process.exit(held && modsHeld && typingSnapped ? 0 : 1);
})();
