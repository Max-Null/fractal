import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { createI18n } from "vue-i18n";
import type { Pinia } from "pinia";
import { useSettingsStore } from "@/stores/settings";
import Onboarding from "./Onboarding.vue";

// mock electron-bridge：testConnection 由用例控制，其余 store 依赖返回 resolve 桩
const mocks = vi.hoisted(() => ({
  testConnection: vi.fn(),
}));

vi.mock("@/lib/electron-bridge", () => ({
  testConnection: mocks.testConnection,
  saveProviderConfig: vi.fn(() => Promise.resolve()),
  loadProviderConfigs: vi.fn(() => Promise.resolve({})),
  saveUiSettings: vi.fn(() => Promise.resolve()),
  loadUiSettings: vi.fn(() => Promise.resolve("{}")),
  listDir: vi.fn(() => Promise.resolve([])),
}));

const i18n = createI18n({
  legacy: false,
  locale: "en",
  messages: {
    en: {
      app: { title: "Fractal" },
      onboarding: {
        subtitle: "Your AI Workbench · Ready to use",
        step1: "Enter API Key",
        step2: "Test Connection",
        step3: "Done",
        apiKeyLabel: "DeepSeek API Key (required · stored locally)",
        apiKeyPlaceholder: "sk-...",
        apiKeyHint: "Get one from the DeepSeek open platform",
        showKey: "Show API Key",
        hideKey: "Hide API Key",
        test: "Test Connection",
        testing: "Testing…",
        retry: "Retry",
        testingHint: "Verifying API Key and engine connection…",
        success: "Connected, model ready",
        done: "All set",
        doneHint: "DeepSeek API configured. Start using Fractal now",
        start: "Get Started",
        skip: "Skip for now",
      },
      error: {
        httpError: "Network request failed: {error}",
        generic: "Error: {error}",
      },
    },
  },
});

let pinia: Pinia;

function mountOb() {
  return mount(Onboarding, {
    global: { plugins: [pinia, i18n] },
  });
}

describe("Onboarding", () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.testConnection.mockReset();
    pinia = createPinia();
    setActivePinia(pinia);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders brand, steps and key input", () => {
    const wrapper = mountOb();
    expect(wrapper.text()).toContain("Fractal");
    expect(wrapper.text()).toContain("Enter API Key");
    expect(wrapper.text()).toContain("Test Connection");
    expect(wrapper.find("input").exists()).toBe(true);
    // 步骤 1 输入框为 password 类型（可切换明文）
    expect(wrapper.find("input").attributes("type")).toBe("password");
  });

  it("skip emits skip event", async () => {
    const wrapper = mountOb();
    await wrapper.find(".ob-skip").trigger("click");
    expect(wrapper.emitted("skip")).toBeTruthy();
  });

  it("test button disabled until a key is entered", async () => {
    const wrapper = mountOb();
    expect(wrapper.find(".ob-primary").attributes("disabled")).toBeDefined();
    await wrapper.find("input").setValue("sk-test");
    expect(wrapper.find(".ob-primary").attributes("disabled")).toBeUndefined();
  });

  it("successful test goes to done page then finish emits", async () => {
    vi.useFakeTimers();
    mocks.testConnection.mockResolvedValue({ ok: true, message: "serve ok" });
    const wrapper = mountOb();
    await wrapper.find("input").setValue("sk-test");
    await wrapper.find(".ob-primary").trigger("click");
    // flush 微任务（testConnection → saveCurrentConfig 均为 resolve 桩）
    await vi.advanceTimersByTimeAsync(0);
    // 测试中状态结束后显示成功提示
    expect(wrapper.text()).toContain("Connected, model ready");
    // 700ms 后自动进入完成页
    await vi.advanceTimersByTimeAsync(700);
    expect(wrapper.text()).toContain("All set");
    expect(mocks.testConnection).toHaveBeenCalledWith("sk-test");
    // 开始使用 → finish
    await wrapper.find(".ob-primary").trigger("click");
    expect(wrapper.emitted("finish")).toBeTruthy();
  });

  it("failed test shows translated error and retry label", async () => {
    vi.useFakeTimers();
    mocks.testConnection.mockResolvedValue({ ok: false, message: "Connection refused" });
    const wrapper = mountOb();
    await wrapper.find("input").setValue("sk-test");
    await wrapper.find(".ob-primary").trigger("click");
    await vi.advanceTimersByTimeAsync(0);
    // translateError 映射为 httpError 文案
    expect(wrapper.text()).toContain("Network request failed: Connection refused");
    // 失败后主按钮变重试，停留在测试步骤
    expect(wrapper.find(".ob-primary").text()).toContain("Retry");
    expect(wrapper.text()).not.toContain("All set");
  });

  it("retry after failure calls testConnection again", async () => {
    vi.useFakeTimers();
    // 第一次失败，第二次成功
    mocks.testConnection
      .mockResolvedValueOnce({ ok: false, message: "timeout" })
      .mockResolvedValueOnce({ ok: true, message: "serve ok" });
    const wrapper = mountOb();
    await wrapper.find("input").setValue("sk-test");
    await wrapper.find(".ob-primary").trigger("click");
    await vi.advanceTimersByTimeAsync(0);
    expect(wrapper.find(".ob-primary").text()).toContain("Retry");
    // 点击重试 → 再次测试成功
    await wrapper.find(".ob-primary").trigger("click");
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.testConnection).toHaveBeenCalledTimes(2);
    expect(wrapper.text()).toContain("Connected, model ready");
  });

  it("key input is stored to settings store", async () => {
    const settings = useSettingsStore();
    const wrapper = mountOb();
    await wrapper.find("input").setValue("sk-stored");
    expect(settings.apiKey).toBe("sk-stored");
  });
});
