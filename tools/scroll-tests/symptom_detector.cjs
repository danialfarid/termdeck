// Proves the live fault recorder (tools/watch_symptoms.cjs) can actually fire, and does not fire on the
// states that merely look like a fault. A monitor that has never been seen to trigger is worth nothing --
// this feeds its detector fabricated samples instead of waiting for the bug to happen.
//
//   node tools/scroll-tests/symptom_detector.cjs
//
// Needs no TermDeck instance: the detector is a function of two samples.
const { chromium } = require('playwright');
const { RECORDER } = require('../watch_symptoms.cjs');

const base = {
  t: 0, id: 'aaa', title: 'probe', top: 1000, ceiling: 1000, nativeMax: 1000, innerH: 2000,
  following: true, pinned: null, anchor: null, mode: 'follow', replaying: false,
  viewportY: 500, baseY: 500, cursorY: 990, lastContent: 1490, showing: '1450..1490',
  rowsBelow: 0, gesture: false, topRow: 'a line of output',
};
const s = (over) => ({ ...base, ...over });

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.evaluate(RECORDER, { ring: 400, before: 20, after: 6 });

  const detect = (prev, next) => page.evaluate(([p, n]) => window.__tdWatch.detect(p, n), [prev, next]);
  const reset = () => page.evaluate(() => { window.__tdWatch.stuckSince = 0; window.__tdWatch.stuckFlagged = false;
    window.__tdWatch.sinkSince = 0; window.__tdWatch.sinkFlagged = false; });

  const cases = [];
  const check = async (name, expected, run) => {
    const got = await run();
    const kind = got ? got.kind : null;
    cases.push({ name, expected, kind, ok: kind === expected });
  };

  // Healthy: following, at the bottom, nothing below the fold.
  await check('following at the bottom', null, async () => {
    await reset();
    return detect(s({ t: 1000 }), s({ t: 1100 }));
  });

  // Stuck: pinned against the container's own limit with content still below, held past the grace period.
  const stuck = { top: 1000, nativeMax: 1000, rowsBelow: 40, following: false };
  await check('at the scroll limit, 40 rows below', 'stuck', async () => {
    await reset();
    await detect(s({ t: 1000, ...stuck }), s({ t: 1100, ...stuck }));
    return detect(s({ t: 1100, ...stuck }), s({ t: 2800, ...stuck }));
  });

  // ...but not while it is still within the grace period.
  await check('same, only 400ms old', null, async () => {
    await reset();
    await detect(s({ t: 1000, ...stuck }), s({ t: 1100, ...stuck }));
    return detect(s({ t: 1100, ...stuck }), s({ t: 1400, ...stuck }));
  });

  // ...and not while the user is mid-gesture, where being briefly past the end is normal.
  await check('same, during a gesture', null, async () => {
    await reset();
    await detect(s({ t: 1000, ...stuck }), s({ t: 1100, ...stuck }));
    return detect(s({ t: 1100, ...stuck }), s({ t: 2800, ...stuck, gesture: true }));
  });

  // Self-park: following one moment, not the next, with nobody touching it.
  await check('parked itself, no gesture', 'selfpark', async () => {
    await reset();
    return detect(s({ t: 1000, following: true }), s({ t: 1100, following: false, top: 17798, ceiling: 17970 }));
  });

  // The same transition right after a gesture is the user scrolling away, which is the point of it.
  await check('parked right after a gesture', null, async () => {
    await reset();
    return detect(s({ t: 1000, following: true, gesture: true }), s({ t: 1100, following: false, top: 12000 }));
  });

  // Drift: parked, hands off, and the line under the reader is no longer the same line.
  await check('parked and the line changed', 'drift', async () => {
    await reset();
    return detect(s({ t: 1000, following: false, topRow: 'epoch 41 loss 0.31' }),
                  s({ t: 1100, following: false, topRow: 'epoch 47 loss 0.28' }));
  });

  // Content walking off the bottom under a hands-off view: the composer sinking as the agent writes.
  // Reported as "I scroll all the way down and it keeps pushing the composer down".
  await check('content sinking below the fold', 'sinking', async () => {
    await reset();
    // Rising rowsBelow, held past the 1.5s settle, with scroll room still left (so not `stuck`).
    await detect(s({ t: 1000, rowsBelow: 3, nativeMax: 900, top: 700 }),
                 s({ t: 1100, rowsBelow: 5, nativeMax: 900, top: 700 }));
    return detect(s({ t: 2600, rowsBelow: 9, nativeMax: 900, top: 700 }),
                  s({ t: 2700, rowsBelow: 12, nativeMax: 900, top: 700 }));
  });

  // A reader parked in history sits with content below them and it must NOT count: what separates the
  // fault is that the gap keeps GROWING, not that it exists.
  await check('parked reader holding steady', null, async () => {
    await reset();
    await detect(s({ t: 1000, following: false, rowsBelow: 40, nativeMax: 900, top: 300 }),
                 s({ t: 1100, following: false, rowsBelow: 40, nativeMax: 900, top: 300 }));
    return detect(s({ t: 2600, following: false, rowsBelow: 40, nativeMax: 900, top: 300 }),
                  s({ t: 2700, following: false, rowsBelow: 40, nativeMax: 900, top: 300 }));
  });

  // The same movement is expected while the user is scrolling, or while a replay repaints the buffer.
  await check('line changed during a gesture', null, async () => {
    await reset();
    return detect(s({ t: 1000, following: false, topRow: 'epoch 41 loss 0.31' }),
                  s({ t: 1100, following: false, topRow: 'epoch 47 loss 0.28', gesture: true }));
  });
  await check('line changed during a replay', null, async () => {
    await reset();
    return detect(s({ t: 1000, following: false, topRow: 'epoch 41 loss 0.31' }),
                  s({ t: 1100, following: false, topRow: 'epoch 47 loss 0.28', replaying: true }));
  });

  // Following views move by design -- that is not drift.
  await check('line changed while following', null, async () => {
    await reset();
    return detect(s({ t: 1000, following: true, topRow: 'epoch 41 loss 0.31' }),
                  s({ t: 1100, following: true, topRow: 'epoch 47 loss 0.28' }));
  });

  for (const c of cases) {
    console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(34)} expected ${String(c.expected)}, got ${String(c.kind)}`);
  }
  const failed = cases.filter((c) => !c.ok).length;
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
