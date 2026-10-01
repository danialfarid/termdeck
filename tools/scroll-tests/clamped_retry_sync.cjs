// A follow scroll that outruns layout must bring the rendered window when it lands.
//
// The follow target comes from buffer rows, which run ahead of the height the box has laid
// out, so a follow scroll issued by the write that grew the output can clamp short; a retry
// re-applies it on the next frame. That retry lands a frame after the caller synced, and its
// own scroll event is swallowed as an echo -- without an explicit sync the rendered window
// stays behind at the clamped landing. While the stream keeps flowing the next write heals
// it within a frame, but when the retried jump is the stream's last one (a big final batch
// at the end of a turn) the desync freezes with the visible span past the window: a black
// pane until the next scroll or write re-syncs it.
//
// This wedges exactly that lag by hand -- pin the box short, drive to the ceiling, let the
// layout catch up -- then requires the visible span to still intersect the rendered window
// once the retry has bridged the gap. Same for the scroll-to-bottom fallback on a tab whose
// ceiling was never computed.
//
//   node tools/scroll-tests/clamped_retry_sync.cjs [port]
const { chromium } = require('playwright');
const PORT = process.argv[2] || process.env.TERMDECK_TEST_PORT || '8536';
const BASE = `http://127.0.0.1:${PORT}`;

const state = (i) => {
  const td = window.__td;
  const v = td.views.get(i);
  const el = v.term.element;
  const visTop = v.container.scrollTop;
  const visBottom = visTop + v.container.clientHeight;
  const elTop = el.offsetTop;
  const elBottom = elTop + el.offsetHeight;
  const overlap = Math.max(0, Math.min(elBottom, visBottom) - Math.max(elTop, visTop));
  return {
    top: Math.round(visTop), ceiling: Math.round(v.tallMaxScrollTop || -1),
    clientH: v.container.clientHeight, elTop, elBottom,
    overlap: Math.round(overlap),
    vy: v.term.buffer.active.viewportY, baseY: v.term.buffer.active.baseY,
    follow: v.tallFollowing, attempts: Number(v.tallClampedScrollAttempts || 0),
  };
};

(async () => {
  const mk = async (title) => (await fetch(`${BASE}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'none', permission: 'default',
      cwd: '/Users/dan/workspace/height-probe-root', title }),
  }).then((r) => r.json())).session_id;
  const id = await mk('clamped-retry-sync');

  const br = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await br.newPage({ viewport: { width: 1400, height: 850 } });
  await p.goto(`${BASE}/p/height-probe-root`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
  await p.waitForTimeout(1500);
  await p.evaluate((i) => window.__td.activate(i), id);
  await p.waitForTimeout(2000);

  await p.evaluate(({ i, s }) => window.__td.sendInput(window.__td.views.get(i), s),
    { i: id, s: "printf '\\033[2J\\033[H'; for n in $(seq 1 600); do printf 'history-%03d\\n' $n; done; printf 'COMPOSER> '; sleep 600\n" });
  await p.waitForTimeout(7000);
  const fail = async (why) => {
    console.log(`\n  FAIL: ${why}`);
    await br.close();
    await fetch(`${BASE}/api/sessions/${id}`, { method: 'DELETE' }).catch(() => {});
    process.exit(1);
  };
  const seeded = await p.evaluate(state, id);
  console.log('seeded:', JSON.stringify(seeded));
  if (seeded.baseY < 100) return fail('fixture never built scrollback');
  if (!seeded.follow) return fail('fixture is not following');
  if (seeded.top < seeded.ceiling - 2) return fail('fixture is not at its ceiling');

  // Wedge layout lag: pin the box short, drive a full-span follow, let the layout catch up.
  await p.evaluate((i) => {
    const td = window.__td;
    const v = td.views.get(i);
    td.endAttachFollowSettle(v);
    td.tallSetScrollTop(v, 0);
    td.tallSyncBufferToScroll(v);
    const inner = v.container.querySelector('.term-inner');
    v.__savedInnerHeight = inner.style.height;
    inner.style.height = `${v.container.clientHeight}px`;
    td.tallSetScrollTop(v, v.tallMaxScrollTop);
    td.tallSyncBufferToScroll(v);
    inner.style.height = v.__savedInnerHeight;
  }, id);
  await p.waitForTimeout(4000);
  const retried = await p.evaluate(state, id);
  console.log('after retry:', JSON.stringify(retried));
  if (retried.top < retried.ceiling - 2) return fail('retry never bridged the gap (no clamp happened)');
  if (retried.attempts < 1) return fail('clamped retry never armed');
  const retryCovered = retried.overlap >= retried.clientH * 0.9;

  // The scroll-to-bottom fallback on a tab with no ceiling yet takes the same path.
  // Sampled synchronously: a later fit pass would re-sync behind it and hide the gap.
  const bottomed = await p.evaluate((i) => {
    const td = window.__td;
    const v = td.views.get(i);
    td.tallSetScrollTop(v, 0);
    td.tallSyncBufferToScroll(v);
    v.tallMaxScrollTop = null;
    td.scrollActiveToBottom();
    const el = v.term.element;
    const visTop = v.container.scrollTop;
    const visBottom = visTop + v.container.clientHeight;
    const overlap = Math.max(0, Math.min(el.offsetTop + el.offsetHeight, visBottom) -
      Math.max(el.offsetTop, visTop));
    return { top: Math.round(visTop), clientH: v.container.clientHeight,
             overlap: Math.round(overlap), vy: v.term.buffer.active.viewportY };
  }, id);
  console.log('after scroll-to-bottom:', JSON.stringify(bottomed));
  const bottomCovered = bottomed.overlap >= bottomed.clientH * 0.9;

  const results = [
    ['retried follow still renders the visible span', retryCovered],
    ['scroll-to-bottom without ceiling still renders', bottomCovered],
  ];
  for (const [label, ok] of results) console.log(`\n  ${label}: ${ok ? 'PASS' : 'FAIL'}`);
  await br.close();
  await fetch(`${BASE}/api/sessions/${id}`, { method: 'DELETE' }).catch(() => {});
  process.exit(results.every(([, ok]) => ok) ? 0 : 1);
})();
