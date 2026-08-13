import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { createI18n } from "vue-i18n";
import type { Pinia } from "pinia";
import { useSettingsStore } from "@/stores/settings";
import SettingsPanel from "./SettingsPanel.vue";

// Mock vue-router：useRouter() 用 vue-router 的 Symbol 注入 key，
// provide: { router }（字符串键）无效——必须 mock useRouter 本身（2026-08-10 实测）
const { mockRouter } = vi.hoisted(() => ({
  mockRouter: { push: vi.fn(), currentRoute: { value: { path: "/settings" } } },
}));
vi.mock("vue-router", () => ({ useRouter: () => mockRouter }));

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
        save: "Save",
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
        advanced: "Advanced Settings",
        advancedDesc: "VSCode-style JSONC config",
        dataModeLabel: "Isolated session data",
        dataModeDesc: "When enabled, sessions are stored only in this app's data directory, isolated from other tools",
        dataModeRestarting: "Restarting engine…",
        dataModeDone: "Engine restarted: isolated session data mode",
        dataModeFail: "Engine restart failed, restored original mode",
        smallModel: "Lightweight Model",
        smallModelFollow: "Follow main model (default)",
        smallModelFlash: "deepseek-v4-flash · fast",
        smallModelPro: "deepseek-v4-pro · stronger reasoning",
        smallModelDesc: "Used for lightweight tasks (titles, summaries, message polish); empty = follow main model",
        kimiApiKey: "Multimodal Model (Cartographer) API Key",
        kimiApiKeyDesc: "Used for the cartographer (kimi-k3) multimodal recognition; cartographer unavailable if empty",
        kimiKeySaved: "Saved and engine restarted",
        showKey: "Show API Key",
        hideKey: "Hide API Key",
        messageLayout: "Message Layout",
        layoutLeft: "All left",
        layoutSplit: "Split (me right · AI left)",
        nickname: "Nickname",
        nicknamePlaceholder: "Empty = show \"Me\"",
        avatar: "Avatar",
        avatarPlaceholder: "Empty = show \"Me\"; emoji supported",
        opencodePath: "OC Executable Path",
        opencodePathPlaceholder: "Empty = bundled engine",
        opencodePathDesc: "Full path to opencode.exe; empty = auto-resolve",
        opencodePathPick: "Select opencode executable",
        browseFile: "Browse…",
        logLevel: "Engine Log Level",
        logLevelDesc: "Verbosity of serve output",
        presetSkills: "Preset Skills Pack",
        presetSkillsDesc: "When off, preset skills are not loaded on next start",
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

let pinia: Pinia;

function mountPanel() {
  return mount(SettingsPanel, {
    global: {
      plugins: [pinia, i18n],
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
        // 数据模式切换链路：engine:refresh 成功 + session:list 数组（setDataMode 内部重拉列表）
        if (channel === "engine:refresh") return Promise.resolve({ ok: true });
        if (channel === "session:list") return Promise.resolve([]);
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

  // ── 布局骨架：左侧导航 6 tab ──

  it("renders header with title and back button", () => {
    const wrapper = mountPanel();
    expect(wrapper.text()).toContain("Settings");
    // 返回按钮（aria-label）点击 → router.push('/chat')
    const back = wrapper.find("button[aria-label='返回聊天']");
    expect(back.exists()).toBe(true);
  });

  it("renders 6 nav tabs with lucide icons", () => {
    const wrapper = mountPanel();
    const items = wrapper.findAll(".f-settings-nav-item");
    expect(items.length).toBe(6);
    // 顺序固定：通用/模型与API/AI行为/通知/高级/关于
    expect(items[0].text()).toContain("通用");
    expect(items[1].text()).toContain("模型与API");
    expect(items[2].text()).toContain("AI行为");
    expect(items[3].text()).toContain("通知");
    expect(items[4].text()).toContain("高级");
    expect(items[5].text()).toContain("关于");
    // 每个导航项包含一个 svg（lucide 图标，禁 emoji 图标）
    for (const item of items) {
      expect(item.find("svg").exists()).toBe(true);
    }
  });

  it("defaults to general tab", () => {
    const wrapper = mountPanel();
    // 默认 activeTab = general：v-if/v-else-if 链只渲染当前 section
    expect(wrapper.find("[data-tab='general']").exists()).toBe(true);
    expect(wrapper.find("[data-tab='model']").exists()).toBe(false);
  });

  it("switching tab renders correct content section", async () => {
    const wrapper = mountPanel();
    const items = wrapper.findAll(".f-settings-nav-item");
    // 依次点每个 tab → 对应 data-tab section 变为可见
    const targets = ["general", "model", "behavior", "notify", "advanced", "about"] as const;
    for (let i = 0; i < targets.length; i++) {
      await items[i].trigger("click");
      expect(wrapper.find(`[data-tab='${targets[i]}']`).exists()).toBe(true);
      // 其余 tab 隐藏（v-if/v-else-if 结构：只有当前 section 渲染内容，占位 text 只出现在当前）
      expect(wrapper.find(".f-settings-tab-placeholder").text()).toContain(
        i === 0 ? "通用" : i === 1 ? "模型与 API" : i === 2 ? "AI 行为" : i === 3 ? "通知" : i === 4 ? "高级" : "关于",
      );
    }
  });

  it("active nav item gets active class", async () => {
    const wrapper = mountPanel();
    const items = wrapper.findAll(".f-settings-nav-item");
    expect(items[0].classes()).toContain("f-settings-nav-item--active");
    await items[2].trigger("click");
    expect(items[2].classes()).toContain("f-settings-nav-item--active");
    expect(items[0].classes()).not.toContain("f-settings-nav-item--active");
  });

  it("keeps balance/effort/mode logic wired (settings store loaded)", () => {
    // 骨架阶段 store 逻辑仍可用：modelVariants 已拉取（effort 下拉在 AI行为 tab 填充后展示）
    const settings = useSettingsStore();
    expect(settings.modelVariants).toEqual(["low", "high", "max"]);
    expect(settings.currentAgent).toBe("双星");
  });
});
