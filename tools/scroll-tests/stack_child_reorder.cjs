// Reordering inside an expanded agent stack moves the child within the stack:
// the drop must not un-file it (land outside the children) nor move it to the
// group's end. Drives the real row ondrop with a synthetic DragEvent.
//
//   node tools/scroll-tests/stack_child_reorder.cjs [port]
const { chromium } = require('playwright');
const PORT = process.argv[2] || process.env.TERMDECK_TEST_PORT || '8536';
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = '/Users/dan/workspace/height-probe-root';
const TOKEN = `stackreorder${process.pid}`;
const GROUP = `stackreorder-group-${process.pid}`;

(async () => {
  await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: ROOT }) }).catch(() => {});
  const mk = (title) => fetch(`${BASE}/api/sessions`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'none', permission: 'default', cwd: ROOT, title }),
  }).then((r) => r.json()).then((j) => j.session_id);
  const parent = await mk(`${TOKEN}-parent`);
  const first = await mk(`${TOKEN}-a`);
  const second = await mk(`${TOKEN}-b`);
  for (const id of [first, second]) {
    await fetch(`${BASE}/api/sessions/${id}/spawned-by`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent_session_id: parent }) });
  }
  await fetch(`${BASE}/api/terminal-groups?project=height-probe-root`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ group_id: GROUP, name: 'StackReorder' }) });
  await fetch(`${BASE}/api/session-group-assignments?project=height-probe-root`, { method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignments: { [parent]: GROUP, [first]: GROUP, [second]: GROUP } }) });
  const br = await chromium.launch({ headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await br.newPage({ viewport: { width: 1400, height: 850 } });
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.goto(`${BASE}/p/height-probe-root`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
  await p.waitForTimeout(1500);

  const before = await p.evaluate(({ pid }) => {
    const td = window.__td;
    td.expandedAgentStacks.add(pid);
    td.renderList();
    return td.spawnedChildrenOf(pid).map((s) => s.session_id);
  }, { pid: parent });
  console.log('children before:', JSON.stringify(before));
  const [dragId, targetId] = before;
  await p.evaluate(({ dragId, targetId }) => {
    const td = window.__td;
    td.dragItem = { type: 'layout', token: `session:${dragId}`, kind: 'session', tokens: [`session:${dragId}`] };
    const row = document.querySelector(`.agent-stack-children .session-item[data-session-id="${targetId}"]`);
    row.classList.add('drop-after');
    const rect = row.getBoundingClientRect();
    row.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height * 0.75 }));
  }, { dragId, targetId });
  await p.waitForTimeout(2000);
  const after = await p.evaluate(({ pid, dragId }) => {
    const td = window.__td;
    return {
      children: td.spawnedChildrenOf(pid).map((s) => s.session_id),
      filedUnder: td.session(dragId)?.spawned_by_session_id || null,
      group: (td.getProjectState().session_groups || {})[dragId] || null,
    };
  }, { pid: parent, dragId });
  console.log('after:', JSON.stringify(after));

  const checks = [
    ['two children render under the parent', before.length === 2],
    ['drop keeps the child filed under its parent', after.filedUnder === parent],
    ['drop reorders within the stack', after.children.length === 2 &&
      after.children[0] === targetId && after.children[1] === dragId],
    ['group assignment untouched', after.group === GROUP],
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
  for (const id of [parent, first, second]) {
    await fetch(`${BASE}/api/sessions/${id}`, { method: 'DELETE' }).catch(() => {});
  }
  await fetch(`${BASE}/api/terminal-groups/${GROUP}?project=height-probe-root`, { method: 'DELETE' }).catch(() => {});
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('probe error:', e.message);
  process.exit(2);
});
