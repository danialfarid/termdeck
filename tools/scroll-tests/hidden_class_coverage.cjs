// Every element the client hides with the `hidden` class must actually be hidden by it.
//
// style.css has no blanket `.hidden { display: none }` -- every use is scoped to its element, sometimes
// through a descendant rule (`#modal label.hidden`). So adding `class="hidden"` to new markup, or a new
// `classList.toggle("hidden", ...)` in the client, silently does nothing until someone remembers the
// stylesheet too. That shipped once: the Markdown toggle set the class correctly and stayed on screen for
// every file, because nothing in the stylesheet acted on it.
//
// Checked in a browser rather than by reading selectors: the rules that matter are as often descendant
// rules as `#id.hidden`, and only the cascade knows. Each candidate has the class forced on, its computed
// display read, and its original classes put back.
//
//   node tools/scroll-tests/hidden_class_coverage.cjs [port]
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const PORT = process.argv[2] || process.env.TERMDECK_TEST_PORT || '8536';
const BASE = `http://127.0.0.1:${PORT}`;
const STATIC = path.join(__dirname, '..', '..', 'termdeck', 'static');
const PROJECT = (process.env.TERMDECK_TEST_REPO || '/Users/dan/workspace/termdeck').split('/').filter(Boolean).pop();

// Ids that carry the class in the markup, plus ids the client puts it on at runtime.
const candidateIds = () => {
  const html = fs.readFileSync(path.join(STATIC, 'index.html'), 'utf8');
  const js = fs.readdirSync(STATIC).filter((name) => /^app.*\.js$/.test(name))
    .map((name) => fs.readFileSync(path.join(STATIC, name), 'utf8')).join('\n');
  const ids = new Set();
  for (const tag of html.match(/<[a-z]+[^>]*>/g) || []) {
    const id = tag.match(/\bid="([^"]+)"/);
    const cls = tag.match(/\bclass="([^"]*)"/);
    if (id && cls && cls[1].split(/\s+/).includes('hidden')) ids.add(id[1]);
  }
  const toggles = /(?:\$\(|getElementById\()"([a-z0-9-]+)"\)\??\.classList\.(?:toggle|add)\("hidden"/g;
  for (let m = toggles.exec(js); m; m = toggles.exec(js)) ids.add(m[1]);
  return [...ids].sort();
};

(async () => {
  const ids = candidateIds();
  const br = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await br.newPage({ viewport: { width: 1500, height: 900 } });
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.goto(`${BASE}/p/${PROJECT}`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
  await p.waitForTimeout(4000);

  const report = await p.evaluate((candidates) => {
    const missing = [];
    const absent = [];
    for (const id of candidates) {
      const el = document.getElementById(id);
      if (!el) { absent.push(id); continue; }
      const original = el.getAttribute('class');
      el.classList.add('hidden');
      const display = getComputedStyle(el).display;
      if (original === null) el.removeAttribute('class');
      else el.setAttribute('class', original);
      if (display !== 'none') missing.push({ id, display });
    }
    return { missing, absent };
  }, ids);

  console.log(`  checked ${ids.length} ids that the class is used on`);
  if (report.absent.length) console.log(`  not in the page right now (skipped): ${report.absent.join(', ')}`);
  for (const entry of report.missing) console.log(`  FAIL  #${entry.id} keeps display:${entry.display} with .hidden`);
  const ok = report.missing.length === 0 && !errors.length;
  console.log(`\n  every .hidden actually hides: ${ok ? 'PASS' : `FAIL (${report.missing.length})`}`);
  if (errors.length) console.log('  errors:', errors);
  await br.close();
  process.exit(ok ? 0 : 1);
})();
