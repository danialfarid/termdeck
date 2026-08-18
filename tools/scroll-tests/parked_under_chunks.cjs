// A parked reader must not be dragged along by output arriving below them.
//
// Reported after line-by-line output was already holding still: with an agent writing in big chunks, a
// reader parked two or three pages up gets pushed toward the bottom -- "I'm in the middle of the third
// page and it becomes the third page from the bottom". The same terminal printing numbers one at a time
// does not do it, so the size of a single write is the variable, and this drives both.
//
//   node tools/scroll-tests/parked_under_chunks.cjs [port]
const { chromium } = require('playwright');
const PORT = process.argv[2] || '8536';
const BASE = `http://127.0.0.1:${PORT}`;

const READ = (i) => {
  const v = window.__td.views.get(i);
  const b = v.term.buffer.active;
  const cell = v.term._core?._renderService?.dimensions?.css?.cell?.height || 21;
  const row = b.viewportY + Math.round(v.container.scrollTop / cell);
  return {
    top: Math.round(v.container.scrollTop), row,
    text: (b.getLine(row)?.translateToString(true) || '').trim().slice(0, 40),
    viewportY: b.viewportY, baseY: b.baseY, len: b.length,
    following: v.tallFollowing, pinned: v.tallPinnedViewportY,
  };
};

(async () => {
  const id = (await fetch(`${BASE}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'none', permission: 'default',
      cwd: '/Users/dan/workspace/height-probe-root', title: 'parked-under-chunks' }),
  }).then((r) => r.json())).session_id;

  const br = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await br.newPage({ viewport: { width: 1400, height: 850 } });
  await p.goto(`${BASE}/p/height-probe-root`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3000);
  await p.evaluate((i) => window.__td.activate(i), id);
  await p.waitForTimeout(2500);

  const send = (t) => p.evaluate(({ i, s }) => window.__td.sendInput(window.__td.views.get(i), s), { i: id, s: t });

  // Fill past the scrollback cap first. That is the condition the fault needs: once the buffer is full,
  // every new line trims one off the start and renumbers every row, which is what makes a row index stop
  // meaning anything. Line-at-a-time output reaches this eventually too -- chunks just get there in
  // seconds instead of an hour, which is why it looked like a chunk-size problem.
  await send('clear; seq 1 21000 | sed "s/^/history /"\n');
  for (let k = 0; k < 60; k += 1) {
    const at = await p.evaluate((i) => window.__td.views.get(i).term.buffer.active.baseY, id);
    if (at >= 20000) break;
    await p.waitForTimeout(1000);
  }
  await p.waitForTimeout(3000);

  const box = await p.evaluate((i) => {
    const r = window.__td.views.get(i).container.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, id);
  await p.mouse.move(box.x, box.y);
  for (let n = 0; n < 12; n += 1) { await p.mouse.wheel(0, -300); await p.waitForTimeout(50); }
  await p.waitForTimeout(1200);

  const parked = await p.evaluate(READ, id);
  console.log('parked at:', JSON.stringify(parked));
  if (parked.following !== false) { console.log('\nDID NOT PARK -- nothing to measure.'); await br.close(); process.exit(2); }

  // Big chunks: whole blocks land in single writes, the way an agent repaints. Deliberately far fewer
  // lines than the scrollback holds, so the reader's own line is never legitimately trimmed away -- if it
  // moves, it moved because of us.
  await send('for i in $(seq 1 10); do seq 1 400 | sed "s/^/chunk /"; sleep 0.6; done\n');

  const samples = [];
  const started = Date.now();
  while (Date.now() - started < 14000) {
    samples.push(await p.evaluate(READ, id));
    await p.waitForTimeout(250);
  }
  await send('\x03');
  await p.waitForTimeout(800);

  const moved = samples.filter((s, i) => i > 0 && s.text !== samples[i - 1].text);
  const grew = samples[samples.length - 1].baseY - parked.baseY;
  const trimmed = samples.some((s, i) => i > 0 && s.len === samples[i - 1].len && s.viewportY < samples[i - 1].viewportY);
  console.log(`\noutput while parked: baseY ${parked.baseY} -> ${samples[samples.length - 1].baseY} (+${grew})`);
  console.log(`buffer at its scrollback cap and trimming: ${trimmed ? 'YES' : 'no'}`);
  console.log(`\nLINE UNDER THE READER changed ${moved.length} times in ${samples.length} samples`);
  for (const s of moved.slice(0, 10)) console.log('   ', JSON.stringify(s));
  console.log('\nfirst:', JSON.stringify(samples[0]));
  console.log('last: ', JSON.stringify(samples[samples.length - 1]));

  const verdict = moved.length === 0;
  console.log(`\n  parked reader held still under chunked output: ${verdict ? 'PASS' : 'FAIL'}`);
  await br.close();
  await fetch(`${BASE}/api/sessions/${id}`, { method: 'DELETE' }).catch(() => {});
  process.exit(verdict ? 0 : 1);
})();
