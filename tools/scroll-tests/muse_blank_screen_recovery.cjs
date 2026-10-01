// A tab whose agent screen went missing must ask for it back -- on return, and on reconnect.
//
// The reported shape: switching to an old muse tab shows an empty screen with the cursor at the
// bottom, and the conversation sits five or six pages up. The buffer is faithful -- the agent
// cleared its screen and never repainted it (muse coalesces a quick resize pair into a no-op,
// so even the repaint nudge used to do nothing) -- and an idle agent sends nothing further, so
// without this the tab sits blank until something resizes it. Refresh only "fixed" it when the
// fresh attach happened to resize the pty.
//
// This wedges exactly that end state by hand -- cleared screen, cursor parked at the bottom,
// scrollback intact -- on a shell session posed as muse (same client-side kind override the
// attach tests use; there is no muse binary in CI), then requires a repaint request both when
// the tab is returned to with its websocket still open and when it has to reconnect first.
// A screen carrying muse's chrome, and the same wedge on a plain shell, must stay silent.
//
//   node tools/scroll-tests/muse_blank_screen_recovery.cjs [port]
const { chromium } = require('playwright');
const PORT = process.argv[2] || process.env.TERMDECK_TEST_PORT || '8536';
const BASE = `http://127.0.0.1:${PORT}`;

const blankState = (i) => {
  const td = window.__td;
  const v = td.views.get(i);
  const b = v.term.buffer.active;
  let nonBlank = 0;
  for (let r = b.baseY; r < Math.min(b.length, b.baseY + v.term.rows); r++) {
    if ((b.getLine(r)?.translateToString(true) || '').trim()) nonBlank++;
  }
  const predicate = typeof td.terminalBlankScreenNeedsRepaint === 'function'
    ? td.terminalBlankScreenNeedsRepaint(v) : 'MISSING';
  return { baseY: b.baseY, cursorAbs: b.baseY + b.cursorY, nonBlank, predicate,
           kind: td.session(i)?.agent_kind };
};

