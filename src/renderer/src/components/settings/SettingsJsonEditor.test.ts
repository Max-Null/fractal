// SettingsJsonEditor 测试：加载 settings.json 原文 → CodeMirror 渲染 → 保存走 settings:saveSettings（mock IPC）
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import SettingsJsonEditor from "./SettingsJsonEditor.vue";

// mock 桥：编辑器不依赖真实主进程，加载/保存返回可控数据（vi.hoisted：mock factory 提升到 import 之前）
const { getSettingsConfig, saveSettingsJson } = vi.hoisted(() => ({
  getSettingsConfig: vi.fn(),
  saveSettingsJson: vi.fn(),
}));
vi.mock("@/lib/electron-bridge", () => ({
  getSettingsConfig,
  saveSettingsJson,
}));

const i18n = createI18n({
  legacy: false,
  locale: "en",
  messages: {
    en: {
      settings: {
        save: "Save",
        saving: "Saving…",
        loading: "Loading…",
        jsonUnsaved: "Unsaved changes",
        jsonSavedAt: "Saved at",
        jsonHint: "JSONC supported",
      },
    },
  },
});

async function mountEditor() {
  const wrapper = mount(SettingsJsonEditor, { global: { plugins: [i18n] } });
  await flushPromises();
  return wrapper;
}

describe("SettingsJsonEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("加载时调用 getSettingsConfig 并渲染编辑器", async () => {
    getSettingsConfig.mockResolvedValue({
      config: { "ui.theme": "light" },
      warnings: [],
      jsoncText: '{ "ui.theme": "light" }',
    });
    const wrapper = await mountEditor();
    expect(getSettingsConfig).toHaveBeenCalled();
    // CodeMirror 内容已挂载（.cm-content 存在）
    expect(wrapper.find(".cm-content").exists()).toBe(true);
    expect(wrapper.text()).toContain("ui.theme");
  });

  it("加载返回 warnings → 展示校验提示", async () => {
    getSettingsConfig.mockResolvedValue({
      config: { "ui.theme": "dark" },
      warnings: ["ui.theme 非法值 red，已回退默认 dark"],
      jsoncText: '{ "ui.theme": "red" }',
    });
    const wrapper = await mountEditor();
    expect(wrapper.text()).toContain("ui.theme 非法值 red");
  });

  it("加载失败 → 展示错误信息", async () => {
    getSettingsConfig.mockRejectedValue(new Error("bridge unavailable"));
    const wrapper = await mountEditor();
    expect(wrapper.text()).toContain("bridge unavailable");
  });

  it("保存：取编辑器内容 → saveSettingsJson → 展示保存状态与 warnings", async () => {
    getSettingsConfig.mockResolvedValue({
      config: { "ui.theme": "light" },
      warnings: [],
      jsoncText: '{ "ui.theme": "light" }',
    });
    saveSettingsJson.mockResolvedValue({ ok: true, warnings: [] });
    const wrapper = await mountEditor();

    // 修改编辑器内容（CodeMirror 无法用原生 input 事件，直接改 doc）
    const cm = (wrapper.vm as unknown as { editorView: { state: { doc: { toString: () => string } } } | null }).editorView;
    expect(cm).toBeTruthy();
    await wrapper.find("button").trigger("click");
    await flushPromises();
    expect(saveSettingsJson).toHaveBeenCalledWith('{ "ui.theme": "light" }');
  });

  it("保存返回 warnings → 展示", async () => {
    getSettingsConfig.mockResolvedValue({
      config: { "ui.theme": "dark" },
      warnings: [],
      jsoncText: '{ "ui.theme": "dark" }',
    });
    saveSettingsJson.mockResolvedValue({ ok: true, warnings: ["ui.theme 非法值 red，已回退默认 dark"] });
    const wrapper = await mountEditor();
    await wrapper.find("button").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("ui.theme 非法值 red");
  });
});
