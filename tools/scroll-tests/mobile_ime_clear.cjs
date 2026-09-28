// Mobile IME textarea clear must land before any IME hold-gesture can be in flight.
//
// The stabilizer empties xterm's helper textarea after each commit so Gboard never
// works against a stale blob. A 40ms delay pushed that mutation into hold gestures:
// holding space to switch languages showed the switcher for an instant, then the clear
// restarted Gboard's input connection and the keyboard bailed out. Clearing on a 0ms
// timer keeps it after every same-task read (xterm's listeners registered first) but
// ~300ms ahead of any gesture decision. Composition-end keeps its own delay: our
// capture listener queues ahead of xterm's bubble finalize, so a 0ms clear there would
// eat the composed text before xterm reads it.
//
//   node tools/scroll-tests/mobile_ime_clear.cjs [port]
const { chromium } = require('playwright');
const PORT = process.argv[2] || process.env.TERMDECK_TEST_PORT || '8536';
const BASE = `http://127.0.0.1:${PORT}`;

(async () => {
  const id = await fetch(`${BASE}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'none', permission: 'default',
      cwd: '/Users/dan/workspace/height-probe-root', title: 'ime-clear' }),
  }).then((r) => r.json()).then((j) => j.session_id);

  // Narrow viewport trips the (max-width: 900px) half of touchMobileLayoutEnabled.
  const br = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await br.newPage({ viewport: { width: 400, height: 800 } });
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  try {
    await p.goto(`${BASE}/p/height-probe-root`, { waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
    await p.waitForTimeout(1500);
    const gate = await p.evaluate(() => window.__td.touchMobileLayoutEnabled());
    console.log('mobile gate:', gate);
    await p.evaluate((i) => window.__td.activate(i), id);
    await p.waitForFunction((i) => !!window.__td.views.get(i)?.term, id, { timeout: 30000 });
    await p.waitForTimeout(1000);

    // Plain commit: cleared within a frame, nothing pending past 10ms (gesture window).
    const commit = await p.evaluate(async (i) => {
      const td = window.__td;
      const view = td.views.get(i);
      const ta = view.term.textarea;
      ta.value = 'x';
      ta.dispatchEvent(new InputEvent('input', { data: 'x', bubbles: true }));
      await new Promise((r) => setTimeout(r, 15));
      return { value: ta.value, timer: view.mobileTextareaCleanupTimer || 0 };
    }, id);
    console.log('after commit:  ', JSON.stringify(commit));

    // Composition: never cleared synchronously (xterm's finalize reads first), still
    // cleared on its own delay.
    const composition = await p.evaluate(async (i) => {
      const td = window.__td;
      const view = td.views.get(i);
      const ta = view.term.textarea;
      ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      ta.value = 'ni';
      ta.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 10));
      const early = ta.value;
      await new Promise((r) => setTimeout(r, 150));
      return { early, late: ta.value };
    }, id);
    console.log('composition:   ', JSON.stringify(composition));

    // IME baseline capture on keydown-229 still works.
    const baseline = await p.evaluate((i) => {
      const td = window.__td;
      const view = td.views.get(i);
      const ta = view.term.textarea;
      ta.value = 'ab';
      ta.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 229, bubbles: true }));
      return { baseline: view.mobileImeTextareaBaseline,
        deadlineInFuture: (view.mobileImeTextareaDeadline || 0) > Date.now() };
    }, id);
    console.log('baseline:      ', JSON.stringify(baseline));

    const checks = [
      ['mobile layout gate is on', gate === true],
      ['commit clears within a frame with no pending timer', commit.value === '' && commit.timer === 0],
      ['composition survives finalize then clears', composition.early === 'ni' && composition.late === ''],
      ['keydown-229 captures the IME baseline', baseline.baseline === 'ab' && baseline.deadlineInFuture === true],
      ['no page errors', errors.length === 0],
    ];
    console.log('');
    let ok = true;
    for (const [name, pass] of checks) {
      console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`);
      if (!pass) ok = false;
    }
    if (errors.length) console.log('  pageerrors: ' + errors.join(' | ').slice(0, 400));
    process.exitCode = ok ? 0 : 1;
  } finally {
    await br.close();
    await fetch(`${BASE}/api/sessions/${id}`, { method: 'DELETE' }).catch(() => {});
  }
})().catch((e) => { console.error('probe error:', e.message); process.exit(2); });
