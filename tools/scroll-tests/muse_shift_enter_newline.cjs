// Shift+Enter in a Muse session sends a bare line feed (what Ctrl+J sends),
// which is the newline Muse's composer honors; every other agent keeps the
// Meta+Enter sequence. Plain Enter stays untouched (passes through to xterm).
//
//   node tools/scroll-tests/muse_shift_enter_newline.cjs [port]
const { chromium } = require('playwright');
const PORT = process.argv[2] || process.env.TERMDECK_TEST_PORT || '8536';
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = '/Users/dan/workspace/height-probe-root';

(async () => {
  await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: ROOT }) }).catch(() => {});
  const br = await chromium.launch({ headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await br.newPage({ viewport: { width: 1400, height: 850 } });
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.goto(`${BASE}/p/height-probe-root`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
  await p.waitForTimeout(1500);

  const keys = await p.evaluate(() => {
    const td = window.__td;
    const sent = [];
    const origSend = td.sendTrackedInput;
    td.sendTrackedInput = (view, text) => { sent.push(text); };
    const records = [];
    const useRecord = (agentKind) => {
      const rec = { session_id: `shiftenter-probe-${agentKind || 'none'}`, agent_kind: agentKind };
      td.sessions.push(rec);
      records.push(rec);
      return { sessionId: rec.session_id, term: { hasSelection: () => false }, closed: false };
    };
    const press = (view, init) => {
      const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init });
      const before = sent.length;
      const passThrough = td.handleTerminalEditingKeys(view, e);
      return {
        passThrough,
        prevented: e.defaultPrevented,
        payload: sent.length > before ? JSON.stringify(sent[sent.length - 1]) : null,
        isLF: sent.length > before && sent[sent.length - 1] === '\n',
        isMetaEnter: sent.length > before && sent[sent.length - 1] === '\x1b\r',
      };
    };
    const out = {
      museShift: press(useRecord('muse'), { shiftKey: true }),
      claudeShift: press(useRecord('claude'), { shiftKey: true }),
      plainShift: press(useRecord(null), { shiftKey: true }),
      museEnter: press(useRecord('muse'), {}),
    };
    td.sendTrackedInput = origSend;
    for (const rec of records) td.sessions.splice(td.sessions.indexOf(rec), 1);
    return out;
  });
  console.log('keys:', JSON.stringify(keys, null, 1));

  const checks = [
    ['muse Shift+Enter sends a line feed and consumes the key',
      keys.museShift.isLF && keys.museShift.passThrough === false && keys.museShift.prevented],
    ['claude Shift+Enter still sends Meta+Enter', keys.claudeShift.isMetaEnter],
    ['agent-less Shift+Enter still sends Meta+Enter', keys.plainShift.isMetaEnter],
    ['plain Enter in muse still passes through unconsumed',
      keys.museEnter.passThrough === true && keys.museEnter.payload === null],
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
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('probe error:', e.message);
  process.exit(2);
});
