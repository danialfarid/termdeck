// "Send now" on a queued transcript prompt takes it out of the queue.
//
// The real case: the server answered a prompt send only once the transcript showed the prompt, and
// an agent that records a message sent mid-turn later -- Codex, at its next step -- kept the request
// open past the browser's fifteen-second limit. The browser gave up and kept the item while the server
// went on to deliver it, so the prompt was sent and the queue stayed the same. This queues a prompt
// in transcript mode on a busy agent, presses its "Send now", and expects the queue to be empty well
// within that limit and the prompt to reach the transcript.
//
// Needs an agent terminal that is busy when it runs: pass the session id of a cheap one (Claude with
// Haiku) on a throwaway instance, after giving it a long foreground command.
//
//   node tools/scroll-tests/send_now_clears_queue.cjs <port> <session_id> <project>
const { chromium } = require('playwright');
const PORT = process.argv[2] || process.env.TERMDECK_TEST_PORT || '8536';
const SESSION = process.argv[3];
const PROJECT = process.argv[4] || 'height-probe-root';
const BASE = `http://127.0.0.1:${PORT}`;
const PROMPT = `Reply with exactly SEND-NOW-${Date.now()} and nothing else.`;

(async () => {
  if (!SESSION) throw new Error('usage: send_now_clears_queue.cjs <port> <session_id> [project]');
  const br = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await br.newPage({ viewport: { width: 1400, height: 850 } });
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.goto(`${BASE}/p/${PROJECT}`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
  await p.waitForTimeout(1500);
  await p.evaluate((i) => window.__td.activate(i), SESSION);
  await p.waitForTimeout(1500);
  await p.evaluate(() => window.__td.setHistoryMode(true));
  await p.waitForFunction(() => window.__td.historyOpen === true, null, { timeout: 15000 });
  const busy = await p.evaluate((i) => window.__td.processingStates.get(i) === true, SESSION);
  console.log('agent busy:', busy);

  await p.click('#history-prompt');
  await p.keyboard.type(PROMPT);
  await p.keyboard.press('Meta+Shift+Enter');
  await p.waitForFunction((i) => window.__td.sessionInteractionState(i, false)?.promptQueue?.length === 1, SESSION, { timeout: 5000 });
  console.log('queued:', 1);

  const started = Date.now();
  await p.click('.history-queued-send-now');
  let cleared = true;
  try {
    await p.waitForFunction((i) => window.__td.sessionInteractionState(i, false)?.promptQueue?.length === 0, SESSION, { timeout: 14000 });
  } catch {
    cleared = false;
  }
  const seconds = (Date.now() - started) / 1000;
  const status = await p.evaluate(() => document.getElementById('status-name')?.textContent || '');
  console.log(`queue cleared: ${cleared} after ${seconds.toFixed(1)}s · status "${status}"`);

  // The prompt went to the agent, not just out of the queue.
  let landed = false;
  for (let attempt = 0; attempt < 60 && !landed; attempt += 1) {
    const turns = await fetch(`${BASE}/api/sessions/${SESSION}/history`).then((r) => r.json()).catch(() => ({}));
    landed = JSON.stringify(turns).includes(PROMPT.split(' ').at(-4));
    if (!landed) await new Promise((r) => setTimeout(r, 1000));
  }
  console.log('reached the transcript:', landed);
  await br.close();
  if (errors.length) console.log('page errors:', errors);
  const pass = busy && cleared && landed && !errors.length;
  console.log(pass ? 'PASS' : 'FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
