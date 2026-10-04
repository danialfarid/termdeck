// Manual mark-as-unread is a sticky reminder: it survives the project-state echo
// and focus/visibility transitions while sitting on the tab, survives switching
// away, and clears when the tab is switched back into, typed in, or explicitly
// marked read.
//
//   node tools/scroll-tests/mark_unread_sticky.cjs [port]
const { chromium } = require('playwright');
const PORT = process.argv[2] || process.env.TERMDECK_TEST_PORT || '8536';
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = '/Users/dan/workspace/height-probe-root';
const TAG = `markunread${process.pid}`;

(async () => {
  await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: ROOT }) }).catch(() => {});
  const mk = async (title) => (await fetch(`${BASE}/api/sessions`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'none', permission: 'default', cwd: ROOT, title }),
  }).then((r) => r.json())).session_id;
  const a = await mk(`sticky-a-${TAG}`);
  const b = await mk(`sticky-b-${TAG}`);
  const br = await chromium.launch({ headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await br.newPage({ viewport: { width: 1400, height: 850 } });
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.goto(`${BASE}/p/height-probe-root`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
  await p.waitForTimeout(1500);
  const isUnread = (id) => p.evaluate((i) => ({
    set: window.__td.unreadSessions.has(i),
    dot: window.__td.sessionStatusEls.get(i)?.classList.contains('unread') ?? null,
  }), id);
  const hasFocus = await p.evaluate(() => document.hasFocus() && !document.hidden);
  console.log('page focused+visible:', hasFocus);
  await p.evaluate((i) => window.__td.activate(i), a);
  await p.waitForFunction((i) => window.__td.activeId === i, a, { timeout: 10000 });

  // The menu item calls setSessionsUnread(ids, true); the state echo that used to
  // wipe it is refreshUnreadSessionsFromState.
  await p.evaluate((i) => window.__td.setSessionsUnread([i], true), a);
  const marked = await isUnread(a);
  await p.evaluate(() => window.__td.refreshUnreadSessionsFromState());
  const afterEcho = await isUnread(a);
  await p.evaluate(() => window.dispatchEvent(new FocusEvent('focus')));
  await p.waitForTimeout(300);
  const afterFocus = await isUnread(a);
  console.log('marked:', JSON.stringify({ marked, afterEcho, afterFocus }));

  await p.evaluate((i) => window.__td.activate(i), b);
  await p.waitForFunction((i) => window.__td.activeId === i, b, { timeout: 10000 });
  const afterAway = await isUnread(a);
  await p.evaluate((i) => window.__td.activate(i), a);
  await p.waitForFunction((i) => window.__td.activeId === i, a, { timeout: 10000 });
  const afterBack = await isUnread(a);
  console.log('switch:', JSON.stringify({ afterAway, afterBack }));

  await p.evaluate((i) => window.__td.setSessionsUnread([i], true), a);
  await p.evaluate((i) => window.__td.sendInput(window.__td.views.get(i), 'x'), a);
  await p.waitForTimeout(300);
  const afterType = await isUnread(a);
  await p.evaluate((i) => window.__td.setSessionsUnread([i], true), a);
  const remarked = await isUnread(a);
  await p.evaluate((i) => window.__td.setSessionsUnread([i], false), a);
  const afterExplicitRead = await isUnread(a);
  console.log('type+explicit:', JSON.stringify({ afterType, remarked, afterExplicitRead }));

  const checks = [
    ['page focused+visible (auto-clear armed, non-vacuous)', hasFocus === true],
    ['mark shows the badge', marked.set === true && marked.dot === true],
    ['state echo does not clear it', afterEcho.set === true && afterEcho.dot === true],
    ['focus transition does not clear it', afterFocus.set === true],
    ['switching away keeps the reminder', afterAway.set === true],
    ['switching back into it clears it', afterBack.set === false],
    ['typing in it clears it', afterType.set === false],
    ['explicit mark-read clears it', remarked.set === true && afterExplicitRead.set === false],
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
  for (const sid of [a, b]) await fetch(`${BASE}/api/sessions/${sid}`, { method: 'DELETE' }).catch(() => {});
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('probe error:', e.message);
  process.exit(2);
});
