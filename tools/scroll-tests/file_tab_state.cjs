// Open file tabs keep IDE-grade editor state: scroll, cursor, undo, and the find widget's
// query survive tab switches, browser back/forward, and page reloads (view state persists to
// localStorage; models stay alive in the session). External disk changes apply as one undo stop
// instead of wiping the stack with setValue.
//
// The regression this pins: without bracketing stack elements the sync edit merges into the open
// typing stop, and the next undo silently drops content (measured: a trailing space vanished).
// The test types a trailing-space marker, syncs an external rewrite, undoes, and byte-compares.
//
//   node tools/scroll-tests/file_tab_state.cjs [port]
const { chromium } = require('playwright');
const fs = require('fs');
const PORT = process.argv[2] || process.env.TERMDECK_TEST_PORT || '8536';
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = '/Users/dan/workspace/height-probe-root';
const PATH = `file-tab-state-probe-${process.pid}.txt`;
const content = (tag) => Array.from({ length: 200 },
  (_, i) => `STATE-${tag}-LINE-${String(i + 1).padStart(3, '0')} padding`).join('\n') + '\n';

const SNAP = (k) => {
  const td = window.__td;
  const entry = td.openFiles.get(k);
  const ed = td.editor;
  const w = document.querySelector('#monaco-host .find-widget');
  let query = null;
  try { query = ed.getContribution('editor.contrib.findController')?.getState()?.searchString ?? null; } catch {}
  return { scrollTop: Math.round(ed.getScrollTop()), cursor: ed.getPosition()?.lineNumber ?? null,
    canUndo: entry?.model?.canUndo() ?? null, dirty: !!entry?.dirty,
    findOpen: !!w && getComputedStyle(w).display !== 'none', findQuery: query,
    value: entry?.model?.getValue() ?? null };
};

(async () => {
  await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: ROOT }) }).catch(() => {});
  await fetch(`${BASE}/api/files/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: ROOT, path: PATH, directory: false }) }).catch(() => {});
  await fetch(`${BASE}/api/files/write`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: ROOT, path: PATH, content: content('V1') }) });
  const sid = (await fetch(`${BASE}/api/sessions`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'none', permission: 'default', cwd: ROOT, title: 'file-tab-state' }),
  }).then((r) => r.json())).session_id;
  const br = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await br.newPage({ viewport: { width: 1400, height: 850 } });
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.goto(`${BASE}/p/height-probe-root`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
  await p.waitForTimeout(1500);
  await p.evaluate((i) => window.__td.activate(i), sid);
  await p.waitForTimeout(800);
  const key = `${ROOT}|${PATH}`;
  await p.evaluate(({ r, f }) => window.__td.openFile(r, f, null, null, { pinned: true }), { r: ROOT, f: PATH });
  await p.waitForFunction((k) => window.__td.activeFileKey === k && !!window.__td.openFiles.get(k)?.model,
    key, { timeout: 15000 });
  await p.waitForTimeout(800);
  await p.evaluate(() => {
    const ed = window.__td.editor;
    ed.setPosition({ lineNumber: 150, column: 1 });
    ed.revealLineInCenter(150);
    ed.focus();
  });
  await p.waitForTimeout(300);
  await p.keyboard.type('MARK-A ');
  await p.waitForTimeout(300);
  await p.evaluate(() => window.__td.editor.getAction('actions.find').run());
  await p.waitForTimeout(500);
  await p.keyboard.type('LINE-1');
  await p.waitForTimeout(500);
  const seeded = await p.evaluate(SNAP, key);
  console.log('seeded:  ', JSON.stringify({ ...seeded, value: `${seeded.value.length} chars` }));

  await p.evaluate(() => history.back());
  await p.waitForFunction(() => window.__td.activeFileKey === null, null, { timeout: 10000 });
  await p.waitForTimeout(600);
  await p.evaluate(() => history.forward());
  await p.waitForFunction((k) => window.__td.activeFileKey === k, key, { timeout: 10000 });
  await p.waitForTimeout(1200);
  const returned = await p.evaluate(SNAP, key);
  console.log('returned:', JSON.stringify({ ...returned, value: `${returned.value.length} chars` }));

  await fetch(`${BASE}/api/files/write`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: ROOT, path: PATH, content: content('V2') }) });
  await p.evaluate(() => history.back());
  await p.waitForFunction(() => window.__td.activeFileKey === null, null, { timeout: 10000 });
  await p.evaluate(() => history.forward());
  await p.waitForFunction((k) => window.__td.activeFileKey === k, key, { timeout: 10000 });
  await p.waitForTimeout(1200);
  const synced = await p.evaluate(SNAP, key);
  await p.evaluate(() => window.__td.editor.getModel().undo());
  await p.waitForTimeout(400);
  const undoneValue = await p.evaluate((k) => window.__td.openFiles.get(k).model.getValue(), key);
  console.log('synced:  ', JSON.stringify({ ...synced, value: `${synced.value.length} chars` }));
  console.log('undo-exact:', undoneValue === seeded.value);

  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
  await p.waitForTimeout(2500);
  await p.evaluate(({ r, f }) => window.__td.openFile(r, f, null, null, { pinned: true }), { r: ROOT, f: PATH });
  await p.waitForFunction((k) => window.__td.activeFileKey === k && !!window.__td.openFiles.get(k)?.model,
    key, { timeout: 15000 });
  await p.waitForTimeout(1200);
  const reloaded = await p.evaluate(SNAP, key);
  console.log('reloaded:', JSON.stringify({ ...reloaded, value: `${(reloaded.value || '').length} chars` }));

  await p.evaluate(({ r, f }) => window.__td.openFile(r, f, 20, null, {}), { r: ROOT, f: PATH });
  await p.waitForTimeout(1200);
  const forced = await p.evaluate(SNAP, key);
  console.log('forced:  ', JSON.stringify({ ...forced, value: `${(forced.value || '').length} chars` }));

  const checks = [
    ['seed holds scroll, cursor, undo, find', seeded.scrollTop > 1000 && seeded.cursor === 150 &&
      seeded.canUndo === true && seeded.findOpen === true && seeded.findQuery === 'LINE-1'],
    ['back/forward preserves everything', returned.scrollTop === seeded.scrollTop && returned.cursor === 150 &&
      returned.canUndo === true && returned.value === seeded.value &&
      returned.findOpen === true && returned.findQuery === 'LINE-1'],
    ['external sync keeps undo and position', synced.canUndo === true && synced.value.includes('STATE-V2-LINE-001') &&
      synced.scrollTop === seeded.scrollTop && synced.findQuery === 'LINE-1'],
    ['undo after sync restores bytes exactly', undoneValue === seeded.value],
    ['reload restores scroll, cursor, find', reloaded.scrollTop === seeded.scrollTop && reloaded.cursor === 150 &&
      reloaded.findOpen === true && reloaded.findQuery === 'LINE-1'],
    ['explicit line still wins', forced.cursor === 20],
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
  await fetch(`${BASE}/api/sessions/${sid}`, { method: 'DELETE' }).catch(() => {});
  try { fs.unlinkSync(`${ROOT}/${PATH}`); } catch {}
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('probe error:', e.message);
  try { fs.unlinkSync(`${ROOT}/${PATH}`); } catch {}
  process.exit(2);
});
