const { _electron } = require("playwright");
(async () => {
  const app = await _electron.launch({ args: ["."], env: { ...process.env, OC_GUI_E2E: "1", OC_GUI_E2E_SHARE: "1" }, timeout: 30000 });
  const win = await app.firstWindow();
  await win.waitForTimeout(25000);
  // 展开侧栏
  await win.evaluate(() => { const b = document.querySelector(".rail-expand-btn"); if (b) b.click(); });
  await win.waitForTimeout(600);
  await win.screenshot({ path: "shot-main.png" });
  // 权限下拉
  await win.evaluate(() => {
    const sel = [...document.querySelectorAll(".composer-select")].find(e => (e.getAttribute("title") || "").includes("权限"));
    if (sel) sel.click();
  });
  await win.waitForTimeout(400);
  await win.screenshot({ path: "shot-perm.png" });
  // 设置页
  await win.evaluate(() => {
    document.body.click();
    const gear = document.querySelector("[title*='\u8bbe\u7f6e'], .icon-btn:last-child");
    if (gear) gear.click();
  });
  await win.waitForTimeout(1200);
  await win.screenshot({ path: "shot-settings.png" });
  const labels = await win.evaluate(() => [...document.querySelectorAll("label")].map(l => l.textContent.trim()));
  console.log("设置页 labels 含推理强度:", labels.some(l => l.includes("推理")), "| 权限模式:", labels.some(l => l.includes("权限")));
  console.log("OK 三张截图");
  await app.close();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });