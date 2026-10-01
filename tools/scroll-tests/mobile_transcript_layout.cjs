// Mobile transcript layout: the page must fit the phone, only the transcript scrolls, and the
// keyboard shift must happen exactly once.
//
// Two bugs shipped in the page shape, both from #main being an ordinary overflow:hidden scroll
// container: iOS panned it to reveal the focused composer (pushing the transcript up out of view,
// and a few characters sideways to the cursor), and nothing ever panned it back. #main is now
// overflow:clip (unscrollable, with hidden as the fallback) and keyboard resizes zero its scroll
// for browsers without clip. The transcript keeps its own scroller; the page must never scroll.
//
// A third bug shipped in the keyboard compensation: the transcript shifted itself for every
// keyboard, but iPhone Safari pans to the focused field on its own -- visual viewport shrinks,
// layout viewport stays -- so our shift landed on top of Safari's and everything moved twice.
// Android shrinks both viewports together and pans nothing, so there our shift is the only one
// and the transcript must still do it.
//
// The Android keyboard is simulated for real: shrinking the viewport shrinks both viewports
// together, exactly its geometry. The iPhone keyboard is faked geometry driving the real handler
// (headless WebKit never pans for a keyboard itself): visual stubbed small, layout left tall.
// Whether Safari's own pan then lands right is platform behavior, verified on-device. Both run
// under Chromium and WebKit.
//
//   node tools/scroll-tests/mobile_transcript_layout.cjs [port]
const { chromium, webkit } = require('playwright');
const PORT = process.argv[2] || process.env.TERMDECK_TEST_PORT || '8536';
const BASE = `http://127.0.0.1:${PORT}`;
// Throw, don't exit: the outer catch reports and exits, and the finallys still run -- an exit
// here would skip them and leak the session on the throwaway.
const fail = (msg) => { throw new Error(msg); };

const seedTranscript = () => {
  const host = document.getElementById('history-body');
  // Clear first: the live transcript can re-render under the seed (fresh agent output), so every
  // phase reseeds rather than trusting an earlier seed to still be there.
  host.innerHTML = '';
  const mk = (cls, html) => {
    const d = document.createElement('div');
    d.className = cls; d.innerHTML = html; host.appendChild(d);
  };
  mk('turn user', '<div class="turn-role">you</div><div class="turn-text">Please review this terminal state and summarize the top three risks in plain language.</div>');
  mk('turn assistant', `<div class="turn-role">codex</div><div class="turn-text markdown"><p>Here is the plan:</p><pre><code>const aVeryLongVariableNameToForceSomeWidth = computeSomethingAmazing(withTheseArguments, andThose);</code></pre><table><tr><th>name</th><th>description of the column</th></tr><tr><td>alpha</td><td>first item in the table</td></tr></table><p>See https://example.com/a/very/long/path/that/keeps/going/and/going?with=query&amp;x=1 and done.</p></div>`);
  for (let i = 0; i < 30; i++) {
    mk('turn assistant', `<div class="turn-role">codex</div><div class="turn-text">Filler line ${i} with enough words to wrap across several lines on a narrow phone screen.</div>`);
  }
};

