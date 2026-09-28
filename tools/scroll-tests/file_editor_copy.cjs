// File-mode copy: an editor selection survives right-click, shows exactly one context
// menu (TermDeck's, with a working Copy item), and Cmd+C lands in copy history.
//
// The regressions this pins:
//  1. `selection.isEmpty` was read as a property (always truthy) instead of called, so
//     readSelectionActionState always returned null for the editor: no Copy item in our
//     menu, no selection-actions bar, nothing recorded in copy history.
//  2. The same missing parens in openFileEditorContextMenu made the caret-positioning
//     guard always true, so every right-click collapsed the selection.
//  3. Monaco's own context menu was left enabled alongside ours, so a right-click
//     showed two stacked menus (Monaco's on top; picking Copy revealed ours beneath).
//
//   node tools/scroll-tests/file_editor_copy.cjs [port]
const { chromium } = require('playwright');
const fs = require('fs');
const PORT = process.argv[2] || process.env.TERMDECK_TEST_PORT || '8536';
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = '/Users/dan/workspace/height-probe-root';
const PATH = `file-editor-copy-probe-${process.pid}.txt`;
const LINES = Array.from({ length: 60 },
  (_, i) => `COPYME-LINE-${String(i + 1).padStart(3, '0')} padding padding`).join('\n') + '\n';

const SELECT = () => {
  const ed = window.__td.editor;
  ed.setSelection({ startLineNumber: 5, startColumn: 1, endLineNumber: 7, endColumn: 10 });
  ed.focus();
  const sel = ed.getSelection();
  const state = window.__td.readSelectionActionState();
  return { kind: typeof sel.isEmpty, empty: sel.isEmpty(), stateKind: state?.kind ?? null,
    stateText: state?.text ?? null };
};

const CLICK_POINT = () => {
  const ed = window.__td.editor;
  const pos = ed.getScrolledVisiblePosition({ lineNumber: 6, column: 5 });
  const r = ed.getDomNode().getBoundingClientRect();
  const x = r.left + pos.left + 4, y = r.top + pos.top + 4;
  const hit = document.elementFromPoint(x, y);
  return { x, y, hitEditor: !!hit?.closest?.('#monaco-host') };
};

const MENUS = () => {
  // #context-menu is position:fixed (offsetParent is always null), so the hidden class --
  // the app's own show/hide signal -- is the visibility check. Monaco renders its menu
  // inside a shadow root, so the light-DOM query has to pierce shadow hosts.
  const ours = document.querySelector('#context-menu');
  const oursVisible = !!ours && !ours.classList.contains('hidden');
  let monacoVisible = 0;
  const walk = (root) => {
    for (const n of root.querySelectorAll('*')) {
      if (n.shadowRoot) walk(n.shadowRoot);
      if (n.classList?.contains('monaco-menu')) {
        const r = n.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && getComputedStyle(n).display !== 'none') monacoVisible += 1;
      }
    }
  };
  walk(document);
  const sel = window.__td.editor.getSelection();
  return { oursVisible, monacoVisible, selEmpty: sel.isEmpty(),
    selText: sel.isEmpty() ? null : window.__td.editor.getModel().getValueInRange(sel),
    items: oursVisible ? [...ours.querySelectorAll('.context-item')].map((i) => i.textContent.trim()) : [] };
};

(async () => {
  await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: ROOT }) }).catch(() => {});
  await fetch(`${BASE}/api/files/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: ROOT, path: PATH, directory: false }) }).catch(() => {});
  await fetch(`${BASE}/api/files/write`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: ROOT, path: PATH, content: LINES }) });
  const sid = (await fetch(`${BASE}/api/sessions`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'none', permission: 'default', cwd: ROOT, title: 'file-editor-copy' }),
  }).then((r) => r.json())).session_id;
  const br = await chromium.launch({ headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await br.newContext({ permissions: ['clipboard-read', 'clipboard-write'],
    viewport: { width: 1400, height: 850 } });
  const p = await ctx.newPage();
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

  const selected = await p.evaluate(SELECT);
  console.log('selected:', JSON.stringify(selected));

  await p.waitForTimeout(300);
  const pt = await p.evaluate(CLICK_POINT);
  console.log('click at:', JSON.stringify(pt));
  if (!pt.hitEditor) {
    console.log('  FAIL  click point misses the editor -- aborting (vacuous otherwise)');
    await br.close();
    await fetch(`${BASE}/api/sessions/${sid}`, { method: 'DELETE' }).catch(() => {});
    try { fs.unlinkSync(`${ROOT}/${PATH}`); } catch {}
    process.exit(1);
  }
  await p.mouse.click(pt.x, pt.y, { button: 'right' });
  await p.waitForTimeout(600);
  const menus = await p.evaluate(MENUS);
  console.log('menus:   ', JSON.stringify({ ...menus, selText: (menus.selText || '').slice(0, 60) }));

  let menuCopyClipboard = null;
  const copyItem = menus.items.find((t) => t.includes('Copy selected text'));
  if (copyItem) {
    await p.evaluate(() => {
      const ours = document.querySelector('#context-menu');
      const item = [...ours.querySelectorAll('.context-item')]
        .find((i) => i.textContent.includes('Copy selected text'));
      item.click();
    });
    await p.waitForTimeout(400);
    menuCopyClipboard = await p.evaluate(() => navigator.clipboard.readText().catch(() => null));
  }
  console.log('menu-copy clipboard:', JSON.stringify((menuCopyClipboard || '').slice(0, 60)));

  // Fresh selection, then the user's exact Cmd+C recipe on the native path.
  await p.evaluate(SELECT);
  await p.keyboard.press('Meta+c');
  await p.waitForTimeout(400);
  const cmdCopy = await p.evaluate(() => Promise.all([
    navigator.clipboard.readText().catch(() => null),
    Promise.resolve(window.__td.projectSelectionCopyHistory()?.[0]?.text ?? null),
  ]));
  console.log('cmd-c clipboard:', JSON.stringify((cmdCopy[0] || '').slice(0, 60)));
  console.log('cmd-c history:  ', JSON.stringify((cmdCopy[1] || '').slice(0, 60)));

  const expected = 'COPYME-LINE-005 padding padding\nCOPYME-LINE-006 padding padding\nCOPYME-LI';
  const checks = [
    ['isEmpty is a method and selection state reads the editor text',
      selected.kind === 'function' && selected.empty === false &&
      selected.stateKind === 'file' && selected.stateText === expected],
    ['right-click preserves the selection', menus.selEmpty === false && menus.selText === expected],
    ['exactly one context menu (ours, no Monaco menu)',
      menus.oursVisible === true && menus.monacoVisible === 0],
    ['our menu offers Copy selected text', copyItem !== undefined],
    ['menu Copy writes the selection to the clipboard', menuCopyClipboard === expected],
    ['Cmd+C copies the selection to the clipboard', cmdCopy[0] === expected],
    ['Cmd+C records the selection in copy history', cmdCopy[1] === expected],
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
