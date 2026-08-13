// SettingsToggle：通用开关组件测试（渲染 + aria-pressed + v-model + disabled）
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import SettingsToggle from "./SettingsToggle.vue";

describe("SettingsToggle", () => {
  it("渲染 label 与 desc", () => {
    const w = mount(SettingsToggle, {
      props: { label: "思考节点", desc: "时间线显示思考过程", modelValue: true },
    });
    expect(w.text()).toContain("思考节点");
    expect(w.text()).toContain("时间线显示思考过程");
  });

  it("aria-pressed 反映 modelValue（供测试与无障碍使用）", async () => {
    const w = mount(SettingsToggle, { props: { label: "思考节点", modelValue: true } });
    expect(w.find("button").attributes("aria-pressed")).toBe("true");
    await w.setProps({ modelValue: false });
    expect(w.find("button").attributes("aria-pressed")).toBe("false");
  });

  it("点击 emit update:modelValue（取反）", async () => {
    const w = mount(SettingsToggle, { props: { label: "思考节点", modelValue: true } });
    await w.find("button").trigger("click");
    expect(w.emitted("update:modelValue")).toEqual([[false]]);
  });

  it("disabled 时点击不 emit", async () => {
    const w = mount(SettingsToggle, { props: { label: "思考节点", modelValue: true, disabled: true } });
    await w.find("button").trigger("click");
    expect(w.emitted("update:modelValue")).toBeUndefined();
  });
});
