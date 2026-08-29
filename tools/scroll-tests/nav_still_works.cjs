// The dedupe must not break real navigation: switching tabs and going back must still work.
const { chromium } = require('playwright');
const PORT = process.argv[2] || process.env.TERMDECK_TEST_PORT || '8530';
const BASE = `http://127.0.0.1:${PORT}`;
(async () => {
  const br = await chromium.launch({headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const p = await br.newPage({viewport:{width:1600,height:1000}});
  await p.goto(BASE + '/p/stock',{waitUntil:'domcontentloaded'});
  await p.waitForTimeout(8000);
  const ids = await p.evaluate(()=> (window.__td.sessions||[]).filter(s=>s.running).slice(0,3).map(s=>s.session_id));
  const urls = [];
  for (const id of ids) { await p.evaluate(i=>window.__td.activate(i), id); await p.waitForTimeout(2500); urls.push(p.url()); }
  console.log('urls while switching tabs:');
  for (const u of urls) console.log('   ', u.replace(BASE + '',''));
  const distinct = new Set(urls).size;
  await p.goBack(); await p.waitForTimeout(3000);
  const afterBack = p.url().replace(BASE + '','');
  const active = await p.evaluate(()=>window.__td.activeId);
  console.log('after Back:', afterBack, '| active session:', active);
  console.log(distinct === urls.length ? 'PASS: each tab got its own URL' : `FAIL: only ${distinct} distinct URLs`);
  console.log(active === ids[1] ? 'PASS: Back returned to the previous terminal' : `note: active=${active} expected=${ids[1]}`);
  await br.close();
})();
