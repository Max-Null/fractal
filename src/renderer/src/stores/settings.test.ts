import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { nextTick } from "vue";
import { useSettingsStore } from "./settings";

describe("settings store", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
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

  it("switches effort levels including ultracode", () => {
    const settings = useSettingsStore();
    settings.effort = "xhigh";
    expect(settings.effort).toBe("xhigh");
    settings.effort = "ultracode";
    expect(settings.effort).toBe("ultracode");
    settings.effort = "low";
    expect(settings.effort).toBe("low");
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

  it("applySettingsJson：agent.effort / agent.contextLimit 同步", () => {
    const settings = useSettingsStore();
    settings.applySettingsJson({ "agent.effort": "medium", "agent.contextLimit": 128000 });
    expect(settings.effort).toBe("medium");
    expect(settings.contextLimit).toBe(128000);
  });
});
