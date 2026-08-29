// Counts real history writes over 15s on a session whose title is animating (a working agent).
// WebKit's limit is 100 per 10s; anything near that throws and breaks the page.
const { chromium } = require('playwright');
const PORT = process.argv[2] || process.env.TERMDECK_TEST_PORT || '8530';
const BASE = `http://127.0.0.1:${PORT}`;
const ID = process.argv[2];
(async () => {
  const br = await chromium.launch({headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const p = await br.newPage({viewport:{width:1600,height:1000}});
  await p.addInitScript(() => {
    window.__h = { push: 0, replace: 0, urls: new Set(), seq: [] };
    const op = history.pushState.bind(history), or = history.replaceState.bind(history);
    history.pushState = (s, t, u) => { window.__h.push++; window.__h.urls.add(String(u)); return op(s, t, u); };
    history.replaceState = (s, t, u) => { window.__h.replace++; window.__h.urls.add(String(u)); window.__h.seq.push(JSON.stringify(s)+' :: '+String(u)); return or(s, t, u); };
  });
  await p.goto(BASE + '/p/stock',{waitUntil:'domcontentloaded'});
  await p.waitForTimeout(8000);
  await p.evaluate(i=>window.__td.activate(i), ID);
  await p.waitForTimeout(3000);
  const before = await p.evaluate(()=>({...window.__h, urls: [...window.__h.urls]}));
  await p.waitForTimeout(15000);   // sit still on a working agent for 15s
  const after = await p.evaluate(()=>({...window.__h, urls: [...window.__h.urls]}));
  const title = await p.evaluate(i=>{
    const s = window.__td.session(i); return { title: s.title, cli: s.cli_title, processing: s.processing };
  }, ID);
  console.log('session:', JSON.stringify(title));
  console.log(`history writes while sitting still for 15s: push=${after.push-before.push} replace=${after.replace-before.replace}`);
  console.log(`WebKit limit is 100 per 10s -> would be ${((after.push-before.push)+(after.replace-before.replace))/1.5} per 10s`);
  console.log('distinct URLs ever used:', after.urls.length);
  for (const u of after.urls) console.log('   URL:', u);
  const seq = await p.evaluate(()=>window.__h.seq.slice(-6));
  console.log('last replaceState calls:'); for (const s of seq) console.log('   ', s.slice(0,150));
  await br.close();
})();
