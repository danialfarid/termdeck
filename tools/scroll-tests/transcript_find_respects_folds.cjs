// The transcript has no find bar of its own: Cmd+F there is the browser's find-in-page. Chrome searches
// inside a closed <details> and forces it open when it matches, so a search sprang open folded code
// edits, folded repetitions and thinking blocks -- everything the transcript's own folds and the
// "Collapse code edits" / "Fold repetitive responses" filters had just put away.
//
// Find-in-page cannot be driven from Playwright (there is no such command in CDP), so this checks the
// property that decides it: text inside a display:none subtree is not searchable and cannot be revealed,
// whereas the closed-<details> content the browser hides by itself is both. If the closed block's
// content computes to display:none and reports itself invisible, find has nothing to match in there.
//
//   node tools/scroll-tests/transcript_find_respects_folds.cjs
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STYLE = path.resolve(__dirname, '../../termdeck/static/style.css');

// The shapes renderHistoryTurns builds: a folded repetition group, a collapsed code edit, a thinking
// block, and one open block to prove the rule only takes away what is already folded.
const PAGE = `<!doctype html><html><head><link rel="stylesheet" href="file://${STYLE}"></head><body>
<div id="history-body">
  <details class="history-repetition-group"><summary>3 similar responses</summary>
    <div class="history-repetition-items"><div class="turn" id="folded-repetition">needle-repetition</div></div>
  </details>
  <details class="history-event edit"><summary>Edited app.js</summary>
    <pre id="folded-edit">needle-edit</pre>
  </details>
  <details class="history-event thinking"><summary>Thinking</summary>
    <div class="history-thinking"><pre id="folded-thinking">needle-thinking</pre></div>
  </details>
  <details class="history-event edit" open><summary>Edited style.css</summary>
    <pre id="open-edit">needle-open</pre>
  </details>
</div>
<!-- The control: a closed fold outside the transcript, left as the browser hides it. It is what every
     one of these looked like before, and find-in-page reaches into it. -->
<details id="control"><summary>Elsewhere in the app</summary><pre id="control-body">needle-control</pre></details>
</body></html>`;

(async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'td-find-')), 'transcript.html');
  fs.writeFileSync(file, PAGE);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`file://${file}`);

  const state = await page.evaluate(() => {
    // What decides find-in-page is whether the needle sits under a display:none ancestor, so walk up
    // from the text rather than reading the text node's own box -- a paragraph inside a hidden div
    // still computes display:block.
    const look = (id) => {
      const element = document.getElementById(id);
      let hiddenBy = null;
      for (let node = element; node && node !== document.body; node = node.parentElement) {
        if (getComputedStyle(node).display === 'none') { hiddenBy = node.className || node.tagName; break; }
      }
      return { hiddenBy, visible: element.checkVisibility() };
    };
    return { repetition: look('folded-repetition'), edit: look('folded-edit'),
             thinking: look('folded-thinking'), open: look('open-edit'), control: look('control-body'),
             // Opening a fold must still hand back everything inside it.
             opened: (() => {
               document.querySelector('.history-event.edit').open = true;
               return look('folded-edit');
             })() };
  });
  await browser.close();

  const failures = [];
  for (const key of ['repetition', 'edit', 'thinking']) {
    if (!state[key].hiddenBy) failures.push(`${key} is still searchable: ${JSON.stringify(state[key])}`);
  }
  // Without the control passing, the three above prove nothing: it would mean the browser hides closed
  // folds this way by itself and the rule is doing no work.
  if (state.control.hiddenBy) failures.push(`the control was hidden too, so this proves nothing: ${JSON.stringify(state.control)}`);
  if (state.open.hiddenBy || !state.open.visible) failures.push(`open block is hidden: ${JSON.stringify(state.open)}`);
  if (state.opened.hiddenBy || !state.opened.visible) failures.push(`opening a fold did not reveal it: ${JSON.stringify(state.opened)}`);

  console.log(JSON.stringify(state, null, 2));
  if (failures.length) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exit(1);
  }
  console.log('PASS folded transcript blocks are out of find-in-page\'s reach');
})();
