// 临时诊断 v12：权限下拉选项数 + variant 选择器（用完即删）
const { _electron } = require("playwright");
(async () => {
  const app = await _electron.launch({ args: ["."], env: { ...process.env, OC_GUI_E2E: "1" } });
  const win = await app.firstWindow();
  await win.waitForTimeout(20000); // 等 serve 就绪 + engine:status 重拉
  const info = await win.evaluate(async () => {
    const q = (s) => document.querySelector(s);
    const effortSel = q(".composer-select[title*='思考']") || q(".composer-select[title*='effort']") || q(".composer-select[title*='推理']");
    // 权限选择器：找 title 含 权限 的元素
    const permSel = q(".composer-select[title*='权限']");
    let permOptions = null;
    if (permSel) {
      permSel.click();
      await new Promise((r) => setTimeout(r, 200));
      permOptions = [...document.querySelectorAll(".dropdown-item")].map((b) => b.textContent.trim());
    }
    return {
      effortSelVisible: !!effortSel,
      effortText: effortSel ? effortSel.textContent.trim() : null,
      permText: permSel ? permSel.textContent.trim() : null,
      permOptions,
    };
  });
  console.log("UI:", JSON.stringify(info, null, 2));
  await app.close();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
