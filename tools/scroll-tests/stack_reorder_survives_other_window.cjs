// A reorder inside an agent stack survives another window writing its own state. The drop used to
// reorder only the page that made it: nothing reached the server, so the next project state any
// window broadcast -- a phone left open on the deck writes its active terminal as you switch -- came
// back with the old order in it and put the row straight back, about a second after it moved.
// Drives the real row ondrop with a synthetic DragEvent, like stack_child_reorder.
//
//   node tools/scroll-tests/stack_reorder_survives_other_window.cjs [port]
const { chromium } = require('playwright');
const PORT = process.argv[2] || process.env.TERMDECK_TEST_PORT || '8536';
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = '/Users/dan/workspace/height-probe-root';
const PROJECT = 'height-probe-root';
const TOKEN = `otherwindow${process.pid}`;
const GROUP = `otherwindow-group-${process.pid}`;
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

(async () => {
  const post = (path, body, method = 'POST') => fetch(`${BASE}${path}`, { method,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  await post('/api/projects', { root: ROOT }).catch(() => {});
  const mk = (title) => post('/api/sessions', { model: 'none', permission: 'default', cwd: ROOT, title })
    .then((r) => r.json()).then((j) => j.session_id);
  const parent = await mk(`${TOKEN}-parent`);
  const first = await mk(`${TOKEN}-a`);
  const second = await mk(`${TOKEN}-b`);
  for (const id of [first, second]) await post(`/api/sessions/${id}/spawned-by`, { parent_session_id: parent });
  await post(`/api/terminal-groups?project=${PROJECT}`, { group_id: GROUP, name: 'OtherWindow' });
  await post(`/api/session-group-assignments?project=${PROJECT}`,
    { assignments: { [parent]: GROUP, [first]: GROUP, [second]: GROUP } }, 'PUT');
  const serverOrder = () => fetch(`${BASE}/api/project-state/session_order?project=${PROJECT}&worktree_id=root`)
    .then((r) => r.json()).then((j) => (j.value || []).filter((id) => id === first || id === second));

  const br = await chromium.launch({ headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const desk = await br.newPage({ viewport: { width: 1400, height: 850 } });
    // The phone: a separate browser context, as a second device would be.
    const phone = await (await br.newContext({ viewport: { width: 400, height: 800 } })).newPage();
    const errors = [];
    desk.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
    for (const page of [desk, phone]) {
      await page.goto(`${BASE}/p/${PROJECT}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
    }
    await desk.waitForTimeout(1500);
    const children = () => desk.evaluate((pid) => {
      const td = window.__td;
      td.expandedAgentStacks.add(pid);
      td.renderList();
      return td.spawnedChildrenOf(pid).map((s) => s.session_id);
    }, parent);
    const before = await children();
    const [dragId, targetId] = before;
    await desk.evaluate(({ dragId, targetId }) => {
      const td = window.__td;
      td.dragItem = { type: 'layout', token: `session:${dragId}`, kind: 'session', tokens: [`session:${dragId}`] };
      const row = document.querySelector(`.agent-stack-children .session-item[data-session-id="${targetId}"]`);
      row.classList.add('drop-after');
      const rect = row.getBoundingClientRect();
      row.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true,
        clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height * 0.75 }));
    }, { dragId, targetId });
    const expected = [targetId, dragId];
    await desk.waitForTimeout(800);
    check('the drop reorders the stack on the page that made it', JSON.stringify(await children()) === JSON.stringify(expected),
      JSON.stringify(await children()));
    // The phone switches terminal: a write of its own, which the server broadcasts to every window.
    await phone.evaluate((id) => fetch(`/api/project-state/active_session_id?project=height-probe-root&worktree_id=root`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: id }) }), parent);
    await desk.waitForTimeout(3000);
    const after = await children();
    check('the order survives the other window writing its state', JSON.stringify(after) === JSON.stringify(expected),
      `before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
    check('the server holds the new order', JSON.stringify(await serverOrder()) === JSON.stringify(expected),
      JSON.stringify(await serverOrder()));
    check('no page errors', errors.length === 0, errors.join(' | '));
  } finally {
    await br.close();
  }
  for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `  (${r.detail})`}`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
