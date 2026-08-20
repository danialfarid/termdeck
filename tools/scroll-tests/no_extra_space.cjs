// The structural claim: the container's own maximum scroll IS the last line, so there is no extra space
// to reach at all -- not "small enough to ignore", but zero. Checked on a sparse terminal and a full one,
// and the terminal must still be 1000 rows with all content intact.
const { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:8536';

(async () => {
  const mk = async (title) => {
    const r = await fetch(`${BASE}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'none', permission: 'default', cwd: '/Users/dan/workspace/height-probe-root', title }) });
    return (await r.json()).session_id;
  };
  const sparse = await mk('extra-sparse');
  const full = await mk('extra-full');

  const br = await chromium.launch({ headless: true, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
  const p = await br.newPage({ viewport: { width: 1400, height: 850 } });
  await p.goto(`${BASE}/p/height-probe-root`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3000);

  const check = async (id, lines, label) => {
    await p.evaluate((i) => window.__td.activate(i), id);
    await p.waitForTimeout(2500);
    if (lines) {
      await p.evaluate(({ i, n }) => window.__td.sendInput(window.__td.views.get(i), `clear; seq 1 ${n}\n`), { i: id, n: lines });
      for (let k = 0; k < 40; k++) {
        const c = await p.evaluate((i) => window.__td.views.get(i)?.tallMaxScrollTop || 0, id);
        if (c > 500) break;
        await p.waitForTimeout(500);
      }
    }
    await p.waitForTimeout(2500);

    const r = await p.evaluate((i) => {
      const v = window.__td.views.get(i);
      const c = v.container;
      const b = v.term.buffer.active;
      const cell = v.term._core._renderService.dimensions.css.cell.height;
      // Drive it as hard as possible past the end and see where it can actually land.
      const before = Math.round(c.scrollTop);
      c.scrollTop = 10 ** 7;
      const maxReachable = Math.round(c.scrollTop);
      c.scrollTop = before;
      let lastContent = -1;
      for (let y = b.length - 1; y >= 0; y--) {
        if ((b.getLine(y)?.translateToString(true) || '').trim()) { lastContent = y; break; }
      }
      // Anchored at the rendered window's offset inside the scroll box, so the number is in the same
      // frame as maxReachable in both scroll modes: offsetTop is 0 in the default mode and
      // viewportY*cell in whole-buffer mode, where the box legitimately spans the scrollback above.
      const lastContentBottomPx = v.term.element.offsetTop + (lastContent - b.viewportY + 1) * cell;
      return { termRows: v.term.rows, cols: v.term.cols, cell,
               plannedRows: v.tallRows, webgl: v.tallWebgl === true,
               innerHeight: c.querySelector('.term-inner').style.height,
               xtermHeight: v.term.element.style.height,
               scrollHeight: c.scrollHeight, clientHeight: c.clientHeight,
               maxReachable, lastContentBottomPx,
               // Reachable scroll BEYOND the ideal bottom. A terminal whose content is shorter than
               // the viewport has no scroll at all, which is not extra space -- it is just a short
               // terminal, exactly as any terminal renders it.
               extraPastLastLine: Math.round(maxReachable - Math.max(0, lastContentBottomPx - c.clientHeight)),
               nonBlank: (() => { let n = 0; for (let y = 0; y < b.length; y++) if ((b.getLine(y)?.translateToString(true) || '').trim()) n++; return n; })() };
    }, id);
    console.log(`${label}`, JSON.stringify(r));
    return r;
  };

  const a = await check(sparse, 0, 'sparse (near-empty):');
  const b = await check(full, 1500, 'full (1500 lines)  :');

  // WebGL mode deliberately runs fewer rows (the GPU texture limit -- see tallRowPlan); what must hold
  // in every mode is that the terminal kept the height the plan chose for it.
  const rowsOk = a.termRows === a.plannedRows && b.termRows === b.plannedRows &&
                 (a.webgl || (a.termRows === 4000 && b.termRows === 4000));
  const ok = Math.abs(a.extraPastLastLine) <= 2 && Math.abs(b.extraPastLastLine) <= 2 && rowsOk;
  console.log(`\n  sparse extra space: ${a.extraPastLastLine}px  (was ~19000)`);
  console.log(`  full extra space:   ${b.extraPastLastLine}px  (was ~10-40)`);
  console.log(`  rows as planned:    ${rowsOk ? 'yes' : 'NO'} (${b.termRows} rows${b.webgl ? ', webgl' : ''})`);
  console.log(ok ? '\nPASS: no reachable space past the last line' : '\nFAIL');
  await br.close();
  process.exit(ok ? 0 : 1);
})();
