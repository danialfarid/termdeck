const { chromium } = require('playwright');
const PORT = process.argv[2] || '8536';
const BASE = `http://127.0.0.1:${PORT}`;
const DROP = 'agentStackSummaryDrop';
const CWD = '/Users/dan/workspace/termdeck';

async function api(path, options) {
  const response = await fetch(`${BASE}${path}`, options);
  if (!response.ok) throw new Error(`${path} -> ${response.status}`);
  return response.json().catch(() => ({}));
}

async function createSession(title) {
  const body = await api('/api/sessions', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'none', permission: 'default', cwd: CWD, title }) });
  return body.session_id;
}

(async () => {
  const ids = [];
  const failures = [];
  const check = (name, cond, extra) => {
    console.log(`${cond ? 'ok' : 'FAIL'} ${name}${extra !== undefined ? ` (${extra})` : ''}`);
    if (!cond) failures.push(name);
  };
  try {
    const parent = await createSession('stack-settle-parent');
    const kid1 = await createSession('stack-settle-kid1');
    const kid2 = await createSession('stack-settle-kid2');
    const other = await createSession('stack-settle-other');
    ids.push(parent, kid1, kid2, other);
    for (const kid of [kid1, kid2]) {
      await api(`/api/sessions/${kid}/spawned-by`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent_session_id: parent }) });
    }
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
    await page.goto(`${BASE}/p/termdeck`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__td);
    await page.waitForFunction(() => document.querySelector('.agent-stack.collapsed .agent-stack-summary'),
      null, { timeout: 20000 });
    // Count every run of the summary drop-in from here on.
    await page.evaluate((drop) => {
      window.__dropStarts = 0;
      document.addEventListener('animationstart', (event) => {
        if (event.animationName === drop) window.__dropStarts += 1;
      });
    }, DROP);
    const dropStarts = () => page.evaluate(() => window.__dropStarts);
    const runningDrops = () => page.evaluate((drop) =>
      [...document.querySelectorAll('.agent-stack-summary')]
        .flatMap((el) => el.getAnimations()).filter((a) => a.animationName === drop).length, DROP);

    await page.waitForTimeout(1500);
    check('settled summary plays no drop-in', (await dropStarts()) === 0, await dropStarts());

    for (const target of [other, parent]) {
      await page.evaluate((id) => window.__td.activate(id), target);
      await page.waitForFunction((id) => window.__td.activeId === id, target);
      await page.waitForTimeout(1500);
    }
    check('tab switches replay no drop-in', (await dropStarts()) === 0, await dropStarts());
    check('no drop-in left running', (await runningDrops()) === 0, await runningDrops());

    // The toggle that reveals the line keeps its one entrance: expand, then collapse.
    await page.evaluate(() => {
      window.__dropStarts = 0;
      document.querySelector('.agent-stack.collapsed .agent-stack-summary').click();
    });
    await page.waitForFunction(() => document.querySelector('.agent-stack.expanded'));
    await page.evaluate(() => {
      document.querySelector('.agent-stack.expanded .agent-stack-rule').click();
    });
    await page.waitForFunction(() => document.querySelector('.agent-stack.collapsed .agent-stack-summary'));
    let sawDrop = false;
    for (let i = 0; i < 40 && !sawDrop; i++) {
      sawDrop = (await dropStarts()) > 0;
      if (!sawDrop) await page.waitForTimeout(100);
    }
    check('collapsing replays the drop-in once', sawDrop, await dropStarts());
    await page.waitForTimeout(1500);
    check('drop-in class removed after it plays',
      await page.evaluate(() => document.querySelectorAll('.agent-stack-summary-drop').length) === 0);
    check('nothing still animating', (await runningDrops()) === 0, await runningDrops());

    await browser.close();
  } finally {
    for (const id of ids) {
      await fetch(`${BASE}/api/sessions/${id}`, { method: 'DELETE' }).catch(() => {});
    }
  }
  if (failures.length) { console.error(`FAILED: ${failures.join(', ')}`); process.exit(1); }
  console.log('stack summary settles');
})().catch((error) => { console.error(error); process.exit(1); });
