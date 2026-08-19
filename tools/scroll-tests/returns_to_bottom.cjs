// Leave a tab that was at the bottom, let it produce output while you are away, come back: the newest
// lines and the composer must be on screen.
//
// Reported on Codex: ask a question, switch tabs, come back, and the view is wherever it was left --
// mid-content, with the composer out of sight. A hidden container has clientHeight 0, so the ceiling
// cannot be recomputed while the tab is away and nothing follows the output; coming back has to redo it.
//
//   node tools/scroll-tests/returns_to_bottom.cjs [port]
const { chromium } = require('playwright');
const PORT = process.argv[2] || '8536';
const BASE = `http://127.0.0.1:${PORT}`;

const READ = (i) => {
  const v = window.__td.views.get(i);
  const b = v.term.buffer.active;
  const cell = v.term._core?._renderService?.dimensions?.css?.cell?.height || 21;
  let lastContent = -1;
  for (let y = b.length - 1; y >= 0; y--) {
    if ((b.getLine(y)?.translateToString(true) || '').trim()) { lastContent = y; break; }
  }
  const lastVisible = b.viewportY + Math.ceil((v.container.scrollTop + v.container.clientHeight) / cell) - 1;
  return { top: Math.round(v.container.scrollTop), ceiling: v.tallMaxScrollTop,
           following: v.tallFollowing, scrollMode: v.scrollMode,
           viewportY: b.viewportY, baseY: b.baseY, lastContent, lastVisible,
           endVisible: lastVisible >= lastContent, rowsBelow: lastContent - lastVisible };
};

(async () => {
  const mk = async (title) => (await fetch(`${BASE}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'none', permission: 'default', cwd: '/Users/dan/workspace/height-probe-root', title }),
  }).then((r) => r.json())).session_id;
  const watched = await mk('returns-watched');
  const other = await mk('returns-other');

  const br = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await br.newPage({ viewport: { width: 1400, height: 850 } });
  await p.goto(`${BASE}/p/height-probe-root`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
  await p.waitForTimeout(1500);
  await p.evaluate((i) => window.__td.activate(i), watched);
  await p.waitForTimeout(2000);
  await p.evaluate(({ i, s }) => window.__td.sendInput(window.__td.views.get(i), s),
    { i: watched, s: 'clear; seq 1 1200 | sed "s/^/before /"\n' });
  await p.waitForTimeout(6000);

  const before = await p.evaluate(READ, watched);
  console.log('before leaving: ', JSON.stringify(before));
  if (!before.endVisible) { console.log('\nNOT AT THE BOTTOM TO BEGIN WITH -- nothing to test.'); await br.close(); process.exit(2); }

  // Away, and it keeps talking while we are gone -- the part that matters.
  await p.evaluate((i) => window.__td.activate(i), other);
  await p.waitForTimeout(1500);
  await p.evaluate(({ i, s }) => window.__td.sendInput(window.__td.views.get(i), s),
    { i: watched, s: 'seq 1 400 | sed "s/^/while-away /"\n' });
  await p.waitForTimeout(6000);

  await p.evaluate((i) => window.__td.activate(i), watched);
  await p.waitForTimeout(6000);
  const after = await p.evaluate(READ, watched);
  console.log('after returning:', JSON.stringify(after));

  // The position on arrival is only half of it. If the return left the view no longer following, the
  // NEXT thing the agent prints goes below the fold -- which is the actual complaint: come back, ask
  // something, and the answer arrives out of sight.
  await p.evaluate(({ i, s }) => window.__td.sendInput(window.__td.views.get(i), s),
    { i: watched, s: 'seq 1 120 | sed "s/^/after-return /"\n' });
  await p.waitForTimeout(6000);
  const later = await p.evaluate(READ, watched);
  console.log('after new output:', JSON.stringify(later));

  const ok = after.endVisible && later.endVisible;
  console.log(`\n  newest output on screen after returning:   ${after.endVisible ? 'PASS' : `FAIL (${after.rowsBelow} rows below)`}`);
  console.log(`  still following what it prints afterwards: ${later.endVisible ? 'PASS' : `FAIL (${later.rowsBelow} rows below)`}`);
  await br.close();
  for (const id of [watched, other]) await fetch(`${BASE}/api/sessions/${id}`, { method: 'DELETE' }).catch(() => {});
  process.exit(ok ? 0 : 1);
})();
