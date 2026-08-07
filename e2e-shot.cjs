// 视觉验收截图 v2：先展开侧栏，截 3 张关键界面
const { _electron } = require("playwright");
(async () => {
  const app = await _electron.launch({
    args: ["."],
    env: { ...process.env, OC_GUI_E2E: "1", OC_GUI_E2E_SHARE: "1" },
  });
  const win = await app.firstWindow();
  await win.waitForTimeout(20000);

  // 展开侧栏（若折叠）：rail 展开按钮「»」
  await win.evaluate(() => {
    const btn = document.querySelector(".rail-expand-btn");
    if (btn) btn.click();
  });
  await win.waitForTimeout(600);

  await win.screenshot({ path: "shot-main.png" });

  await win.evaluate(() => {
    const sel = [...document.querySelectorAll(".composer-select")].find(e => (e.getAttribute("title") || "").includes("权限"));
    if (sel) sel.click();
  });
  await win.waitForTimeout(400);
  await win.screenshot({ path: "shot-perm.png" });

  await win.evaluate(() => {
    document.body.click();
    const gear = document.querySelector("[title*='设置'], .icon-btn:last-child");
    if (gear) gear.click();
  });
  await win.waitForTimeout(1500);
  await win.screenshot({ path: "shot-settings.png" });

  console.log("OK: shot-main / shot-perm / shot-settings");
  await app.close();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
