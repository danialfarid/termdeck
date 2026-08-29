// Find-in-terminal must bring the match onto the screen -- including matches deep in scrollback, and
// including on a freshly loaded page.
//
// Two shipped failures drive this: the container target was computed in the old rendered-window frame
// (absoluteRow - viewportY), so the view moved somewhere unrelated to the match ("search moves the
// scroll but the match is further down"), and the programmatic scroll's echo-suppressed event meant the
// rendered window was never brought along, leaving the match "revealed" on blank canvas after a reload.
//
//   node tools/scroll-tests/find_reveals_match.cjs [port]
const { chromium } = require('playwright');
const PORT = process.argv[2] || '8536';
const BASE = `http://127.0.0.1:${PORT}`;

const CHECK = ({ i, needle }) => {
  const v = window.__td.views.get(i);
  const b = v.term.buffer.active;
  const cell = v.term._core?._renderService?.dimensions?.css?.cell?.height || 21;
  const offset = v.container.scrollTop - v.term.element.offsetTop;
  const first = b.viewportY + Math.floor(offset / cell);
  const last = b.viewportY + Math.floor((offset + v.container.clientHeight - 1) / cell);
  let matchVisible = false;
  let blankRows = 0;
  for (let row = first; row <= last; row += 1) {
    const text = (b.getLine(row)?.translateToString(true) || '').trim();
    if (!text) blankRows += 1;
    if (text.includes(needle)) matchVisible = true;
  }
  const windowCovers = v.term.element.offsetTop <= v.container.scrollTop &&
    v.term.element.offsetTop + v.term.element.offsetHeight >=
      v.container.scrollTop + v.container.clientHeight;
  return { top: Math.round(v.container.scrollTop), first, last, matchVisible, blankRows,
           total: last - first + 1, windowCovers };
};

(async () => {
  const id = (await fetch(`${BASE}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'none', permission: 'default',
      cwd: '/Users/dan/workspace/height-probe-root', title: 'find-reveal' }),
  }).then((r) => r.json())).session_id;

  const br = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await br.newPage({ viewport: { width: 1400, height: 850 } });
  await p.goto(`${BASE}/p/height-probe-root`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
  await p.waitForTimeout(1500);
  await p.evaluate((i) => window.__td.activate(i), id);
  await p.waitForTimeout(2000);

  // The needle sits deep above the prompt: past the 4000-row screen into real scrollback. Assembled at
  // runtime so the echoed command line itself cannot match.
  await p.evaluate(({ i, s }) => window.__td.sendInput(window.__td.views.get(i), s),
    { i: id, s: 'seq 1 2000 | sed "s/^/pad /"; printf "THE-NEEDLE-%s\\n" LINE; seq 1 4300 | sed "s/^/tail /"\n' });
  await p.waitForTimeout(14000);
  await p.waitForFunction((i) => window.__td.views.get(i)?.term.buffer.active.baseY > 2000, id, { timeout: 60000 });

  const run = async (label) => {
    await p.evaluate((i) => {
      window.__td.activate(i);
      const input = document.getElementById('terminal-find-input');
      input.value = 'THE-NEEDLE-LINE';
      window.__td.updateTerminalFindMatches();
    }, id);
    await p.waitForTimeout(1200);
    const r = await p.evaluate(CHECK, { i: id, needle: 'THE-NEEDLE-LINE' });
    console.log(`${label}:`, JSON.stringify(r));
    return r.matchVisible && r.windowCovers && r.blankRows < r.total;
  };

  const fresh = await run('same page  ');

  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
  await p.waitForTimeout(2500);
  await p.evaluate((i) => window.__td.activate(i), id);
  await p.waitForFunction((i) => {
    const v = window.__td.views.get(i);
    return v && !v.replaying && !v.awaitingSnapshot && v.term.buffer.active.baseY > 2000;
  }, id, { timeout: 60000 });
  await p.waitForTimeout(1500);
  const reloaded = await run('after reload');

  console.log(`\n  match revealed on screen:         ${fresh ? 'PASS' : 'FAIL'}`);
  console.log(`  still revealed on a fresh page:   ${reloaded ? 'PASS' : 'FAIL'}`);
  await br.close();
  await fetch(`${BASE}/api/sessions/${id}`, { method: 'DELETE' }).catch(() => {});
  process.exit(fresh && reloaded ? 0 : 1);
})();
