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

// 头像图片预览（5.3）：mock getAvatarPath——useAvatarImageUrl 内部经该模块拼 file:// URL；
// 保留其余实际实现（testConnection 等仍走 window.electronBridge，见 beforeEach）
const { getAvatarPathMock } = vi.hoisted(() => ({
  getAvatarPathMock: vi.fn(),
}));
vi.mock("@/lib/electron-bridge", async () => {
  const actual = await vi.importActual<typeof import("@/lib/electron-bridge")>("@/lib/electron-bridge");
  return { ...actual, getAvatarPath: getAvatarPathMock };
});

// 自动更新状态回调捕获：组件 onUpdaterStatus 订阅经 window.electronBridge.on 落地，
// 测试保存 handler 手动触发各状态（available/progress/downloaded/error）
const updaterStateHandler = vi.hoisted(() => ({ handler: null as null | ((s: unknown) => void) }));

const i18n = createI18n({
  legacy: false,
  locale: "en",
  messages: {
    en: {
      settings: {
        title: "Settings",
        uiTitle: "Interface Settings",
        mainModelApi: "Main Model API",
        multimodalApi: "Multimodal API",
        baseUrl: "API Base URL",
        apiKey: "DeepSeek API Key",
        apiKeyDesc: "Used by the main model and most sub-agents (DeepSeek)",
        model: "Model",
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
        smallModelFollow: "Follow main model",
        smallModelFlash: "deepseek-v4-flash · fast",
        smallModelPro: "deepseek-v4-pro · stronger reasoning",
        smallModelDesc: "Used for lightweight tasks (titles, summaries, message polish); flash by default for speed and cost",
        kimiApiKey: "Kimi K3 API Key",
        kimiApiKeyDesc: "Used for the cartographer (kimi-k3) multimodal recognition; cartographer unavailable if empty",
        keyChangeTitle: "API Key Changed",
        keyChangeTesting: "Testing connection…",
        keyChangeSaving: "Saving and restarting engine…",
        keyChangeSuccess: "✓ Saved and engine restarted",
        keyChangeRetry: "Retry",
        showKey: "Show API Key",
        hideKey: "Hide API Key",
        messageLayout: "Message Layout",
        layoutLeft: "All left",
        layoutSplit: "Split (me right · AI left)",
        nickname: "Nickname",
        nicknamePlaceholder: "Empty = show \"Me\"",
        avatar: "Avatar",
        opencodePath: "OC Executable Path",
        opencodePathPlaceholder: "Empty = bundled engine",
        opencodePathDesc: "Full path to opencode.exe; empty = auto-resolve",
        opencodePathPick: "Select opencode executable",
        browseFile: "Browse…",
        loading: "Loading…",
        jsonHint: "VSCode-style JSONC",
        logLevel: "Engine Log Level",
        logLevelDesc: "Verbosity of serve output",
        presetSkills: "Preset Skills Pack",
        presetSkillsDesc: "When off, preset skills are not loaded on next start",
        tabs: {
          general: "General",
          model: "Model & API",
          behavior: "AI Behavior",
          notify: "Notifications",
          advanced: "Advanced",
          about: "About",
        },
        section: {
          profile: "Profile",
          session: "Session",
          agent: "Agent",
          subagentModels: "Sub-agent Models",
          configFile: "Config File (settings.json)",
          onboarding: "Onboarding",
        },
        backToChat: "Back to chat",
        keyPlaceholder: "sk-...",
        balance: "Account Balance",
        balanceQueryFailed: "Failed to query balance",
        balanceQueryFailedShort: "Query failed",
        refreshBalance: "Refresh balance",
        upload: "Upload",
        clearAvatar: "Clear",
        changeAvatar: "Change",
        langZh: "中文",
        langEn: "English",
        defaultMainAgent: "Default Main Agent",
        followDefault: "Follow default ({model})",
        subagentModelLabel: "{name} ({slot})",
        thinkingNode: "Thinking Nodes",
        thinkingNodeDesc: "Show AI thinking process nodes in the timeline",
        notifyGlobal: "Global Notification Switch",
        notifyGlobalDesc: "When off, no system notifications are sent",
        notifyReplyDone: "AI Reply Complete",
        notifyReplyDoneDesc: "Send a notification when the AI finishes replying",
        notifyEngineError: "Engine Error",
        notifyEngineErrorDesc: "Send a notification when the serve engine fails",
        notifyPermissionPending: "Pending Permission Request",
        notifyPermissionPendingDesc: "Send a notification when a tool call awaits approval",
        notifySubtaskDone: "Subtask Complete",
        notifySubtaskDoneDesc: "Send a notification when a subtask/phase completes",
        update: {
          check: "Check for Updates",
          checking: "Checking…",
          latest: "You're up to date",
          found: "New version available",
          download: "Update Now",
          downloading: "Downloading…",
          restart: "Restart & Install",
          error: "Update check failed",
          noNotes: "No release notes",
          devMode: "Unavailable in dev mode",
          confirmTitle: "New version available",
          confirmDesc: "Download and install now?",
        },
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
      modal: { close: "Close", confirm: "Confirm", cancel: "Cancel" },
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
    getAvatarPathMock.mockReset();
    updaterStateHandler.handler = null;
    // mock electronBridge：默认模型（flash）variants 返回 3 档——
    // store 的 watch(model, immediate) 经此拉取，effort 下拉显示、触发器计数保持 6；
    // app:getInfo 返回三版本（关于区 onMounted 异步拉取）
    (window as unknown as { electronBridge: { invoke: (c: string, a?: unknown) => Promise<unknown>; on: (c: string, h: (s: unknown) => void) => () => void } }).electronBridge = {
      invoke: (channel: string) => {
        if (channel === "provider:modelVariants") return Promise.resolve(["low", "high", "max"]);
        if (channel === "app:getInfo") return Promise.resolve({ name: "Fractal", version: "1.2.3", engineVersion: "1.18.15", presetVersion: "1.1.0" });
        // 数据模式切换链路：engine:refresh 成功 + session:list 数组（setDataMode 内部重拉列表）
        if (channel === "engine:refresh") return Promise.resolve({ ok: true });
        if (channel === "session:list") return Promise.resolve([]);
        // 头像图片：pick 成功返回文件名（avatarImage 状态写入）；clear 成功返回 ok
        if (channel === "avatar:pick") return Promise.resolve({ ok: true, filename: "avatar.png" });
        if (channel === "avatar:clear") return Promise.resolve({ ok: true });
        // 自动更新 IPC：check/download/quit-and-install 均为无返回值调用
        if (channel.startsWith("updater:")) return Promise.resolve(undefined);
        return Promise.resolve({});
      },
      on: (channel: string, handler: (s: unknown) => void) => {
        if (channel === "updater:status") updaterStateHandler.handler = handler;
        return () => {};
      },
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
    const back = wrapper.find("button[aria-label='Back to chat']");
    expect(back.exists()).toBe(true);
  });

  it("renders 6 nav tabs with lucide icons", () => {
    const wrapper = mountPanel();
    const items = wrapper.findAll(".f-settings-nav-item");
    expect(items.length).toBe(6);
    // 顺序固定：通用/模型与API/AI行为/通知/高级/关于（i18n en）
    expect(items[0].text()).toContain("General");
    expect(items[1].text()).toContain("Model & API");
    expect(items[2].text()).toContain("AI Behavior");
    expect(items[3].text()).toContain("Notifications");
    expect(items[4].text()).toContain("Advanced");
    expect(items[5].text()).toContain("About");
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

  it("avatar uploader empty box calls store pickAvatar and shows preview+clear", async () => {
    const wrapper = mountPanel();
    const settings = useSettingsStore();
    // spy store.pickAvatar：确认上传占位框绑定 store 方法
    const pickSpy = vi.spyOn(settings, "pickAvatar").mockResolvedValue({ ok: true, filename: "avatar.png" });
    const pickBtn = wrapper.find("[data-tab='general'] .avatar-uploader__empty");
    expect(pickBtn.exists()).toBe(true);
    await pickBtn.trigger("click");
    expect(pickSpy).toHaveBeenCalledTimes(1);
    // 模拟成功写入 avatarImage → 预览容器 + 清除按钮出现（占位框消失）
    settings.avatarImage = "avatar.png";
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".avatar-uploader__preview").exists()).toBe(true);
    expect(wrapper.find(".avatar-uploader__clear").exists()).toBe(true);
    expect(wrapper.find(".avatar-uploader__empty").exists()).toBe(false);
  });

  it("avatar clear button calls store clearAvatar", async () => {
    const wrapper = mountPanel();
    const settings = useSettingsStore();
    settings.avatarImage = "avatar.png";
    await wrapper.vm.$nextTick();
    const clearSpy = vi.spyOn(settings, "clearAvatar").mockResolvedValue({ ok: true });
    const clearBtn = wrapper.find(".avatar-uploader__clear");
    expect(clearBtn.exists()).toBe(true);
    await clearBtn.trigger("click");
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });

  // ── 5.3 头像图片预览（avatarImage 非空 → .avatar-uploader__img；空 → 占位框）──

  it("avatarImage 非空 → 渲染 .avatar-uploader__img 预览图（avatar:// 协议 + 文件名）", async () => {
    const wrapper = mountPanel();
    const settings = useSettingsStore();
    settings.avatarImage = "avatar.png";
    await wrapper.vm.$nextTick();
    const preview = wrapper.find(".avatar-uploader__img");
    expect(preview.exists()).toBe(true);
    expect(preview.attributes("src")).toContain("avatar:///");
    expect(preview.attributes("src")).toContain("avatar.png");
  });

  it("avatarImage 为空 → 显示上传占位框，不渲染预览图", async () => {
    const wrapper = mountPanel();
    const settings = useSettingsStore();
    settings.avatarImage = "";
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".avatar-uploader__preview").exists()).toBe(false);
    expect(wrapper.find(".avatar-uploader__empty").exists()).toBe(true);
  });

  it("avatar icon click sets avatar and clears avatarImage", async () => {
    const wrapper = mountPanel();
    const settings = useSettingsStore();
    settings.avatarImage = "avatar.png";
    const clearSpy = vi.spyOn(settings, "clearAvatar").mockResolvedValue({ ok: true });
    await wrapper.vm.$nextTick();
    // 点击第一个 lucide 图标（bot → ui.avatar 存图标 id）
    await wrapper.find(".avatar-icon-item").trigger("click");
    expect(settings.avatar).toBe("bot");
    // 选图标时图片头像被清除（图片优先于图标，避免显示歧义）
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });

  // ── 模型与API tab ──

  /** 切到模型与API tab（索引 1）并返回该 tab 容器 */
  async function switchToModelTab(wrapper: ReturnType<typeof mountPanel>) {
    await wrapper.findAll(".f-settings-nav-item")[1].trigger("click");
    return wrapper.find("[data-tab='model']");
  }

  /** fake timers 下 flush 微任务链（async/await 多层链推进到稳定，不触发宏任务 timer）。
   *  不用 advanceTimersByTimeAsync(0)——其微任务 flush 行为不稳定（偶发推进不充分导致 Heisenbug），
   *  Promise.resolve 链是纯微任务、不受 fake timers 影响，稳定可靠。 */
  async function flushMicrotasks(times = 20) {
    for (let i = 0; i < times; i++) await Promise.resolve();
  }

  it("model tab renders two key groups: main model API + multimodal API + session", async () => {
    const wrapper = mountPanel();
    const tab = await switchToModelTab(wrapper);
    // 三分组：主模型 API / 多模态 API / 会话（标题来自 SettingsSection）
    const sections = tab.findAll(".settings-section");
    expect(sections.length).toBe(3);
    const titles = sections.map((s) => s.find(".settings-section__title").text());
    expect(titles).toEqual(["Main Model API", "Multimodal API", "Session"]);
    // 主模型 API section：DeepSeek API Key + 说明 + 余额 + baseUrl + 模型（测试/保存已移至 blur 引导弹窗）
    const mainSection = sections[0];
    expect(mainSection.text()).toContain("DeepSeek API Key");
    expect(mainSection.text()).toContain("Used by the main model and most sub-agents (DeepSeek)");
    expect(mainSection.text()).toContain("Account Balance");
    expect(mainSection.text()).toContain("API Base URL");
    expect(mainSection.text()).toContain("Model");
    // 多模态 API section：Kimi K3 Key + 说明（制图师不可用提示）+ 余额行 + 刷新按钮
    const multiSection = sections[1];
    expect(multiSection.text()).toContain("Kimi K3 API Key");
    expect(multiSection.text()).toContain("Used for the cartographer (kimi-k3) multimodal recognition; cartographer unavailable if empty");
    expect(multiSection.text()).toContain("Account Balance");
    // 多模态区余额刷新按钮（aria-label 复用 refreshBalance，与 DeepSeek 对称）
    const kimiRefresh = multiSection.find("button[aria-label='Refresh balance']");
    expect(kimiRefresh.exists()).toBe(true);
    // 会话 section：上下文窗口
    const sessionSection = sections[2];
    expect(sessionSection.text()).toContain("Context Limit");
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

  it("deepseek key eye toggles password to text (明文切换)", async () => {
    const wrapper = mountPanel();
    const tab = await switchToModelTab(wrapper);
    const sections = tab.findAll(".settings-section");
    // DeepSeek key 明文切换按钮（aria-label = Show API Key）
    const eye = sections[0].find("button[aria-label='Show API Key']");
    expect(eye.exists()).toBe(true);
    await eye.trigger("click");
    const dsInput = wrapper
      .findAll("input")
      .find((i) => i.attributes("placeholder") === "sk-..." && i.attributes("type") === "text");
    expect(dsInput).toBeTruthy();
  });

  it("kimi key eye toggles password to text (明文切换)", async () => {
    const wrapper = mountPanel();
    const tab = await switchToModelTab(wrapper);
    const sections = tab.findAll(".settings-section");
    // kimi key 明文切换按钮（aria-label = Show API Key）
    const eye = sections[1].find("button[aria-label='Show API Key']");
    expect(eye.exists()).toBe(true);
    await eye.trigger("click");
    const kimiInput = wrapper
      .findAll("input")
      .find((i) => i.attributes("placeholder") === "sk-..." && i.attributes("type") === "text");
    expect(kimiInput).toBeTruthy();
  });

  it("kimi key blur runs auto test→save→restart flow with restart=true", async () => {
    const wrapper = mountPanel();
    await switchToModelTab(wrapper);
    const bridge = (window as unknown as { electronBridge: { invoke: ReturnType<typeof vi.fn>; on: () => () => void } }).electronBridge;
    bridge.invoke = vi.fn().mockImplementation((channel: string) => {
      if (channel === "provider:modelVariants") return Promise.resolve(["low", "high", "max"]);
      if (channel === "app:getInfo") return Promise.resolve({ name: "Fractal", version: "1.2.3", engineVersion: "1.18.15", presetVersion: "1.1.0" });
      if (channel === "engine:testKimiConnection") return Promise.resolve({ ok: true, message: "kimi ok" });
      if (channel === "settings:saveProviderConfig") return Promise.resolve({ ok: true });
      return Promise.resolve({});
    });
    vi.useFakeTimers();
    try {
      // 填入 kimi key：密码输入框有两个（DeepSeek / kimi Key，均 sk-...），取第二个（模型 tab 顺序固定）
      const passwordInputs = wrapper.findAll("input").filter((i) => i.attributes("type") === "password" && i.attributes("placeholder") === "sk-...");
      expect(passwordInputs.length).toBe(2);
      await passwordInputs[1].setValue("sk-kimi-123");
      // blur 触发自动流程（测试 → 保存并重启）
      await passwordInputs[1].trigger("blur");
      await flushMicrotasks();
      // 自动保存 restart=true（此刻防抖 500ms 未 advance，仅显式保存一次）
      const saveCalls = bridge.invoke.mock.calls.filter((c) => c[0] === "settings:saveProviderConfig");
      expect(saveCalls.length).toBeGreaterThanOrEqual(1);
      const arg = saveCalls.at(-1)![1] as { providerId: string; apiKey: string; restart: boolean };
      expect(arg.providerId).toBe("moonshotai-cn");
      expect(arg.apiKey).toBe("sk-kimi-123");
      expect(arg.restart).toBe(true);
      // 成功态后自动关闭
      vi.advanceTimersByTime(1200);
      await flushMicrotasks();
      expect(document.body.querySelector(".modal-shell-overlay")).toBeFalsy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("mount with non-empty kimiApiKey queries kimi balance (getKimiBalance invoked)", async () => {
    // 预置 Kimi key → 挂载时 onMounted 直接查一次余额（未配置时不应发起查询）
    const settings = useSettingsStore();
    settings.kimiApiKey = "sk-kimi-123";
    const bridge = (window as unknown as { electronBridge: { invoke: ReturnType<typeof vi.fn>; on: () => () => void } }).electronBridge;
    bridge.invoke = vi.fn().mockImplementation((channel: string) => {
      if (channel === "provider:modelVariants") return Promise.resolve(["low", "high", "max"]);
      if (channel === "app:getInfo") return Promise.resolve({ name: "Fractal", version: "1.2.3", engineVersion: "1.18.15", presetVersion: "1.1.0" });
      if (channel === "kimi:getBalance") return Promise.resolve({ ok: true, isAvailable: true, balanceInfos: [{ currency: "CNY", totalBalance: "49.58" }] });
      return Promise.resolve({});
    });
    const wrapper = mountPanel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const kimiCalls = bridge.invoke.mock.calls.filter((c) => c[0] === "kimi:getBalance");
    expect(kimiCalls.length).toBeGreaterThanOrEqual(1);
    // 多模态区展示 Kimi 余额（¥49.58）
    const tab = await switchToModelTab(wrapper);
    const multiSection = tab.findAll(".settings-section")[1];
    expect(multiSection.text()).toContain("¥49.58");
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
    expect(tab.text()).toContain("Default Main Agent");
    // 7 个子 agent 模型行（label 含 agent 名 + 槽位；agent 名为契约数据不翻译）
    expect(tab.text()).toContain("双星 (high)");
    expect(tab.text()).toContain("侦查兵 (anthropic)");
    expect(tab.text()).toContain("制图师 (vision)");
    expect(tab.text()).toContain("Permission Mode");
    expect(tab.text()).toContain("Effort Level");
    expect(tab.text()).toContain("Thinking Nodes");
    expect(tab.text()).toContain("Lightweight Model");
    // 子 agent 行数 = 7
    const subagentSelects = tab.findAll(".settings-select__trigger");
    expect(subagentSelects.length).toBeGreaterThanOrEqual(7);
  });

  it("subagent model default select shows Follow default（当前值） with slot-aligned value", async () => {
    const wrapper = mountPanel();
    await switchToBehaviorTab(wrapper);
    const settings = useSettingsStore();
    // 双星（high）→ 跟随默认显示主模型名（i18n en：Follow default）
    const tab = wrapper.find("[data-tab='behavior']");
    const fields = tab.findAll(".settings-field");
    const twinField = fields.find((f) => f.find(".settings-field__label").text() === "双星 (high)")!;
    expect(twinField.text()).toContain(`Follow default (${settings.model})`);
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
    const twinField = fields.find((f) => f.find(".settings-field__label").text() === "双星 (high)")!;
    await twinField.find(".settings-select__trigger").trigger("click");
    const followItem = wrapper.findAll(".settings-select__item").find((i) => i.text().startsWith("Follow default"))!;
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
    const twinField = fields.find((f) => f.find(".settings-field__label").text() === "双星 (high)")!;
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
    const scoutField = fields.find((f) => f.find(".settings-field__label").text() === "侦查兵 (anthropic)")!;
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
    const artisanField = fields.find((f) => f.find(".settings-field__label").text() === "工匠 (low)")!;
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
    const agentField = fields.find((f) => f.find(".settings-field__label").text() === "Default Main Agent")!;
    await agentField.find(".settings-select__trigger").trigger("click");
    // 主 agent 下拉仅 3 项（双星/build/plan），选 build 验证写入（子 agent 不在此列）
    const buildItem = wrapper.findAll(".settings-select__item").find((i) => i.text() === "build")!;
    await buildItem.trigger("click");
    expect(settings.currentAgent).toBe("build");
  });

  // ── 通知 tab：全局开关 + 4 场景 ──

  it("notify tab renders global toggle and 4 scenario toggles", async () => {
    const wrapper = mountPanel();
    await wrapper.findAll(".f-settings-nav-item")[3].trigger("click");
    const tab = wrapper.find("[data-tab='notify']");
    expect(tab.text()).toContain("Global Notification Switch");
    expect(tab.text()).toContain("AI Reply Complete");
    expect(tab.text()).toContain("Engine Error");
    expect(tab.text()).toContain("Pending Permission Request");
    expect(tab.text()).toContain("Subtask Complete");
    // 默认全局开（2026-08-14 定案：默认开启回答完成/引擎异常/权限请求，子任务完成关）→ 场景开关均可用
    const switches = tab.findAll(".settings-toggle__switch");
    expect(switches.length).toBe(5);
    for (const s of switches) {
      expect((s.element as HTMLButtonElement).disabled).toBe(false);
    }
    // 关闭全局开关 → 场景开关禁用（opt-in）
    await switches[0].trigger("click");
    expect((switches[1].element as HTMLButtonElement).disabled).toBe(true);
  });

  it("notification toggle switches store.notifications", async () => {
    const wrapper = mountPanel();
    await wrapper.findAll(".f-settings-nav-item")[3].trigger("click");
    const settings = useSettingsStore();
    // 默认全局开
    expect(settings.notifications.enabled).toBe(true);
    // 关全局 → 场景开关禁用
    const switches = wrapper.find("[data-tab='notify']").findAll(".settings-toggle__switch");
    await switches[0].trigger("click");
    expect(settings.notifications.enabled).toBe(false);
    // 再开全局 → 场景可操作：切 replyDone（默认 true → false）
    await switches[0].trigger("click");
    expect(settings.notifications.enabled).toBe(true);
    await switches[1].trigger("click");
    expect(settings.notifications.replyDone).toBe(false);
    await switches[1].trigger("click");
    expect(settings.notifications.replyDone).toBe(true);
  });

  // ── 高级 + 关于 tab ──

  it("advanced tab renders data mode / opencode path / log level / preset skills / json editor", async () => {
    const wrapper = mountPanel();
    await wrapper.findAll(".f-settings-nav-item")[4].trigger("click");
    const tab = wrapper.find("[data-tab='advanced']");
    expect(tab.text()).toContain("Isolated session data");
    expect(tab.text()).toContain("OC Executable Path");
    expect(tab.text()).toContain("Engine Log Level");
    expect(tab.text()).toContain("Preset Skills Pack");
    expect(tab.text()).toContain("settings.json");
  });

  it("data mode toggle calls setDataMode and switches dataMode", async () => {
    const wrapper = mountPanel();
    await wrapper.findAll(".f-settings-nav-item")[4].trigger("click");
    const settings = useSettingsStore();
    // 默认 isolated（开关开）
    expect(settings.dataMode).toBe("isolated");
    const sw = wrapper.find("[data-tab='advanced'] .settings-toggle__switch");
    await sw.trigger("click");
    // flush setDataMode 异步链（saveSettings → refreshEngine → loadSessions）
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settings.dataMode).toBe("shared");
    expect(settings.isRestarting).toBe(false);
  });

  it("data mode switch disabled while isRestarting (防连点)", async () => {
    const wrapper = mountPanel();
    await wrapper.findAll(".f-settings-nav-item")[4].trigger("click");
    const settings = useSettingsStore();
    settings.isRestarting = true;
    await wrapper.vm.$nextTick();
    const sw = wrapper.find("[data-tab='advanced'] .settings-toggle__switch");
    expect((sw.element as HTMLButtonElement).disabled).toBe(true);
  });

  it("about tab renders version / engine / preset lines and changelog button", async () => {
    const wrapper = mountPanel();
    await wrapper.findAll(".f-settings-nav-item")[5].trigger("click");
    await new Promise((resolve) => setTimeout(resolve, 0));  // flush onMounted getAppInfo
    const tab = wrapper.find("[data-tab='about']");
    expect(tab.text()).toContain("Fractal");
    expect(tab.text()).toContain(`v${__APP_VERSION__}`);
    // label 与 value 分离（flex 布局拼接无空格），分别断言（第 2/3 行 = 引擎/预置版本）
    const labels = tab.findAll(".about-label").map((l) => l.text());
    expect(labels[1]).toContain("OC Engine");
    expect(tab.text()).toContain("1.18.15");
    expect(labels[2]).toContain("Preset");
    expect(tab.text()).toContain("1.1.0");
    // 变更记录按钮打开弹窗
    const changelogBtn = tab.findAll("button").find((b) => b.text().includes("Changelog"));
    expect(changelogBtn).toBeTruthy();
    await changelogBtn!.trigger("click");
    // ModalShell 用 Teleport 渲染到 body（不在组件 wrapper 内）
    await wrapper.vm.$nextTick();
    expect(document.body.querySelector(".modal-shell-overlay")).toBeTruthy();
    // 关闭弹窗（右上角 close 按钮）：Teleport 到 body 不随 wrapper 自动清理，避免残留影响后续用例
    const closeBtn = document.body.querySelector<HTMLButtonElement>(".modal-shell-close");
    closeBtn!.click();
    await wrapper.vm.$nextTick();
  });

  // ── API Key 变更引导弹窗（blur 检测变化 → 自动「测试连接 → 保存并重启引擎」，弹窗只做进度/结果反馈）──

  it("deepseek key blur runs auto test→save→restart flow and auto-closes on success", async () => {
    const wrapper = mountPanel();
    await switchToModelTab(wrapper);
    const bridge = (window as unknown as { electronBridge: { invoke: ReturnType<typeof vi.fn>; on: () => () => void } }).electronBridge;
    bridge.invoke = vi.fn().mockImplementation((channel: string) => {
      if (channel === "engine:testConnection") return Promise.resolve({ ok: true, message: "serve connected" });
      if (channel === "settings:saveProviderConfig") return Promise.resolve({ ok: true });
      return Promise.resolve({});
    });
    vi.useFakeTimers();
    try {
      const dsInput = wrapper
        .findAll("input")
        .find((i) => i.attributes("type") === "password" && i.attributes("placeholder") === "sk-...");
      expect(dsInput).toBeTruthy();
      await dsInput!.setValue("sk-new-key");
      await dsInput!.trigger("blur");
      // 推进自动流程微任务链（testConnection → saveCurrentConfig → success 态）；
      // 不 advance 1200ms 自动关闭 timer（此刻仍处 success 态）
      await flushMicrotasks();
      // 弹窗打开 + 成功态文案
      expect(document.body.querySelector(".modal-shell-overlay")).toBeTruthy();
      expect(document.body.textContent).toContain("API Key Changed");
      expect(document.body.textContent).toContain("Saved and engine restarted");
      // 自动测试已发起
      expect(bridge.invoke.mock.calls.filter((c) => c[0] === "engine:testConnection").length).toBeGreaterThanOrEqual(1);
      // 自动保存 restart=true（此刻防抖 500ms 未 advance，仅显式保存一次）
      const saveCalls = bridge.invoke.mock.calls.filter((c) => c[0] === "settings:saveProviderConfig");
      expect(saveCalls.length).toBeGreaterThanOrEqual(1);
      const arg = saveCalls.at(-1)![1] as { providerId: string; apiKey: string; restart: boolean };
      expect(arg.providerId).toBe("deepseek");
      expect(arg.apiKey).toBe("sk-new-key");
      expect(arg.restart).toBe(true);
      // 1.2s 后自动关闭（同步 advance 触发 timer，再 flush 微任务让 DOM 更新）
      vi.advanceTimersByTime(1200);
      await flushMicrotasks();
      expect(document.body.querySelector(".modal-shell-overlay")).toBeFalsy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("deepseek key blur with unchanged value does not open dialog", async () => {
    const wrapper = mountPanel();
    await switchToModelTab(wrapper);
    const dsInput = wrapper
      .findAll("input")
      .find((i) => i.attributes("type") === "password" && i.attributes("placeholder") === "sk-...");
    // 空值 blur：cur 为空，不弹窗
    await dsInput!.trigger("blur");
    await wrapper.vm.$nextTick();
    expect(document.body.querySelector(".modal-shell-overlay")).toBeFalsy();
  });

  it("auto flow stops on test failure: shows error, does not save, retry re-tests", async () => {
    const wrapper = mountPanel();
    await switchToModelTab(wrapper);
    const bridge = (window as unknown as { electronBridge: { invoke: ReturnType<typeof vi.fn>; on: () => () => void } }).electronBridge;
    let testCount = 0;
    bridge.invoke = vi.fn().mockImplementation((channel: string) => {
      if (channel === "engine:testConnection") {
        testCount++;
        return Promise.resolve({ ok: false, message: "401 Unauthorized" });
      }
      if (channel === "settings:saveProviderConfig") return Promise.resolve({ ok: true });
      return Promise.resolve({});
    });
    vi.useFakeTimers();
    try {
      const dsInput = wrapper
        .findAll("input")
        .find((i) => i.attributes("type") === "password" && i.attributes("placeholder") === "sk-...");
      await dsInput!.setValue("sk-bad-key");
      await dsInput!.trigger("blur");
      await flushMicrotasks();
      // 失败态：显示错误信息 + 不保存（不重启）
      expect(document.body.textContent).toContain("401 Unauthorized");
      expect(bridge.invoke.mock.calls.filter((c) => c[0] === "settings:saveProviderConfig").length).toBe(0);
      // 「重试」+「取消」按钮存在
      const retryBtn = Array.from(document.body.querySelectorAll<HTMLButtonElement>(".key-change-btn--primary"))
        .find((b) => b.textContent === "Retry");
      expect(retryBtn).toBeTruthy();
      // 点重试 → 重新跑测试（testCount 递增），仍失败不保存
      retryBtn!.click();
      await flushMicrotasks();
      expect(testCount).toBe(2);
      expect(bridge.invoke.mock.calls.filter((c) => c[0] === "settings:saveProviderConfig").length).toBe(0);
      // 清理：点取消关闭弹窗
      const cancel = Array.from(document.body.querySelectorAll<HTMLButtonElement>(".key-change-btn"))
        .find((b) => b.textContent === "Cancel");
      cancel!.click();
      await wrapper.vm.$nextTick();
      expect(document.body.querySelector(".modal-shell-overlay")).toBeFalsy();
    } finally {
      vi.useRealTimers();
    }
  });

  // ── 自动更新（关于 tab 更新区块：检查按钮 + 状态区 + 确认弹窗）──

  it("about tab shows updater section with check button", async () => {
    const wrapper = mountPanel();
    await wrapper.findAll(".f-settings-nav-item")[5].trigger("click");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const tab = wrapper.find("[data-tab='about']");
    const checkBtn = tab.find(".about-updater-check");
    expect(checkBtn.exists()).toBe(true);
    expect(checkBtn.text()).toContain("Check for Updates");
  });

  it("clicking check button invokes updater:check IPC", async () => {
    const wrapper = mountPanel();
    await wrapper.findAll(".f-settings-nav-item")[5].trigger("click");
    const bridge = (window as unknown as { electronBridge: { invoke: ReturnType<typeof vi.fn> } }).electronBridge;
    bridge.invoke = vi.fn().mockImplementation((channel: string) => {
      if (channel === "provider:modelVariants") return Promise.resolve(["low", "high", "max"]);
      if (channel === "app:getInfo") return Promise.resolve({ name: "Fractal", version: "1.2.3", engineVersion: "1.18.15", presetVersion: "1.1.0" });
      if (channel.startsWith("updater:")) return Promise.resolve(undefined);
      return Promise.resolve({});
    });
    await wrapper.find("[data-tab='about'] .about-updater-check").trigger("click");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bridge.invoke.mock.calls.some((c) => c[0] === "updater:check")).toBe(true);
  });

  it("dev 模式 updater:check 抛错 → 状态区显示「开发模式不可用」", async () => {
    const wrapper = mountPanel();
    await wrapper.findAll(".f-settings-nav-item")[5].trigger("click");
    const bridge = (window as unknown as { electronBridge: { invoke: ReturnType<typeof vi.fn> } }).electronBridge;
    bridge.invoke = vi.fn().mockImplementation((channel: string) => {
      if (channel === "provider:modelVariants") return Promise.resolve(["low", "high", "max"]);
      if (channel === "app:getInfo") return Promise.resolve({ name: "Fractal", version: "1.2.3", engineVersion: "1.18.15", presetVersion: "1.1.0" });
      if (channel === "updater:check") return Promise.reject(new Error("DEV_MODE_UPDATER_UNAVAILABLE"));
      return Promise.resolve({});
    });
    await wrapper.find("[data-tab='about'] .about-updater-check").trigger("click");
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();
    expect(wrapper.find("[data-tab='about'] .about-updater-status").text()).toContain("Unavailable in dev mode");
  });

  it("updater:check 抛非 DEV_MODE 错误 → 状态区透传真实错误（不误报 devMode）", async () => {
    const wrapper = mountPanel();
    await wrapper.findAll(".f-settings-nav-item")[5].trigger("click");
    const bridge = (window as unknown as { electronBridge: { invoke: ReturnType<typeof vi.fn> } }).electronBridge;
    bridge.invoke = vi.fn().mockImplementation((channel: string) => {
      if (channel === "provider:modelVariants") return Promise.resolve(["low", "high", "max"]);
      if (channel === "app:getInfo") return Promise.resolve({ name: "Fractal", version: "1.2.3", engineVersion: "1.18.15", presetVersion: "1.1.0" });
      if (channel === "updater:check") return Promise.reject(new Error("Cannot find latest.yml"));
      return Promise.resolve({});
    });
    await wrapper.find("[data-tab='about'] .about-updater-check").trigger("click");
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();
    const text = wrapper.find("[data-tab='about'] .about-updater-status").text();
    expect(text).toContain("Cannot find latest.yml");
    expect(text).not.toContain("Unavailable in dev mode");
  });

  it("updater status available opens confirm dialog and download works", async () => {
    const wrapper = mountPanel();
    await wrapper.findAll(".f-settings-nav-item")[5].trigger("click");
    const bridge = (window as unknown as { electronBridge: { invoke: ReturnType<typeof vi.fn> } }).electronBridge;
    bridge.invoke = vi.fn().mockImplementation((channel: string) => {
      if (channel === "provider:modelVariants") return Promise.resolve(["low", "high", "max"]);
      if (channel === "app:getInfo") return Promise.resolve({ name: "Fractal", version: "1.2.3", engineVersion: "1.18.15", presetVersion: "1.1.0" });
      if (channel.startsWith("updater:")) return Promise.resolve(undefined);
      return Promise.resolve({});
    });
    // 触发 available 状态 → 弹窗出现
    updaterStateHandler.handler?.({ type: "available", version: "1.2.0", releaseNotes: "fix bugs" });
    await wrapper.vm.$nextTick();
    expect(document.body.textContent).toContain("New version available");
    // 弹窗点「Update Now」→ 调 downloadUpdate（updater:download）
    const confirmBtn = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
      .find((b) => b.textContent === "Update Now");
    expect(confirmBtn).toBeTruthy();
    confirmBtn!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bridge.invoke.mock.calls.some((c) => c[0] === "updater:download")).toBe(true);
    // 清理弹窗（Teleport 残留）
    const closeBtn = document.body.querySelector<HTMLButtonElement>(".modal-shell-close");
    closeBtn?.click();
    await wrapper.vm.$nextTick();
  });

  it("updater status progress renders percent in state area", async () => {
    const wrapper = mountPanel();
    await wrapper.findAll(".f-settings-nav-item")[5].trigger("click");
    updaterStateHandler.handler?.({ type: "progress", percent: 42 });
    await wrapper.vm.$nextTick();
    const tab = wrapper.find("[data-tab='about']");
    expect(tab.find(".about-updater-status").text()).toContain("42%");
  });

  it("updater status downloaded shows restart and triggers quit-and-install", async () => {
    const wrapper = mountPanel();
    await wrapper.findAll(".f-settings-nav-item")[5].trigger("click");
    const bridge = (window as unknown as { electronBridge: { invoke: ReturnType<typeof vi.fn> } }).electronBridge;
    bridge.invoke = vi.fn().mockImplementation((channel: string) => {
      if (channel === "provider:modelVariants") return Promise.resolve(["low", "high", "max"]);
      if (channel === "app:getInfo") return Promise.resolve({ name: "Fractal", version: "1.2.3", engineVersion: "1.18.15", presetVersion: "1.1.0" });
      if (channel.startsWith("updater:")) return Promise.resolve(undefined);
      return Promise.resolve({});
    });
    updaterStateHandler.handler?.({ type: "downloaded", version: "1.2.0" });
    await wrapper.vm.$nextTick();
    const tab = wrapper.find("[data-tab='about']");
    const restartBtn = tab.find(".about-updater-restart");
    expect(restartBtn.exists()).toBe(true);
    await restartBtn.trigger("click");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bridge.invoke.mock.calls.some((c) => c[0] === "updater:quit-and-install")).toBe(true);
  });

  it("updater status error renders message", async () => {
    const wrapper = mountPanel();
    await wrapper.findAll(".f-settings-nav-item")[5].trigger("click");
    updaterStateHandler.handler?.({ type: "error", message: "网络连接失败，请检查网络后重试" });
    await wrapper.vm.$nextTick();
    const tab = wrapper.find("[data-tab='about']");
    expect(tab.find(".about-updater-status").text()).toContain("Update check failed");
    expect(tab.find(".about-updater-status").text()).toContain("网络连接失败，请检查网络后重试");
  });
});
