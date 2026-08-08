const { _electron } = require('playwright');
(async () => {
  const app = await _electron.launch({ args: ['out/main/index.js'], cwd: 'H:\\MaxNull\\WorkStation\\fractal', env: { ...process.env, OC_GUI_E2E: '1', OC_GUI_E2E_SHARE: '1' } });
  const win = await app.firstWindow();
  await win.waitForTimeout(9000);
  // 点击展开按钮（rail »）——若无则跳过
  const clicked = await win.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    const b = btns.find(x => x.textContent.trim() === '»' || x.textContent.includes('»'));
    if (b) { b.click(); return true; }
    return false;
  });
  await win.waitForTimeout(2500);
  const state = await win.evaluate(() => {
    const items = document.querySelectorAll('[class*="session-item"], [class*="sessionItem"], [class*="f-session"]').length;
    const aside = document.querySelector('aside');
    const text = aside ? aside.innerText.slice(0, 600) : '';
    return { items, text };
  });
  console.log('DIAG2 ' + JSON.stringify({ clicked, ...state }, null, 1));
  await app.close();
  process.exit(0);
})().catch(e => { console.error('DIAG_ERR', e); process.exit(1); });
