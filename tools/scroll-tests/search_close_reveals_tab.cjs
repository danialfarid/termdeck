// Closing the sidebar terminal search scrolls the clicked (active) terminal into
// view, like the reveal/focus button: after the full list is back, the active
// row must sit inside the sidebar's visible scrollport instead of wherever the
// short filtered list left the scroll position.
//
//   node tools/scroll-tests/search_close_reveals_tab.cjs [port]
const { chromium } = require('playwright');
const PORT = process.argv[2] || process.env.TERMDECK_TEST_PORT || '8536';
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = '/Users/dan/workspace/height-probe-root';
const TAG = `revealclose${process.pid}`;
const TARGET_TITLE = `zzztarget-${TAG}`;
const FILLERS = 29;

(async () => {
  await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: ROOT }) }).catch(() => {});
  const mk = async (title) => (await fetch(`${BASE}/api/sessions`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'none', permission: 'default', cwd: ROOT, title }),
  }).then((r) => r.json())).session_id;
  const ids = [];
  for (let i = 0; i < FILLERS; i++) ids.push(await mk(`filler-${i}-${TAG}`));
  const target = await mk(TARGET_TITLE);
  ids.push(target);
  const br = await chromium.launch({ headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await br.newPage({ viewport: { width: 1400, height: 850 } });
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.goto(`${BASE}/p/height-probe-root`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
  await p.waitForTimeout(1500);
  const before = await p.evaluate(() => {
    const list = document.querySelector('#session-list');
    return { rows: list.querySelectorAll('.session-item').length,
      scrollH: list.scrollHeight, clientH: list.clientHeight };
  });
  console.log('before:', JSON.stringify(before));

  await p.click('#project-terminal-search-btn');
  await p.waitForFunction(() => !!document.querySelector('#terminal-search-inline'), null, { timeout: 5000 });
  await p.fill('#terminal-search-input', TARGET_TITLE);
  await p.waitForFunction(() => document.querySelectorAll('#session-list .session-item').length === 1,
    null, { timeout: 15000 });
  await p.click(`#session-list .session-item[data-session-id="${target}"]`);
  await p.waitForFunction((id) => window.__td.activeId === id, target, { timeout: 10000 });
  await p.click('#terminal-search-input');
  await p.keyboard.press('Escape');
  await p.waitForFunction(() => !document.querySelector('#terminal-search-inline'), null, { timeout: 5000 });
  const escClosed = true;
  await p.waitForTimeout(600);
  const after = await p.evaluate((id) => {
    const list = document.querySelector('#session-list');
    const row = list.querySelector(`.session-item[data-session-id="${id}"]`);
    const listBox = list.getBoundingClientRect();
    const rowBox = row.getBoundingClientRect();
    return { rows: list.querySelectorAll('.session-item').length, active: window.__td.activeId === id,
      scrollTop: list.scrollTop, scrollH: list.scrollHeight, clientH: list.clientHeight,
      rowOffsetTop: row.offsetTop,
      rowTop: Math.round(rowBox.top - listBox.top), rowBottom: Math.round(rowBox.bottom - listBox.top),
      listH: Math.round(listBox.height) };
  }, target);
  console.log('after:', JSON.stringify(after));

  const visible = after.rowTop >= -1 && after.rowBottom <= after.listH + 1;
  const checks = [
    ['full list overflowing before the search', before.rows === FILLERS + 1 && before.scrollH > before.clientH + 50],
    ['search filtered to the one target row', true], // waitForFunction above proves it
    ['click activated the target', after.active],
    ['Escape closed the panel', escClosed],
    ['full list restored after close', after.rows === FILLERS + 1],
    ['target row fully visible in the sidebar after close', visible],
    // Vacuity guard: the target sits below the first viewport, so code that never
    // scrolls on close cannot pass.
    ['target below the first fold (non-vacuous)', after.rowOffsetTop > after.clientH],
    ['no page errors', errors.length === 0],
  ];
  console.log('');
  let ok = true;
  for (const [name, pass] of checks) {
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`);
    if (!pass) ok = false;
  }
  if (errors.length) console.log('  pageerrors: ' + errors.join(' | ').slice(0, 400));
  await br.close();
  for (const sid of ids) await fetch(`${BASE}/api/sessions/${sid}`, { method: 'DELETE' }).catch(() => {});
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('probe error:', e.message);
  process.exit(2);
});
