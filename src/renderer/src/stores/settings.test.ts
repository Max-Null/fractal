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
      JSON.stringify({ planMode: true, autoMode: false, permissionMode: "default", effort: "xhigh", theme: "light", locale: "en", fontSize: "medium", ponytailMode: "full", claudePath: "" })
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

  it("saves current config and restores per-provider config", async () => {
    const settings = useSettingsStore();

    // 模拟在 DeepSeek provider 上的配置
    settings.providerId = "deepseek";
    settings.apiKey = "sk-ds-test";
    settings.baseUrl = "https://api.deepseek.com";
    settings.model = "deepseek-v4-pro[1M]";
    await settings.saveCurrentConfig();

    // 模拟切换到 Anthropic（switchProvider 的正确顺序）
    settings.saveCurrentConfig(); // 先保存旧值（deepseek）
    settings.restoreConfig("anthropic"); // 恢复目标值（无记录，用默认）
    settings.providerId = "anthropic"; // 最后切 providerId
    // anthropic 无已保存配置，apiKey 应清空，baseUrl 用默认
    expect(settings.apiKey).toBe("");
    expect(settings.baseUrl).toBe("");

    // 填 Anthropic key
    settings.apiKey = "sk-ant-test";
    settings.model = "claude-sonnet-4-6";
    await settings.saveCurrentConfig();

    // 切回 DeepSeek
    settings.saveCurrentConfig();
    settings.restoreConfig("deepseek");
    settings.providerId = "deepseek";
    // 应恢复之前保存的 DeepSeek 值
    expect(settings.apiKey).toBe("sk-ds-test");
    expect(settings.baseUrl).toBe("https://api.deepseek.com");
    expect(settings.model).toBe("deepseek-v4-pro[1M]");
  });
});
