// Thinking blocks stay dense: the "N more lines" control rides at the end of the fourth line
// instead of taking a full-width row of its own, and the label/result/summary/footer paddings are
// tight so more of each block fits on screen.
//
// It used to be a full-width bar under the clamped preview: a row that held a few words while the
// reader scrolled past twenty tool calls. The control now overlays the last visible line (the clamp
// and its fade are unchanged), and opening it rides "show less" in the empty right of the next
// item's title row instead of a row of its own (only the last item, with no next title, keeps a
// row under its text).
//
// Driven through the real renderer (appendHistoryThinkingItem) into a real .history-event so the
// scoped stylesheet rules apply; no session needed.
//
//   node tools/scroll-tests/thinking_block_density.cjs [port]
const { chromium } = require('playwright');
const PORT = process.argv[2] || process.env.TERMDECK_TEST_PORT || '8536';
const BASE = `http://127.0.0.1:${PORT}`;
const fail = (msg) => { throw new Error(msg); };

(async () => {
  const br = await chromium.launch({ headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const p = await br.newPage({ viewport: { width: 1500, height: 900 } });
    await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
    await p.waitForTimeout(1000);

    const seed = await p.evaluate(() => {
      const event = document.createElement('div');
      event.className = 'history-event thinking';
      event.innerHTML = '<details open><summary><span class="history-thinking-title">Thinking</span></summary>' +
        '<div class="history-thinking"></div>' +
        '<div class="history-thinking-footer"><button class="history-thinking-collapse">Collapse</button></div>' +
        '</details>';
      document.body.appendChild(event);
      const results = event.querySelector('.history-thinking');
      const longText = Array.from({ length: 20 }, (_, i) => `output line ${i}`).join('\n');
      window.__td.appendHistoryThinkingItem(results, { kind: 'result', text: longText }, 'density:0');
      window.__td.appendHistoryThinkingItem(results, { kind: 'tool', title: 'Read', text: 'a\nb' }, 'density:1');
      const pre = results.querySelector('pre.history-thinking-item');
      const toggle = results.querySelector('button.history-thinking-more');
      const label = results.querySelector('.history-thinking-label');
      const summary = event.querySelector('summary');
      const footer = event.querySelector('.history-thinking-footer');
      const css = (el, prop) => parseFloat(getComputedStyle(el)[prop]);
      return {
        clamped: pre.classList.contains('clamped'),
        toggleText: toggle?.textContent,
        preRect: pre.getBoundingClientRect().toJSON(),
        toggleRect: toggle.getBoundingClientRect().toJSON(),
        labelPadTop: css(label, 'paddingTop'),
        prePadTop: css(pre, 'paddingTop'),
        summaryPadTop: css(summary, 'paddingTop'),
        footerPadTop: css(footer, 'paddingTop'),
        shortHasToggle: !!results.querySelectorAll('button.history-thinking-more')[1],
      };
    });
    if (!seed.clamped) fail('long thinking item is not clamped');
    if (seed.toggleText !== '… 16 more lines') fail(`toggle reads ${JSON.stringify(seed.toggleText)}`);
    if (seed.shortHasToggle) fail('short item grew a toggle');
    const { preRect, toggleRect } = seed;
    if (!(toggleRect.top > preRect.top && toggleRect.top < preRect.bottom &&
        toggleRect.bottom <= preRect.bottom + 2)) {
      fail(`toggle is not riding the last line: toggle top ${toggleRect.top} bottom ${toggleRect.bottom}, ` +
        `pre top ${preRect.top} bottom ${preRect.bottom}`);
    }
    if (preRect.right - toggleRect.right > 12) {
      fail(`toggle is not right-aligned: toggle right ${toggleRect.right}, pre right ${preRect.right}`);
    }
    if (seed.labelPadTop > 4) fail(`label padding-top is ${seed.labelPadTop}px, want <= 4`);
    if (seed.prePadTop > 5) fail(`result padding-top is ${seed.prePadTop}px, want <= 5`);
    if (seed.summaryPadTop > 4) fail(`header padding-top is ${seed.summaryPadTop}px, want <= 4`);
    if (seed.footerPadTop > 5) fail(`footer padding-top is ${seed.footerPadTop}px, want <= 5`);

    await p.click('button.history-thinking-more');
    const expanded = await p.evaluate(() => {
      const pre = document.querySelector('pre.history-thinking-item');
      const toggle = document.querySelector('button.history-thinking-more');
      const nextLabel = toggle.nextElementSibling;
      return {
        clamped: pre.classList.contains('clamped'),
        toggleText: toggle?.textContent,
        preBottom: pre.getBoundingClientRect().bottom,
        toggleRect: toggle.getBoundingClientRect().toJSON(),
        nextLabelRect: nextLabel.getBoundingClientRect().toJSON(),
        nextLabelClass: nextLabel.className,
      };
    });
    if (expanded.clamped) fail('click did not expand');
    if (expanded.toggleText !== 'show less') fail(`expanded toggle reads ${JSON.stringify(expanded.toggleText)}`);
    if (expanded.toggleRect.top < expanded.preBottom - 2) {
      fail(`expanded toggle overlaps the text: toggle top ${expanded.toggleRect.top}, pre bottom ${expanded.preBottom}`);
    }
    if (!String(expanded.nextLabelClass).includes('history-thinking-label')) {
      fail(`fixture has no next title row: next sibling is ${JSON.stringify(expanded.nextLabelClass)}`);
    }
    if (!(expanded.toggleRect.top < expanded.nextLabelRect.bottom - 2 &&
        expanded.toggleRect.bottom > expanded.nextLabelRect.top + 2)) {
      fail(`show less is not riding the next title row: toggle top ${expanded.toggleRect.top} bottom ` +
        `${expanded.toggleRect.bottom}, title top ${expanded.nextLabelRect.top} bottom ${expanded.nextLabelRect.bottom}`);
    }
    if (expanded.nextLabelRect.top - expanded.preBottom > 4) {
      fail(`show less takes a row of its own: next title starts ` +
        `${expanded.nextLabelRect.top - expanded.preBottom}px below the text`);
    }
    if (expanded.nextLabelRect.right - expanded.toggleRect.right > 12) {
      fail(`show less is not right-aligned: toggle right ${expanded.toggleRect.right}, ` +
        `title right ${expanded.nextLabelRect.right}`);
    }
    await p.click('button.history-thinking-more');
    const collapsed = await p.evaluate(() => ({
      clamped: document.querySelector('pre.history-thinking-item').classList.contains('clamped'),
      toggleText: document.querySelector('button.history-thinking-more')?.textContent,
    }));
    if (!collapsed.clamped || collapsed.toggleText !== '… 16 more lines') fail('click did not collapse back');
    console.log('thinking block density ok:', JSON.stringify(seed.toggleText));
  } finally {
    await br.close();
  }
})().catch((e) => { console.error(`FAIL: ${e.message}`); process.exit(1); });
