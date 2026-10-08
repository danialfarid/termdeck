// Attention bell: hidden while nothing needs attention; appears with a count when
// prompts do, and each click opens the next attention session in sidebar order,
// wrapping around. Dismissing all attention hides it again. Attention is raised
// server-side through real output detection (agy markers on live zsh ptys), so
// the full broadcast path is exercised.
//
//   node tools/scroll-tests/attention_bell.cjs [port]
const { chromium } = require('playwright');
const PORT = process.argv[2] || process.env.TERMDECK_TEST_PORT || '8536';
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = '/Users/dan/workspace/height-probe-root';
const TAG = `attnbell${process.pid}`;

(async () => {
  await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: ROOT }) }).catch(() => {});
  // Command-token trick: the "agy" token claims agy detection (output markers)
  // while the pty actually runs zsh, so no agent binary is needed.
  const mk = async (title) => (await fetch(`${BASE}/api/sessions`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'true agy; exec zsh -i', permission: 'default', cwd: ROOT, title }),
  }).then((r) => r.json())).session_id;
  const a = await mk(`plain-${TAG}`);
  const b = await mk(`needy-b-${TAG}`);
  const c = await mk(`needy-c-${TAG}`);
  const kinds = await fetch(`${BASE}/api/sessions`).then((r) => r.json()).then((list) =>
    Object.fromEntries(list.filter((s) => [a, b, c].includes(s.session_id)).map((s) => [s.session_id, s.agent_kind])));
  console.log('kinds:', JSON.stringify(kinds));
  const br = await chromium.launch({ headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await br.newPage({ viewport: { width: 1400, height: 850 } });
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.goto(`${BASE}/p/height-probe-root`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
  await p.waitForTimeout(1500);
  const bell = () => p.evaluate(() => {
    const btn = document.querySelector('#attention-bell-btn');
    return { exists: !!btn, hidden: btn?.classList.contains('hidden') ?? null,
      count: document.querySelector('#attention-bell-count')?.textContent ?? null };
  });
  const serverFlags = () => fetch(`${BASE}/api/sessions`).then((r) => r.json()).then((list) =>
    Object.fromEntries(list.filter((s) => [b, c].includes(s.session_id)).map((s) => [s.session_id, s.needs_attention])));

  const idle = await bell();
  console.log('idle:', JSON.stringify(idle));
  // Row 1 must use the full header width: + sits at the padding, nothing invisible
  // (bell, empty action slots) may hold space right of it.
  const plusGap = await p.evaluate(() => {
    const plus = document.querySelector('#project-add-btn').getBoundingClientRect();
    const header = document.querySelector('#sidebar-header').getBoundingClientRect();
    return Math.round(header.right - plus.right);
  });
  console.log('plus-to-edge gap:', plusGap);
  const placement = await p.evaluate(() => {
    const td = window.__td;
    const row = td.$('worktree-header-row');
    row.classList.add('hidden');
    td.updateAttentionBell();
    const noRow = td.$('attention-bell-btn').parentElement.id;
    row.classList.remove('hidden');
    td.updateAttentionBell();
    const withRow = td.$('attention-bell-btn').parentElement.id;
    return { noRow, withRow };
  });
  console.log('placement:', JSON.stringify(placement));
  for (const id of [b, c, a]) await p.evaluate((i) => window.__td.activate(i), id);
  await p.waitForFunction((i) => window.__td.activeId === i, a, { timeout: 10000 });
  await p.waitForTimeout(1000);
  // The sleep outlasts the 1s typing-quiet gate, so the marker output detects.
  for (const id of [b, c]) {
    await p.evaluate((i) => window.__td.sendInput(window.__td.views.get(i),
      "sleep 1.6; printf 'Request permission to proceed\\n'\n"), id);
  }
  await p.waitForFunction(() => !document.querySelector('#attention-bell-btn').classList.contains('hidden') &&
    document.querySelector('#attention-bell-count')?.textContent === '2', null, { timeout: 30000 });
  const raised = await bell();
  const flags = await serverFlags();
  console.log('raised:', JSON.stringify({ ...raised, serverFlags: flags }));

  await p.click('#attention-bell-btn');
  await p.waitForFunction((i) => window.__td.activeId !== i, a, { timeout: 10000 });
  const first = await p.evaluate(() => window.__td.activeId);
  await p.click('#attention-bell-btn');
  await p.waitForFunction((i) => window.__td.activeId !== i, first, { timeout: 10000 });
  const second = await p.evaluate(() => window.__td.activeId);
  await p.click('#attention-bell-btn');
  await p.waitForFunction((i) => window.__td.activeId === i, first, { timeout: 10000 });
  const stillTwo = await bell();
  console.log('cycle:', JSON.stringify({ firstIsB: first === b, secondIsC: second === c, bell: stillTwo }));

  await fetch(`${BASE}/api/sessions/${b}/attention`, { method: 'POST' });
  await p.waitForFunction(() => document.querySelector('#attention-bell-count')?.textContent === '1',
    null, { timeout: 10000 });
  const one = await bell();
  await fetch(`${BASE}/api/sessions/${c}/attention`, { method: 'POST' });
  await p.waitForFunction(() => document.querySelector('#attention-bell-btn').classList.contains('hidden'),
    null, { timeout: 10000 });
  const cleared = await bell();
  console.log('cleared:', JSON.stringify({ one, cleared }));

  const pair = new Set([first, second]);
  const checks = [
    ['sessions claimed agy detection', kinds[b] === 'agy' && kinds[c] === 'agy'],
    ['bell hidden while nothing needs attention', idle.exists && idle.hidden === true],
    ['+ sits at the header edge (no dead gap)', plusGap <= 8],
    ['bell falls back to row 1 without a worktree row', placement.noRow === 'project-header-row'],
    ['bell sits on row 2 with one', placement.withRow === 'worktree-header-row'],
    ['server-side detection raised both flags', flags[b] === true && flags[c] === true],
    ['bell appears with count 2', raised.hidden === false && raised.count === '2'],
    ['first click opens an attention session', first === b || first === c],
    ['second click opens the other one', pair.has(b) && pair.has(c)],
    ['third click wraps to the first', true], // waitForFunction above proves it
    ['cycling keeps both queued (prompts unanswered)', stillTwo.count === '2'],
    ['dismissing one drops the count to 1, bell stays', one.hidden === false && one.count === '1'],
    ['dismissing all hides the bell', cleared.hidden === true],
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
  for (const sid of [a, b, c]) await fetch(`${BASE}/api/sessions/${sid}`, { method: 'DELETE' }).catch(() => {});
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('probe error:', e.message);
  process.exit(2);
});
