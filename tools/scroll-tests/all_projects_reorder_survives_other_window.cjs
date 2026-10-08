// A terminal dragged to a new place in the All-projects list stays there when another window
// writes its own state -- a phone left open on the deck, switching terminals.
//
//   node tools/scroll-tests/all_projects_reorder_survives_other_window.cjs [port]
const { chromium } = require('playwright');
const PORT = process.argv[2] || process.env.TERMDECK_TEST_PORT || '8536';
const BASE = `http://127.0.0.1:${PORT}`;
const ROOTS = ['/Users/dan/workspace/height-probe-root', '/Users/dan/workspace/termdeck'];
const TOKEN = `allreorder${process.pid}`;
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

(async () => {
  const post = (path, body, method = 'POST') => fetch(`${BASE}${path}`, { method,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  for (const root of ROOTS) await post('/api/projects', { root }).catch(() => {});
  const mk = (title, cwd) => post('/api/sessions', { model: 'none', permission: 'default', cwd, title })
    .then((r) => r.json()).then((j) => j.session_id);
  const ids = [await mk(`${TOKEN}-one`, ROOTS[0]), await mk(`${TOKEN}-two`, ROOTS[1]),
               await mk(`${TOKEN}-three`, ROOTS[0])];
  const br = await chromium.launch({ headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const desk = await br.newPage({ viewport: { width: 1400, height: 850 } });
    const phone = await (await br.newContext({ viewport: { width: 400, height: 800 } })).newPage();
    const errors = [];
    const writes = [];
    desk.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
    desk.on('response', async (r) => {
      if (!r.url().includes('/api/') || r.request().method() === 'GET') return;
      writes.push(`${r.request().method()} ${r.url().replace(BASE, '').split('?')[0]} ${r.status()}`);
    });
    for (const page of [desk, phone]) {
      await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
      await page.evaluate(() => window.__td.switchProject?.(""));
    }
    await desk.waitForTimeout(2000);
    const order = () => desk.evaluate((mine) =>
      [...document.querySelectorAll('#session-list .session-item[data-session-id]')]
        .map((row) => row.dataset.sessionId).filter((id) => mine.includes(id)), ids);
    const before = await order();
    check('all three terminals are listed', before.length === 3, JSON.stringify(before));
    const [dragId, , targetId] = before;
    await desk.evaluate(({ dragId, targetId }) => {
      const td = window.__td;
      td.dragItem = { type: 'layout', token: `session:${dragId}`, kind: 'session', tokens: [`session:${dragId}`],
                      worktreeId: td.stateWorktreeId() };
      td.sidebarSelectedSessionIds = new Set([dragId]);
      const row = document.querySelector(`#session-list .session-item[data-session-id="${targetId}"]`);
      row.classList.add('drop-after');
      const rect = row.getBoundingClientRect();
      row.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true,
        clientX: rect.left + rect.width / 2, clientY: rect.bottom - 2 }));
    }, { dragId, targetId });
    await desk.waitForTimeout(1000);
    const moved = await order();
    check('the drop moves it on the page that made it', moved[moved.length - 1] === dragId, JSON.stringify(moved));
    await phone.evaluate((id) => fetch('/api/project-state/active_session_id?project=&worktree_id=root',
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: id }) }), ids[1]);
    await desk.waitForTimeout(3000);
    const after = await order();
    check('the order survives the other window writing its state', JSON.stringify(after) === JSON.stringify(moved),
      `moved ${JSON.stringify(moved)} after ${JSON.stringify(after)}`);
    // A page loaded now knows only what the server kept.
    const fresh = await (await br.newContext({ viewport: { width: 1400, height: 850 } })).newPage();
    await fresh.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await fresh.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
    await fresh.evaluate(() => window.__td.switchProject?.(""));
    await fresh.waitForTimeout(2500);
    const reloaded = await fresh.evaluate((mine) =>
      [...document.querySelectorAll('#session-list .session-item[data-session-id]')]
        .map((row) => row.dataset.sessionId).filter((id) => mine.includes(id)), ids);
    check('a page loaded afterwards shows the new order', JSON.stringify(reloaded) === JSON.stringify(moved),
      `moved ${JSON.stringify(moved)} fresh page ${JSON.stringify(reloaded)}`);
    check('every write the drop made succeeded', writes.every((w) => / 2\d\d$/.test(w)), writes.join(' | '));
    check('no page errors', errors.length === 0, errors.join(' | '));
    console.log('writes:', writes.join(' | '));
  } finally {
    await br.close();
  }
  for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `  (${r.detail})`}`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
