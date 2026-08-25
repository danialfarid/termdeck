// A fold that deletes earlier lines (Codex collapsing commands into "Ran N", Claude rewriting its
// output) must not float the composer up the screen and snap it back: the view moves WITH the composer
// in the same write. Deliberately does NOT include codex's transcript marker text -- this pins the
// general mechanism (the >=2-row cursor-rise fast-forwards the ceiling damper), not the marker-sniffing
// special case that codex_fold_stability drives.
//
//   node tools/scroll-tests/fold_keeps_composer.cjs [port] [commandCount]
const { chromium } = require('playwright');
const PORT = process.argv[2] || '8536';
const COMMAND_COUNT = Math.max(2, Number(process.argv[3]) || 3);
const BASE = `http://127.0.0.1:${PORT}`;

(async () => {
  const response = await fetch(`${BASE}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'none', permission: 'default', cwd: '/Users/dan/workspace/height-probe-root',
      title: 'codex-fold-stability' }),
  });
  const id = (await response.json()).session_id;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
  await page.goto(`${BASE}/p/height-probe-root`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__td);
  await page.waitForTimeout(1200);
  await page.evaluate((sessionId) => window.__td.activate(sessionId), id);
  await page.waitForTimeout(1200);
  await page.evaluate(({ sessionId, commandCount }) => {
    const app = window.__td;
    app.session(sessionId).agent_kind = 'claude';
    const view = app.views.get(sessionId);
    app.sendInput(view, `printf '\\033[2J\\033[H'; for i in $(seq 1 80); do printf 'history-%03d\\n' $i; done; for i in $(seq 1 ${commandCount}); do printf 'command %s\\n' $i; done; printf 'COMPOSER> '; sleep 1; printf '\\033[${commandCount}A\\r\\033[JRan ${commandCount} commands\\nCOMPOSER> '; sleep 4\n`);
  }, { sessionId: id, commandCount: COMMAND_COUNT });
  await page.waitForFunction((sessionId) => {
    const view = window.__td.views.get(sessionId);
    const buffer = view?.term?.buffer?.active;
    if (!buffer) return false;
    return buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true).includes('COMPOSER>');
  }, id);
  await page.evaluate((sessionId) => {
    const view = window.__td.views.get(sessionId);
    const sample = () => {
      const buffer = view.term.buffer.active;
      const cell = view.term._core?._renderService?.dimensions?.css?.cell?.height || 21;
      const absoluteCursorTop = (buffer.baseY + buffer.cursorY) * cell;
      return absoluteCursorTop - view.container.scrollTop;
    };
    window.__foldProbe = { baseline: sample(), webgl: !!view.tallWebgl, samples: [] };
    const tick = () => {
      window.__foldProbe.samples.push({ at: performance.now(), cursorTop: sample(), scrollTop: view.container.scrollTop,
        ceiling: view.tallMaxScrollTop, innerHeight: view.tallInnerHeight });
      window.__foldProbe.frame = requestAnimationFrame(tick);
    };
    tick();
  }, id);
  await page.waitForTimeout(3300);
  const result = await page.evaluate(() => {
    cancelAnimationFrame(window.__foldProbe.frame);
    const baseline = window.__foldProbe.baseline;
    const offsets = window.__foldProbe.samples.map((sample) => sample.cursorTop - baseline);
    return { baseline, webgl: window.__foldProbe.webgl, minOffset: Math.min(...offsets), maxOffset: Math.max(...offsets),
      samples: window.__foldProbe.samples.filter((_, index) => index % 10 === 0) };
  });
  console.log(JSON.stringify({ commandCount: COMMAND_COUNT, ...result }, null, 2));
  await browser.close();
  await fetch(`${BASE}/api/sessions/${id}`, { method: 'DELETE' }).catch(() => {});
  process.exit(result.minOffset >= -2 && result.maxOffset <= 2 ? 0 : 1);
})().catch((error) => { console.error(error); process.exit(1); });
