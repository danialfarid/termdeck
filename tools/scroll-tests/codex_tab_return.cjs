// Switching back to a codex tab whose commands folded while it was hidden must land at the bottom.
//
// The reported shape: a codex tab runs commands, they fold into "Ran N" (shrinking the content) while
// the user is on another tab; switching back leaves the view mid-page instead of following the
// composer. Emulated with a shell session marked codex, exactly like codex_fold_stability.
//
//   node tools/scroll-tests/codex_tab_return.cjs [port]
const { chromium } = require('playwright');
const PORT = process.argv[2] || '8536';
const BASE = `${'http'}://127.0.0.1:${PORT}`;

(async () => {
  const mk = async (title) => (await fetch(`${BASE}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'none', permission: 'default',
      cwd: '/Users/dan/workspace/height-probe-root', title }),
  }).then((r) => r.json())).session_id;
  const codexId = await mk('codex-return');
  const otherId = await mk('other-tab');

  const br = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await br.newPage({ viewport: { width: 1400, height: 850 } });
  await p.goto(`${BASE}/p/height-probe-root`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
  await p.waitForTimeout(1500);
  await p.evaluate((i) => { window.__td.session(i).agent_kind = 'codex'; window.__td.activate(i); }, codexId);
  await p.waitForTimeout(2000);

  // Content past one screen, composer at the bottom, following.
  await p.evaluate(({ i, s }) => window.__td.sendInput(window.__td.views.get(i), s),
    { i: codexId, s: "printf '\\033[2J\\033[H'; for n in $(seq 1 120); do printf 'history-%03d\\n' $n; done; for n in $(seq 1 4); do printf 'command %s\\n' $n; done; printf 'COMPOSER> '; sleep 60\n" });
  await p.waitForTimeout(5000);
  const rest = await p.evaluate((i) => {
    const v = window.__td.views.get(i);
    return { top: Math.round(v.container.scrollTop), ceiling: v.tallMaxScrollTop, following: v.tallFollowing };
  }, codexId);
  console.log('before leaving:', JSON.stringify(rest));

  // Leave for another tab; the fold happens while hidden, marker included so codex's collapse path runs.
  await p.evaluate((i) => window.__td.activate(i), otherId);
  await p.waitForTimeout(1500);
  // dtach delivers this to the hidden view: fold 4 commands + composer redraw.
  const D = (await fetch(`${BASE}/api/sessions`)).ok; // no-op keepalive
  await p.evaluate(({ i, s }) => window.__td.sendInput(window.__td.views.get(i), s), { i: otherId, s: '\n' });
  await p.waitForTimeout(300);
  // Send the fold through the codex session's pty via a second shell trick: write escape directly.
  await p.evaluate(({ i }) => {
    const v = window.__td.views.get(i);
    // Emulate pty output while hidden by writing into the terminal the way the ws does.
    window.__td.queueTerminalWrite(v, new TextEncoder().encode(
      '\x1b[5A\r\x1b[JRan 4 commands · ctrl + t to view transcript\r\nCOMPOSER> '));
  }, codexId);
  await p.waitForTimeout(2500);

  // Return, then watch where it rests.
  await p.evaluate((i) => window.__td.activate(i), codexId);
  const samples = [];
  for (let n = 0; n < 10; n += 1) {
    await p.waitForTimeout(500);
    samples.push(await p.evaluate((i) => {
      const v = window.__td.views.get(i);
      const b = v.term.buffer.active;
      const cell = v.term._core?._renderService?.dimensions?.css?.cell?.height || 21;
      let last = -1;
      for (let y = b.length - 1; y >= 0; y--) {
        if ((b.getLine(y)?.translateToString(true) || '').trim()) { last = y; break; }
      }
      const needed = Math.max(0, Math.round((last + 1) * cell - v.container.clientHeight));
      return { top: Math.round(v.container.scrollTop), ceiling: v.tallMaxScrollTop, needed,
               following: v.tallFollowing, offRows: Math.round((v.container.scrollTop - needed) / cell) };
    }, codexId));
  }
  for (const s of samples) console.log(JSON.stringify(s));
  const final = samples[samples.length - 1];
  const ok = Math.abs(final.top - final.needed) <= 30 && final.following !== false;
  console.log(`\n  returns to the bottom after hidden fold: ${ok ? 'PASS' : `FAIL (${final.offRows} rows off)`}`);
  await br.close();
  for (const id of [codexId, otherId]) await fetch(`${BASE}/api/sessions/${id}`, { method: 'DELETE' }).catch(() => {});
  process.exit(ok ? 0 : 1);
})();
