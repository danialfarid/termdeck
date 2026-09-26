// Sidebar draft pen: a pencil right of the tab title while a tab holds an unsent composer
// draft or unsubmitted terminal input; clicking it opens the tab's composer with the draft.
//
// The real cases: (1) typing in a terminal tab lit nothing because the pen only watched the
// composer draft, which terminal tabs never show; (2) a composer draft on a terminal-view tab
// showed a pen with no way to see or clear the draft it pointed at. The terminal half rides the
// existing promptDraft tracker (sendTrackedInput), so this types through a real xterm rather
// than calling sendInput, which bypasses the tracker. The composer half dispatches a real input
// event at the (hidden-on-shell-tabs) composer, the exact shape of the stranded-draft report.
//
//   node tools/scroll-tests/draft_pen.cjs [port]
const { chromium } = require('playwright');
const PORT = process.argv[2] || process.env.TERMDECK_TEST_PORT || '8536';
const BASE = `http://127.0.0.1:${PORT}`;

const PEN = (i) => {
  const td = window.__td;
  const row = document.querySelector(`.session-item[data-session-id="${i}"]`);
  const pen = row?.querySelector('.session-draft-pen');
  const view = td.sessionInteractionState(i, false);
  return {
    hasPen: !!pen, hidden: pen?.classList.contains('hidden') ?? null,
    title: pen?.title ?? null,
    terminalDraft: view?.promptDraft ?? null,
    composerDraft: td.markdownPromptDraftForSession(i),
  };
};

(async () => {
  const makeSession = (title) => fetch(`${BASE}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'none', permission: 'default',
      cwd: '/Users/dan/workspace/height-probe-root', title }),
  }).then((r) => r.json()).then((j) => j.session_id);
  const id = await makeSession('draft-pen');
  const other = await makeSession('draft-pen-other');

  const br = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await br.newPage({ viewport: { width: 1400, height: 850 } });
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.goto(`${BASE}/p/height-probe-root`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
  await p.waitForTimeout(1500);
  await p.evaluate((i) => window.__td.activate(i), id);
  await p.waitForFunction((i) => !!window.__td.views.get(i)?.term, id, { timeout: 30000 });
  await p.waitForTimeout(1500);

  const baseline = await p.evaluate(PEN, id);
  console.log('baseline:      ', JSON.stringify(baseline));

  // Terminal input lights the pen through the real key path.
  const box = await p.evaluate((i) => {
    const r = window.__td.views.get(i).container.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, id);
  await p.mouse.click(box.x, box.y);
  await p.keyboard.type('echo PEN-PROBE');
  await p.waitForFunction((i) => window.__td.views.get(i)?.promptDraft === 'echo PEN-PROBE', id, { timeout: 15000 });
  const typed = await p.evaluate(PEN, id);
  console.log('terminal typed:', JSON.stringify(typed));
  await p.keyboard.press('Enter');
  await p.waitForFunction((i) => (window.__td.views.get(i)?.promptDraft || '') === '', id, { timeout: 15000 });
  const submitted = await p.evaluate(PEN, id);
  console.log('terminal sent: ', JSON.stringify(submitted));

  // Legacy X10 mouse reports must not pollute the tracked draft (whole and split chunks).
  const x10 = await p.evaluate(() => {
    const td = window.__td;
    const scratch = () => ({ promptDraft: '', promptEscape: '', promptPaste: false });
    const a = scratch();
    td.updatePromptDraftFromTerminal(a, '\x1b[Ma##');
    const b = scratch();
    td.updatePromptDraftFromTerminal(b, '\x1b[Ma');
    td.updatePromptDraftFromTerminal(b, '##');
    return { whole: a.promptDraft, split: b.promptDraft };
  });
  console.log('x10 mouse:     ', JSON.stringify(x10));

  // Composer input reaches the pen even where the composer itself is hidden (shell tabs).
  await p.evaluate(() => {
    const prompt = document.getElementById('history-prompt');
    prompt.value = 'composer seed';
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await p.waitForFunction((i) => window.__td.markdownPromptDraftForSession(i) === 'composer seed', id, { timeout: 10000 });
  const seeded = await p.evaluate(PEN, id);
  console.log('composer set:  ', JSON.stringify(seeded));
  await p.evaluate(() => {
    const prompt = document.getElementById('history-prompt');
    prompt.value = '';
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await p.waitForFunction((i) => window.__td.markdownPromptDraftForSession(i) === '', id, { timeout: 10000 });
  const cleared = await p.evaluate(PEN, id);
  console.log('composer clear:', JSON.stringify(cleared));

  // Clicking the pen navigates to the tab that holds the input.
  await p.mouse.click(box.x, box.y);
  await p.keyboard.type('x');
  await p.waitForFunction((i) => (window.__td.views.get(i)?.promptDraft || '') === 'x', id, { timeout: 15000 });
  await p.evaluate((i) => window.__td.activate(i), other);
  await p.waitForTimeout(800);
  await p.evaluate((i) => {
    document.querySelector(`.session-item[data-session-id="${i}"] .session-draft-pen`).click();
  }, id);
  await p.waitForTimeout(800);
  const revealed = await p.evaluate((i) => ({ active: window.__td.activeId,
    draft: window.__td.views.get(i)?.promptDraft }), id);
  console.log('pen click:     ', JSON.stringify(revealed));
  await p.keyboard.press('Backspace');
  await p.waitForFunction((i) => (window.__td.views.get(i)?.promptDraft || '') === '', id, { timeout: 15000 });

  const checks = [
    ['pen starts hidden with empty drafts', baseline.hasPen && baseline.hidden === true &&
      baseline.terminalDraft === '' && baseline.composerDraft === ''],
    ['terminal typing shows the pen', typed.hidden === false && typed.terminalDraft === 'echo PEN-PROBE' &&
      (typed.title || '').includes('terminal')],
    ['submitting clears the pen', submitted.hidden === true && submitted.terminalDraft === ''],
    ['x10 mouse reports leave no draft', x10.whole === '' && x10.split === ''],
    ['composer draft shows the pen', seeded.hidden === false && seeded.composerDraft === 'composer seed' &&
      (seeded.title || '').includes('composer')],
    ['clearing the composer hides the pen', cleared.hidden === true && cleared.composerDraft === ''],
    ['pen click returns to the tab', revealed.active === id && revealed.draft === 'x'],
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
  await fetch(`${BASE}/api/sessions/${id}`, { method: 'DELETE' }).catch(() => {});
  await fetch(`${BASE}/api/sessions/${other}`, { method: 'DELETE' }).catch(() => {});
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('probe error:', e.message); process.exit(2); });
