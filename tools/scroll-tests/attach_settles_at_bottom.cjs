// A tab that has just attached must end up at the composer, even if one of the attach's own paints
// left it parked mid-history.
//
// The reported shape: coming back to a codex tab after a restart opens it "somewhere in the middle"
// instead of at the bottom. The attach is several paints, not one -- the recording replays, then the
// agent redraws its screen over the tail of it -- and a redraw that walks the cursor high reads to the
// write callback either as a fold (glue drives the view to a mid-redraw content bottom) or as "somebody
// moved this view" (the follow-break guard parks it). Both are permanent when that redraw's completion
// was the attach's last write: nothing else is coming to drive the view down again.
//
// This wedges exactly that end state -- parked, mid-buffer, with no user gesture anywhere -- inside the
// post-attach window, and requires the view back at the bottom. Then it repeats the wedge WITH a gesture
// first, which must be respected: the window only ever corrects positions nobody asked for.
//
//   node tools/scroll-tests/attach_settles_at_bottom.cjs [port]
const { chromium } = require('playwright');
const PORT = process.argv[2] || process.env.TERMDECK_TEST_PORT || '8536';
const BASE = `http://127.0.0.1:${PORT}`;

const probe = (i) => {
  const v = window.__td.views.get(i);
  const b = v.term.buffer.active;
  const cell = v.term._core?._renderService?.dimensions?.css?.cell?.height || 21;
  let last = -1;
  for (let y = b.length - 1; y >= 0; y--) {
    if ((b.getLine(y)?.translateToString(true) || '').trim()) { last = y; break; }
  }
  const top = Math.round(v.container.scrollTop);
  const needed = Math.max(0, Math.round((last + 1) * cell - v.container.clientHeight));
  return { top, needed, offRows: Math.round((top - needed) / cell), following: v.tallFollowing,
           ceiling: Math.round(v.tallMaxScrollTop || 0), settleUntil: v.attachSettleDeadline };
};

(async () => {
  const mk = async (title) => (await fetch(`${BASE}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'none', permission: 'default',
      cwd: '/Users/dan/workspace/height-probe-root', title }),
  }).then((r) => r.json())).session_id;
  const id = await mk('attach-settle');

  const br = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await br.newPage({ viewport: { width: 1400, height: 850 } });
  await p.goto(`${BASE}/p/height-probe-root`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
  await p.waitForTimeout(1500);
  await p.evaluate((i) => { window.__td.session(i).agent_kind = 'codex'; window.__td.activate(i); }, id);
  await p.waitForTimeout(2000);

  // Several screens of history with a composer at the bottom, following.
  await p.evaluate(({ i, s }) => window.__td.sendInput(window.__td.views.get(i), s),
    { i: id, s: "printf '\\033[2J\\033[H'; for n in $(seq 1 220); do printf 'history-%03d\\n' $n; done; printf 'COMPOSER> '; sleep 600\n" });
  await p.waitForTimeout(5000);
  const seeded = await p.evaluate(probe, id);
  console.log('seeded:', JSON.stringify(seeded));
  if (seeded.needed < 400) {
    console.log('\n  FAIL: fixture never exceeded one screen of scrollback');
    await br.close();
    await fetch(`${BASE}/api/sessions/${id}`, { method: 'DELETE' }).catch(() => {});
    process.exit(1);
  }

  // Wedge the end state a bad attach paint leaves: parked, well above the content bottom, no gesture.
  const wedge = (i) => {
    const td = window.__td;
    const v = td.views.get(i);
    td.beginAttachFollowSettle(v);
    v.tallFollowing = false;
    td.tallSetScrollTop(v, Math.max(0, Math.round(v.tallMaxScrollTop / 2)));
    td.tallSyncBufferToScroll(v);
    return Math.round(v.container.scrollTop);
  };
  console.log('wedged at:', await p.evaluate(wedge, id));
  await p.waitForTimeout(2500);
  const recovered = await p.evaluate(probe, id);
  console.log('after settle:', JSON.stringify(recovered));

  // The same wedge, but preceded by a real gesture: the user's position must survive untouched.
  await p.evaluate((i) => window.__td.beginAttachFollowSettle(window.__td.views.get(i)), id);
  await p.mouse.move(700, 400);
  await p.mouse.wheel(0, -600);
  await p.waitForTimeout(600);
  const parkedByUser = await p.evaluate(probe, id);
  await p.waitForTimeout(2500);
  const stillParked = await p.evaluate(probe, id);
  console.log('parked by user:', JSON.stringify(parkedByUser));
  console.log('after settle:  ', JSON.stringify(stillParked));

  const recoveredOk = Math.abs(recovered.top - recovered.needed) <= 30 && recovered.following !== false;
  const respectedOk = parkedByUser.following === false && stillParked.following === false &&
    Math.abs(stillParked.top - parkedByUser.top) <= 30;
  console.log(`\n  a bad attach paint recovers to the composer: ${recoveredOk ? 'PASS' : `FAIL (${recovered.offRows} rows off, following=${recovered.following})`}`);
  console.log(`  a user gesture inside the window is respected: ${respectedOk ? 'PASS' : 'FAIL'}`);
  await br.close();
  await fetch(`${BASE}/api/sessions/${id}`, { method: 'DELETE' }).catch(() => {});
  process.exit(recoveredOk && respectedOk ? 0 : 1);
})();
