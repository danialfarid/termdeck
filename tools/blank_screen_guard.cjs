// Blank-screen / grey-area regression guard.
//
// The failure this exists to catch: a reattached Codex/Claude terminal showing an empty pane. Those TUIs
// paint inside synchronized-update frames, which are stripped from durable scrollback, so replayed
// scrollback alone cannot reconstruct their screen -- the server's SIGWINCH nudge (_force_screen_repaint)
// is what actually brings it back. The tall-terminal work adds a second way to get a black screen that
// has nothing to do with that: WebGL backs the terminal with one drawing buffer sized to the FULL
// terminal in device pixels, and exceeding MAX_TEXTURE_SIZE does not error, it silently renders black.
//
// So this asserts three things per session, all of which have actually broken at some point:
//   1. the VISIBLE viewport region has real text (not just "the buffer has content somewhere")
//   2. any renderer canvas is inside the GPU's texture limit
//   3. the terminal surface paints an opaque background (the grey-area failure)
//
// Usage: node tools/blank_screen_guard.cjs [port] [project]
const { chromium } = require('playwright');

const PORT = process.argv[2] || '8534';
const PROJECT = process.argv[3] || 'height-probe-root';

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(`http://127.0.0.1:${PORT}/p/${PROJECT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  const sessions = await page.evaluate(() => (window.__td.sessions || []).map((s) => ({
    id: s.session_id, title: s.title, agent: s.agent_kind, running: s.running,
  })));
  if (!sessions.length) {
    console.log('no sessions to check');
    await browser.close();
    return;
  }

  const failures = [];
  for (const s of sessions) {
    if (!s.running) continue;
    await page.evaluate((id) => window.__td.activate(id), s.id);
    // Generous: the SIGWINCH repaint is deliberately delayed server-side.
    await page.waitForTimeout(6000);

    const r = await page.evaluate((id) => {
      const v = window.__td.views.get(id);
      if (!v) return { noView: true };
      const buffer = v.term.buffer.active;
      const cell = v.term._core?._renderService?.dimensions?.css?.cell?.height || 21;
      // Only the rows the container is actually showing count as "on screen".
      const firstVisible = buffer.viewportY + Math.floor(v.container.scrollTop / cell);
      const visibleRows = Math.ceil(v.container.clientHeight / cell);
      let visibleNonBlank = 0;
      for (let y = firstVisible; y < firstVisible + visibleRows; y++) {
        if ((buffer.getLine(y)?.translateToString(true) || '').trim()) visibleNonBlank++;
      }
      let bufferNonBlank = 0;
      for (let y = 0; y < buffer.length; y++) {
        if ((buffer.getLine(y)?.translateToString(true) || '').trim()) bufferNonBlank++;
      }
      const gl = (() => {
        const c = document.createElement('canvas');
        const ctx = c.getContext('webgl2') || c.getContext('webgl');
        return ctx ? ctx.getParameter(ctx.MAX_TEXTURE_SIZE) : 0;
      })();
      const canvases = [...v.container.querySelectorAll('canvas')]
        .map((c) => ({ w: c.width, h: c.height }));
      const overs = canvases.filter((c) => gl && (c.h > gl || c.w > gl));
      const vp = v.container.querySelector('.xterm-viewport');
      const bg = vp ? getComputedStyle(vp).backgroundColor : '';
      const transparent = !bg || bg === 'transparent' || /rgba\(0,\s*0,\s*0,\s*0\)/.test(bg);
      return {
        visibleNonBlank, bufferNonBlank, termRows: v.term.rows,
        canvases, maxTextureSize: gl, oversizedCanvases: overs.length,
        viewportBg: bg, transparentBg: transparent,
      };
    }, s.id);

    const problems = [];
    // A session with content in its buffer but nothing on screen is the blank-screen bug.
    if (r.bufferNonBlank > 0 && r.visibleNonBlank === 0) problems.push('BLANK SCREEN (buffer has content, viewport shows none)');
    if (r.oversizedCanvases > 0) problems.push(`canvas exceeds MAX_TEXTURE_SIZE ${r.maxTextureSize} -> silent black render`);
    if (r.transparentBg) problems.push(`grey area (viewport background is ${r.viewportBg || 'unset'})`);

    const label = `${s.title} [${s.agent}]`;
    if (problems.length) {
      failures.push({ label, problems, detail: r });
      console.log(`FAIL  ${label}`);
      for (const p of problems) console.log(`        - ${p}`);
    } else {
      console.log(`ok    ${label.padEnd(34)} visible=${r.visibleNonBlank} rows=${r.termRows} ` +
                  `canvas=${r.canvases.map((c) => `${c.w}x${c.h}`).join(',') || 'dom'}`);
    }
  }

  if (pageErrors.length) console.log('page errors:', pageErrors.slice(0, 5));
  console.log(failures.length ? `\n${failures.length} FAILING SESSION(S)` : '\nPASS: no blank screen, no oversized canvas, no grey area');
  await browser.close();
  process.exit(failures.length ? 1 : 0);
})();
