import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import ModeBar from "./ModeBar.vue";
import { useSettingsStore } from "@/stores/settings";

const i18n = createI18n({
  legacy: false,
  locale: "en",
  messages: {
    en: {
      mode: {
        askBefore: "Ask",
        editAuto: "Edit",
        plan: "Plan",
        auto: "Auto",
        effort: { low: "Low", medium: "Med", high: "High", xhigh: "XHigh", max: "Max", ultracode: "Ultra" },
      },
    },
    zh: {
      mode: {
        askBefore: "询问",
        editAuto: "编辑",
        plan: "计划",
        auto: "自动",
        effort: { low: "低", medium: "中", high: "高", xhigh: "极高", max: "最大", ultracode: "极高级" },
      },
    },
  },
});

describe("ModeBar", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it("renders all 4 mode labels", () => {
    const wrapper = mount(ModeBar, { global: { plugins: [i18n] } });
    expect(wrapper.text()).toContain("Ask");
    expect(wrapper.text()).toContain("Edit");
    expect(wrapper.text()).toContain("Plan");
    expect(wrapper.text()).toContain("Auto");
  });

  it("renders effort select", () => {
    const wrapper = mount(ModeBar, { global: { plugins: [i18n] } });
    const select = wrapper.find("select");
    expect(select.exists()).toBe(true);
  });

  it("selecting a mode updates settings", async () => {
    const wrapper = mount(ModeBar, { global: { plugins: [i18n] } });
    const settings = useSettingsStore();

    // Click "Plan" radio
    const planInput = wrapper.find("input[value='plan']");
    await planInput.setValue(true);

    expect(settings.planMode).toBe(true);
    expect(settings.autoMode).toBe(false);
  });

  it("selecting auto mode updates settings", async () => {
    const wrapper = mount(ModeBar, { global: { plugins: [i18n] } });
    const settings = useSettingsStore();

    const autoInput = wrapper.find("input[value='auto']");
    await autoInput.setValue(true);

    expect(settings.autoMode).toBe(true);
    expect(settings.planMode).toBe(false);
  });

  it("selecting editAuto sets permissionMode to acceptEdits", async () => {
    const wrapper = mount(ModeBar, { global: { plugins: [i18n] } });
    const settings = useSettingsStore();

    const editInput = wrapper.find("input[value='editAuto']");
    await editInput.setValue(true);

    expect(settings.permissionMode).toBe("acceptEdits");
    expect(settings.planMode).toBe(false);
    expect(settings.autoMode).toBe(false);
  });

  it("changing effort via select updates settings", async () => {
    const wrapper = mount(ModeBar, { global: { plugins: [i18n] } });
    const settings = useSettingsStore();

    const select = wrapper.find("select");
    await select.setValue("ultracode");
    expect(settings.effort).toBe("ultracode");

    await select.setValue("low");
    expect(settings.effort).toBe("low");
  });
});
