const { chromium } = require('playwright');
(async () => {
  const br = await chromium.launch({ headless:true, args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const p = await br.newPage({ viewport:{width:1400,height:850}});
  const errs=[]; p.on('pageerror', e=>errs.push(e.message + '\n   ' + (e.stack||'').split('\n')[1]));
  await p.goto('http://127.0.0.1:8536/p/height-probe-root',{waitUntil:'domcontentloaded'});
  await p.waitForTimeout(7000);
  console.log('errors before click:', errs.length ? '\n  '+[...new Set(errs)].slice(0,3).join('\n  ') : ' none');
  errs.length = 0;
  await p.click('#settings-gear');
  await p.waitForTimeout(1500);
  const info = await p.evaluate(() => {
    const pop = document.querySelector('.settings-popover, #settings-popover') ||
      [...document.querySelectorAll('div')].find(d => d.className && String(d.className).includes('popover'));
    if (!pop) return { found:false };
    const r = pop.getBoundingClientRect();
    return { found:true, rows: pop.querySelectorAll('.settings-row').length,
             visible: r.width>0 && r.height>0, w:Math.round(r.width), h:Math.round(r.height),
             display: getComputedStyle(pop).display, hidden: pop.classList.contains('hidden') };
  });
  console.log('popover:', JSON.stringify(info));
  console.log('errors on click:', errs.length ? '\n  '+[...new Set(errs)].slice(0,3).join('\n  ') : ' none');
  await p.screenshot({path:'settings_open.png'});
  await br.close();
})();
