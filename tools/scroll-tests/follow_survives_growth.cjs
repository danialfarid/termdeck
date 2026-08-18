// A view nobody has touched must not be parked just because the ceiling moved underneath it.
//
// The bug this pins down, captured live on a tab switch into a working agent: scrollTop 17798, ceiling
// 17970 -- the view sat exactly where the last follow had placed it, and the 172px gap was output that
// had arrived since. The settle handler read that gap as "the user scrolled away", parked the view, and
// it stayed 8 rows behind the agent until something else set following again. Typing was one such thing,
// which is what made it look like typing was the cure.
//
// Exercised against a fabricated view rather than a live agent: the fault needs a ceiling that moves
// while the view is still, which a synthetic session will not do on demand (it falls idle first).
//
//   node tools/scroll-tests/follow_survives_growth.cjs [port]
const { chromium } = require('playwright');
const PORT = process.argv[2] || '8536';

const SETUP = () => {
  // A real scrollable element -- scrollTop on a detached div silently stays 0.
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:-9999px;top:0;width:400px;height:800px;overflow-y:auto';
  const inner = document.createElement('div');
  inner.style.cssText = 'height:40000px';
  box.appendChild(inner);
  document.body.appendChild(box);
  window.__fakeBox = box;
};

const RUN = ({ scrollTop, ceiling, followTop, following }) => {
  const box = window.__fakeBox;
  box.scrollTop = scrollTop;
  const view = {
    closed: false, container: box,
    tallMaxScrollTop: ceiling, tallFollowTop: followTop, tallFollowing: following,
    tallPinnedViewportY: null, tallAnchorRow: null,
    term: {
      buffer: { active: { viewportY: 500, baseY: 500, cursorY: 0 } },
      scrollToBottom() {},
      // Real terminals always have this; the anchor uses it to follow a line through scrollback trimming.
      registerMarker() { return null; },
      _core: { _renderService: { dimensions: { css: { cell: { height: 21 } } } } },
    },
  };
  window.__td.tallApplySettledScroll(view);
  return { following: view.tallFollowing, top: Math.round(box.scrollTop) };
};

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__td, null, { timeout: 30000 });
  await page.evaluate(SETUP);

  const cases = [
    { name: 'still where follow left it, ceiling grew',
      input: { scrollTop: 17798, ceiling: 17970, followTop: 17798, following: true }, expect: true },
    { name: 'sitting at the ceiling',
      input: { scrollTop: 17970, ceiling: 17970, followTop: 17970, following: true }, expect: true },
    { name: 'no ceiling established yet',
      input: { scrollTop: 0, ceiling: null, followTop: null, following: true }, expect: true },
    { name: 'dragged up, ceiling unchanged',
      input: { scrollTop: 12000, ceiling: 17970, followTop: 17798, following: true }, expect: false },
    { name: 'already parked at an old follow position',
      input: { scrollTop: 17798, ceiling: 17970, followTop: 17798, following: false }, expect: false },
    { name: 'parked far up, ceiling grew',
      input: { scrollTop: 9000, ceiling: 17970, followTop: 17798, following: false }, expect: false },
  ];

  let failed = 0;
  for (const c of cases) {
    const got = await page.evaluate(RUN, c.input);
    const ok = got.following === c.expect;
    if (!ok) failed += 1;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(38)} following: expected ${c.expect}, got ${got.following}`);
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
