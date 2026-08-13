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
        workspaceTitle: "Workspace",
        workspaceLabel: "Current workspace",
        workspacePlaceholder: "Not selected (defaults to user home)",
        workspaceHint: "The AI assistant works in this directory; new sessions take effect after switching",
        logLevel: "Engine Log Level",
        logLevelDesc: "Verbosity of serve output",
        presetSkills: "Preset Skills Pack",
        presetSkillsDesc: "When off, preset skills are not loaded on next start",
      },
      mode: {
        askBefore: "Ask before edits", editAuto: "Edit auto",
        plan: "Plan mode", auto: "Auto mode",
        bypass: "Bypass", dontAsk: "Don't Ask",
        planDesc: "Plan-only mode",
        askBeforeDesc: "Ask before every change",
        editAutoDesc: "Auto-accept file edits",
        bypassDesc: "No permission prompts",
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
        // 头像图片：pick 成功返回文件名（avatarImage 状态写入）；clear 成功返回 ok
        if (channel === "avatar:pick") return Promise.resolve({ ok: true, filename: "avatar.png" });
        if (channel === "avatar:clear") return Promise.resolve({ ok: true });
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
      // 当前 section 渲染内容（占位 text 或真实字段），其余 tab section 不渲染
      for (let j = 0; j < targets.length; j++) {
        if (j === i) continue;
        expect(wrapper.find(`[data-tab='${targets[j]}']`).exists()).toBe(false);
      }
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

  // ── 通用 tab：语言/主题/字号/排布/昵称/头像/工作目录 ──

  it("general tab renders language/theme/font/layout selects and nickname input", () => {
    const wrapper = mountPanel();
    // 默认就在通用 tab
    const tab = wrapper.find("[data-tab='general']");
    expect(tab.text()).toContain("Language");
    expect(tab.text()).toContain("Theme");
    expect(tab.text()).toContain("Font Size");
    expect(tab.text()).toContain("Message Layout");
    expect(tab.text()).toContain("Nickname");
  });

  it("general tab language select switches locale in store", async () => {
    const wrapper = mountPanel();
    const settings = useSettingsStore();
    // 找到语言下拉：settings-field label 为 Language 的触发器
    const fields = wrapper.findAll(".settings-field");
    const langField = fields.find((f) => f.find(".settings-field__label").text() === "Language")!;
    await langField.find(".settings-select__trigger").trigger("click");
    const items = wrapper.findAll(".settings-select__item");
    const enItem = items.find((i) => i.text().includes("English"))!;
    await enItem.trigger("click");
    expect(settings.locale).toBe("en");
  });

  it("avatar pick button calls store pickAvatar and shows avatarImage status", async () => {
    const wrapper = mountPanel();
    const settings = useSettingsStore();
    // spy store.pickAvatar：确认按钮绑定 store 方法（TDD：上传按钮触发 pickAvatar）
    const pickSpy = vi.spyOn(settings, "pickAvatar").mockResolvedValue({ ok: true, filename: "avatar.png" });
    const pickBtn = wrapper.find("[data-tab='general'] button.f-settings-btn");
    expect(pickBtn.text()).toContain("上传");
    await pickBtn.trigger("click");
    expect(pickSpy).toHaveBeenCalledTimes(1);
    // avatarImage 状态展示：初始无图片显示空态提示
    expect(wrapper.find(".avatar-image-status").text()).toContain("未设置图片头像");
    // spy 后手动模拟成功写入 avatarImage → 状态变为文件名 + 清除按钮出现
    settings.avatarImage = "avatar.png";
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".avatar-image-status").text()).toContain("图片头像：avatar.png");
    expect(wrapper.find("button.f-settings-btn--danger").exists()).toBe(true);
  });

  it("avatar clear button calls store clearAvatar", async () => {
    const wrapper = mountPanel();
    const settings = useSettingsStore();
    settings.avatarImage = "avatar.png";
    await wrapper.vm.$nextTick();
    const clearSpy = vi.spyOn(settings, "clearAvatar").mockResolvedValue({ ok: true });
    const clearBtn = wrapper.find("button.f-settings-btn--danger");
    expect(clearBtn.exists()).toBe(true);
    await clearBtn.trigger("click");
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });

  it("avatar emoji click sets avatar and clears avatarImage", async () => {
    const wrapper = mountPanel();
    const settings = useSettingsStore();
    settings.avatarImage = "avatar.png";
    const clearSpy = vi.spyOn(settings, "clearAvatar").mockResolvedValue({ ok: true });
    await wrapper.vm.$nextTick();
    // 点击第一个 emoji（🐱）
    await wrapper.find(".avatar-emoji-item").trigger("click");
    expect(settings.avatar).toBe("🐱");
    // 选 emoji 时图片头像被清除（图片优先于 emoji，避免显示歧义）
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });

  it("workspace pick button is wired", async () => {
    const wrapper = mountPanel();
    // 工作目录输入框 readonly + 后缀选择按钮（lucide FolderOpen）
    const tab = wrapper.find("[data-tab='general']");
    expect(tab.find("input[readonly]").exists()).toBe(true);
    expect(tab.find(".f-settings-btn--suffix svg").exists()).toBe(true);
  });

  // ── 模型与API tab ──

  /** 切到模型与API tab（索引 1）并返回该 tab 容器 */
  async function switchToModelTab(wrapper: ReturnType<typeof mountPanel>) {
    await wrapper.findAll(".f-settings-nav-item")[1].trigger("click");
    return wrapper.find("[data-tab='model']");
  }

  it("model tab renders api key, kimi key, baseUrl, model select and test button", async () => {
    const wrapper = mountPanel();
    const tab = await switchToModelTab(wrapper);
    expect(tab.text()).toContain("API Key");
    expect(tab.text()).toContain("Multimodal Model (Cartographer) API Key");
    expect(tab.text()).toContain("API Base URL");
    expect(tab.text()).toContain("Model");
    expect(tab.text()).toContain("Test Connection");
    expect(tab.text()).toContain("账户余额");
  });

  it("model tab main model select switches settings.model", async () => {
    const wrapper = mountPanel();
    await switchToModelTab(wrapper);
    const settings = useSettingsStore();
    // 找到 label=Model 的字段 → 触发器 → 选 deepseek-v4-flash
    const fields = wrapper.findAll(".settings-field");
    const modelField = fields.find((f) => f.find(".settings-field__label").text() === "Model")!;
    await modelField.find(".settings-select__trigger").trigger("click");
    const flashItem = wrapper.findAll(".settings-select__item").find((i) => i.text() === "deepseek-v4-flash")!;
    await flashItem.trigger("click");
    expect(settings.model).toBe("deepseek-v4-flash");
  });

  it("contextLimit input accepts 128K shorthand on blur", async () => {
    const wrapper = mountPanel();
    await switchToModelTab(wrapper);
    const settings = useSettingsStore();
    const clInput = wrapper
      .findAll("input")
      .find((el) => (el.element as HTMLInputElement).placeholder.includes("128K"));
    expect(clInput).toBeTruthy();
    if (clInput) {
      await clInput.setValue("128K");
      await clInput.trigger("blur");
      expect(settings.contextLimit).toBe(128000);
    }
  });

  it("kimi key eye toggles password to text (明文切换)", async () => {
    const wrapper = mountPanel();
    await switchToModelTab(wrapper);
    // kimi key 明文切换按钮（aria-label = Show API Key）
    const eye = wrapper.find("button[aria-label='Show API Key']");
    expect(eye.exists()).toBe(true);
    await eye.trigger("click");
    const kimiInput = wrapper
      .findAll("input")
      .find((i) => i.attributes("placeholder") === "sk-..." && i.attributes("type") === "text");
    expect(kimiInput).toBeTruthy();
  });

  it("kimi key save button writes provider-configs with restart=true", async () => {
    const wrapper = mountPanel();
    await switchToModelTab(wrapper);
    const bridge = (window as unknown as { electronBridge: { invoke: ReturnType<typeof vi.fn>; on: () => () => void } }).electronBridge;
    bridge.invoke = vi.fn().mockImplementation((channel: string) => {
      if (channel === "provider:modelVariants") return Promise.resolve(["low", "high", "max"]);
      if (channel === "app:getInfo") return Promise.resolve({ name: "Fractal", version: "1.2.3", engineVersion: "1.18.15", presetVersion: "1.1.0" });
      if (channel === "settings:saveProviderConfig") return Promise.resolve({ ok: true });
      return Promise.resolve({});
    });
    // 填入 kimi key：密码输入框有两个（API Key / kimi Key，均 sk-...），取第二个（模型 tab 顺序固定）
    const passwordInputs = wrapper.findAll("input").filter((i) => i.attributes("type") === "password" && i.attributes("placeholder") === "sk-...");
    expect(passwordInputs.length).toBe(2);
    await passwordInputs[1].setValue("sk-kimi-123");
    // 保存按钮：kimi 区保存（文案 Save，非禁用）
    const saveBtn = wrapper.findAll("button").find((b) => b.text() === "Save" && !(b.element as HTMLButtonElement).disabled);
    expect(saveBtn).toBeTruthy();
    await saveBtn!.trigger("click");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const saveCalls = bridge.invoke.mock.calls.filter((c) => c[0] === "settings:saveProviderConfig");
    expect(saveCalls.length).toBeGreaterThanOrEqual(1);
    const arg = saveCalls.at(-1)![1] as { providerId: string; apiKey: string; restart: boolean };
    expect(arg.providerId).toBe("moonshotai-cn");
    expect(arg.apiKey).toBe("sk-kimi-123");
    expect(arg.restart).toBe(true);
  });

  it("test connection button exists", async () => {
    const wrapper = mountPanel();
    await switchToModelTab(wrapper);
    const testBtn = wrapper.findAll("button").find((b) => b.text().includes("Test Connection"));
    expect(testBtn).toBeTruthy();
    expect(testBtn!.attributes("disabled")).toBeUndefined();
  });

  // ── AI行为 tab：默认主 Agent / 子 agent 模型 / 权限模式 / 思考深度 / 思考节点 / 轻量模型 ──

  /** 切到 AI行为 tab（索引 2） */
  async function switchToBehaviorTab(wrapper: ReturnType<typeof mountPanel>) {
    await wrapper.findAll(".f-settings-nav-item")[2].trigger("click");
    return wrapper.find("[data-tab='behavior']");
  }

  it("behavior tab renders agent, subagent, permission, effort, thinking, small model controls", async () => {
    const wrapper = mountPanel();
    const tab = await switchToBehaviorTab(wrapper);
    expect(tab.text()).toContain("默认主 Agent");
    // 7 个子 agent 模型行（label 含 agent 名 + 槽位）
    expect(tab.text()).toContain("双星（high）");
    expect(tab.text()).toContain("侦查兵（anthropic）");
    expect(tab.text()).toContain("制图师（vision）");
    expect(tab.text()).toContain("Permission Mode");
    expect(tab.text()).toContain("Effort Level");
    expect(tab.text()).toContain("思考节点");
    expect(tab.text()).toContain("Lightweight Model");
    // 子 agent 行数 = 7
    const subagentSelects = tab.findAll(".settings-select__trigger");
    expect(subagentSelects.length).toBeGreaterThanOrEqual(7);
  });

  it("subagent model default select shows 跟随默认（当前值） with slot-aligned value", async () => {
    const wrapper = mountPanel();
    await switchToBehaviorTab(wrapper);
    const settings = useSettingsStore();
    // 双星（high）→ 跟随默认显示主模型名
    const tab = wrapper.find("[data-tab='behavior']");
    const fields = tab.findAll(".settings-field");
    const twinField = fields.find((f) => f.find(".settings-field__label").text() === "双星（high）")!;
    expect(twinField.text()).toContain(`跟随默认（${settings.model}）`);
  });

  it("subagent model select 跟随默认 → setAgentModelOverride(name, null)", async () => {
    const wrapper = mountPanel();
    await switchToBehaviorTab(wrapper);
    const settings = useSettingsStore();
    // 先设置一个 override，再选「跟随默认」应清空
    settings.setAgentModelOverride("双星", "deepseek/deepseek-v4-pro");
    await wrapper.vm.$nextTick();
    const spy = vi.spyOn(settings, "setAgentModelOverride");
    const tab = wrapper.find("[data-tab='behavior']");
    const fields = tab.findAll(".settings-field");
    const twinField = fields.find((f) => f.find(".settings-field__label").text() === "双星（high）")!;
    await twinField.find(".settings-select__trigger").trigger("click");
    const followItem = wrapper.findAll(".settings-select__item").find((i) => i.text().startsWith("跟随默认"))!;
    await followItem.trigger("click");
    expect(spy).toHaveBeenCalledWith("双星", null);
    expect(settings.agentModelOverrides["双星"]).toBeUndefined();
  });

  it("subagent model select 具体模型 → setAgentModelOverride(name, 全名)", async () => {
    const wrapper = mountPanel();
    await switchToBehaviorTab(wrapper);
    const settings = useSettingsStore();
    const spy = vi.spyOn(settings, "setAgentModelOverride");
    const tab = wrapper.find("[data-tab='behavior']");
    const fields = tab.findAll(".settings-field");
    const twinField = fields.find((f) => f.find(".settings-field__label").text() === "双星（high）")!;
    await twinField.find(".settings-select__trigger").trigger("click");
    const proItem = wrapper.findAll(".settings-select__item").find((i) => i.text() === "deepseek-v4-pro")!;
    await proItem.trigger("click");
    expect(spy).toHaveBeenCalledWith("双星", "deepseek/deepseek-v4-pro");
    expect(settings.agentModelOverrides["双星"]).toBe("deepseek/deepseek-v4-pro");
  });

  it("subagent model candidates are whitelist-limited per agent (侦查兵 ds-anthropic)", async () => {
    const wrapper = mountPanel();
    await switchToBehaviorTab(wrapper);
    const tab = wrapper.find("[data-tab='behavior']");
    const fields = tab.findAll(".settings-field");
    const scoutField = fields.find((f) => f.find(".settings-field__label").text() === "侦查兵（anthropic）")!;
    await scoutField.find(".settings-select__trigger").trigger("click");
    const items = wrapper.findAll(".settings-select__item").map((i) => i.text());
    // 侦查兵白名单：ds-anthropic flash/pro（不含 deepseek 前缀）
    expect(items).toContain("deepseek-v4-flash");
    expect(items).toContain("deepseek-v4-pro");
    // 跟随默认显示 ds-anthropic/deepseek-v4-flash（ANTHROPIC_MODEL 固定值）
    expect(items.some((t) => t.includes("ds-anthropic/deepseek-v4-flash"))).toBe(true);
  });

  it("subagent default value follows smallModel switch (low slot 工匠)", async () => {
    const wrapper = mountPanel();
    await switchToBehaviorTab(wrapper);
    const settings = useSettingsStore();
    const tab = wrapper.find("[data-tab='behavior']");
    // 轻量模型选 pro → 工匠（low）跟随默认显示 pro
    settings.smallModel = "deepseek/deepseek-v4-pro";
    await wrapper.vm.$nextTick();
    const fields = tab.findAll(".settings-field");
    const artisanField = fields.find((f) => f.find(".settings-field__label").text() === "工匠（low）")!;
    expect(artisanField.text()).toContain("deepseek/deepseek-v4-pro");
  });

  it("thinking toggle switches store.showThinking", async () => {
    const wrapper = mountPanel();
    await switchToBehaviorTab(wrapper);
    const settings = useSettingsStore();
    expect(settings.showThinking).toBe(true);
    const toggle = wrapper.find("[data-tab='behavior'] .settings-toggle__switch");
    await toggle.trigger("click");
    expect(settings.showThinking).toBe(false);
  });

  it("default agent select writes store.currentAgent", async () => {
    const wrapper = mountPanel();
    await switchToBehaviorTab(wrapper);
    const settings = useSettingsStore();
    const fields = wrapper.find("[data-tab='behavior']").findAll(".settings-field");
    const agentField = fields.find((f) => f.find(".settings-field__label").text() === "默认主 Agent")!;
    await agentField.find(".settings-select__trigger").trigger("click");
    const scoutItem = wrapper.findAll(".settings-select__item").find((i) => i.text() === "侦查兵")!;
    await scoutItem.trigger("click");
    expect(settings.currentAgent).toBe("侦查兵");
  });
});
