// Terminal search panel: a push-button scope icon right of the input toggles
// transcript scope between conversation-only and all output; the panel has no close
// button (search toggle / Esc close it) and no border box of its own (the input
// field carries the border, the summary is a plain line below it with its head
// visible when truncated, and the panel drops in with a short animation); the
// summary never names the
// group; the group's unread count sits at the right beside its search button.
//
//   node tools/scroll-tests/terminal_search_scope.cjs [port]
const { chromium } = require('playwright');
const PORT = process.argv[2] || process.env.TERMDECK_TEST_PORT || '8536';
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = '/Users/dan/workspace/height-probe-root';
const TOKEN = `scopesearchprobe${process.pid}`;
const GROUP = `scopegroup-${process.pid}`;
const GROUP_NAME = 'ScopeGroup';

(async () => {
  const glyphOf = () => [...(document.querySelector('#terminal-search-scope .codicon')?.classList || [])]
    .find((c) => c.startsWith('codicon-') && c !== 'codicon') || null;
  await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: ROOT }) }).catch(() => {});
  const sid = (await fetch(`${BASE}/api/sessions`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'none', permission: 'default', cwd: ROOT, title: TOKEN }),
  }).then((r) => r.json())).session_id;
  await fetch(`${BASE}/api/terminal-groups?project=height-probe-root`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ group_id: GROUP, name: GROUP_NAME }) });
  await fetch(`${BASE}/api/session-group-assignments?project=height-probe-root`, { method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignments: { [sid]: GROUP } }) });
  const br = await chromium.launch({ headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await br.newPage({ viewport: { width: 1400, height: 850 } });
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.goto(`${BASE}/p/height-probe-root`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
  await p.waitForTimeout(1500);
  await p.evaluate((i) => window.__td.activate(i), sid);
  await p.waitForTimeout(800);

  // Open through the real group-header search button.
  await p.click(`.terminal-group[data-group-id="${GROUP}"] .terminal-group-search`);
  await p.waitForFunction(() => !!document.querySelector('#terminal-search-inline'), null, { timeout: 5000 });
  const panel = await p.evaluate(() => ({
    icons: document.querySelectorAll('#terminal-search-inline .terminal-search-inline-icon').length,
    close: document.querySelectorAll('#terminal-search-inline-close').length,
    glyph: [...(document.querySelector('#terminal-search-scope .codicon')?.classList || [])]
      .find((c) => c.startsWith('codicon-') && c !== 'codicon') || null,
    flag: window.__td.historySearchOperations,
    idleSummary: document.querySelector('#terminal-search-summary')?.textContent ?? null,
    placeholder: document.querySelector('#terminal-search-input')?.placeholder ?? null,
    layout: (() => {
      const bar = document.querySelector('#terminal-search-inline');
      const row = bar.querySelector('.terminal-search-row');
      const input = bar.querySelector('#terminal-search-input');
      const scope = bar.querySelector('#terminal-search-scope');
      const summary = bar.querySelector('#terminal-search-summary');
      const scopeBox = scope.getBoundingClientRect();
      const inputBox = input.getBoundingClientRect();
      const scopeStyle = getComputedStyle(scope);
      return {
        scopeRightOfInput: scopeBox.left >= inputBox.right - 1,
        scopePush: scopeStyle.borderColor !== 'rgba(0, 0, 0, 0)' &&
          scopeStyle.backgroundColor !== 'rgba(0, 0, 0, 0)',
        scopeBorder: scopeStyle.borderColor,
        scopeBg: scopeStyle.backgroundColor,
        barBorderless: getComputedStyle(bar).borderTopStyle === 'none',
        rowHoldsField: row.contains(input) && row.contains(scope) && !row.contains(summary),
        inputBordered: getComputedStyle(input).borderTopStyle !== 'none',
        summaryBelow: summary.getBoundingClientRect().top >= row.getBoundingClientRect().bottom - 1,
        animated: getComputedStyle(bar).animationName === 'td-search-drop',
      };
    })(),
  }));
  console.log('panel:', JSON.stringify(panel));

  // Title search is client-side, so the summary proves a real search ran either way.
  await p.fill('#terminal-search-input', TOKEN);
  await p.waitForFunction(() => document.querySelector('#terminal-search-summary')?.textContent.includes('conversation'),
    null, { timeout: 15000 });
  const convSummary = await p.evaluate(() => {
    const summary = document.querySelector('#terminal-search-summary');
    const box = summary.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(summary);
    const first = range.getClientRects()[0];
    return { text: summary.textContent, headAtLeft: !!first && first.left <= box.left + 1 };
  });
  console.log('conv summary:', JSON.stringify(convSummary));

  await p.click('#terminal-search-scope');
  await p.waitForFunction(() => document.querySelector('#terminal-search-summary')?.textContent.includes('all output'),
    null, { timeout: 15000 });
  const allState = await p.evaluate(() => ({
    glyph: [...(document.querySelector('#terminal-search-scope .codicon')?.classList || [])]
      .find((c) => c.startsWith('codicon-') && c !== 'codicon') || null,
    flag: window.__td.historySearchOperations,
    summary: document.querySelector('#terminal-search-summary').textContent,
    pressed: document.querySelector('#terminal-search-scope').getAttribute('aria-pressed'),
  }));
  console.log('all:', JSON.stringify(allState));

  await p.click('#terminal-search-scope');
  await p.waitForFunction(() => document.querySelector('#terminal-search-summary')?.textContent.includes('conversation'),
    null, { timeout: 15000 });
  const backGlyph = await p.evaluate(glyphOf);
  console.log('back glyph:', backGlyph);

  // Unread badge geometry on the group header.
  const badge = await p.evaluate(({ id, group }) => {
    window.__td.unreadSessions.add(id);
    window.__td.renderList();
    const header = document.querySelector(`.terminal-group[data-group-id="${group}"] .terminal-group-label`);
    const name = header.querySelector('.terminal-group-name').getBoundingClientRect();
    const count = header.querySelector('.group-unread-count').getBoundingClientRect();
    const search = header.querySelector('.terminal-group-search').getBoundingClientRect();
    return { text: header.querySelector('.group-unread-count').textContent,
      nameToCount: count.left - name.right, countToSearch: search.left - count.right };
  }, { id: sid, group: GROUP });
  console.log('badge:', JSON.stringify(badge));

  // Both remaining close paths.
  await p.click('#terminal-search-input');
  await p.keyboard.press('Escape');
  await p.waitForFunction(() => !document.querySelector('#terminal-search-inline'), null, { timeout: 5000 });
  const escClosed = true;
  await p.click(`.terminal-group[data-group-id="${GROUP}"] .terminal-group-search`);
  await p.waitForFunction(() => !!document.querySelector('#terminal-search-inline'), null, { timeout: 5000 });
  await p.click(`.terminal-group[data-group-id="${GROUP}"] .terminal-group-search`);
  await p.waitForFunction(() => !document.querySelector('#terminal-search-inline'), null, { timeout: 5000 });
  const toggleClosed = true;

  const checks = [
    ['no magnifier icon and no close button in the panel', panel.icons === 0 && panel.close === 0],
    ['scope icon starts a speech bubble with the flag off', panel.glyph === 'codicon-comment' && panel.flag === false],
    ['scope sits right of the input and reads as a push button',
      panel.layout.scopeRightOfInput && panel.layout.scopePush],
    ['no border box: bar borderless, input carries the border',
      panel.layout.barBorderless && panel.layout.inputBordered],
    ['summary is a plain line below the field row, head visible when truncated',
      panel.layout.rowHoldsField && panel.layout.summaryBelow && convSummary.headAtLeft],
    ['panel drops in with an animation', panel.layout.animated],
    ['idle summary names no group', panel.idleSummary === ''],
    ['placeholder still scopes to the group', (panel.placeholder || '').includes(GROUP_NAME)],
    ['conversation search finds the session by title, no group in summary',
      convSummary.text.includes('1 terminal') && !convSummary.text.includes(GROUP_NAME)],
    ['scope click flips to All output and re-searches',
      allState.glyph === 'codicon-list-unordered' && allState.flag === true &&
      allState.summary.includes('all output') && allState.summary.includes('1 terminal') &&
      !allState.summary.includes(GROUP_NAME) && allState.pressed === 'true'],
    ['second click flips back to the speech bubble', backGlyph === 'codicon-comment'],
    ['unread count sits right, beside search', badge.text === '1' && badge.nameToCount > 40 && badge.countToSearch < 12],
    ['Escape closes the panel', escClosed],
    ['search button toggles the panel closed', toggleClosed],
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
  await fetch(`${BASE}/api/terminal-groups/${GROUP}?project=height-probe-root`, { method: 'DELETE' }).catch(() => {});
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('probe error:', e.message);
  process.exit(2);
});
