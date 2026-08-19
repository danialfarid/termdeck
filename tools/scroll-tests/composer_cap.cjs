// A popup taller than the screen must not push the composer off the top.
//
// Claude's slash menu is the real case: on the forced-height terminal it paints its full command list,
// well over a hundred rows below the composer, and following the content bottom put the composer ~90
// rows above the fold -- with nothing to bring it back on a fresh tab, because the ceiling only shrinks
// on writes and an open menu writes nothing. Following is capped so the cursor's row rides no higher
// than the top of the screen; the popup rows that do not fit stay reachable by scrolling, because the
// ceiling itself is deliberately not capped.
//
// Emulated without an agent: print a composer line, paint 150 option rows below it, then move the
// cursor back up onto the composer -- the exact shape the menu leaves the screen in.
//
//   node tools/scroll-tests/composer_cap.cjs [port]
const { chromium } = require('playwright');
const PORT = process.argv[2] || '8536';
const BASE = `http://127.0.0.1:${PORT}`;

const READ = (i) => {
  const v = window.__td.views.get(i);
  const b = v.term.buffer.active;
  const cell = v.term._core?._renderService?.dimensions?.css?.cell?.height || 21;
  const absCursor = (b.baseY || 0) + b.cursorY;
  const offset = v.container.scrollTop - v.term.element.offsetTop;
  const first = b.viewportY + Math.floor(offset / cell);
  const last = b.viewportY + Math.floor((offset + v.container.clientHeight - 1) / cell);
  let lastContent = -1;
  for (let y = b.length - 1; y >= 0; y--) {
    if ((b.getLine(y)?.translateToString(true) || '').trim()) { lastContent = y; break; }
  }
  return { top: Math.round(v.container.scrollTop), ceiling: v.tallMaxScrollTop, cell,
           absCursor, firstVisible: first, lastVisible: last, lastContent,
           cursorVisible: absCursor >= first && absCursor <= last,
           cursorText: (b.getLine(absCursor)?.translateToString(true) || '').trim().slice(0, 20) };
};

(async () => {
  const id = (await fetch(`${BASE}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'none', permission: 'default',
      cwd: '/Users/dan/workspace/height-probe-root', title: 'composer-cap' }),
  }).then((r) => r.json())).session_id;

  const br = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await br.newPage({ viewport: { width: 1400, height: 850 } });
  await p.goto(`${BASE}/p/height-probe-root`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
  await p.waitForTimeout(1500);
  await p.evaluate((i) => window.__td.activate(i), id);
  await p.waitForTimeout(2500);

  // The popup shape: composer, 150 options below, cursor back on the composer line. Held open by a
  // foreground sleep -- returning to the prompt would let zsh erase below the cursor and dissolve the
  // shape before it is measured.
  await p.evaluate(({ i, s }) => window.__td.sendInput(window.__td.views.get(i), s),
    { i: id, s: "clear; { printf 'COMPOSER> '; printf '\\n'; seq 1 150 | sed 's/^/  option /'; printf '\\033[151A\\033[10C'; sleep 45; }\n" });
  await p.waitForTimeout(4000);
  const open = await p.evaluate(READ, id);
  console.log('popup open:', JSON.stringify(open));

  // The overflow must still be reachable by scrolling down (the ceiling is not capped).
  const box = await p.evaluate((i) => {
    const r = window.__td.views.get(i).container.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, id);
  await p.mouse.move(box.x, box.y);
  for (let n = 0; n < 20; n += 1) { await p.mouse.wheel(0, 600); await p.waitForTimeout(120); }
  await p.waitForTimeout(4000);
  const scrolled = await p.evaluate(READ, id);
  console.log('scrolled:  ', JSON.stringify(scrolled));

  const held = open.cursorVisible && open.firstVisible <= open.absCursor;
  const overflowReachable = scrolled.lastVisible >= scrolled.lastContent;
  console.log(`\n  composer stays on screen under the popup: ${held ? 'PASS' : `FAIL (cursor row ${open.absCursor}, visible ${open.firstVisible}..${open.lastVisible})`}`);
  console.log(`  popup overflow reachable by scrolling:    ${overflowReachable ? 'PASS' : `FAIL (last content ${scrolled.lastContent}, saw to ${scrolled.lastVisible})`}`);
  await br.close();
  await fetch(`${BASE}/api/sessions/${id}`, { method: 'DELETE' }).catch(() => {});
  process.exit(held && overflowReachable ? 0 : 1);
})();
