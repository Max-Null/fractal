// 临时诊断：正式环境点击最近使用非当前项 → 检查 dialog.log 是否有 [openWorkspace]
const { _electron } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

(async () => {
  const logFile = path.join(process.env.APPDATA || os.homedir(), 'oc-gui', 'dialog.log');
  const before = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').length : 0;

  const app = await _electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    env: { ...process.env, OC_GUI_E2E_SHARE: '1', OC_GUI_E2E: '1' },
    timeout: 30000,
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(6000); // 等引擎/渲染就绪

  // 点击工作区胶囊（.ws-pill）
  const pill = win.locator('.ws-pill');
  await pill.click({ timeout: 10000 });
  await win.waitForTimeout(800);

  // 读取菜单项（文本以 H:\ 开头）
  const items = win.locator('.ws-menu-item');
  const count = await items.count();
  console.log('MENU_ITEMS=' + count);
  let clicked = null;
  for (let i = 0; i < count; i++) {
    const txt = (await items.nth(i).textContent()).trim();
    console.log('  item[' + i + ']=' + txt);
  }
  // 点第一个非当前项（文本含 doc-edit 或 stage0）
  for (let i = 0; i < count; i++) {
    const txt = (await items.nth(i).textContent()).trim();
    if (txt.includes('doc-edit') || txt.includes('stage0')) { clicked = txt; await items.nth(i).click(); break; }
  }
  console.log('CLICKED=' + clicked);
  await win.waitForTimeout(3000);

  // 检查 dialog.log 增量
  const after = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').length : 0;
  const lines = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n') : [];
  console.log('LOG_BEFORE=' + before + ' AFTER=' + after);
  for (let i = before; i < after && i < lines.length; i++) console.log('LOG: ' + lines[i]);

  // 窗口数量（新窗口可见性）
  const wins = app.windows();
  console.log('WINDOWS=' + wins.length);
  for (const w of wins) {
    console.log('  win visible=' + await w.evaluate(() => document.visibilityState) + ' title=' + await w.title());
  }

  await app.close();
})().catch(e => { console.error('DIAG_ERROR', e); process.exit(1); });
