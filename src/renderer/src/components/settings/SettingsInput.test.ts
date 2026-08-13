// SettingsInput：通用文本输入组件测试（渲染 + v-model + 透传 + suffix slot）
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import SettingsInput from "./SettingsInput.vue";

describe("SettingsInput", () => {
  it("渲染 label 与输入值", () => {
    const w = mount(SettingsInput, { props: { label: "昵称", modelValue: "小明" } });
    expect(w.text()).toContain("昵称");
    expect((w.find("input").element as HTMLInputElement).value).toBe("小明");
  });

  it("输入触发 update:modelValue", async () => {
    const w = mount(SettingsInput, { props: { label: "昵称", modelValue: "" } });
    await w.find("input").setValue("小明");
    expect(w.emitted("update:modelValue")).toEqual([["小明"]]);
  });

  it("透传 type / placeholder / readonly", () => {
    const w = mount(SettingsInput, {
      props: { label: "路径", modelValue: "", type: "password", placeholder: "输入路径", readonly: true },
    });
    const input = w.find("input").element as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.placeholder).toBe("输入路径");
    expect(input.readOnly).toBe(true);
  });

  it("suffix slot 渲染后缀按钮区（如查询/浏览按钮）", () => {
    const w = mount(SettingsInput, {
      props: { label: "地址", modelValue: "" },
      slots: { suffix: '<button class="suffix-btn">查询</button>' },
    });
    expect(w.find(".suffix-btn").exists()).toBe(true);
  });
});
