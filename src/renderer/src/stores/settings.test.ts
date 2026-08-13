import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { nextTick } from "vue";
import { useSettingsStore } from "./settings";
import { useSessionStore } from "./session";
import { useChatStore } from "./chat";

describe("settings store", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    // mock electronBridge：store 的 watch(model, immediate) 会拉取模型 variants，
    // 测试环境无 bridge 时 loadModelVariants 抛错 → modelVariants=[] → effort 被清空，破坏默认值断言。
    // 模拟默认 pro 模型（deepseek-v4-pro）返回 ['high','max']，effort 默认 high 保留。
    (window as unknown as { electronBridge: unknown }).electronBridge = {
      invoke: vi.fn().mockImplementation((channel: string) => {
        if (channel === "provider:modelVariants") return Promise.resolve(["high", "max"]);
        // session:list：setDataMode 成功链路会重拉会话列表，必须返回数组（否则 .map 抛错）
        if (channel === "session:list") return Promise.resolve([]);
        // engine:refresh：默认成功（setDataMode 成功后走清缓存/重拉分支；失败场景测试单独覆盖）
        if (channel === "engine:refresh") return Promise.resolve({ ok: true });
        return Promise.resolve({});
      }),
      on: vi.fn().mockReturnValue(() => {}),
    };
  });

  it("has default values", () => {
    const settings = useSettingsStore();
    expect(settings.baseUrl).toBe("https://api.deepseek.com");
    expect(settings.model).toBe("deepseek-v4-pro[1M]");
    expect(settings.planMode).toBe(false);
    expect(settings.autoMode).toBe(true);
    expect(settings.permissionMode).toBe("bypassPermissions");
    expect(settings.effort).toBe("high");
    // 默认主 agent = 分形预置「双星」（D15：oc-plus 四 agent 协作的主 agent）
    expect(settings.currentAgent).toBe("双星");
    expect(settings.theme).toBe("dark");
    expect(settings.locale).toBe("zh");
  });

  it("can change API settings", () => {
    const settings = useSettingsStore();
    settings.apiKey = "sk-test-key";
    settings.baseUrl = "https://custom.api.com";
    settings.model = "custom-model";

    expect(settings.apiKey).toBe("sk-test-key");
    expect(settings.baseUrl).toBe("https://custom.api.com");
    expect(settings.model).toBe("custom-model");
  });

  it("persists UI preferences to localStorage", async () => {
    const settings = useSettingsStore();
    settings.theme = "light";
    await nextTick();

    const raw = localStorage.getItem("sb-ui-settings");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.theme).toBe("light");
  });

  it("persists effort（variant 值）to localStorage", async () => {
    const settings = useSettingsStore();
    settings.effort = "max";
    await nextTick();

    const raw = localStorage.getItem("sb-ui-settings");
    const parsed = JSON.parse(raw!);
    // 持久化字段值即 variant 名（不再是旧 6 档枚举）
    expect(parsed.effort).toBe("max");
  });

  it("loads UI preferences from localStorage on init", () => {
    localStorage.setItem(
      "sb-ui-settings",
      JSON.stringify({ planMode: true, autoMode: false, permissionMode: "default", effort: "xhigh", theme: "light", locale: "en", fontSize: "medium" })
    );

    setActivePinia(createPinia());
    const settings = useSettingsStore();
    expect(settings.locale).toBe("en");
    expect(settings.planMode).toBe(true);
    expect(settings.autoMode).toBe(false);
    expect(settings.permissionMode).toBe("default");
    expect(settings.theme).toBe("light");
    // 旧 6 档 effort 读入归一为 variant（xhigh → high）
    expect(settings.effort).toBe("high");
  });

  it("switches between plan and auto mode", () => {
    const settings = useSettingsStore();
    settings.planMode = true;
    expect(settings.planMode).toBe(true);
    settings.autoMode = true;
    expect(settings.autoMode).toBe(true);
  });

  it("switches permission modes", () => {
    const settings = useSettingsStore();
    settings.permissionMode = "acceptEdits";
    expect(settings.permissionMode).toBe("acceptEdits");
    settings.permissionMode = "bypassPermissions";
    expect(settings.permissionMode).toBe("bypassPermissions");
  });

  it("switches effort (variant) levels", () => {
    const settings = useSettingsStore();
    settings.effort = "low";
    expect(settings.effort).toBe("low");
    settings.effort = "high";
    expect(settings.effort).toBe("high");
    settings.effort = "max";
    expect(settings.effort).toBe("max");
    settings.effort = "";
    expect(settings.effort).toBe("");
  });

  it("modelVariants setter：无 variants → effort 清空（模型无思考强度不传）", () => {
    const settings = useSettingsStore();
    settings.setModelVariants([]);
    expect(settings.modelVariants).toEqual([]);
    expect(settings.effort).toBe("");
  });

  it("modelVariants setter：variants 不含当前 effort → 归一到 high（默认档）", () => {
    const settings = useSettingsStore();
    settings.effort = "low";
    settings.setModelVariants(["high", "max"]);
    expect(settings.modelVariants).toEqual(["high", "max"]);
    expect(settings.effort).toBe("high");
  });

  it("modelVariants setter：variants 含当前 effort → 保留", () => {
    const settings = useSettingsStore();
    settings.effort = "max";
    settings.setModelVariants(["low", "high", "max"]);
    expect(settings.modelVariants).toEqual(["low", "high", "max"]);
    expect(settings.effort).toBe("max");
  });

  it("switches currentAgent and persists to localStorage", async () => {
    const settings = useSettingsStore();
    settings.currentAgent = "plan";
    await nextTick();

    const raw = localStorage.getItem("sb-ui-settings");
    const parsed = JSON.parse(raw!);
    expect(parsed.currentAgent).toBe("plan");
  });

  it("toggles between dark and light theme", () => {
    const settings = useSettingsStore();
    expect(settings.theme).toBe("dark");
    settings.theme = "light";
    expect(settings.theme).toBe("light");
    settings.theme = "dark";
    expect(settings.theme).toBe("dark");
  });

  it("contextLimit defaults to 0 (auto-detect)", () => {
    const settings = useSettingsStore();
    expect(settings.contextLimit).toBe(0);
  });

  it("contextLimit can be set manually", () => {
    const settings = useSettingsStore();
    settings.contextLimit = 128000;
    expect(settings.contextLimit).toBe(128000);
  });

  it("saves current config and restores it", async () => {
    const settings = useSettingsStore();

    // 保存 DeepSeek 配置（分形唯一 provider）
    settings.providerId = "deepseek";
    settings.apiKey = "sk-ds-test";
    settings.baseUrl = "https://api.deepseek.com";
    settings.model = "deepseek-v4-pro[1M]";
    await settings.saveCurrentConfig();

    // 模拟切走再切回：清空后 restoreConfig 应恢复已保存值
    settings.apiKey = "";
    settings.restoreConfig("deepseek");
    expect(settings.apiKey).toBe("sk-ds-test");
    expect(settings.baseUrl).toBe("https://api.deepseek.com");
    expect(settings.model).toBe("deepseek-v4-pro[1M]");
  });

  it("saveKimiKey：写 moonshotai-cn 槽位（仅 apiKey，无 baseUrl/model）", async () => {
    const settings = useSettingsStore();
    const bridge = (window as unknown as { electronBridge: { invoke: ReturnType<typeof vi.fn> } }).electronBridge;
    settings.kimiApiKey = "sk-kimi-test";
    await settings.saveKimiKey(true);
    const saveCalls = bridge.invoke.mock.calls.filter((c) => c[0] === "settings:saveProviderConfig");
    expect(saveCalls.length).toBeGreaterThanOrEqual(1);
    const arg = saveCalls.at(-1)![1] as { providerId: string; apiKey: string; restart: boolean };
    expect(arg.providerId).toBe("moonshotai-cn");
    expect(arg.apiKey).toBe("sk-kimi-test");
    expect(arg.restart).toBe(true);
  });

  it("initFromDb 恢复 kimiApiKey（moonshotai-cn 条目已有 key）", async () => {
    const bridge = (window as unknown as { electronBridge: { invoke: ReturnType<typeof vi.fn> } }).electronBridge;
    bridge.invoke.mockImplementation((channel: string) => {
      if (channel === "provider:modelVariants") return Promise.resolve(["high", "max"]);
      if (channel === "settings:loadProviderConfigs") return Promise.resolve({ "moonshotai-cn": { apiKey: "sk-kimi" } });
      if (channel === "settings:loadUiSettings") return Promise.resolve("{}");
      if (channel === "settings:getConfig") return Promise.resolve({ config: {}, exists: false });
      return Promise.resolve({});
    });
    const settings = useSettingsStore();
    await settings.initFromDb();
    expect(settings.kimiApiKey).toBe("sk-kimi");
  });

  it("onboarding dismiss flag persists to localStorage", () => {
    const settings = useSettingsStore();
    expect(settings.onboardingDismissed).toBe(false);
    settings.markOnboardingDismissed();
    expect(settings.onboardingDismissed).toBe(true);
    expect(localStorage.getItem("sb-onboarding-dismissed")).toBe("1");
  });

  it("onboarding dismiss flag loads from localStorage and can reset", () => {
    localStorage.setItem("sb-onboarding-dismissed", "1");
    setActivePinia(createPinia());
    const settings = useSettingsStore();
    expect(settings.onboardingDismissed).toBe(true);
    settings.resetOnboarding();
    expect(settings.onboardingDismissed).toBe(false);
    expect(localStorage.getItem("sb-onboarding-dismissed")).toBeNull();
  });

  // ── settings.json 合并（阶段 6 config-changed 事件 / 启动拉取共用 applySettingsJson）──

  it("applySettingsJson：ui.theme / ui.language 即时生效（settings.json 文件真实存在时）", () => {
    const settings = useSettingsStore();
    expect(settings.theme).toBe("dark");
    expect(settings.locale).toBe("zh");
    settings.settingsFileExists = true;  // 模拟 settings.json 已存在（用户/GUI/agent 保存过）
    settings.applySettingsJson({ "ui.theme": "light", "ui.language": "en" });
    expect(settings.theme).toBe("light");
    expect(settings.locale).toBe("en");
  });

  it("applySettingsJson：默认态（settings.json 不存在）不覆盖表单主题——主题持久化修复", () => {
    const settings = useSettingsStore();
    settings.theme = "light";  // 用户表单选择了亮色（已持久化）
    // 启动时 settings.json 不存在 → 广播默认值（ui.theme=dark）——不应覆盖用户选择
    settings.applySettingsJson({ "ui.theme": "dark" });
    expect(settings.theme).toBe("light");
    expect(settings.locale).toBe("zh");
  });

  it("applySettingsJson：settings.json 无 system 主题，不覆盖表单的跟随系统", () => {
    const settings = useSettingsStore();
    settings.theme = "system";
    // 未知/非法主题值 → 保持表单当前值（仅 dark/light 覆盖）
    settings.applySettingsJson({ "ui.theme": "neon" });
    expect(settings.theme).toBe("system");
  });

  it("applySettingsJson：deepseek.model 同步（pro 映射为 [1M] 显示名）", () => {
    const settings = useSettingsStore();
    settings.model = "deepseek-v4-flash";
    settings.applySettingsJson({ "deepseek.model": "deepseek-v4-pro" });
    expect(settings.model).toBe("deepseek-v4-pro[1M]");
    settings.applySettingsJson({ "deepseek.model": "deepseek-v4-flash" });
    expect(settings.model).toBe("deepseek-v4-flash");
  });

  it("applySettingsJson：agent.permissionMode 四值 → plan/auto/permissionMode 三联动", () => {
    const settings = useSettingsStore();
    // plan → planMode 开、autoMode 关
    settings.applySettingsJson({ "agent.permissionMode": "plan" });
    expect(settings.planMode).toBe(true);
    expect(settings.autoMode).toBe(false);
    // auto → autoMode 开
    settings.applySettingsJson({ "agent.permissionMode": "auto" });
    expect(settings.autoMode).toBe(true);
    expect(settings.planMode).toBe(false);
    // default / acceptEdits → permissionMode 落点
    settings.applySettingsJson({ "agent.permissionMode": "acceptEdits" });
    expect(settings.permissionMode).toBe("acceptEdits");
    expect(settings.planMode).toBe(false);
    expect(settings.autoMode).toBe(false);
    settings.applySettingsJson({ "agent.permissionMode": "default" });
    expect(settings.permissionMode).toBe("default");
  });

  it("applySettingsJson：agent.effort / agent.contextLimit 同步（旧档位 medium 归一到 low）", () => {
    const settings = useSettingsStore();
    settings.applySettingsJson({ "agent.effort": "medium", "agent.contextLimit": 128000 });
    expect(settings.effort).toBe("low");
    expect(settings.contextLimit).toBe(128000);
    // variant 值原样生效
    settings.applySettingsJson({ "agent.effort": "max" });
    expect(settings.effort).toBe("max");
    settings.applySettingsJson({ "agent.effort": "high" });
    expect(settings.effort).toBe("high");
  });

  // ── 数据模式（dataMode 开关，方案 D1-D9 军师 P0）──

  it("dataMode 默认 isolated；isRestarting 默认 false", () => {
    const settings = useSettingsStore();
    expect(settings.dataMode).toBe("isolated");
    expect(settings.isRestarting).toBe(false);
  });

  it("applySettingsJson 同步 dataMode（非法/缺失保持当前值）", () => {
    const settings = useSettingsStore();
    settings.applySettingsJson({ dataMode: "shared" });
    expect(settings.dataMode).toBe("shared");
    settings.applySettingsJson({ dataMode: "isolated" });
    expect(settings.dataMode).toBe("isolated");
    // 非法值不覆盖（config-changed 广播可能带脏值）
    settings.applySettingsJson({ dataMode: "weird" });
    expect(settings.dataMode).toBe("isolated");
  });

  // ── B1：messageLayout / nickname / avatar / opencodePath / logLevel / presetSkillsEnabled ──

  it("B1 默认值：messageLayout=split（现状一致）、nickname/avatar 空、opencodePath 空、logLevel=INFO、presetSkillsEnabled=true", () => {
    const settings = useSettingsStore();
    expect(settings.messageLayout).toBe("split");
    expect(settings.nickname).toBe("");
    expect(settings.avatar).toBe("");
    expect(settings.opencodePath).toBe("");
    expect(settings.logLevel).toBe("INFO");
    expect(settings.presetSkillsEnabled).toBe(true);
  });

  it("applySettingsJson 同步 6 个 B1 字段（非法/缺失保持当前值）", () => {
    const settings = useSettingsStore();
    settings.applySettingsJson({
      "ui.messageLayout": "left",
      "ui.nickname": "小明",
      "ui.avatar": "🐱",
      "engine.opencodePath": "C:\\tools\\opencode.exe",
      "engine.logLevel": "DEBUG",
      "preset.skills.enabled": false,
    });
    expect(settings.messageLayout).toBe("left");
    expect(settings.nickname).toBe("小明");
    expect(settings.avatar).toBe("🐱");
    expect(settings.opencodePath).toBe("C:\\tools\\opencode.exe");
    expect(settings.logLevel).toBe("DEBUG");
    expect(settings.presetSkillsEnabled).toBe(false);
    // 非法值不覆盖：messageLayout 白名单、logLevel 白名单、preset 需 boolean
    settings.applySettingsJson({ "ui.messageLayout": "weird", "engine.logLevel": "VERBOSE", "preset.skills.enabled": "yes" });
    expect(settings.messageLayout).toBe("left");
    expect(settings.logLevel).toBe("DEBUG");
    expect(settings.presetSkillsEnabled).toBe(false);
  });

  it("setDataMode 成功：写 settings.json（合并 dataMode）→ 停止活跃会话 → 刷新引擎 → 清缓存 → 重拉会话列表", async () => {
    const settings = useSettingsStore();
    // 默认 isolated（2026-08-12 起）；模拟用户从 shared 切到 isolated 的切换场景
    settings.applySettingsJson({ dataMode: "shared" });
    const sessionStore = useSessionStore();
    sessionStore.setActiveSession("ses-1");
    const chat = useChatStore();
    chat.addUserMessage("Hi");
    chat.saveSessionCache("ses-1");
    const bridge = (window as unknown as { electronBridge: { invoke: ReturnType<typeof vi.fn> } }).electronBridge;

    const r = await settings.setDataMode("isolated");
    expect(r).toEqual({ ok: true, mode: "isolated" });
    expect(settings.dataMode).toBe("isolated");
    expect(settings.isRestarting).toBe(false);

    // 写 settings.json：合并 dataMode（getSettingsConfig 返回空 config → {dataMode}）
    const saveCalls = bridge.invoke.mock.calls.filter((c) => c[0] === "settings:saveSettings");
    expect(saveCalls.length).toBeGreaterThanOrEqual(1);
    const jsonc = JSON.parse(saveCalls.at(-1)![1].jsoncText);
    expect(jsonc.dataMode).toBe("isolated");
    // 停止活跃流（防 isStreaming 悬挂）
    expect(bridge.invoke.mock.calls.some((c) => c[0] === "chat:stopSession" && c[1]?.sessionId === "ses-1")).toBe(true);
    // 刷新引擎
    expect(bridge.invoke.mock.calls.some((c) => c[0] === "engine:refresh")).toBe(true);
    // 会话缓存清空 + 活跃会话重置
    expect(chat.sessionCache.size).toBe(0);
    expect(sessionStore.activeSessionId).toBe("");
    // 重新拉会话列表（serve 数据目录已切换）
    expect(bridge.invoke.mock.calls.some((c) => c[0] === "session:list")).toBe(true);
  });

  it("setDataMode 失败：回滚旧值 → 二次刷新成功 → 返回 error（引擎未停摆）", async () => {
    const settings = useSettingsStore();
    // 默认 isolated：先切到 shared 模拟「从 shared 尝试切 isolated」的场景
    settings.applySettingsJson({ dataMode: "shared" });
    const bridge = (window as unknown as { electronBridge: { invoke: ReturnType<typeof vi.fn> } }).electronBridge;
    // 第一次 engine:refresh 失败、第二次成功（回滚后恢复）
    let refreshCount = 0;
    bridge.invoke.mockImplementation((channel: string) => {
      if (channel === "provider:modelVariants") return Promise.resolve(["high", "max"]);
      if (channel === "session:list") return Promise.resolve([]);
      if (channel === "engine:refresh") {
        refreshCount++;
        return Promise.resolve(refreshCount === 1 ? { ok: false, error: "serve 连续 3 次启动失败" } : { ok: true });
      }
      return Promise.resolve({});
    });

    const r = await settings.setDataMode("isolated");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("已恢复原模式");
    expect(settings.dataMode).toBe("shared"); // 已还原旧值
    expect(settings.isRestarting).toBe(false);
    // 写回两次：isolated（尝试）→ shared（回滚）
    const saveCalls = bridge.invoke.mock.calls.filter((c) => c[0] === "settings:saveSettings");
    expect(saveCalls).toHaveLength(2);
    expect(JSON.parse(saveCalls[0]![1].jsoncText).dataMode).toBe("isolated");
    expect(JSON.parse(saveCalls[1]![1].jsoncText).dataMode).toBe("shared");
    expect(refreshCount).toBe(2);
  });

  it("setDataMode 二次刷新也失败 → 返回引擎错误（引擎停摆风险提示）", async () => {
    const settings = useSettingsStore();
    settings.applySettingsJson({ dataMode: "shared" });
    const bridge = (window as unknown as { electronBridge: { invoke: ReturnType<typeof vi.fn> } }).electronBridge;
    bridge.invoke.mockImplementation((channel: string) => {
      if (channel === "provider:modelVariants") return Promise.resolve(["high", "max"]);
      if (channel === "session:list") return Promise.resolve([]);
      if (channel === "engine:refresh") return Promise.resolve({ ok: false, error: "serve 连续 3 次启动失败" });
      return Promise.resolve({});
    });

    const r = await settings.setDataMode("isolated");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("serve 连续 3 次启动失败");
    expect(settings.dataMode).toBe("shared");
    expect(settings.isRestarting).toBe(false);
  });

  it("setDataMode 同值/切换中 → 直接返回不重复执行", async () => {
    const settings = useSettingsStore();
    const bridge = (window as unknown as { electronBridge: { invoke: ReturnType<typeof vi.fn> } }).electronBridge;
    // 默认 isolated（2026-08-12 起）：同值调用直接返回
    const r = await settings.setDataMode("isolated");
    expect(r.ok).toBe(true);
    const refreshCalls = bridge.invoke.mock.calls.filter((c) => c[0] === "engine:refresh");
    expect(refreshCalls).toHaveLength(0);
  });

  // ── 轻量模型（smallModel，LOW 槽位）──

  it("smallModel 默认空（跟随主模型）", () => {
    const settings = useSettingsStore();
    expect(settings.smallModel).toBe("");
  });

  it("applySettingsJson 同步 smallModel（白名单值生效）", () => {
    const settings = useSettingsStore();
    settings.applySettingsJson({ smallModel: "deepseek/deepseek-v4-pro" });
    expect(settings.smallModel).toBe("deepseek/deepseek-v4-pro");
    settings.applySettingsJson({ smallModel: "" });
    expect(settings.smallModel).toBe("");
  });

  it("applySettingsJson 非法 smallModel 不覆盖（保持当前值）", () => {
    const settings = useSettingsStore();
    settings.smallModel = "deepseek/deepseek-v4-pro";
    settings.applySettingsJson({ smallModel: "gpt-4o" });
    expect(settings.smallModel).toBe("deepseek/deepseek-v4-pro");
    settings.applySettingsJson({ smallModel: 42 });
    expect(settings.smallModel).toBe("deepseek/deepseek-v4-pro");
  });

  it("persistSmallModel 合并写 settings.json（不覆盖文件其他字段）", async () => {
    const settings = useSettingsStore();
    const bridge = (window as unknown as { electronBridge: { invoke: ReturnType<typeof vi.fn> } }).electronBridge;
    // getSettingsConfig 返回已有字段（ui.theme），persistSmallModel 应保留
    bridge.invoke.mockImplementation((channel: string) => {
      if (channel === "provider:modelVariants") return Promise.resolve(["high", "max"]);
      if (channel === "settings:getConfig") return Promise.resolve({ config: { "ui.theme": "light" } });
      if (channel === "settings:saveSettings") return Promise.resolve({ ok: true, warnings: [] });
      return Promise.resolve({});
    });
    await settings.persistSmallModel("deepseek/deepseek-v4-flash");
    const saveCalls = bridge.invoke.mock.calls.filter((c) => c[0] === "settings:saveSettings");
    expect(saveCalls).toHaveLength(1);
    const jsonc = JSON.parse(saveCalls[0]![1].jsoncText);
    expect(jsonc.smallModel).toBe("deepseek/deepseek-v4-flash");
    expect(jsonc["ui.theme"]).toBe("light"); // 保留文件其他字段
  });

  // ── 设置页重构：showThinking / avatarImage / notifications / agentModelOverrides ──

  it("新字段默认值：showThinking=true、avatarImage 空、notifications 5 子项、agentModelOverrides 空", () => {
    const settings = useSettingsStore();
    expect(settings.showThinking).toBe(true);
    expect(settings.avatarImage).toBe("");
    expect(settings.notifications).toEqual({
      enabled: false,
      replyDone: true,
      engineError: false,
      permissionPending: false,
      subtaskDone: false,
    });
    expect(settings.agentModelOverrides).toEqual({});
  });

  it("applySettingsJson 解析 4 个新字段（部分 notifications 子项缺失保留默认）", () => {
    const settings = useSettingsStore();
    settings.applySettingsJson({
      "ui.showThinking": false,
      "ui.avatarImage": "avatar.png",
      "ui.notifications": { enabled: true, replyDone: false, engineError: true },
      agentModelOverrides: { 双星: "deepseek/deepseek-v4-pro", 工匠: "deepseek/deepseek-v4-flash" },
    });
    expect(settings.showThinking).toBe(false);
    expect(settings.avatarImage).toBe("avatar.png");
    expect(settings.notifications.enabled).toBe(true);
    expect(settings.notifications.replyDone).toBe(false);
    expect(settings.notifications.engineError).toBe(true);
    // 未提供的子项保留默认（config-changed 广播可能只带部分字段）
    expect(settings.notifications.permissionPending).toBe(false);
    expect(settings.notifications.subtaskDone).toBe(false);
    expect(settings.agentModelOverrides).toEqual({
      双星: "deepseek/deepseek-v4-pro",
      工匠: "deepseek/deepseek-v4-flash",
    });
  });

  it("applySettingsJson 非法新字段不覆盖（保持当前值）", () => {
    const settings = useSettingsStore();
    settings.showThinking = false;
    settings.avatarImage = "avatar.png";
    settings.applySettingsJson({ "ui.showThinking": "yes", "ui.avatarImage": 42, "ui.notifications": "on", agentModelOverrides: [] });
    expect(settings.showThinking).toBe(false);
    expect(settings.avatarImage).toBe("avatar.png");
    expect(settings.notifications).toEqual({
      enabled: false,
      replyDone: true,
      engineError: false,
      permissionPending: false,
      subtaskDone: false,
    });
    expect(settings.agentModelOverrides).toEqual({});
  });

  it("showThinking 变化持久化到 localStorage（ui 三写链第一链）", async () => {
    const settings = useSettingsStore();
    settings.showThinking = false;
    await nextTick();
    const parsed = JSON.parse(localStorage.getItem("sb-ui-settings")!);
    expect(parsed.showThinking).toBe(false);
  });

  it("showThinking 变化同步写 settings.json（themeSync 防抖链，ui.showThinking 且保留其他字段）", async () => {
    const settings = useSettingsStore();
    const bridge = (window as unknown as { electronBridge: { invoke: ReturnType<typeof vi.fn> } }).electronBridge;
    bridge.invoke.mockImplementation((channel: string) => {
      if (channel === "provider:modelVariants") return Promise.resolve(["high", "max"]);
      if (channel === "settings:getConfig") return Promise.resolve({ config: { "ui.theme": "dark" } });
      if (channel === "settings:saveSettings") return Promise.resolve({ ok: true, warnings: [] });
      return Promise.resolve({});
    });
    settings.showThinking = false;
    // themeSync 链 800ms 防抖，等待写盘完成
    await new Promise((r) => setTimeout(r, 900));
    const saveCalls = bridge.invoke.mock.calls.filter((c) => c[0] === "settings:saveSettings");
    expect(saveCalls.length).toBeGreaterThanOrEqual(1);
    const jsonc = JSON.parse(saveCalls.at(-1)![1].jsoncText);
    expect(jsonc["ui.showThinking"]).toBe(false);
    expect(jsonc["ui.theme"]).toBe("dark"); // 保留文件其他字段
  });

  it("setAgentModelOverride：设置覆盖 → 更新 ref + 合并写 settings.json（agentModelOverrides 顶层字段）", async () => {
    const settings = useSettingsStore();
    const bridge = (window as unknown as { electronBridge: { invoke: ReturnType<typeof vi.fn> } }).electronBridge;
    bridge.invoke.mockImplementation((channel: string) => {
      if (channel === "provider:modelVariants") return Promise.resolve(["high", "max"]);
      if (channel === "settings:getConfig") return Promise.resolve({ config: { "ui.theme": "dark" } });
      if (channel === "settings:saveSettings") return Promise.resolve({ ok: true, warnings: [] });
      return Promise.resolve({});
    });
    await settings.setAgentModelOverride("双星", "deepseek/deepseek-v4-pro");
    expect(settings.agentModelOverrides["双星"]).toBe("deepseek/deepseek-v4-pro");
    const saveCalls = bridge.invoke.mock.calls.filter((c) => c[0] === "settings:saveSettings");
    const jsonc = JSON.parse(saveCalls.at(-1)![1].jsoncText);
    expect(jsonc.agentModelOverrides).toEqual({ 双星: "deepseek/deepseek-v4-pro" });
    expect(jsonc["ui.theme"]).toBe("dark"); // 保留文件其他字段
  });

  it("setAgentModelOverride(null)：删除覆盖，空表时移除 agentModelOverrides key", async () => {
    const settings = useSettingsStore();
    const bridge = (window as unknown as { electronBridge: { invoke: ReturnType<typeof vi.fn> } }).electronBridge;
    bridge.invoke.mockImplementation((channel: string) => {
      if (channel === "provider:modelVariants") return Promise.resolve(["high", "max"]);
      if (channel === "settings:getConfig") return Promise.resolve({ config: { "ui.theme": "dark" } });
      if (channel === "settings:saveSettings") return Promise.resolve({ ok: true, warnings: [] });
      return Promise.resolve({});
    });
    await settings.setAgentModelOverride("双星", "deepseek/deepseek-v4-pro");
    await settings.setAgentModelOverride("双星", null);
    expect(settings.agentModelOverrides["双星"]).toBeUndefined();
    const saveCalls = bridge.invoke.mock.calls.filter((c) => c[0] === "settings:saveSettings");
    const jsonc = JSON.parse(saveCalls.at(-1)![1].jsoncText);
    expect(jsonc.agentModelOverrides).toBeUndefined();
  });

  it("pickAvatar：bridge 成功 → avatarImage 写入文件名", async () => {
    const settings = useSettingsStore();
    const bridge = (window as unknown as { electronBridge: { invoke: ReturnType<typeof vi.fn> } }).electronBridge;
    bridge.invoke.mockImplementation((channel: string) => {
      if (channel === "provider:modelVariants") return Promise.resolve(["high", "max"]);
      if (channel === "avatar:pick") return Promise.resolve({ ok: true, filename: "avatar.png" });
      return Promise.resolve({});
    });
    await settings.pickAvatar();
    expect(settings.avatarImage).toBe("avatar.png");
  });

  it("pickAvatar：用户取消 → avatarImage 不变", async () => {
    const settings = useSettingsStore();
    const bridge = (window as unknown as { electronBridge: { invoke: ReturnType<typeof vi.fn> } }).electronBridge;
    bridge.invoke.mockImplementation((channel: string) => {
      if (channel === "provider:modelVariants") return Promise.resolve(["high", "max"]);
      if (channel === "avatar:pick") return Promise.resolve({ ok: false });
      return Promise.resolve({});
    });
    await settings.pickAvatar();
    expect(settings.avatarImage).toBe("");
  });

  it("clearAvatar：bridge 成功 → avatarImage 清空（回退 emoji 兜底）", async () => {
    const settings = useSettingsStore();
    settings.applySettingsJson({ "ui.avatarImage": "avatar.png" });
    const bridge = (window as unknown as { electronBridge: { invoke: ReturnType<typeof vi.fn> } }).electronBridge;
    bridge.invoke.mockImplementation((channel: string) => {
      if (channel === "provider:modelVariants") return Promise.resolve(["high", "max"]);
      if (channel === "avatar:clear") return Promise.resolve({ ok: true });
      return Promise.resolve({});
    });
    await settings.clearAvatar();
    expect(settings.avatarImage).toBe("");
  });
});
