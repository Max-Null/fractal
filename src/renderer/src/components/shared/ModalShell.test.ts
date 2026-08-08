// ModalShell 宽度自定义 prop 测试：width 覆盖 size 预设、缺省回退 size 类
import { describe, it, expect, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import ModalShell from "./ModalShell.vue";

// ModalShell 模板使用 $t（关闭按钮 title 等）——测试需 i18n plugin
const i18n = createI18n({
  legacy: false,
  locale: "en",
  messages: { en: { modal: { close: "Close" } } },
});

// 真实 Teleport 渲染到 body：用 document 查询面板（stub teleport 会让 find 拿不到子内容）
function mountShell(props: Record<string, unknown> = {}) {
  return mount(ModalShell, {
    props: { open: true, ...props },
    global: { plugins: [i18n] },
  });
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ModalShell width prop", () => {
  it("传 width 时面板 style.width 生效（覆盖 size 预设）", () => {
    mountShell({ size: "xl", width: "min(60vw, 960px)" });
    const panel = document.querySelector(".modal-shell-panel") as HTMLElement | null;
    expect(panel).toBeTruthy();
    // Vue 用 CSSOM 设置内联样式（setProperty）——jsdom 下读 style.width，不用 getAttribute
    expect(panel?.style.width).toBe("min(60vw, 960px)");
  });

  it("不传 width 时不附加 style（回退 size 类宽）", () => {
    mountShell({ size: "xl" });
    const panel = document.querySelector(".modal-shell-panel") as HTMLElement | null;
    expect(panel).toBeTruthy();
    expect(panel?.style.width).toBe("");
    expect(panel?.classList.contains("modal-shell-panel--xl")).toBe(true);
  });
});
