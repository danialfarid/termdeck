// A tab whose file cannot be opened must say so, not leave the previous file on screen.
//
// The reported shape: clicking a README.md tab in one project changed the address but not the middle
// panel, and reloading on it showed nothing. The tab was left over from an earlier session and the file
// had since been deleted; activateFile gave up on the failed read after having already switched the tab
// and written the address, so the editor kept rendering whichever file was there before.
//
//   node tools/scroll-tests/missing_file_tab.cjs [port]
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const PORT = process.argv[2] || process.env.TERMDECK_TEST_PORT || '8536';
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = process.env.TERMDECK_TEST_REPO || '/Users/dan/workspace/termdeck';
const PROJECT = ROOT.split('/').filter(Boolean).pop();
const GHOST = 'termdeck-missing-file-probe.md';

const snap = () => {
  const td = window.__td;
  const model = td.editor?.getModel?.();
  const notice = document.getElementById('file-unavailable');
  return {
    activeFile: (td.activeFileKey || '').split('|').pop() || null,
    editorModel: model ? decodeURIComponent(String(model.uri)).split('/').pop() : null,
    noticeShown: !!notice && !notice.classList.contains('hidden'),
    noticeTitle: document.getElementById('file-unavailable-title')?.textContent || '',
    noticeDetail: document.getElementById('file-unavailable-detail')?.textContent || '',
    tabs: [...document.querySelectorAll('#file-tabs .file-editor-tab')].map((t) => t.textContent.trim()),
  };
};

(async () => {
  await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: ROOT }) }).catch(() => {});
  const ghostPath = path.join(ROOT, GHOST);
  fs.writeFileSync(ghostPath, '# probe\n\nThis file is removed while its tab stays open.\n');

  const br = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await br.newPage({ viewport: { width: 1500, height: 900 } });
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  const results = [];
  const check = (label, ok, detail = '') => {
    results.push(ok);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`);
  };

  try {
    await p.goto(`${BASE}/p/${PROJECT}`, { waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
    await p.waitForTimeout(3000);
    await p.evaluate(({ root, name }) => window.__td.openFile(root, name, null, null, { pinned: true }), { root: ROOT, name: GHOST });
    await p.waitForTimeout(2500);
    await p.evaluate(({ root }) => window.__td.openFile(root, 'NOTICE', null, null, { pinned: true }), { root: ROOT });
    await p.waitForTimeout(2500);
    const other = await p.evaluate(snap);
    check('a second file is open and rendered', other.editorModel === 'NOTICE', JSON.stringify(other));

    // The user's way in: the tab is restored from a past session, so it has no buffer of its own, and
    // the file it names is gone by the time anyone clicks it.
    fs.unlinkSync(ghostPath);
    await p.reload({ waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
    await p.waitForTimeout(6000);
    await p.evaluate(({ root }) => window.__td.openFile(root, 'NOTICE', null, null, { pinned: true }), { root: ROOT });
    await p.waitForTimeout(2500);
    const restored = await p.evaluate(snap);
    check('a restored deck renders a file that does exist', restored.editorModel === 'NOTICE', JSON.stringify(restored));

    await p.evaluate((name) => [...document.querySelectorAll('#file-tabs .file-editor-tab')]
      .find((tab) => tab.textContent.trim().startsWith(name))?.click(), GHOST);
    await p.waitForTimeout(3000);
    const missing = await p.evaluate(snap);
    check('switching to the deleted file says so', missing.noticeShown && missing.noticeTitle === GHOST,
      JSON.stringify(missing));

    // Reloading straight onto it lands in the same honest state, not a blank panel.
    await p.reload({ waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
    await p.waitForTimeout(6000);
    const reloaded = await p.evaluate(snap);
    check('a reload onto it shows the notice too', reloaded.noticeShown, JSON.stringify(reloaded));

    // Close tab clears it and leaves a working deck.
    await p.click('#file-unavailable-close');
    await p.waitForTimeout(2500);
    const closed = await p.evaluate(snap);
    check('closing the tab clears the notice', !closed.noticeShown && !closed.tabs.includes(GHOST), JSON.stringify(closed));
  } finally {
    fs.rmSync(ghostPath, { force: true });
    await br.close();
  }
  console.log('\n  errors:', errors.length ? errors : 'none');
  process.exit(results.every(Boolean) && !errors.length ? 0 : 1);
})();
