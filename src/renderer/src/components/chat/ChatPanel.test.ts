// ChatPanel 弹窗测试：serve 原生 question.asked（提问弹窗提交）+ permission.asked（总是允许按钮）
// 子组件全部 stub，仅验证弹窗交互与 bridge 调用参数
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { createI18n } from "vue-i18n";
import { useChatStore } from "@/stores/chat";
import { useSessionStore } from "@/stores/session";
import ChatPanel from "./ChatPanel.vue";

// mock electron-bridge：只关心 questionReply / respondPermission 的调用参数
const questionReplyMock = vi.fn();
const questionRejectMock = vi.fn();
const respondPermissionMock = vi.fn();
const sendMessageMock = vi.fn();
const listMessagesMock = vi.fn();
vi.mock("@/lib/electron-bridge", () => ({
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
  respondPermission: (...args: unknown[]) => respondPermissionMock(...args),
  questionReply: (...args: unknown[]) => questionReplyMock(...args),
  questionReject: (...args: unknown[]) => questionRejectMock(...args),
  forkSession: vi.fn().mockResolvedValue({ id: "ses-fork" }),
  getAutoModeStatus: vi.fn().mockResolvedValue(false),
  stopSession: vi.fn().mockResolvedValue(undefined),
  listMessages: (...args: unknown[]) => listMessagesMock(...args),
  writeFile: vi.fn().mockResolvedValue(undefined),
  loadSessionLogs: vi.fn().mockResolvedValue([null, null]),
  openDialog: vi.fn().mockResolvedValue(null),
  saveDialog: vi.fn().mockResolvedValue(null),
  readFileBase64: vi.fn().mockResolvedValue(""),
}));

const i18n = createI18n({
  legacy: false,
  locale: "en",
  messages: {
    en: {
      chat: {
        welcomeTitle: "Welcome",
        welcomeSubtitle: "Subtitle",
        welcomeSend: "Enter to send",
        welcomeNewline: "Shift+Enter newline",
        historyOfflineTitle: "Engine not ready",
        historyOfflineSubtitle: "History unavailable until the engine starts",
        historyLoadingTitle: "Loading history",
        historyLoadingSubtitle: "Large sessions may take a few seconds",
        loadingEarlier: "Loading earlier messages",
        allow: "Allow",
        deny: "Deny",
        alwaysAllow: "Always allow",
        alwaysAllowHint: "Allow all {patterns}",
        allowTool: "Allow {tool}?",
        askUserQuestion: "Need more info",
        skip: "Skip",
        submit: "Submit",
        todos: "Task List",
        noTodos: "No tasks yet",
      },
      composer: { chipHint: "" },
      tools: { Bash: "Bash" },
    },
  },
});

// ModalShell stub：模拟 open prop 控制显示（Teleport 不便断言，用 v-if 内联渲染 slots）
const ModalShellStub = {
  props: { open: Boolean },
  emits: ["close"],
  template: `
    <div v-if="open" class="modal-shell-stub">
      <slot name="header" />
      <slot />
      <slot name="footer" />
    </div>
  `,
};

const mockRouter = { push: vi.fn(), currentRoute: { value: { path: "/chat" } } };
let pinia: Pinia;

// InputBar stub：声明 send 事件，供 handleSend 附件传递用例触发
const InputBarStub = {
  name: "InputBarStub",
  emits: ["send"],
  template: '<div class="input-bar-stub" />',
};

function mountChatPanel(): VueWrapper {
  return mount(ChatPanel, {
    global: {
      plugins: [pinia, i18n],
      provide: { router: mockRouter },
      stubs: {
        ErrorBoundary: { template: "<div><slot /></div>" },
        InputBar: InputBarStub,
        // 渲染 data-message-id / data-role：时间线跳转与 scroll spy 定位依赖 DOM 属性
        MessageBubble: {
          props: ["message"],
          template: '<div class="msg-stub" :data-message-id="message.id" :data-role="message.role" />',
        },
        ThinkingIndicator: { template: "<div />" },
        ContextUsageModal: { props: ["open"], template: "<div />" },
        ManagePanel: { props: ["open", "initialTab"], template: "<div />" },
        ModalShell: ModalShellStub,
        MarkdownRenderer: { template: "<div />" },
        ChatTimelineNav: { props: ["messages", "timeline", "scrollContainer"], template: "<div />" },
        TodoPanel: { template: "<div />" },
      },
    },
  });
}

/** 构造 N 条升序历史记录（m0 最旧） */
function makeRecords(n: number): Array<{ id: string; role: string; content: string; created_at: string }> {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    role: "user",
    content: `msg ${i}`,
    created_at: `2026-01-01T00:${String(i % 60).padStart(2, "0")}:00`,
  }));
}

