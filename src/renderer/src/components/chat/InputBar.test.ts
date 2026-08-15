import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { setActivePinia, createPinia } from "pinia";
import { nextTick } from "vue";
import InputBar from "./InputBar.vue";
import { useSettingsStore } from "@/stores/settings";
import { useSessionStore } from "@/stores/session";
import { useSessionDrafts } from "@/composables/useSessionDrafts";

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
        polishTitle: "Polish message with AI",
      },
      mode: {
        plan: "Plan mode",
        askBefore: "Ask before edits",
        editAuto: "Edit automatically",
        auto: "Auto mode",
        bypass: "Bypass",
        dontAsk: "Don't Ask",
        effort: { low: "Low", high: "High", max: "Max" },
      },
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
    expect(wrapper.emitted("send")![0]).toEqual(["Hello World", false]);
    // Input should clear after send
    expect(textarea.element.value).toBe("");
  });

  it("emits send on Enter key", async () => {
    const wrapper = mountInputBar();

    const textarea = wrapper.find("textarea");
    await textarea.setValue("Test message");
    await textarea.trigger("keydown", { key: "Enter", shiftKey: false });

    expect(wrapper.emitted("send")).toBeTruthy();
    expect(wrapper.emitted("send")![0]).toEqual(["Test message", false]);
  });

  it("Ctrl+Enter 发送且携带 altBehavior 标记（繁忙时走另一行为）", async () => {
    const wrapper = mountInputBar();

    const textarea = wrapper.find("textarea");
    await textarea.setValue("Ctrl 发送");
    await textarea.trigger("keydown", { key: "Enter", ctrlKey: true, shiftKey: false });

    expect(wrapper.emitted("send")).toBeTruthy();
    expect(wrapper.emitted("send")![0]).toEqual(["Ctrl 发送", true]);
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

  it("disabled 且无输入 → 显示暂停按钮（无发送按钮）", () => {
    const wrapper = mountInputBar({ disabled: true });
    expect(wrapper.find("button[title='Stop']").exists()).toBe(true);
    expect(wrapper.find("button[title='Send']").exists()).toBe(false);
  });

  it("disabled 且有输入 → 显示发送按钮（无暂停按钮，发送即打断）", async () => {
    const wrapper = mountInputBar({ disabled: true });
    await wrapper.find("textarea").setValue("补充消息");
    expect(wrapper.find("button[title='Stop']").exists()).toBe(false);
    const sendBtn = wrapper.find("button[title='Send']");
    expect(sendBtn.exists()).toBe(true);
    expect(sendBtn.attributes("disabled")).toBeUndefined();
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

  it("只发附件（无文字）：chips 有 path → 发送按钮可用，emit send", async () => {
    const wrapper = mountInputBar({ chips: [{ id: "file:x", label: "a.pdf", path: "C:\\x\\a.pdf", removable: true }] });
    const sendBtn = findSendBtn(wrapper);
    expect(sendBtn.exists()).toBe(true);
    expect(sendBtn.attributes("disabled")).toBeUndefined();
    await sendBtn.trigger("click");
    expect(wrapper.emitted("send")).toBeTruthy();
  });

  it("只有选区卡片（无 path）→ 发送按钮禁用（引用文本需配文字发送）", () => {
    const wrapper = mountInputBar({ chips: [{ id: "snippet", label: "选中片段", content: "hello", removable: true }] });
    const sendBtn = findSendBtn(wrapper);
    expect(sendBtn.exists()).toBe(true);
    expect(sendBtn.attributes("disabled")).toBeDefined();
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

  it("emits files event on drop (path via webUtils bridge)", async () => {
    // Electron 32+ 无 File.path：preload 暴露 getPathForFile 转换真实路径
    (window as unknown as { electronBridge: { getPathForFile: (f: File) => string; invoke: (c: string, a?: unknown) => Promise<unknown>; on: () => () => void } }).electronBridge = {
      getPathForFile: () => "/home/user/test.ts",
      invoke: () => Promise.resolve({}),
      on: () => () => {},
    };
    const wrapper = mountInputBar();
    const container = wrapper.find(".composer");

    const files = [{ name: "test.ts" }];
    const dt = { dropEffect: "", files, items: [] };

    await container.trigger("drop", { dataTransfer: dt });
    expect(wrapper.emitted("files")).toBeTruthy();
    expect(wrapper.emitted("files")![0]).toEqual([[{ name: "test.ts", path: "/home/user/test.ts" }]]);
  });

  it("emits files event on drop (falls back to name when bridge missing)", async () => {
    // 浏览器/未注入桥环境：取不到真实路径退化为文件名（主进程会拒绝，但 UI 不崩）
    delete (window as unknown as { electronBridge?: unknown }).electronBridge;
    const wrapper = mountInputBar();
    const container = wrapper.find(".composer");

    const files = [{ name: "test.ts" }];
    const dt = { dropEffect: "", files, items: [] };

    await container.trigger("drop", { dataTransfer: dt });
    expect(wrapper.emitted("files")![0]).toEqual([[{ name: "test.ts", path: "test.ts" }]]);
  });

  it("emits files event on paste (path via webUtils bridge)", async () => {
    (window as unknown as { electronBridge: { getPathForFile: (f: File) => string; invoke: (c: string, a?: unknown) => Promise<unknown>; on: () => () => void } }).electronBridge = {
      getPathForFile: (f) => `/paste/${f.name}`,
      invoke: () => Promise.resolve({}),
      on: () => () => {},
    };
    const wrapper = mountInputBar();
    const textarea = wrapper.find("textarea");

    // ClipboardEvent items：kind=file 的 item.getAsFile() 返回 File
    const file = { name: "clip.png" } as File;
    const items = [{ kind: "file", getAsFile: () => file }];
    await textarea.trigger("paste", { clipboardData: { items } });

    expect(wrapper.emitted("files")).toBeTruthy();
    expect(wrapper.emitted("files")![0]).toEqual([[{ name: "clip.png", path: "/paste/clip.png" }]]);
  });

  it("ignores non-file paste items", async () => {
    const wrapper = mountInputBar();
    const textarea = wrapper.find("textarea");

    const items = [{ kind: "string" }];
    await textarea.trigger("paste", { clipboardData: { items } });
    expect(wrapper.emitted("files")).toBeFalsy();
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

  // chips 空态不再占高度（用户反馈①）：整行不渲染，无 hint 残留
  it("hides chips row when no chips (zero height)", () => {
    const wrapper = mountInputBar();
    expect(wrapper.find(".composer-tools").exists()).toBe(false);
  });

  it("renders chips row when chips present", () => {
    const wrapper = mountInputBar({ chips: [{ id: "c1", label: "file.md", tone: "elevated", removable: true }] });
    expect(wrapper.find(".composer-tools").exists()).toBe(true);
    expect(wrapper.find(".chip-name").text()).toBe("file.md");
  });

  // ── ✨ 优化消息按钮（原型发送左侧功能：AI 润色替换输入框）──

  it("polish button replaces input with polished text", async () => {
    // mock electronBridge：ai:polishMessage 返回润色结果（其余通道空对象）
    (window as unknown as { electronBridge: { invoke: (c: string, a?: unknown) => Promise<unknown>; on: () => () => void } }).electronBridge = {
      invoke: (channel: string) =>
        channel === "ai:polishMessage" ? Promise.resolve({ ok: true, text: "优化后的文本" }) : Promise.resolve({}),
      on: () => () => {},
    };
    const wrapper = mountInputBar();
    const textarea = wrapper.find("textarea");
    await textarea.setValue("请帮我优化这条消息");
    await wrapper.find("button[title='Polish message with AI']").trigger("click");
    await new Promise((r) => setTimeout(r, 0));
    expect(textarea.element.value).toBe("优化后的文本");
  });

  it("polish button disabled when input empty", () => {
    const wrapper = mountInputBar();
    expect(wrapper.find("button[title='Polish message with AI']").attributes("disabled")).toBeDefined();
  });

  it("polish with chips refs passes context to IPC", async () => {
    // chips 带 content/path（选区/附件）→ polishMessage 应收到 refs
    let captured: unknown;
    (window as unknown as { electronBridge: { invoke: (c: string, a?: unknown) => Promise<unknown>; on: () => () => void } }).electronBridge = {
      invoke: (channel: string, args?: unknown) => {
        if (channel === "ai:polishMessage") { captured = args; return Promise.resolve({ ok: true, text: "好" }); }
        return Promise.resolve({});
      },
      on: () => () => {},
    };
    const wrapper = mountInputBar({
      chips: [
        { id: "snippet", label: "选区片段", tone: "accent", content: "const a = 1" },
        { id: "file:C:\\b.ts", label: "b.ts", tone: "elevated", path: "C:\\b.ts" },
      ],
    });
    await wrapper.find("textarea").setValue("优化这段代码");
    await wrapper.find("button[title='Polish message with AI']").trigger("click");
    await new Promise((r) => setTimeout(r, 0));
    expect(captured).toEqual({
      text: "优化这段代码",
      refs: [
        { label: "选区片段", content: "const a = 1", path: "" },
        { label: "b.ts", content: "", path: "C:\\b.ts" },
      ],
    });
  });

  it("polish 期间切换会话：结果写入发起会话草稿而非当前输入框", async () => {
    // 润色跨会话写回：发起会话 A → 润色异步期间切到 B → 完成时输入框不污染（B 保持自己的草稿），
    // A 的草稿文字被替换为润色结果（保留 A 原有附件/选区）。
    // 说明：切会话时输入框由 ChatPanel restoreDraft 清空/恢复——本测试直接 mount InputBar（无 ChatPanel），
    // 手动模拟该行为（setText("")），聚焦验证「润色完成时跨会话写草稿」逻辑本身。
    const sessionStore = useSessionStore();
    const drafts = useSessionDrafts();
    drafts._resetForTest();
    // 预置会话（InputBar 润色写回守卫 session.sessions.some 要求会话存在——军师 P2-3）
    sessionStore.sessions.push({ id: "ses-a", title: "A", createdAt: 0, updatedAt: 0, messageCount: 0, totalTokens: null, totalCost: null, mode: "default" });
    sessionStore.setActiveSession("ses-a");
    (window as unknown as { electronBridge: { invoke: (c: string, a?: unknown) => Promise<unknown>; on: () => () => void } }).electronBridge = {
      invoke: (channel: string) =>
        channel === "ai:polishMessage" ? Promise.resolve({ ok: true, text: "润色后-A" }) : Promise.resolve({}),
      on: () => () => {},
    };
    const wrapper = mountInputBar();
    await wrapper.find("textarea").setValue("润色前-A");
    await wrapper.find("button[title='Polish message with AI']").trigger("click");
    // 润色未完成：切到会话 B（模拟用户行为；ChatPanel 会 setText("") 清空输入框）
    sessionStore.setActiveSession("ses-b");
    await wrapper.find("textarea").setValue("");
    await new Promise((r) => setTimeout(r, 0));
    // 输入框保持 B 的（空）草稿——不被 A 的润色结果污染
    expect((wrapper.find("textarea").element as HTMLTextAreaElement).value).toBe("");
    // 润色结果已登记到 A（pending），经 saveDraft 合并可见——模拟 ChatPanel 下一次 captureDraft(A)
    drafts.saveDraft("ses-a", { text: "", files: [], snippet: null });
    expect(drafts.getDraft("ses-a").text).toBe("润色后-A");
  });

  it("润色按钮状态跟随会话：A 润色中切到 B，B 按钮恢复正常；切回 A 继续显示处理中", async () => {
    // 润色按钮 busy 状态按会话隔离（2026-08-15 用户反馈）：
    // A 发起润色 → polishMessage 挂起（不 resolve）→ 切到 B → B 按钮可点（非 busy）→ 切回 A → A 按钮仍 busy
    const sessionStore = useSessionStore();
    const drafts = useSessionDrafts();
    drafts._resetForTest();
    sessionStore.sessions.push(
      { id: "ses-a", title: "A", createdAt: 0, updatedAt: 0, messageCount: 0, totalTokens: null, totalCost: null, mode: "default" },
      { id: "ses-b", title: "B", createdAt: 0, updatedAt: 0, messageCount: 0, totalTokens: null, totalCost: null, mode: "default" },
    );
    sessionStore.setActiveSession("ses-a");
    // polishMessage 永不 resolve（模拟长润色）——用 pending promise 控制
    let resolvePolish: (v: unknown) => void = () => {};
    (window as unknown as { electronBridge: { invoke: (c: string, a?: unknown) => Promise<unknown>; on: () => () => void } }).electronBridge = {
      invoke: (channel: string) =>
        channel === "ai:polishMessage" ? new Promise((res) => { resolvePolish = res; }) : Promise.resolve({}),
      on: () => () => {},
    };
    const wrapper = mountInputBar();
    await wrapper.find("textarea").setValue("润色-A");
    await wrapper.find("button[title='Polish message with AI']").trigger("click");
    await wrapper.vm.$nextTick();
    await new Promise((r) => setTimeout(r, 0));
    // A 会话：润色中 → 按钮 busy
    expect(wrapper.find("button[title='Polish message with AI']").classes()).toContain("polish-btn--busy");

    // 切到 B：按钮恢复正常（可点）
    sessionStore.setActiveSession("ses-b");
    await wrapper.vm.$nextTick();
    await new Promise((r) => setTimeout(r, 0));
    expect(wrapper.find("button[title='Polish message with AI']").classes()).not.toContain("polish-btn--busy");

    // 切回 A：按钮继续 busy（A 润色未完成）
    sessionStore.setActiveSession("ses-a");
    await wrapper.vm.$nextTick();
    await new Promise((r) => setTimeout(r, 0));
    expect(wrapper.find("button[title='Polish message with AI']").classes()).toContain("polish-btn--busy");

    // A 润色完成 → 按钮复位
    resolvePolish({ ok: true, text: "完成" });
    await wrapper.vm.$nextTick();
    await new Promise((r) => setTimeout(r, 0));
    expect(wrapper.find("button[title='Polish message with AI']").classes()).not.toContain("polish-btn--busy");
  });

  // ── foot 操作按钮 ──

  it("emits attach on 📎 button", async () => {
    const wrapper = mountInputBar();
    await wrapper.find("button[title='Attach file']").trigger("click");
    expect(wrapper.emitted("attach")).toBeTruthy();
  });

// ── 思考强度选择器（variant 动态过滤：选项 = settings.modelVariants 的映射子集）──
// store 的 watch(model, immediate) 通过 electronBridge 拉取 variants：
// 每个测试 mock invoke 返回对应模型 variants，await flush 后选择器按 modelVariants 渲染。

/** mock electronBridge：provider:modelVariants 返回指定 variants（其余通道空对象） */
function mockVariants(variants: string[]) {
  (window as unknown as { electronBridge: { invoke: (c: string, a?: unknown) => Promise<unknown>; on: () => () => void } }).electronBridge = {
    invoke: (channel: string) => (channel === "provider:modelVariants" ? Promise.resolve(variants) : Promise.resolve({})),
    on: () => () => {},
  };
}

/** flush 所有微任务（让 store watch 的 async continuation 跑完） */
function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

it("effort 选择器：flash 模型（low/high/max）显示 3 档", async () => {
  mockVariants(["low", "high", "max"]);
  const settings = useSettingsStore();
  await flushPromises();
  expect(settings.modelVariants).toEqual(["low", "high", "max"]);
  const wrapper = mountInputBar();
  await nextTick();
  const pill = wrapper.find('.composer-select[title="Reasoning effort"]');
  expect(pill.exists()).toBe(true);
  await pill.trigger("click");
  const items = wrapper.findAll(".dropdown-menu .dropdown-item");
  expect(items.length).toBe(3);
  // 选项顺序固定 low/high/max
  expect(items[0].text()).toBe("Low");
  expect(items[1].text()).toBe("High");
  expect(items[2].text()).toBe("Max");
});

it("effort 选择器：pro 模型（high/max）只显示 2 档", async () => {
  mockVariants(["high", "max"]);
  const settings = useSettingsStore();
  await flushPromises();
  expect(settings.modelVariants).toEqual(["high", "max"]);
  const wrapper = mountInputBar();
  await nextTick();
  const pill = wrapper.find('.composer-select[title="Reasoning effort"]');
  expect(pill.exists()).toBe(true);
  await pill.trigger("click");
  const items = wrapper.findAll(".dropdown-menu .dropdown-item");
  expect(items.length).toBe(2);
  expect(items[0].text()).toBe("High");
  expect(items[1].text()).toBe("Max");
});

it("effort 选择器：模型无 variants（如 deepseek-chat）→ 隐藏", async () => {
  mockVariants([]);
  const settings = useSettingsStore();
  await flushPromises();
  expect(settings.modelVariants).toEqual([]);
  const wrapper = mountInputBar();
  await nextTick();
  expect(wrapper.find('.composer-select[title="Reasoning effort"]').exists()).toBe(false);
});

it("effort 选择器：选择档位同步 settings.effort（variant 值）", async () => {
  mockVariants(["low", "high", "max"]);
  const settings = useSettingsStore();
  await flushPromises();
  const wrapper = mountInputBar();
  await nextTick();
  await wrapper.find('.composer-select[title="Reasoning effort"]').trigger("click");
  const items = wrapper.findAll(".dropdown-menu .dropdown-item");
  await items[2].trigger("click");
  expect(settings.effort).toBe("max");
});

// ── insertAtCursor：光标位置插入文本（office 附件右键添加 → 路径直接插输入框，2026-08-16）──

it("insertAtCursor：光标中插入 → 文本拼接且光标后移", async () => {
  // attachTo 真实 DOM：insertAtCursor 用 document.querySelector(".chat-textarea") 定位
  // （与 autoResize 同款——组件挂 detached 时 querySelector 查不到，selectionStart 读不到）
  const wrapper = mount(InputBar, {
    props: { disabled: false },
    global: { plugins: [i18n, pinia] },
    attachTo: document.body,
  });
  const textarea = wrapper.find("textarea");
  await textarea.setValue("你好世界");
  // 模拟光标在「你」和「好」之间（index=1）——jsdom 中 setSelectionRange 后 selectionStart 生效
  (textarea.element as HTMLTextAreaElement).setSelectionRange(1, 1);
  (wrapper.vm as unknown as { insertAtCursor: (t: string) => void }).insertAtCursor('"C:\\tmp\\a.docx"');
  await nextTick();
  expect((textarea.element as HTMLTextAreaElement).value).toBe('你"C:\\tmp\\a.docx"好世界');
  expect((textarea.element as HTMLTextAreaElement).selectionStart).toBe(1 + '"C:\\tmp\\a.docx"'.length);
  wrapper.unmount();
});

it("insertAtCursor：光标在末尾（未聚焦）→ 末尾追加", async () => {
  const wrapper = mount(InputBar, {
    props: { disabled: false },
    global: { plugins: [i18n, pinia] },
    attachTo: document.body,
  });
  const textarea = wrapper.find("textarea");
  await textarea.setValue("已有内容");
  (wrapper.vm as unknown as { insertAtCursor: (t: string) => void }).insertAtCursor('"C:\\tmp\\b.docx"');
  await nextTick();
  expect((textarea.element as HTMLTextAreaElement).value).toBe('已有内容"C:\\tmp\\b.docx"');
  wrapper.unmount();
});
});
