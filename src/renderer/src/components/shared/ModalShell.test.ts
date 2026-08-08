// ModalShell 宽度自定义 prop 测试：width 覆盖 size 预设、缺省回退 size 类
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import ModalShell from "./ModalShell.vue";

// ModalShell 模板使用 $t（关闭按钮 title 等）——测试需 i18n plugin
const i18n = createI18n({
  legacy: false,
  locale: "en",
  messages: { en: { modal: { close: "Close" } } },
});

function mountShell(props: Record<string, unknown> = {}) {
  return mount(ModalShell, {
    props: { open: true, ...props },
    global: { stubs: { teleport: true }, plugins: [i18n] },
  });
}

describe("ModalShell width prop", () => {
  it("传 width 时面板 style.width 生效（覆盖 size 预设）", () => {
    const wrapper = mountShell({ size: "xl", width: "min(60vw, 960px)" });
    const panel = wrapper.find(".modal-shell-panel");
    expect(panel.attributes("style")).toContain("width: min(60vw, 960px)");
  });

  it("不传 width 时不附加 style（回退 size 类宽）", () => {
    const wrapper = mountShell({ size: "xl" });
    const panel = wrapper.find(".modal-shell-panel");
    expect(panel.attributes("style")).toBeUndefined();
    expect(panel.classes()).toContain("modal-shell-panel--xl");
  });
});
