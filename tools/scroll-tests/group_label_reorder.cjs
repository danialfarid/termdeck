// Reordering a full group by dropping it above another group label persists: the drop used to
// send after:null (a boolean OR over a rect that is null for group targets), the server 422'd
// it, and the failure handler reloaded server state -- so the group visibly moved and then
// snapped back to where it was a couple of seconds later.
// Drives the real label ondrop with a synthetic DragEvent, like stack_child_reorder.
//
//   node tools/scroll-tests/group_label_reorder.cjs [port]
const { chromium } = require('playwright');
const PORT = process.argv[2] || process.env.TERMDECK_TEST_PORT || '8536';
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = '/Users/dan/workspace/height-probe-root';
const TOKEN = `grouplabel${process.pid}`;
const G1 = `grouplabel-g1-${process.pid}`;
const G2 = `grouplabel-g2-${process.pid}`;
const fail = (msg) => { throw new Error(msg); };

(async () => {
  await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: ROOT }) }).catch(() => {});
  const mk = (title) => fetch(`${BASE}/api/sessions`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'none', permission: 'default', cwd: ROOT, title }),
  }).then((r) => r.json()).then((j) => j.session_id);
  const a = await mk(`${TOKEN}-A`);
  const b = await mk(`${TOKEN}-B`);
  for (const [group, ids] of [[G1, [a]], [G2, [b]]]) {
    await fetch(`${BASE}/api/terminal-groups?project=height-probe-root`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group_id: group, name: group.slice(-8), session_ids: ids }) });
  }
  const serverLayout = () => fetch(`${BASE}/api/terminal-layout?project=height-probe-root&worktree_id=root`)
    .then((r) => r.json()).then((j) => j.terminal_layout);
  const br = await chromium.launch({ headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const p = await br.newPage({ viewport: { width: 1400, height: 850 } });
    const errors = [];
    p.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
    await p.goto(`${BASE}/p/height-probe-root`, { waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
    await p.waitForFunction(([g1, g2]) => {
      const ids = new Set(window.__td.terminalGroups().map((g) => g.id));
      return ids.has(g1) && ids.has(g2);
    }, [G1, G2], { timeout: 60000 });
    await p.waitForTimeout(500);
    const groupOrder = () => p.evaluate(() =>
      [...document.querySelectorAll('#session-list .terminal-group')].map((g) => g.dataset.groupId));
    const before = await groupOrder();
    if (before.indexOf(G1) < 0 || before.indexOf(G2) < 0) fail(`groups missing: ${JSON.stringify(before)}`);
    // Drop G2 above G1: drop-before indicator, pointer at the label's top edge. The local move
    // lands synchronously in the drop handler; the save round-trip settles afterwards.
    const moved = await p.evaluate(({ src, tgt }) => {
      const td = window.__td;
      td.dragItem = { type: 'layout', token: `group:${src}`, kind: 'group', tokens: [`group:${src}`] };
      const label = document.querySelector(`.terminal-group[data-group-id="${tgt}"] > .terminal-group-label`);
      label.classList.add('drop-before');
      const rect = label.getBoundingClientRect();
      label.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true,
        clientX: rect.left + rect.width / 2, clientY: rect.top + 2 }));
      return [...document.querySelectorAll('#session-list .terminal-group')].map((g) => g.dataset.groupId);
    }, { src: G2, tgt: G1 });
    // Past the save round-trip plus the broadcast that used to carry the revert.
    await p.waitForTimeout(4000);
    const settled = await groupOrder();
    const server = await serverLayout();
    const g2First = (order) => order.indexOf(`group:${G2}`) >= 0 &&
      order.indexOf(`group:${G2}`) < order.indexOf(`group:${G1}`);
    if (!g2First(moved.map((id) => `group:${id}`))) fail(`drop did not move G2 above G1: ${JSON.stringify(moved)}`);
    if (!g2First(settled.map((id) => `group:${id}`))) fail(`order snapped back: ${JSON.stringify(settled)}`);
    if (!g2First(server)) fail(`server disagrees: ${JSON.stringify(server)}`);
    if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
    console.log('group label reorder ok');
  } finally {
    await br.close();
  }
  for (const id of [a, b]) {
    await fetch(`${BASE}/api/sessions/${id}`, { method: 'DELETE' }).catch(() => {});
  }
  for (const group of [G1, G2]) {
    await fetch(`${BASE}/api/terminal-groups/${group}?project=height-probe-root`, { method: 'DELETE' }).catch(() => {});
  }
})().catch((e) => { console.error(`FAIL: ${e.message}`); process.exit(1); });
