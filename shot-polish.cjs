// 临时截图脚本：启动 app（共享正式 userData）→ 截图 composer 区域 → 关闭
const { _electron } = require('playwright');

(async () => {
  const app = await _electron.launch({
    args: ['.'],
    env: { ...process.env, OC_GUI_E2E_SHARE: '1' },
    cwd: __dirname,
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(6000);
  // 定位 composer 区域（输入行右侧按钮）
  const box = await win.evaluate(() => {
    const bar = document.querySelector('.sb-input-bar');
    if (!bar) return null;
    const r = bar.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  if (box) {
    await win.screenshot({ path: 'shot-composer.png', clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
    console.log('shot-composer.png saved, box=', JSON.stringify(box));
  } else {
    await win.screenshot({ path: 'shot-composer.png' });
    console.log('composer not found, full shot saved');
  }
  await app.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
