// SettingsSelect：通用下拉组件测试（渲染 + 展开 + v-model + disabled）
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import SettingsSelect from "./SettingsSelect.vue";

// 选项结构：value=存储值 / label=显示文案 / desc=可选副文案
const options = [
  { value: "dark", label: "深色" },
  { value: "light", label: "浅色" },
  { value: "system", label: "跟随系统", desc: "跟随操作系统外观" },
];

describe("SettingsSelect", () => {
  it("渲染 label 与当前选中项文案（modelValue 匹配的选项 label）", () => {
    const w = mount(SettingsSelect, { props: { label: "主题", modelValue: "dark", options } });
    expect(w.text()).toContain("主题");
    expect(w.find(".settings-select__value").text()).toBe("深色");
  });

  it("modelValue 无匹配选项 → 显示原值兜底", () => {
    const w = mount(SettingsSelect, { props: { label: "主题", modelValue: "unknown", options } });
    expect(w.find(".settings-select__value").text()).toBe("unknown");
  });

  it("点击触发器展开选项列表，desc 副文案一并渲染", async () => {
    const w = mount(SettingsSelect, { props: { label: "主题", modelValue: "dark", options } });
    await w.find(".settings-select__trigger").trigger("click");
    const items = w.findAll(".settings-select__item");
    expect(items).toHaveLength(3);
    expect(w.text()).toContain("跟随操作系统外观");
  });

  it("选中项带 accent 高亮类（--selected）", async () => {
    const w = mount(SettingsSelect, { props: { label: "主题", modelValue: "light", options } });
    await w.find(".settings-select__trigger").trigger("click");
    const selected = w.find(".settings-select__item--selected");
    expect(selected.exists()).toBe(true);
    expect(selected.text()).toContain("浅色");
  });

  it("点击选项 emit update:modelValue 并关闭列表", async () => {
    const w = mount(SettingsSelect, { props: { label: "主题", modelValue: "dark", options } });
    await w.find(".settings-select__trigger").trigger("click");
    await w.findAll(".settings-select__item")[1]!.trigger("click");
    expect(w.emitted("update:modelValue")).toEqual([["light"]]);
    expect(w.find(".settings-select__menu").exists()).toBe(false);
  });

  it("disabled 时点击不展开（禁用态不可交互）", async () => {
    const w = mount(SettingsSelect, { props: { label: "主题", modelValue: "dark", options, disabled: true } });
    await w.find(".settings-select__trigger").trigger("click");
    expect(w.find(".settings-select__menu").exists()).toBe(false);
  });
});