async function checkEngine(kind, launch, id) {
  const br = await launch();
  try {
    const ctx = await br.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true,
      isMobile: true, deviceScaleFactor: 3 });
    const p = await ctx.newPage();
    try {
      await p.goto(`${BASE}/p/height-probe-root`, { waitUntil: 'domcontentloaded' });
      await p.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
      await p.evaluate((i) => window.__td.activate(i), id);
      // The new session reaches the client's polled list on a refresh; opening the transcript
      // before that silently no-ops (setHistoryMode trusts the list), so wait for support first.
      await p.waitForFunction((i) => window.__td.sessionSupportsTranscript(
        window.__td.session(i)), id, { timeout: 30000 });
      await p.evaluate(() => window.__td.setHistoryMode(true, { persist: false }));
      await p.waitForFunction(() => document.getElementById('history-body')?.clientWidth > 0,
        null, { timeout: 15000 });
      await p.evaluate(seedTranscript);
      await p.waitForTimeout(500);

      const geo = await p.evaluate(() => ({
        innerW: window.innerWidth,
        bodyScrollW: document.body.scrollWidth,
        histW: document.getElementById('history-body').getBoundingClientRect().width,
        histScrollW: document.getElementById('history-body').scrollWidth,
        mainOverflow: getComputedStyle(document.getElementById('main')).overflow,
        nativeMenu: window.__td.transcriptTouchMenuIsNative({ id: 'history-body' }),
        customElsewhere: window.__td.transcriptTouchMenuIsNative({ id: 'xterm' }),
      }));
      if (geo.mainOverflow !== 'clip') fail(`[${kind}] #main overflow is ${geo.mainOverflow}, want clip`);
      if (geo.bodyScrollW > geo.innerW) fail(`[${kind}] page scrolls sideways: ${geo.bodyScrollW} > ${geo.innerW}`);
      if (geo.histScrollW > Math.ceil(geo.histW)) fail(`[${kind}] transcript scrolls sideways: ${geo.histScrollW} > ${geo.histW}`);
      if (geo.nativeMenu !== true) fail(`[${kind}] transcript hold on a phone should use the native menu`);
      if (geo.customElsewhere !== false) fail(`[${kind}] terminal hold should keep the custom menu`);

      await p.evaluate(() => {
        const main = document.getElementById('main');
        main.scrollTop = 50; main.scrollLeft = 30;
        window.__td.resetMainScrollAfterKeyboard();
      });
      await p.waitForFunction(() => {
        const main = document.getElementById('main');
        return main.scrollTop === 0 && main.scrollLeft === 0;
      }, null, { timeout: 5000 });

      // Android keyboard: a real viewport shrink. Both viewports shrink together, the app must
      // shrink the body with them and keep the transcript pinned to its end.
      await p.evaluate(seedTranscript);
      const overflow = await p.evaluate(() => {
        const body = document.getElementById('history-body');
        body.scrollTop = body.scrollHeight;
        return body.scrollHeight - body.clientHeight;
      });
      // Without real overflow the pin below has nowhere to travel and the bottom-assertion passes
      // without it running.
      if (overflow < 300) fail(`[${kind}] seeded transcript does not overflow: ${overflow}px`);
      await p.setViewportSize({ width: 390, height: 400 });
      // The metrics update before the resize handler runs (WebKit especially), so wait for the
      // handler's own end state, not the metrics.
      const cssVarIs = (px) => `getComputedStyle(document.documentElement).getPropertyValue('--mobile-visual-height').trim() === '${px}'`;
      await p.waitForFunction(cssVarIs('400px'), null, { timeout: 10000 });
      await p.waitForFunction(() => window.__td.historyBodyAtBottom(), null, { timeout: 10000 });
      const android = await p.evaluate(() => ({
        visual: window.visualViewport.height,
        layout: window.innerHeight,
        cssVar: getComputedStyle(document.documentElement).getPropertyValue('--mobile-visual-height').trim(),
        native: window.__td.keyboardShiftIsNative(),
      }));
      if (android.native !== false) fail(`[${kind}] shrink of both viewports is not a native pan`);
      if (android.cssVar !== '400px') fail(`[${kind}] body did not shrink with the keyboard: var is ${android.cssVar}`);
      await p.setViewportSize({ width: 390, height: 844 });
      await p.waitForFunction(cssVarIs('844px'), null, { timeout: 10000 });
      // Drain the Android pin's chained frames before the iPhone phase parks below the max: a
      // late second pin frame landing inside the iPhone compare window would look exactly like
      // an unsuppressed pin.
      await p.evaluate(() => new Promise((resolve) => {
        let frames = 0;
        const tick = () => (++frames < 3 ? requestAnimationFrame(tick) : resolve());
        requestAnimationFrame(tick);
      }));

      // iPhone keyboard: faked geometry, real handler. Visual small, layout tall -- Safari's pan
      // owns this shift, so the handler must leave the body height and the transcript alone.
      await p.evaluate(seedTranscript);
      const iphone = await p.evaluate(() => {
        const liveVisual = window.visualViewport;
        Object.defineProperty(window, 'innerHeight', { value: 844, configurable: true });
        Object.defineProperty(window, 'visualViewport',
          { value: { height: 400, width: 390, offsetTop: 0, scale: 1 }, configurable: true });
        const body = document.getElementById('history-body');
        // Park just inside the bottom slack: at-bottom enough that an unsuppressed pin would run,
        // off-max enough that it would visibly move -- otherwise the scrollTop compare below could
        // pass vacuously on broken code. Re-checked here (not just in the Android phase) so a
        // transcript re-render wiping the seed between phases fails loudly instead of passing empty.
        if (body.scrollHeight - body.clientHeight < 300) {
          throw new Error(`seeded transcript lost its overflow: ${body.scrollHeight - body.clientHeight}px`);
        }
        body.scrollTop = Math.max(0, body.scrollHeight - body.clientHeight - 50);
        const before = {
          native: window.__td.keyboardShiftIsNative(),
          cssVar: getComputedStyle(document.documentElement).getPropertyValue('--mobile-visual-height').trim(),
          scrollTop: body.scrollTop,
        };
        window.__td.syncMobileVisualViewport();
        // Four frames, not a timeout: the pin the fix suppresses is itself two chained frames, so
        // counting frames guarantees it would have landed by the compare even where frames are slow.
        // A fixed wait here would pass vacuously on broken code under a slow headless renderer.
        return new Promise((resolve) => {
          let frames = 0;
          const tick = () => {
            if (++frames < 4) { requestAnimationFrame(tick); return; }
            const after = {
              cssVar: getComputedStyle(document.documentElement).getPropertyValue('--mobile-visual-height').trim(),
              scrollTop: document.getElementById('history-body').scrollTop,
            };
            delete window.visualViewport;
            delete window.innerHeight;
            Object.defineProperty(window, 'visualViewport', { value: liveVisual, configurable: true });
            window.__td.syncMobileVisualViewport();
            resolve({ before, after });
          };
          requestAnimationFrame(tick);
        });
      });
      if (iphone.before.native !== true) fail(`[${kind}] visual-shrank-layout-stayed is a native pan`);
      if (iphone.after.cssVar !== iphone.before.cssVar) {
        fail(`[${kind}] body shrank on top of the native pan: ${iphone.before.cssVar} -> ${iphone.after.cssVar}`);
      }
      if (iphone.after.scrollTop !== iphone.before.scrollTop) {
        fail(`[${kind}] transcript pinned on top of the native pan: ${iphone.before.scrollTop} -> ${iphone.after.scrollTop}`);
      }
      console.log(`[${kind}] ok:`, JSON.stringify(geo), JSON.stringify(android), 'iphone-shift-skipped');
    } finally {
      await p.close();
      await ctx.close();
    }
  } finally {
    await br.close();
  }
}

(async () => {
  const id = (await fetch(`${BASE}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'codex', permission: 'default',
      cwd: '/Users/dan/workspace/height-probe-root', title: 'mobile-layout' }),
  }).then((r) => r.json())).session_id;
  if (!id) fail('no session created');
  try {
    await checkEngine('chromium', () => chromium.launch({ headless: true,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }), id);
    await checkEngine('webkit', () => webkit.launch({ headless: true }), id);
    console.log('mobile transcript layout ok');
  } finally {
    await fetch(`${BASE}/api/sessions/${id}`, { method: 'DELETE' }).catch(() => {});
  }
})().catch((e) => { console.error(`FAIL: ${e.message}`); process.exit(1); });
