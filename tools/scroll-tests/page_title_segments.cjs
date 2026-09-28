// Page title reads "project · branch · tab": the branch is the current worktree's,
// empty segments are dropped, and switching tabs refreshes it. vscodeMode keeps
// the plain "TermDeck" title.
//
//   node tools/scroll-tests/page_title_segments.cjs [port]
const { chromium } = require('playwright');
const PORT = process.argv[2] || process.env.TERMDECK_TEST_PORT || '8536';
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = '/Users/dan/workspace/height-probe-root';
const TOKEN = `titlesegprobe${process.pid}`;

(async () => {
  await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: ROOT }) }).catch(() => {});
  const mk = (title) => fetch(`${BASE}/api/sessions`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'none', permission: 'default', cwd: ROOT, title }),
  }).then((r) => r.json()).then((j) => j.session_id);
  const sid = await mk(`${TOKEN}-one`);
  const sid2 = await mk(`${TOKEN}-two`);
  const br = await chromium.launch({ headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await br.newPage({ viewport: { width: 1400, height: 850 } });
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.goto(`${BASE}/p/height-probe-root`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
  await p.waitForTimeout(1500);

  const titles = await p.evaluate(({ id, id2 }) => {
    const td = window.__td;
    const out = {};
    const realWorktrees = td.worktrees;
    const realWorktreeId = td.worktreeId;
    const realSlug = td.projectSlug;
    td.worktrees = [{ id: 'root', branch: 'feature-x', name: 'root', path: '/x', available: true },
      { id: 'wt-1', branch: 'hotfix', name: 'hotfix', path: '/y', available: true }];
    td.worktreeId = 'root';
    out.full = td.topbarPageTitle('sometab');
    td.worktrees = [{ id: 'root', branch: '', name: 'height-probe-root', path: '/x', available: true }];
    out.noBranch = td.topbarPageTitle('sometab');
    td.worktrees = realWorktrees;
    td.worktreeId = 'all';
    out.allWorktrees = td.topbarPageTitle('sometab');
    td.worktreeId = realWorktreeId;
    td.projectSlug = '';
    td.worktrees = [{ id: 'root', branch: 'main', name: 'root', path: '/x', available: true }];
    td.worktreeId = 'root';
    out.noProject = td.topbarPageTitle('sometab');
    td.projectSlug = realSlug;
    // Integration: a real active session renders the segments into document.title.
    td.worktrees = [{ id: 'root', branch: 'feature-x', name: 'root', path: '/x', available: true }];
    td.worktreeId = 'root';
    td.activate(id);
    td.renderTopbar();
    out.liveOne = document.title;
    td.activate(id2);
    td.renderTopbar();
    out.liveTwo = document.title;
    td.worktrees = realWorktrees;
    td.worktreeId = realWorktreeId;
    return out;
  }, { id: sid, id2: sid2 });
  console.log('titles:', JSON.stringify(titles, null, 1));

  const checks = [
    ['project, branch, and tab join with middots',
      titles.full === 'height-probe-root · feature-x · sometab'],
    ['empty branch drops out', titles.noBranch === 'height-probe-root · sometab'],
    ['all-worktrees view names itself', titles.allWorktrees === 'height-probe-root · All worktrees · sometab'],
    ['project-less page falls back to All projects', titles.noProject === 'All projects · main · sometab'],
    ['live title carries the session tab', titles.liveOne === `height-probe-root · feature-x · ${TOKEN}-one`],
    ['switching tabs refreshes the title', titles.liveTwo === `height-probe-root · feature-x · ${TOKEN}-two`],
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
  await fetch(`${BASE}/api/sessions/${sid2}`, { method: 'DELETE' }).catch(() => {});
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('probe error:', e.message);
  process.exit(2);
});
