import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { setActivePinia, createPinia } from "pinia";
import InputBar from "./InputBar.vue";
import { useSettingsStore } from "@/stores/settings";

const i18n = createI18n({
  legacy: false,
  locale: "en",
  fallbackLocale: "en",
  messages: {
    en: {
      chat: { placeholder: "Type a message, Enter to send...", stop: "Stop", send: "Send", remove: "Remove" },
      toolbar: { attach: "Attach", attachTitle: "Attach file", slashTitle: "Quick slash", commandsTitle: "Commands" },
      composer: {
        chipHint: "Attach files / reference files · Auto-parsed in input",
        agentTitle: "Primary agent",
        agentShuangxing: "Fractal default",
        agentBuild: "Built-in · All tools available",
        agentPlan: "Built-in · Read-only · Plan first",
        modelTitle: "Session model",
        modelFlash: "Default · Stable · Fast",
        modelPro: "Preview · Stronger reasoning",
        permTitle: "Permission mode",
        effortTitle: "Reasoning effort",
        sendHint: "Shift+Enter ↵",
      },
      mode: {
        plan: "Plan mode",
        askBefore: "Ask before edits",
        editAuto: "Edit automatically",
        auto: "Auto mode",
        bypass: "Bypass",
        dontAsk: "Don't Ask",
        effort: { low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max", ultracode: "UltraCode" },
      },
      effortWarning: "xhigh + DeepSeek may cause API errors",
    },
  },
});

// 共享 pinia：组件内 useSettingsStore 与测试断言必须指向同一实例
let pinia: ReturnType<typeof createPinia>;
function mountInputBar(props: Record<string, unknown> = {}) {
  return mount(InputBar, {
    props: { disabled: false, ...props },
    global: { plugins: [i18n, pinia] },
  });
}

/** InputBar composer：发送按钮带文字（title=Send），处理中显示停止按钮（title=Stop） */
function findSendBtn(wrapper: ReturnType<typeof mountInputBar>) {
  return wrapper.find("button[title='Send']");
}

describe("InputBar", () => {
  beforeEach(() => {
    localStorage.clear();
    pinia = createPinia();
    setActivePinia(pinia);
  });

  it("emits send with trimmed text on button click", async () => {
    const wrapper = mountInputBar();

    const textarea = wrapper.find("textarea");
    await textarea.setValue("  Hello World  ");
    await findSendBtn(wrapper).trigger("click");

    expect(wrapper.emitted("send")).toBeTruthy();
    expect(wrapper.emitted("send")![0]).toEqual(["Hello World"]);
    // Input should clear after send
    expect(textarea.element.value).toBe("");
  });

  it("emits send on Enter key", async () => {
    const wrapper = mountInputBar();

    const textarea = wrapper.find("textarea");
    await textarea.setValue("Test message");
    await textarea.trigger("keydown", { key: "Enter", shiftKey: false });

    expect(wrapper.emitted("send")).toBeTruthy();
    expect(wrapper.emitted("send")![0]).toEqual(["Test message"]);
  });

  it("allows newline on Shift+Enter", async () => {
    const wrapper = mountInputBar();

    const textarea = wrapper.find("textarea");
    await textarea.trigger("keydown", { key: "Enter", shiftKey: true });

    // Should NOT emit send
    expect(wrapper.emitted("send")).toBeFalsy();
  });

  it("shows stop button when disabled (processing)", () => {
    const wrapper = mountInputBar({ disabled: true });
    const stopBtn = wrapper.find("button[title='Stop']");
    expect(stopBtn.exists()).toBe(true);
  });

  it("emits stop on stop button click", async () => {
    const wrapper = mountInputBar({ disabled: true });
    await wrapper.find("button[title='Stop']").trigger("click");
    expect(wrapper.emitted("stop")).toBeTruthy();
  });

  it("does not emit when disabled", async () => {
    const wrapper = mountInputBar({ disabled: true });

    const textarea = wrapper.find("textarea");
    await textarea.setValue("Should not send");
    // The send button is hidden when disabled (stop button is shown instead)
    expect(wrapper.emitted("send")).toBeFalsy();
  });

  it("does not emit empty message", async () => {
    const wrapper = mountInputBar();

    await findSendBtn(wrapper).trigger("click");
    expect(wrapper.emitted("send")).toBeFalsy();

    await wrapper.find("textarea").setValue("   ");
    await findSendBtn(wrapper).trigger("click");
    expect(wrapper.emitted("send")).toBeFalsy();
  });

  it("disables send button when input is empty", () => {
    const wrapper = mountInputBar();
    expect(findSendBtn(wrapper).exists()).toBe(true);
    expect(findSendBtn(wrapper).attributes("disabled")).toBeDefined();
  });

  // ── Drag & drop ──

  it("shows drag-over border on dragover", async () => {
    const wrapper = mountInputBar();
    const container = wrapper.find(".composer");
    await container.trigger("dragover", { dataTransfer: { dropEffect: "" } });
    expect(container.classes()).toContain("composer--dragover");
  });

  it("hides drag border on dragleave", async () => {
    const wrapper = mountInputBar();
    const container = wrapper.find(".composer");
    await container.trigger("dragover", { dataTransfer: { dropEffect: "" } });
    await container.trigger("dragleave");
    expect(container.classes()).not.toContain("composer--dragover");
  });

  it("emits files event on drop", async () => {
    const wrapper = mountInputBar();
    const container = wrapper.find(".composer");

    const files = [{ name: "test.ts", path: "/home/user/test.ts" }];
    const dt = { dropEffect: "", files, items: [] };

    await container.trigger("drop", { dataTransfer: dt });
    expect(wrapper.emitted("files")).toBeTruthy();
    expect(wrapper.emitted("files")![0]).toEqual([[{ name: "test.ts", path: "/home/user/test.ts" }]]);
  });

  // ── composer foot：agent / model pill ──

  it("agent pill renders current agent and switches selection", async () => {
    const settings = useSettingsStore();
    // 默认主 agent = 分形预置「双星」
    expect(settings.currentAgent).toBe("双星");

    const wrapper = mountInputBar();
    const pill = wrapper.find(".composer-pill");
    expect(pill.text()).toContain("双星");

    // 展开下拉 → 3 个选项（双星 / build / plan）
    await pill.trigger("click");
    const items = wrapper.findAll(".d-item");
    expect(items.length).toBe(3);

    // 选择 build → settings.currentAgent 同步
    await items[1].trigger("click");
    expect(settings.currentAgent).toBe("build");
    expect(wrapper.find(".composer-pill").text()).toContain("build");
  });

  it("model pill renders current model and switches selection", async () => {
    const settings = useSettingsStore();
    // 默认 pro（DEEPSEEK_MODELS[0]）
    expect(settings.model).toBe("deepseek-v4-pro[1M]");

    const wrapper = mountInputBar();
    const pills = wrapper.findAll(".composer-pill");
    const modelPill = pills[1];
    // 显示名去 [1M] 标注与 provider 前缀
    expect(modelPill.text()).toContain("v4-pro");

    // 展开 → 选 v4-flash → settings.model 同步为存储格式
    await modelPill.trigger("click");
    const items = wrapper.findAll(".d-item");
    await items[0].trigger("click");
    expect(settings.model).toBe("deepseek-v4-flash");
    expect(wrapper.findAll(".composer-pill")[1].text()).toContain("v4-flash");
  });

  // ── composer chips 行 ──

  it("renders chips and emits removeChip on ×", async () => {
    const wrapper = mountInputBar({
      chips: [
        { id: "snippet", label: "选区片段 · <div>", tone: "accent", removable: true },
        { id: "file:/a/b.ts", label: "b.ts", tone: "elevated", removable: true },
      ],
    });
    // 仅 chips 行内的 composer-tool（foot 的 📎 附件按钮同名，须限定子级）
    const chips = wrapper.findAll(".composer-tools > .composer-tool");
    expect(chips.length).toBe(2);
    expect(chips[0].text()).toContain("选区片段");
    expect(chips[1].text()).toContain("b.ts");

    // 点击第二个 chip 的 × → removeChip 带 id
    await chips[1].find(".chip-x").trigger("click");
    expect(wrapper.emitted("removeChip")).toBeTruthy();
    expect(wrapper.emitted("removeChip")![0]).toEqual(["file:/a/b.ts"]);
  });

  it("emits chipClick for clickable chip", async () => {
    const wrapper = mountInputBar({
      chips: [{ id: "file:/a/b.ts", label: "b.ts", tone: "elevated", clickable: true }],
    });
    await wrapper.find(".composer-tool").trigger("click");
    expect(wrapper.emitted("chipClick")).toBeTruthy();
    expect(wrapper.emitted("chipClick")![0]).toEqual(["file:/a/b.ts"]);
  });

  it("shows hint text when no chips", () => {
    const wrapper = mountInputBar();
    expect(wrapper.find(".composer-chip-hint").exists()).toBe(true);
  });

  // ── foot 操作按钮 ──

  it("emits attach on 📎 button", async () => {
    const wrapper = mountInputBar();
    await wrapper.find("button[title='Attach file']").trigger("click");
    expect(wrapper.emitted("attach")).toBeTruthy();
  });
});
