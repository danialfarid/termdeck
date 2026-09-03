// The open file drives the address; the side panel only rides along.
//
// The reported shape: with the Git panel selected, reloading a page that had a file open dropped the file
// from the URL and came back on whatever the Git panel had selected. The cause was routing: a file opened
// while the Git panel was up was addressed as /g/<project>/<path>, and /g/ is parsed as "the Git tab"
// with the path segment ignored. The panel is a view of its own (?view=git), not the thing being read.
//
// The second half is the state the first half left behind: activating a file hid the Git review but left
// it flagged open, and openGitReviewDiff trusts that flag -- so clicking the same Git row again decided
// the diff was already on screen and returned, and the Git panel could no longer change the middle panel.
//
//   node tools/scroll-tests/file_tab_owns_url.cjs [port]
const { chromium } = require('playwright');
const PORT = process.argv[2] || process.env.TERMDECK_TEST_PORT || '8536';
const BASE = `http://127.0.0.1:${PORT}`;
// This test needs a git repository with at least one change to review. The checkout under test is one.
const ROOT = process.env.TERMDECK_TEST_REPO || '/Users/dan/workspace/termdeck';
const PROJECT = ROOT.split('/').filter(Boolean).pop();

const snap = () => {
  const td = window.__td;
  const model = td.editor?.getModel?.();
  const review = document.getElementById('git-review-area');
  const visible = (el) => !!el && !el.classList.contains('hidden') && el.getBoundingClientRect().height > 40;
  return {
    url: location.pathname + location.search,
    sideView: td.sideView,
    activeFile: (td.activeFileKey || '').split('|').pop() || null,
    gitReviewOpen: td.gitReviewOpen,
    reviewVisible: visible(review),
    editorModel: model ? decodeURIComponent(String(model.uri)).split('/').pop() : null,
    activeTab: document.querySelector('#file-tabs .file-editor-tab.active')?.textContent?.trim() || null,
  };
};

(async () => {
  await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: ROOT }) }).catch(() => {});
  const br = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await br.newPage({ viewport: { width: 1500, height: 900 } });
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  const results = [];
  const check = (label, ok, detail = '') => {
    results.push({ label, ok });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`);
  };

  await p.goto(`${BASE}/g/${PROJECT}`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
  await p.waitForTimeout(5000);
  const row = await p.$('#git-results .git-file-row');
  if (!row) {
    console.log('\n  SKIP: no pending Git changes in the test repository, nothing to review');
    await br.close();
    process.exit(0);
  }

  await row.click();
  await p.waitForTimeout(2500);
  const diff = await p.evaluate(snap);
  check('a Git row opens its diff', diff.reviewVisible && diff.activeFile === null, JSON.stringify(diff));
  check('a diff is addressed on the files route, not a Git route',
    diff.url.startsWith(`/f/${PROJECT}/`) && diff.url.includes('git_path=') && diff.url.includes('view=git'), diff.url);

  // The same diff by address: reload it and it comes back.
  const diffUrl = diff.url;
  await p.goto(BASE + diffUrl, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
  await p.waitForTimeout(6000);
  const diffReloaded = await p.evaluate(snap);
  check('a diff address restores the diff', diffReloaded.reviewVisible && diffReloaded.sideView === 'git',
    JSON.stringify(diffReloaded));

  await p.evaluate(({ root }) => window.__td.openFile(root, 'README.md', null, null, { pinned: true }), { root: ROOT });
  await p.waitForTimeout(2500);
  const file = await p.evaluate(snap);
  check('opening a file takes the panel back from the diff',
    !file.reviewVisible && !file.gitReviewOpen && file.editorModel === 'README.md', JSON.stringify(file));
  check('and is addressed as a file, with the panel in ?view=',
    file.url.startsWith(`/f/${PROJECT}/`) && file.url.includes('README.md') && file.url.includes('view=git'), file.url);

  // The same row again: the flag said "already showing this" while the file had the panel.
  await (await p.$('#git-results .git-file-row')).click();
  await p.waitForTimeout(2500);
  const again = await p.evaluate(snap);
  check('the same Git row still works after a file took the panel',
    again.reviewVisible && again.activeFile === null, JSON.stringify(again));

  await p.evaluate(({ root }) => window.__td.openFile(root, 'README.md', null, null, { pinned: true }), { root: ROOT });
  await p.waitForTimeout(2000);
  const before = await p.evaluate(snap);
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
  await p.waitForTimeout(6000);
  const after = await p.evaluate(snap);
  check('a reload keeps the file', after.activeFile === before.activeFile && after.editorModel === before.editorModel,
    `${before.activeFile} -> ${after.activeFile}`);
  check('a reload keeps the Git panel', after.sideView === 'git', after.sideView);
  check('a reload keeps the address', after.url === before.url, `${before.url} -> ${after.url}`);

  // Switching the panel while a file is open updates ?view= so a reload comes back to the same panel,
  // without moving off the file's own route.
  await p.evaluate(() => window.__td.setSideView('project', false));
  await p.waitForTimeout(1500);
  const switched = await p.evaluate(snap);
  check('switching the panel keeps the file route and records the panel',
    switched.url.startsWith(`/f/${PROJECT}/`) && switched.url.includes('README.md') && !switched.url.includes('view=git'),
    switched.url);

  // Addresses already in people's history: a file path under the old /g/ route.
  await p.goto(`${BASE}/g/${PROJECT}/main/README.md`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
  await p.waitForTimeout(6000);
  const legacy = await p.evaluate(snap);
  check('an old /g/<project>/<path> address still opens the file',
    legacy.editorModel === 'README.md' && legacy.sideView === 'git', JSON.stringify(legacy));

  const legacyDiff = diffUrl.replace(`/f/${PROJECT}/`, `/g/${PROJECT}/`);
  await p.goto(BASE + legacyDiff, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
  await p.waitForTimeout(6000);
  const legacyReview = await p.evaluate(snap);
  check('an old /g/ diff address still opens its diff',
    legacyReview.reviewVisible && legacyReview.sideView === 'git', JSON.stringify(legacyReview));

  console.log('\n  errors:', errors.length ? errors : 'none');
  await br.close();
  process.exit(results.every((result) => result.ok) && !errors.length ? 0 : 1);
})();
