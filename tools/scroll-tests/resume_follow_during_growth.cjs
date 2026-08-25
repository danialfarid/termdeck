const { chromium } = require('playwright');
const PORT = process.argv[2] || '8536';
const BASE = `http://127.0.0.1:${PORT}`;

const readState = (page, sessionId) => page.evaluate((id) => {
  const view = window.__td.views.get(id);
  const buffer = view.term.buffer.active;
  const cellHeight = view.term._core?._renderService?.dimensions?.css?.cell?.height || 21;
  let lastContentRow = -1;
  for (let row = buffer.length - 1; row >= 0; row -= 1) {
    if ((buffer.getLine(row)?.translateToString(true) || '').trim()) { lastContentRow = row; break; }
  }
  const lastVisibleRow = Math.ceil((view.container.scrollTop + view.container.clientHeight) / cellHeight) - 1;
  return { top: Math.round(view.container.scrollTop), ceiling: view.tallMaxScrollTop,
    following: view.tallFollowing, lastContentRow, lastVisibleRow,
    endVisible: lastVisibleRow >= lastContentRow };
}, sessionId);

(async () => {
  const response = await fetch(`${BASE}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'none', permission: 'default', cwd: '/Users/dan/workspace/height-probe-root',
      title: 'resume-follow-during-growth' }),
  });
  const sessionId = (await response.json()).session_id;
  const browser = await chromium.launch({ headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
  await page.goto(`${BASE}/p/height-probe-root`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
  await page.evaluate((id) => window.__td.activate(id), sessionId);
  await page.waitForTimeout(1500);
  await page.evaluate(({ id, input }) => window.__td.sendInput(window.__td.views.get(id), input),
    { id: sessionId, input: 'clear; seq 1 1200\n' });
  await page.waitForTimeout(5000);
  const box = await page.locator('.term-container.visible').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -5000);
  await page.waitForTimeout(500);
  await page.evaluate(({ id, input }) => window.__td.sendInput(window.__td.views.get(id), input),
    { id: sessionId, input: 'for i in $(seq 1 300); do echo growing-$i; sleep 0.03; done\n' });
  await page.waitForTimeout(600);
  await page.mouse.wheel(0, 50000);
  await page.waitForTimeout(900);
  const resumed = await readState(page, sessionId);
  await page.waitForTimeout(4000);
  const later = await readState(page, sessionId);
  console.log('after returning during growth:', JSON.stringify(resumed));
  console.log('after more output:             ', JSON.stringify(later));
  const passed = resumed.following && resumed.endVisible && later.following && later.endVisible;
  await browser.close();
  await fetch(`${BASE}/api/sessions/${sessionId}`, { method: 'DELETE' });
  console.log(passed ? 'PASS' : 'FAIL');
  process.exit(passed ? 0 : 1);
})();
