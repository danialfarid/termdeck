// Reproduce Safari behaviour with WebKit: does the wheel scroll at all, and does the view survive
// being dragged to the bottom?
const { webkit } = require('playwright');
const ID = process.argv[2];
(async () => {
  const br = await webkit.launch({ headless: true });
  const p = await br.newPage({ viewport: { width: 1600, height: 1000 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:8530/p/stock', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(9000);
  await p.evaluate(i => window.__td.activate(i), ID);
  await p.waitForTimeout(9000);

  const st = async () => p.evaluate(i => {
    const v = window.__td.views.get(i); if (!v) return { noView: true };
    const b = v.term.buffer.active;
    let last = -1; for (let y=b.length-1;y>=0;y--) if((b.getLine(y)?.translateToString(true)||'').trim()){last=y;break;}
    return { top: Math.round(v.container.scrollTop), ceiling: v.tallMaxScrollTop,
             scrollH: v.container.scrollHeight, clientH: v.container.clientHeight,
             innerH: v.container.querySelector('.term-inner')?.offsetHeight,
             cols: v.term.cols, rows: v.term.rows, lastContent: last,
             following: v.tallFollowing, cell: v.term._core?._renderService?.dimensions?.css?.cell?.height };
  }, ID);

  console.log('initial:', JSON.stringify(await st()));
  const box = await p.locator('.term-container.visible').boundingBox();
  await p.mouse.move(box.x + box.width/2, box.y + box.height/2);
  await p.mouse.wheel(0, -1200);
  await p.waitForTimeout(900);
  console.log('after wheel up 1200:', JSON.stringify(await st()));
  await p.mouse.wheel(0, 2400);
  await p.waitForTimeout(900);
  console.log('after wheel down 2400:', JSON.stringify(await st()));
  console.log('page errors:', errs.length ? [...new Set(errs)].slice(0,3) : 'none');
  await br.close();
})();
