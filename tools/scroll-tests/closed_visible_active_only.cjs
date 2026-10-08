// Recently closed terminals stay visible in "show active terminals only" mode: the eye toggle
// filters the live list to active/unread sessions, but the closed section below it is history,
// not clutter, and hiding it stranded reopening behind a mode switch.
//
//   node tools/scroll-tests/closed_visible_active_only.cjs [port]
const { chromium } = require('playwright');
const PORT = process.argv[2] || process.env.TERMDECK_TEST_PORT || '8536';
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = '/Users/dan/workspace/height-probe-root';
const TAG = `closedvis${process.pid}`;
const fail = (msg) => { throw new Error(msg); };

(async () => {
  await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: ROOT }) }).catch(() => {});
  const created = await fetch(`${BASE}/api/sessions`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'exec zsh -i', permission: 'default', cwd: ROOT, title: TAG }),
  }).then((r) => r.json());
  const id = created.session_id;
  if (!id) fail(`session create failed: ${JSON.stringify(created).slice(0, 200)}`);
  const del = await fetch(`${BASE}/api/sessions/${id}`, { method: 'DELETE' });
  if (!del.ok) fail(`session delete failed: ${del.status}`);
  const br = await chromium.launch({ headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const p = await br.newPage({ viewport: { width: 1400, height: 850 } });
    const errors = [];
    p.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
    await p.goto(`${BASE}/p/height-probe-root`, { waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
    await p.waitForFunction((tag) => window.__td.closedSessions.some((s) => s.title === tag), TAG, { timeout: 30000 });
    const headerVisible = () => p.evaluate(() => {
      const header = document.querySelector('#session-list .closed-header');
      if (!header) return { found: false };
      const rect = header.getBoundingClientRect();
      return { found: true, width: Math.round(rect.width), height: Math.round(rect.height) };
    });
    const before = await headerVisible();
    if (!before.found || !before.width) fail(`closed header missing before the toggle: ${JSON.stringify(before)}`);
    await p.evaluate(() => { window.__td.hideInactiveTerminals = true; window.__td.renderList(); });
    await p.waitForTimeout(300);
    const during = await headerVisible();
    if (!during.found || !during.width) fail(`closed header hidden in active-only mode: ${JSON.stringify(during)}`);
    await p.evaluate(() => { window.__td.hideInactiveTerminals = false; window.__td.renderList(); });
    await p.waitForTimeout(300);
    const after = await headerVisible();
    if (!after.found || !after.width) fail(`closed header missing after untoggling: ${JSON.stringify(after)}`);
    if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
    console.log('closed visible in active-only mode ok');
  } finally {
    await br.close();
  }
  await fetch(`${BASE}/api/closed/${id}`, { method: 'DELETE' }).catch(() => {});
})().catch((e) => { console.error(`FAIL: ${e.message}`); process.exit(1); });
