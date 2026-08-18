// How many distinct positions does a tab switch pass through before it settles?
//
// This is a measurement, not a test, and deliberately so: the walk only happens against a real agent
// session, whose fill is its TUI repainting rather than a buffer replay. Two synthetic versions were
// written and both passed with the fix disabled -- a shell's fill arrives in one batch, and on a full
// 1000-row buffer staying at the bottom needs no container scroll at all -- so they were deleted rather
// than kept as false confidence. Run this against two real sessions instead, before and after a change:
//
//   node tools/measure_switch.cjs <session-id> <other-session-id>
//
// Baseline for the fill-settle change was 19 steps on a cold switch; after it, 3 (one visible move).
// Runs in its own headless client, so the window you are using is untouched.
const { chromium } = require('playwright');
const A = process.argv[2], B = process.argv[3];

(async () => {
  const br = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await br.newPage({ viewport: { width: 1400, height: 850 } });
  await p.goto('http://127.0.0.1:8530/p/stock', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(9000);

  const watch = async (id, label) => {
    await p.evaluate(({ i, dur }) => {
      window.__t = [];
      const start = performance.now();
      const tick = () => {
        const v = window.__td.views.get(i);
        if (v && v.container) {
          const b = v.term.buffer.active;
          const last = window.__t[window.__t.length - 1];
          const top = Math.round(v.container.scrollTop);
          if (!last || last.top !== top || last.viewportY !== b.viewportY) {
            window.__t.push({ ms: Math.round(performance.now() - start), top, viewportY: b.viewportY,
                              ceil: v.tallMaxScrollTop == null ? null : Math.round(v.tallMaxScrollTop),
                              foll: v.tallFollowing, replaying: !!v.replaying });
          }
        }
        if (performance.now() - start < dur) requestAnimationFrame(tick);
      };
      tick();
    }, { i: id, dur: 6000 });
    await p.evaluate((i) => window.__td.activate(i), id);
    await p.waitForTimeout(6500);
    const t = await p.evaluate(() => window.__t);
    const ups = t.filter((s, i) => i > 0 && s.top < t[i - 1].top);
    console.log(`\n${label}`);
    console.log(`  distinct positions: ${t.length}   backward moves: ${ups.length}`);
    for (const s of t.slice(0, 12)) console.log('   ', JSON.stringify(s));
    return { steps: t.length, ups: ups.length };
  };

  const first = await watch(A, `SWITCH -> ${A}`);
  await p.waitForTimeout(1500);
  const second = await watch(B, `SWITCH -> ${B}`);
  await p.waitForTimeout(1500);
  const third = await watch(A, `SWITCH BACK -> ${A}`);
  console.log(`\nsteps ${first.steps}/${second.steps}/${third.steps}   backward ${first.ups}/${second.ups}/${third.ups}`);
  await br.close();
})();
