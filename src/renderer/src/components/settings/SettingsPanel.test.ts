import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { createI18n } from "vue-i18n";
import type { Pinia } from "pinia";
import { useSettingsStore } from "@/stores/settings";
import SettingsPanel from "./SettingsPanel.vue";

const i18n = createI18n({
  legacy: false,
  locale: "en",
  messages: {
    en: {
      settings: {
        title: "Settings",
        engineTitle: "Engine Settings",
        uiTitle: "Interface Settings",
        baseUrl: "API Base URL",
        apiKey: "API Key",
        model: "Model",
        test: "Test Connection",
        testing: "Testing…",
        language: "Language",
        theme: "Theme",
        defaultMode: "Permission Mode",
        defaultEffort: "Effort Level",
        themeDark: "Dark",
        themeLight: "Light",
        themeSystem: "System",
        provider: "Provider",
        fontSize: "Font Size",
        fontSizeSmall: "Small",
        fontSizeMedium: "Medium",
        fontSizeLarge: "Large",
        llmApiUrl: "LLM API URL",
        llmApiUrlPlaceholder: "Full URL",
        llmApiUrlLookup: "Lookup",
        changelog: "Changelog",
        contextLimit: "Context Limit",
        contextLimitPlaceholder: "0=auto, accepts 128K / 1M",
      },
      mode: {
        askBefore: "Ask before edits", editAuto: "Edit auto",
        plan: "Plan mode", auto: "Auto mode",
        bypass: "Bypass", dontAsk: "Don't Ask",
        effort: { low: "Low", medium: "Med", high: "High", xhigh: "XHigh", max: "Max", ultracode: "Ultra" },
      },
      app: { title: "Fractal" },
    },
  },
});

const mockRouter = { push: () => {}, currentRoute: { value: { path: "/settings" } } };

let pinia: Pinia;

function mountPanel() {
  return mount(SettingsPanel, {
    global: {
      plugins: [pinia, i18n],
      provide: { router: mockRouter },
    },
  });
}

describe("SettingsPanel", () => {
  beforeEach(() => {
    localStorage.clear();
    pinia = createPinia();
    setActivePinia(pinia);
  });

  // ── activeMode computed (bridges planMode / autoMode / permissionMode) ──

  it("shows plan label when planMode=true", () => {
    const settings = useSettingsStore();
    settings.planMode = true;
    settings.autoMode = false;
    const wrapper = mountPanel();
    expect(wrapper.text()).toContain("Plan mode");
  });

  it("shows auto label when autoMode=true", () => {
    const settings = useSettingsStore();
    settings.autoMode = true;
    settings.planMode = false;
    const wrapper = mountPanel();
    expect(wrapper.text()).toContain("Auto mode");
  });

  it("shows bypass when permissionMode=bypassPermissions", () => {
    const settings = useSettingsStore();
    settings.permissionMode = "bypassPermissions";
    settings.autoMode = false;
    settings.planMode = false;
    const wrapper = mountPanel();
    expect(wrapper.text()).toContain("Bypass");
  });

  it("shows dontAsk when permissionMode=dontAsk", () => {
    const settings = useSettingsStore();
    settings.permissionMode = "dontAsk";
    settings.autoMode = false;
    settings.planMode = false;
    const wrapper = mountPanel();
    expect(wrapper.text()).toContain("Don't Ask");
  });

  it("shows editAuto when permissionMode=acceptEdits", () => {
    const settings = useSettingsStore();
    settings.permissionMode = "acceptEdits";
    settings.autoMode = false;
    settings.planMode = false;
    const wrapper = mountPanel();
    expect(wrapper.text()).toContain("Edit auto");
  });

  it("shows askBefore when permissionMode=default", () => {
    const settings = useSettingsStore();
    settings.permissionMode = "default";
    settings.autoMode = false;
    settings.planMode = false;
    const wrapper = mountPanel();
    expect(wrapper.text()).toContain("Ask before edits");
  });

  // ── Effort ──

  it("shows current effort level", () => {
    const settings = useSettingsStore();
    settings.effort = "max";
    const wrapper = mountPanel();
    expect(wrapper.text()).toContain("Max");
  });

  // ── Dropdown triggers ──

  it("has settings dropdown triggers", () => {
    const wrapper = mountPanel();
    const triggers = wrapper.findAll(".settings-dropdown");
    expect(triggers.length).toBe(6); // model + lang + theme + font + perm + effort
  });

  // ── Layout ──

  it("renders both sections", () => {
    const wrapper = mountPanel();
    expect(wrapper.text()).toContain("Engine Settings");
    expect(wrapper.text()).toContain("Interface Settings");
  });

  it("renders about footer", () => {
    const wrapper = mountPanel();
    expect(wrapper.text()).toContain("Fractal");
    // 版本号来自 vitest define __APP_VERSION__（package.json version），不写死具体版本
    expect(wrapper.text()).toContain(`v${__APP_VERSION__}`);
  });

  // ── Connection test ──

  it("shows test connection button", () => {
    const wrapper = mountPanel();
    expect(wrapper.text()).toContain("Test Connection");
  });

  it("contextLimit input accepts 128K shorthand", async () => {
    const settings = useSettingsStore();
    const wrapper = mountPanel();
    const input = wrapper.find("input[type=\"text\"]");
    // 找到 contextLimit 输入框（placeholder 匹配）
    const allInputs = wrapper.findAll("input[type=\"text\"]");
    const clInput = allInputs.find(el => (el.element as HTMLInputElement).placeholder.includes("128K"));
    expect(clInput).toBeTruthy();
    if (clInput) {
      await clInput.setValue("128K");
      await clInput.trigger("blur");
      expect(settings.contextLimit).toBe(128000);
    }
  });

  it("contextLimit defaults to 0", () => {
    const settings = useSettingsStore();
    expect(settings.contextLimit).toBe(0);
  });
});
