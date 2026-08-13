// SettingsSection：设置页区块容器测试（标题 + 默认 slot）
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import SettingsSection from "./SettingsSection.vue";

describe("SettingsSection", () => {
  it("渲染标题", () => {
    const w = mount(SettingsSection, { props: { title: "通用" } });
    expect(w.text()).toContain("通用");
  });

  it("默认 slot 渲染区块内容", () => {
    const w = mount(SettingsSection, {
      props: { title: "通用" },
      slots: { default: '<div class="section-content">内容</div>' },
    });
    expect(w.find(".section-content").exists()).toBe(true);
  });
});