(async () => {
  const mk = async (title) => (await fetch(`${BASE}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'none', permission: 'default',
      cwd: '/Users/dan/workspace/height-probe-root', title }),
  }).then((r) => r.json())).session_id;
  const id = await mk('muse-blank-recovery');
  const other = await mk('muse-blank-away');

  const br = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await br.newPage({ viewport: { width: 1400, height: 850 } });
  await p.goto(`${BASE}/p/height-probe-root`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
  await p.waitForTimeout(1500);
  await p.evaluate(() => {
    window.__repaints = [];
    const origSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) {
      try {
        if (typeof d === 'string' && JSON.parse(d).type === 'repaint') window.__repaints.push(Date.now());
      } catch { /* not a control message */ }
      return origSend.call(this, d);
    };
  });
  await p.evaluate((i) => { window.__td.session(i).agent_kind = 'muse'; window.__td.activate(i); }, id);
  await p.waitForTimeout(2000);

  // Several screens of history with a composer at the bottom, following.
  await p.evaluate(({ i, s }) => window.__td.sendInput(window.__td.views.get(i), s),
    { i: id, s: "printf '\\033[2J\\033[H'; for n in $(seq 1 600); do printf 'history-%03d\\n' $n; done; printf 'COMPOSER> '; sleep 600\n" });
  await p.waitForTimeout(7000);
  const seeded = await p.evaluate(blankState, id);
  console.log('seeded:', JSON.stringify(seeded));
  const fail = async (why) => {
    console.log(`\n  FAIL: ${why}`);
    await br.close();
    for (const sid of [id, other]) await fetch(`${BASE}/api/sessions/${sid}`, { method: 'DELETE' }).catch(() => {});
    process.exit(1);
  };
  if (seeded.baseY < 100) return fail('fixture never built scrollback (baseY ' + seeded.baseY + ')');

  const roundTrip = async (i, o) => {
    await p.evaluate((x) => window.__td.activate(x), o);
    await p.waitForTimeout(1000);
    await p.evaluate((x) => window.__td.activate(x), i);
    await p.waitForTimeout(3500);
  };
  const repaintCount = () => p.evaluate(() => window.__repaints.length);

  // Healthy screen first: muse chrome on the bottom rows must stay silent on return.
  await p.evaluate((i) => new Promise((resolve) => {
    const td = window.__td;
    const v = td.views.get(i);
    v.term.write('\r\n  muse-spark-1.3 · max · ~/workspace/stock · YOLO\r\n❯ ready', () => {
      td.tallUpdateMaxScrollTop(v);
      if (v.tallFollowing !== false) td.scrollTallContainerToCursor(v);
      resolve(true);
    });
  }), id);
  const chromed = await p.evaluate(blankState, id);
  console.log('chromed:', JSON.stringify(chromed));
  if (chromed.predicate !== false) return fail('healthy muse screen still reads as blank');
  await roundTrip(id, other);
  const afterChrome = await repaintCount();
  console.log('repaints after healthy return:', afterChrome);

  // The failure, wedged by hand: cleared screen, cursor parked at the bottom, scrollback intact.
  // As a plain shell it must stay silent: only agents with missing chrome recover themselves.
  await p.evaluate((i) => { window.__td.session(i).agent_kind = 'none'; }, id);
  const wedgedShell = await p.evaluate((i) => new Promise((resolve) => {
    const td = window.__td;
    const v = td.views.get(i);
    v.term.write('\x1b[H\x1b[J\x1b[' + v.term.rows + ';1H', () => {
      td.tallUpdateMaxScrollTop(v);
      if (v.tallFollowing !== false) td.scrollTallContainerToCursor(v);
      const b = v.term.buffer.active;
      let nonBlank = 0;
      for (let r = b.baseY; r < Math.min(b.length, b.baseY + v.term.rows); r++) {
        if ((b.getLine(r)?.translateToString(true) || '').trim()) nonBlank++;
      }
      resolve({ baseY: b.baseY, cursorAbs: b.baseY + b.cursorY, nonBlank });
    });
  }), id);
  console.log('wedged:', JSON.stringify(wedgedShell));
  if (wedgedShell.nonBlank !== 0 || wedgedShell.baseY < 100) {
    return fail('wedge did not take (screen not blank or scrollback gone)');
  }
  await roundTrip(id, other);
  const afterShell = await repaintCount();
  console.log('repaints after shell return:', afterShell);

  // Same wedge as muse: returning to the tab must ask the agent to repaint.
  await p.evaluate((i) => { window.__td.session(i).agent_kind = 'muse'; }, id);
  const wedgedMuse = await p.evaluate(blankState, id);
  console.log('wedged as muse:', JSON.stringify(wedgedMuse));
  if (wedgedMuse.predicate !== true) return fail('blank muse screen does not read as blank');
  await roundTrip(id, other);
  const afterReturn = await repaintCount();
  console.log('repaints after muse return:', afterReturn);

  // Same wedge across a reconnect: the attach's empty snapshot frame runs the completion
  // check, which must ask. A new episode for the shared cooldown, which the return above
  // just spent; the snapshot frame and the attach timer must still collapse into one ask.
  await p.evaluate((i) => { window.__td.views.get(i).blankRecoverySentAt = 0; }, id);
  await p.evaluate((i) => window.__td.views.get(i).ws.close(), id);
  await p.waitForTimeout(6000);
  const afterReconnect = await repaintCount();
  console.log('repaints after reconnect:', afterReconnect);

  const results = [
    ['healthy muse screen stays silent', afterChrome === 0],
    ['blank shell stays silent', afterShell === 0],
    ['blank muse tab repaints on return', afterReturn === 1],
    ['blank muse tab repaints on reconnect', afterReconnect === 2],
  ];
  for (const [label, ok] of results) console.log(`\n  ${label}: ${ok ? 'PASS' : 'FAIL'}`);
  await br.close();
  for (const sid of [id, other]) await fetch(`${BASE}/api/sessions/${sid}`, { method: 'DELETE' }).catch(() => {});
  process.exit(results.every(([, ok]) => ok) ? 0 : 1);
})();
