// The Markdown toggle: only for Markdown files, and beside Notes rather than under it.
//
// The visibility half shipped broken once and is the reason this exists: the button was given
// class="hidden", but style.css has no blanket `.hidden { display: none }` -- every use is scoped to the
// element -- so the class was set correctly and the button stayed on screen for every file.
//
// The layout half pins the row: Notes and Markdown share one row hanging under the tab strip, Notes on
// the right, and both stop short of the right edge so they do not sit on the editor's own scrollbar.
//
//   node tools/scroll-tests/markdown_view_toggle.cjs [port]
const { chromium } = require('playwright');
const PORT = process.argv[2] || process.env.TERMDECK_TEST_PORT || '8536';
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = process.env.TERMDECK_TEST_REPO || '/Users/dan/workspace/termdeck';
const PROJECT = ROOT.split('/').filter(Boolean).pop();

const snap = () => {
  const markdown = document.getElementById('file-tabs-markdown');
  const notes = document.getElementById('file-tabs-notebook');
  const view = document.getElementById('markdown-file-view');
  const box = (el) => { const r = el.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), width: Math.round(r.width) }; };
  const scrollbar = document.querySelector('#monaco-host .monaco-scrollable-element > .scrollbar.vertical');
  return {
    active: (window.__td.activeFileKey || '').split('|').pop() || null,
    markdownDisplay: getComputedStyle(markdown).display,
    markdownBox: box(markdown), notesBox: box(notes),
    viewShown: !view.classList.contains('hidden'),
    renderedChars: view.textContent.length,
    editorRight: Math.round(document.getElementById('monaco-host').getBoundingClientRect().right),
    scrollbarWidth: scrollbar ? Math.round(scrollbar.getBoundingClientRect().width) : -1,
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
    results.push(ok);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`);
  };

  await p.goto(`${BASE}/p/${PROJECT}`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
  await p.waitForTimeout(3000);

  await p.evaluate(({ root }) => window.__td.openFile(root, 'run.sh', null, null, { pinned: true }), { root: ROOT });
  await p.waitForTimeout(2500);
  const plain = await p.evaluate(snap);
  // Computed display, not the class: setting the class is exactly what used to look right and do nothing.
  check('no Markdown toggle on a file that is not Markdown',
    plain.markdownDisplay === 'none' && plain.markdownBox.width === 0, JSON.stringify(plain));
  check('Notes takes the whole hanging row when it is alone',
    plain.notesBox.right < plain.editorRight && plain.editorRight - plain.notesBox.right <= 16,
    JSON.stringify(plain));

  await p.evaluate(({ root }) => window.__td.openFile(root, 'README.md', null, null, { pinned: true }), { root: ROOT });
  await p.waitForTimeout(2500);
  const md = await p.evaluate(snap);
  check('a Markdown file offers the toggle', md.markdownDisplay !== 'none' && md.markdownBox.width > 0, JSON.stringify(md));
  check('Notes and Markdown share one row, Notes on the right',
    md.markdownBox.top === md.notesBox.top && md.notesBox.left > md.markdownBox.left, JSON.stringify(md));
  check('the row stops short of the editor scrollbar',
    md.notesBox.right < md.editorRight && md.editorRight - md.notesBox.right >= 8, JSON.stringify(md));

  await p.click('#file-tabs-markdown');
  await p.waitForTimeout(1200);
  const rendered = await p.evaluate(snap);
  check('the toggle renders the document', rendered.viewShown && rendered.renderedChars > 500, JSON.stringify(rendered));

  await p.keyboard.press('Alt+Shift+M');
  await p.waitForTimeout(1000);
  const back = await p.evaluate(snap);
  check('the shortcut returns to the source', !back.viewShown, JSON.stringify(back));

  check('the editor scrollbar is the width the rest of the app uses',
    back.scrollbarWidth === -1 || back.scrollbarWidth === 12, String(back.scrollbarWidth));

  console.log('\n  errors:', errors.length ? errors : 'none');
  await br.close();
  process.exit(results.every(Boolean) && !errors.length ? 0 : 1);
})();
