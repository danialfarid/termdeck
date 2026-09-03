// Images, video and PDFs open from the file tree instead of being refused as binary.
//
// The editor can only hold text, so opening a screenshot used to fail the read ("binary file") and leave
// the panel on whatever was there before. Media now bypasses the editor entirely: the browser fetches the
// bytes from /api/files/media and renders them in the element that can show them.
//
// Also checks the half that is a security boundary rather than a feature: the endpoint serves an
// allowlist of media types and nothing else, so a file the browser might treat as a document cannot be
// fetched from the app's own origin.
//
//   node tools/scroll-tests/media_file_preview.cjs [port]
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const PORT = process.argv[2] || process.env.TERMDECK_TEST_PORT || '8536';
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = process.env.TERMDECK_TEST_REPO || '/Users/dan/workspace/termdeck';
const PROJECT = ROOT.split('/').filter(Boolean).pop();
const IMAGE = 'termdeck-media-probe.png';
// 1x1 transparent PNG.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100fdff03fa0000000049454e44ae426082', 'hex');

const snap = () => {
  const view = document.getElementById('media-file-view');
  const media = view.querySelector('img, video, audio, iframe');
  return {
    active: (window.__td.activeFileKey || '').split('|').pop() || null,
    viewShown: !view.classList.contains('hidden'),
    element: media ? media.tagName.toLowerCase() : null,
    src: media ? media.getAttribute('src') : null,
    naturalWidth: media && media.tagName === 'IMG' ? media.naturalWidth : null,
    editorHidden: document.getElementById('monaco-host').classList.contains('editor-covered'),
    noticeShown: !document.getElementById('file-unavailable').classList.contains('hidden'),
  };
};

(async () => {
  await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: ROOT }) }).catch(() => {});
  const imagePath = path.join(ROOT, IMAGE);
  fs.writeFileSync(imagePath, PNG);

  const br = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await br.newPage({ viewport: { width: 1500, height: 900 } });
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  const results = [];
  const check = (label, ok, detail = '') => {
    results.push(ok);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`);
  };

  try {
    await p.goto(`${BASE}/p/${PROJECT}`, { waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => !!window.__td, null, { timeout: 60000 });
    await p.waitForTimeout(3000);

    await p.evaluate(({ root }) => window.__td.openFile(root, 'NOTICE', null, null, { pinned: true }), { root: ROOT });
    await p.waitForTimeout(2000);

    await p.evaluate(({ root, name }) => window.__td.openFile(root, name, null, null, { pinned: true }), { root: ROOT, name: IMAGE });
    await p.waitForTimeout(2500);
    const image = await p.evaluate(snap);
    check('an image opens as a picture, not a failed read',
      image.viewShown && image.element === 'img' && !image.noticeShown, JSON.stringify(image));
    check('and the bytes actually decoded', image.naturalWidth > 0, String(image.naturalWidth));

    // Video: the element is enough -- decoding a real file in headless SwiftShader is not the point.
    const video = fs.existsSync(path.join(ROOT, 'docs/media/demo-terminals.webm'));
    if (video) {
      await p.evaluate(({ root }) => window.__td.openFile(root, 'docs/media/demo-terminals.webm', null, null, { pinned: true }), { root: ROOT });
      await p.waitForTimeout(2500);
      const clip = await p.evaluate(snap);
      check('a video opens in a player', clip.viewShown && clip.element === 'video', JSON.stringify(clip));
    }

    // Back to a text file: the editor comes back and the preview goes away with its stream.
    await p.evaluate(({ root }) => window.__td.openFile(root, 'NOTICE', null, null, { pinned: true }), { root: ROOT });
    await p.waitForTimeout(2500);
    const text = await p.evaluate(snap);
    check('a text file takes the panel back', !text.viewShown && !text.editorHidden && text.element === null,
      JSON.stringify(text));

    const statuses = await p.evaluate(async ({ root }) => {
      const ask = async (file) => (await fetch(`/api/files/media?root=${encodeURIComponent(root)}&path=${encodeURIComponent(file)}`)).status;
      return { html: await ask('README.md'), escape: await ask('../../../../etc/hosts'), missing: await ask('nope.png') };
    }, { root: ROOT });
    check('the endpoint refuses a document type', statuses.html === 415, String(statuses.html));
    check('the endpoint refuses a path outside the root', statuses.escape === 403, String(statuses.escape));
    check('and reports a missing file as missing', statuses.missing === 404, String(statuses.missing));
  } finally {
    fs.rmSync(imagePath, { force: true });
    await br.close();
  }
  console.log('\n  errors:', errors.length ? errors : 'none');
  process.exit(results.every(Boolean) && !errors.length ? 0 : 1);
})();
