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
vi.mock("@/lib/electron-bridge", () => ({
  sendMessage: vi.fn().mockResolvedValue({ accepted: true }),
  respondPermission: (...args: unknown[]) => respondPermissionMock(...args),
  questionReply: (...args: unknown[]) => questionReplyMock(...args),
  questionReject: (...args: unknown[]) => questionRejectMock(...args),
  forkSession: vi.fn().mockResolvedValue({ id: "ses-fork" }),
  getAutoModeStatus: vi.fn().mockResolvedValue(false),
  stopSession: vi.fn().mockResolvedValue(undefined),
  listMessages: vi.fn().mockResolvedValue([]),
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

function mountChatPanel(): VueWrapper {
  return mount(ChatPanel, {
    global: {
      plugins: [pinia, i18n],
      provide: { router: mockRouter },
      stubs: {
        ErrorBoundary: { template: "<div><slot /></div>" },
        InputBar: { template: '<div class="input-bar-stub" />' },
        MessageBubble: { template: '<div class="msg-stub" />' },
        ThinkingIndicator: { template: "<div />" },
        ContextUsageModal: { props: ["open"], template: "<div />" },
        ManagePanel: { props: ["open", "initialTab"], template: "<div />" },
        ModalShell: ModalShellStub,
        MarkdownRenderer: { template: "<div />" },
        ChatTimelineNav: { props: ["messages", "scrollContainer"], template: "<div />" },
        TodoPanel: { template: "<div />" },
      },
    },
  });
}

describe("ChatPanel 弹窗", () => {
  beforeEach(() => {
    localStorage.clear();
    pinia = createPinia();
    setActivePinia(pinia);
    questionReplyMock.mockReset();
    questionRejectMock.mockReset();
    respondPermissionMock.mockReset();
    questionReplyMock.mockResolvedValue({ ok: true });
    questionRejectMock.mockResolvedValue({ ok: true });
    respondPermissionMock.mockResolvedValue({ responded: true });
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

  it("G3: 无 historyError 且无消息 → 正常欢迎页（非离线占位）", async () => {
    const chat = useChatStore();
    chat.setHistoryError(false);

    const wrapper = mountChatPanel();
    await flush();

    expect(wrapper.find(".offline-placeholder").exists()).toBe(false);
    expect(wrapper.find(".welcome-page").exists()).toBe(true);
    expect(wrapper.text()).toContain("Welcome");
  });
});

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