describe("ChatPanel 弹窗", () => {
  beforeEach(() => {
    localStorage.clear();
    pinia = createPinia();
    setActivePinia(pinia);
    questionReplyMock.mockReset();
    questionRejectMock.mockReset();
    respondPermissionMock.mockReset();
    sendMessageMock.mockReset();
    listMessagesMock.mockReset();
    questionReplyMock.mockResolvedValue({ ok: true });
    questionRejectMock.mockResolvedValue({ ok: true });
    respondPermissionMock.mockResolvedValue({ responded: true });
    sendMessageMock.mockResolvedValue({ accepted: true });
    listMessagesMock.mockResolvedValue([]);
  });

  it("question 弹窗提交 → questionReply 收集 answers（单选 → 单元素数组）并关闭", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    session.setActiveSession("ses-1");
    chat.addControlRequest({
      subtype: "question",
      tool_name: "AskUserQuestion",
      request_id: "que-1",
      tool_input: {},
      questions: [
        {
          question: "你更偏好哪个配色方案？",
          header: "配色方案",
          options: [
            { label: "A 深色", description: "深色主题配色" },
            { label: "B 浅色", description: "浅色主题配色" },
          ],
        },
      ],
    });

    const wrapper = mountChatPanel();
    await flush();

    // 弹窗已打开且渲染问题选项
    expect(wrapper.find(".modal-shell-stub").exists()).toBe(true);
    expect(wrapper.text()).toContain("你更偏好哪个配色方案？");

    // 选中「A 深色」（单选 radio）
    const radio = wrapper.find('input[type="radio"]');
    await radio.setValue(true);

    // 点提交
    const submitBtn = wrapper.findAll("button").find(b => b.text() === "Submit");
    expect(submitBtn).toBeDefined();
    await submitBtn!.trigger("click");
    await flush();

    expect(questionReplyMock).toHaveBeenCalledOnce();
    expect(questionReplyMock).toHaveBeenCalledWith("ses-1", "que-1", [["A 深色"]]);
    // 弹窗已关闭（control_request 队列已清）
    expect(chat.pendingControlRequest).toBeNull();
  });

  it("question 弹窗多问题 + 多选 → answers 按 questions 顺序收集", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    session.setActiveSession("ses-1");
    chat.addControlRequest({
      subtype: "question",
      tool_name: "AskUserQuestion",
      request_id: "que-2",
      tool_input: {},
      questions: [
        {
          question: "多选哪些模块？",
          multiple: true,
          options: [{ label: "A" }, { label: "B" }, { label: "C" }],
        },
        {
          question: "确认继续？",
          options: [{ label: "是" }, { label: "否" }],
        },
      ],
    });

    const wrapper = mountChatPanel();
    await flush();

    // 勾选多选 A、C + 单选「是」
    const checkboxes = wrapper.findAll('input[type="checkbox"]');
    await checkboxes[0].setValue(true);
    await checkboxes[2].setValue(true);
    const radios = wrapper.findAll('input[type="radio"]');
    // 第二个问题的第一个选项（是）
    await radios[0].setValue(true);

    const submitBtn = wrapper.findAll("button").find(b => b.text() === "Submit");
    await submitBtn!.trigger("click");
    await flush();

    expect(questionReplyMock).toHaveBeenCalledWith("ses-1", "que-2", [["A", "C"], ["是"]]);
  });

  it("question 弹窗跳过 → questionReject（不调 respondPermission）", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    session.setActiveSession("ses-1");
    chat.addControlRequest({
      subtype: "question",
      tool_name: "AskUserQuestion",
      request_id: "que-3",
      tool_input: {},
      questions: [{ question: "Q?", options: [{ label: "A" }] }],
    });

    const wrapper = mountChatPanel();
    await flush();

    const skipBtn = wrapper.findAll("button").find(b => b.text() === "Skip");
    expect(skipBtn).toBeDefined();
    await skipBtn!.trigger("click");
    await flush();

    expect(questionRejectMock).toHaveBeenCalledWith("ses-1", "que-3");
    expect(respondPermissionMock).not.toHaveBeenCalled();
    expect(chat.pendingControlRequest).toBeNull();
  });

  it("approval 且 always 有值 → 显示建议文案与「总是允许」，点击调 respondPermission always", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    session.setActiveSession("ses-1");
    chat.addControlRequest({
      subtype: "approval",
      tool_name: "Bash",
      request_id: "per-1",
      tool_input: { command: "echo x" },
      always: ["echo *"],
    });

    const wrapper = mountChatPanel();
    await flush();

    expect(wrapper.text()).toContain("Allow all echo *");

    const alwaysBtn = wrapper.findAll("button").find(b => b.text() === "Always allow");
    expect(alwaysBtn).toBeDefined();
    await alwaysBtn!.trigger("click");
    await flush();

    expect(respondPermissionMock).toHaveBeenCalledWith("ses-1", "per-1", "always");
    expect(chat.pendingControlRequest).toBeNull();
  });

  it("approval 无 always → 不显示「总是允许」按钮", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    session.setActiveSession("ses-1");
    chat.addControlRequest({
      subtype: "approval",
      tool_name: "Bash",
      request_id: "per-2",
      tool_input: { command: "echo y" },
    });

    const wrapper = mountChatPanel();
    await flush();

    expect(wrapper.text()).not.toContain("Always allow");
    expect(wrapper.text()).toContain("Allow Bash?");
  });

  it("G3: historyError 且无消息 → 显示离线占位而非欢迎页", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    session.setActiveSession("ses-1");
    session.sessions.push({ id: "ses-1", title: "测试会话", createdAt: 1, updatedAt: 2, messageCount: 0 });
    chat.setHistoryError(true);

    const wrapper = mountChatPanel();
    await flush();

    expect(wrapper.find(".offline-placeholder").exists()).toBe(true);
    expect(wrapper.text()).toContain("Engine not ready");
    // 会话标题正常展示（离线不影响会话信息）
    expect(wrapper.text()).toContain("测试会话");
    // 不显示正常欢迎页（welcome-keywords 是正常欢迎页独有元素）
    expect(wrapper.find(".welcome-keywords").exists()).toBe(false);
  });

  it("历史加载中 → 显示加载占位而非欢迎页/离线占位", async () => {
    const chat = useChatStore();
    chat.setHistoryError(false);
    chat.setHistoryLoading(true);  // 切会话全量拉取期间

    const wrapper = mountChatPanel();
    await flush();

    expect(wrapper.text()).toContain("Loading history");
    expect(wrapper.find(".offline-placeholder").exists()).toBe(false);
    expect(wrapper.find(".welcome-keywords").exists()).toBe(false);
  });

  it("加载完成 → 加载占位消失，回到正常欢迎页", async () => {
    const chat = useChatStore();
    chat.setHistoryLoading(true);
    const wrapper = mountChatPanel();
    await flush();
    chat.setHistoryLoading(false);
    await flush();
    expect(wrapper.text()).not.toContain("Loading history");
    expect(wrapper.find(".welcome-keywords").exists()).toBe(true);
  });

  it("G3: 无 historyError 且无消息 → 正常欢迎页（非离线占位）", async () => {
    const chat = useChatStore();
    chat.setHistoryError(false);

    const wrapper = mountChatPanel();
    await flush();

    expect(wrapper.find(".offline-placeholder").exists()).toBe(false);
    expect(wrapper.find(".welcome-page").exists()).toBe(true);
    expect(wrapper.text()).toContain("Welcome");
  });

  it("P6: 附件发送 → sendMessage 收到 attachments（path/name 数组）", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    session.setActiveSession("ses-1");
    sendMessageMock.mockResolvedValue({ accepted: true });

    const wrapper = mountChatPanel();
    await flush();

    // 触发 attach-files 事件（右键菜单「添加到会话」同路径）→ 附件进入 attachedFiles
    window.dispatchEvent(new CustomEvent("attach-files", { detail: [{ name: "a.txt", path: "C:\\tmp\\a.txt" }] }));
    await flush();

    // InputBar emit send → handleSend
    await wrapper.findComponent(InputBarStub).vm.$emit("send", "看下附件");
    await flush();

    expect(sendMessageMock).toHaveBeenCalledOnce();
    const [sid, msg, opts] = sendMessageMock.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(sid).toBe("ses-1");
    expect(msg).toBe("看下附件");
    expect(opts.attachments).toEqual([{ name: "a.txt", path: "C:\\tmp\\a.txt" }]);
  });

  // ── 滚动到顶加载更早（内存分页：从 fullHistory 切片，无网络）──

  it("滚动到顶部 → prependFromFullHistory 从内存切片更早消息（无网络请求）", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    session.setActiveSession("ses-1");
    // 全量 60 条 → 首屏渲染尾部 50 条（m10..m59），hasMore=true
    chat.loadFullHistory(makeRecords(60));
    expect(chat.messages).toHaveLength(50);

    const wrapper = mountChatPanel();
    await flush();

    // 触发 scroll（jsdom 中 scrollTop=0 < 80 → 满足加载条件）
    await wrapper.find(".chat-messages").trigger("scroll");
    await flush();

    // 同步内存切片：无网络请求，listMessages 不被滚动触发
    expect(listMessagesMock).not.toHaveBeenCalled();
    // prepend 后整体 m0..m59（旧→新）
    expect(chat.messages).toHaveLength(60);
    expect(chat.messages[0].id).toBe("m0");
    expect(chat.loadedFromFull).toBe(60);
    // 已到顶
    expect(chat.hasMoreHistory).toBe(false);
  });

  it("hasMoreHistory=false（已到顶）→ 滚动不触发切片", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    session.setActiveSession("ses-1");
    // 全量 50 条 → 首屏全部渲染，hasMore=false
    chat.loadFullHistory(makeRecords(50));

    const wrapper = mountChatPanel();
    await flush();

    await wrapper.find(".chat-messages").trigger("scroll");
    await flush();

    expect(listMessagesMock).not.toHaveBeenCalled();
    expect(chat.messages).toHaveLength(50);
    expect(chat.loadedFromFull).toBe(50);
  });

  it("内存切片耗尽后 hasMoreHistory 置 false → 后续滚动不再触发", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    session.setActiveSession("ses-1");
    // 全量 55 条 → 首屏 50 条（m5..m54），滚动一次切完剩余 5 条
    chat.loadFullHistory(makeRecords(55));
    expect(chat.hasMoreHistory).toBe(true);

    const wrapper = mountChatPanel();
    await flush();

    // 第一次滚动：切出 m0..m4，到达全量 → hasMore=false
    await wrapper.find(".chat-messages").trigger("scroll");
    await flush();
    expect(chat.messages).toHaveLength(55);
    expect(chat.hasMoreHistory).toBe(false);

    // 第二次滚动：不再触发（已到顶）
    const lengthAfterFirst = chat.messages.length;
    await wrapper.find(".chat-messages").trigger("scroll");
    await flush();
    expect(chat.messages).toHaveLength(lengthAfterFirst);
  });

  // ── 时间线跳转（scrollToTimelineIndex：目标未渲染 → 循环 prepend 后滚动到 DOM）──

  it("scrollToTimelineIndex：目标未渲染 → 从内存切片后滚动到目标 DOM", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    session.setActiveSession("ses-1");
    // 全量 120 条 → 首屏尾部 50 条（m70..m119），m20 未渲染
    chat.loadFullHistory(makeRecords(120));

    const scrollIntoViewMock = vi.fn();
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoViewMock;
    try {
      const wrapper = mountChatPanel();
      await flush();

      // 跳到全局锚点 index 20（对应 m20）
      await (wrapper.vm as unknown as { scrollToTimelineIndex: (i: number) => Promise<void> }).scrollToTimelineIndex(20);
      await flush();

      // 循环 prepend：m20 已进入渲染区（120-50-50=20 → 一次切片 m20..m69）
      expect(chat.messages.some(m => m.id === "m20")).toBe(true);
      expect(chat.loadedFromFull).toBe(100);
      expect(scrollIntoViewMock).toHaveBeenCalled();
      expect(scrollIntoViewMock.mock.calls[0][0]).toEqual({ block: "start" });
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });

  it("scrollToTimelineIndex：目标已渲染 → 不切片直接滚动", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    session.setActiveSession("ses-1");
    chat.loadFullHistory(makeRecords(120)); // 首屏 m70..m119

    const scrollIntoViewMock = vi.fn();
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoViewMock;
    try {
      const wrapper = mountChatPanel();
      await flush();

      // m100 已在首屏 → 不触发 prepend
      await (wrapper.vm as unknown as { scrollToTimelineIndex: (i: number) => Promise<void> }).scrollToTimelineIndex(100);
      await flush();

      expect(chat.loadedFromFull).toBe(50);
      expect(chat.messages).toHaveLength(50);
      expect(scrollIntoViewMock).toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });

  it("scrollToTimelineIndex：越界 index → 静默返回不滚动", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    session.setActiveSession("ses-1");
    chat.loadFullHistory(makeRecords(50));

    const scrollIntoViewMock = vi.fn();
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoViewMock;
    try {
      const wrapper = mountChatPanel();
      await flush();

      await (wrapper.vm as unknown as { scrollToTimelineIndex: (i: number) => Promise<void> }).scrollToTimelineIndex(999);
      await flush();

      expect(chat.loadedFromFull).toBe(50);
      expect(scrollIntoViewMock).not.toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });
});

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
