// Dropping a spawned child into a gap between list entries files it out of its stack: the gap
// zones sit at the list's top level, so landing there is leaving the parent, the same as a drop
// onto a row outside the stack. The zone used to move only the layout -- which a stacked row is
// not drawn from -- so the drop visibly did nothing and the child stayed put.
// Drives the real zone ondrop with a synthetic DragEvent, like stack_child_reorder.
//
//   node tools/scroll-tests/stack_child_escape_zone.cjs [port]
const { chromium } = require('playwright');
const PORT = process.argv[2] || process.env.TERMDECK_TEST_PORT || '8536';
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = '/Users/dan/workspace/height-probe-root';
const TOKEN = `stackescape${process.pid}`;

(async () => {
  await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: ROOT }) }).catch(() => {});
  const mk = (title) => fetch(`${BASE}/api/sessions`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'none', permission: 'default', cwd: ROOT, title }),
  }).then((r) => r.json()).then((j) => j.session_id);
  const parent = await mk(`${TOKEN}-parent`);
  const child = await mk(`${TOKEN}-child`);
  const target = await mk(`${TOKEN}-target`);
  await fetch(`${BASE}/api/sessions/${child}/spawned-by`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parent_session_id: parent }) });
  const br = await chromium.launch({ headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await br.newPage({ viewport: { width: 1400, height: 850 } });
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.goto(`${BASE}/p/height-probe-root`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
  await p.waitForTimeout(1500);

  const before = await p.evaluate(({ pid, cid }) => {
    const td = window.__td;
    td.expandedAgentStacks.add(pid);
    td.renderList();
    const row = document.querySelector(`.session-item[data-session-id="${cid}"]`);
    return { stacked: !!row?.closest('.agent-stack-children'),
      filedUnder: td.session(cid)?.spawned_by_session_id || null };
  }, { pid: parent, cid: child });
  console.log('before:', JSON.stringify(before));
  // The last zone sits after the final entry, so the escapee should land last.
  await p.evaluate(({ cid }) => {
    const td = window.__td;
    td.dragItem = { type: 'layout', token: `session:${cid}`, kind: 'session', tokens: [`session:${cid}`] };
    const zones = [...document.querySelectorAll('#session-list .terminal-layout-drop-zone')];
    const zone = zones[zones.length - 1];
    const rect = zone.getBoundingClientRect();
    zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
  }, { cid: child });
  await p.waitForTimeout(2500);
  const after = await p.evaluate(({ cid }) => {
    const td = window.__td;
    const rows = [...document.querySelectorAll('#session-list .session-item[data-session-id]')];
    return {
      filedUnder: td.session(cid)?.spawned_by_session_id || null,
      stacked: !!document.querySelector(`.session-item[data-session-id="${cid}"]`)?.closest('.agent-stack-children'),
      lastRow: rows[rows.length - 1]?.dataset.sessionId || null,
    };
  }, { cid: child });
  console.log('after:', JSON.stringify(after));
  const serverFiled = await fetch(`${BASE}/api/sessions`).then((r) => r.json())
    .then((list) => list.find((s) => s.session_id === child)?.spawned_by_session_id || null);

  const checks = [
    ['child starts stacked under its parent', before.stacked && before.filedUnder === parent],
    ['gap drop un-files the child', after.filedUnder === null],
    ['server agrees the child is released', serverFiled === null],
    ['child row leaves the stack', after.stacked === false],
    ['child lands after the final entry', after.lastRow === child],
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
  for (const id of [parent, child, target]) {
    await fetch(`${BASE}/api/sessions/${id}`, { method: 'DELETE' }).catch(() => {});
  }
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('probe error:', e.message);
  process.exit(2);
});
