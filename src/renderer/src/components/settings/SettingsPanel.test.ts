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
        engineVersion: "OC Engine",
        presetVersion: "Preset",
        contextLimit: "Context Limit",
        contextLimitPlaceholder: "0=auto, accepts 128K / 1M",
      },
      mode: {
        askBefore: "Ask before edits", editAuto: "Edit auto",
        plan: "Plan mode", auto: "Auto mode",
        bypass: "Bypass", dontAsk: "Don't Ask",
        effort: { low: "Low", high: "High", max: "Max" },
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
  beforeEach(async () => {
    localStorage.clear();
    // mock electronBridge：默认模型（flash）variants 返回 3 档——
    // store 的 watch(model, immediate) 经此拉取，effort 下拉显示、触发器计数保持 6；
    // app:getInfo 返回三版本（关于区 onMounted 异步拉取）
    (window as unknown as { electronBridge: { invoke: (c: string, a?: unknown) => Promise<unknown>; on: () => () => void } }).electronBridge = {
      invoke: (channel: string) => {
        if (channel === "provider:modelVariants") return Promise.resolve(["low", "high", "max"]);
        if (channel === "app:getInfo") return Promise.resolve({ name: "Fractal", version: "1.2.3", engineVersion: "1.18.15", presetVersion: "1.1.0" });
        return Promise.resolve({});
      },
      on: () => () => {},
    };
    pinia = createPinia();
    setActivePinia(pinia);
    useSettingsStore(); // 触发 watch immediate 拉取
    // flush 微任务：让 watch 的 async continuation 完成（modelVariants = ['low','high','max']）
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  // ── activeMode computed (bridges planMode / autoMode / permissionMode) ──

  it("shows plan label when planMode=true", () => {
    const settings = useSettingsStore();
    settings.planMode = true;
    settings.autoMode = false;
    const wrapper = mountPanel();
    expect(wrapper.text()).toContain("Plan mode");
  });

  // auto/dontAsk 已从权限选项移除（CC 遗留模式，全自动语义由 bypassPermissions 承担）——
  // 旧配置兼容：autoMode=true 仍应显示「完全放行」（activeMode 映射 bypassPermissions 分支）
  it("shows bypass label when autoMode=true (legacy auto 兼容)", () => {
    const settings = useSettingsStore();
    settings.autoMode = true;
    settings.planMode = false;
    settings.permissionMode = "bypassPermissions";
    const wrapper = mountPanel();
    expect(wrapper.text()).toContain("Bypass");
  });

  it("shows bypass when permissionMode=bypassPermissions", () => {
    const settings = useSettingsStore();
    settings.permissionMode = "bypassPermissions";
    settings.autoMode = false;
    settings.planMode = false;
    const wrapper = mountPanel();
    expect(wrapper.text()).toContain("Bypass");
  });

  // dontAsk 已移除：dontAsk 旧值兼容归入 bypass（activeMode 映射）
  it("shows bypass when permissionMode=dontAsk (legacy 兼容)", () => {
    const settings = useSettingsStore();
    settings.permissionMode = "dontAsk";
    settings.autoMode = false;
    settings.planMode = false;
    const wrapper = mountPanel();
    expect(wrapper.text()).toContain("Bypass");
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

  it("renders about footer with three version lines", async () => {
    const wrapper = mountPanel();
    // flush onMounted 的异步 getAppInfo（invoke mock 返回三版本）
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(wrapper.text()).toContain("Fractal");
    // 版本号来自 vitest define __APP_VERSION__（package.json version），不写死具体版本
    expect(wrapper.text()).toContain(`v${__APP_VERSION__}`);
    // v1.1.0 新增：OC 引擎版本 + 预置包版本（标签 + 值）
    expect(wrapper.text()).toContain("OC Engine 1.18.15");
    expect(wrapper.text()).toContain("Preset 1.1.0");
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
