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
const stopSessionMock = vi.fn().mockResolvedValue(undefined);
const listMessagesMock = vi.fn();
const loadSessionLogsMock = vi.fn();
const readServeLogMock = vi.fn();
const readRendererLogMock = vi.fn();
const getAppInfoMock = vi.fn();
vi.mock("@/lib/electron-bridge", () => ({
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
  respondPermission: (...args: unknown[]) => respondPermissionMock(...args),
  questionReply: (...args: unknown[]) => questionReplyMock(...args),
  questionReject: (...args: unknown[]) => questionRejectMock(...args),
  forkSession: vi.fn().mockResolvedValue({ id: "ses-fork" }),
  getAutoModeStatus: vi.fn().mockResolvedValue(false),
  stopSession: (...args: unknown[]) => stopSessionMock(...args),
  listMessages: (...args: unknown[]) => listMessagesMock(...args),
  writeFile: vi.fn().mockResolvedValue(undefined),
  loadSessionLogs: (...args: unknown[]) => loadSessionLogsMock(...args),
  readServeLog: (...args: unknown[]) => readServeLogMock(...args),
  readRendererLog: (...args: unknown[]) => readRendererLogMock(...args),
  getAppInfo: (...args: unknown[]) => getAppInfoMock(...args),
  openDialog: vi.fn().mockResolvedValue(null),
  saveDialog: vi.fn().mockResolvedValue(null),
  readFileBase64: vi.fn().mockResolvedValue(""),
  // 活跃会话上报（session store 切会话时 fire-and-forget）：测试环境静默
  setActiveSession: vi.fn().mockResolvedValue({ ok: true }),
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
        todoRecord: "Todos",
        todoRecordDone: "done",
        debugTitle: "Diagnostics",
        debugLabel: "Event Log",
        debugServeTab: "Engine Log",
        debugRendererTab: "Console Log",
        debugNoRendererLog: "No console logs yet",
        debugRefresh: "Refresh",
        debugCopyDiag: "Copy Diagnostics",
        debugNoServeLog: "No engine logs yet",
        debugPrivacyHint: "Logs may contain local paths",
        debugFooter: "Logs help troubleshooting",
        engineTimeout: "Engine unresponsive for 30s",
        copied: "Copied",
        close: "Close",
        copy: "Copy",
      },
      status: { exportFail: "Export failed {error}" },
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

// ConfirmDialog stub：可触发 confirm/cancel 事件（office 附件/删除会话确认测试用）
const ConfirmDialogStub = {
  props: { open: Boolean, title: String, message: String, danger: Boolean },
  emits: ["confirm", "cancel"],
  template: `
    <div v-if="open" class="confirm-dialog-stub">
      <button class="confirm-dialog-stub-confirm" @click="$emit('confirm')">confirm</button>
      <button class="confirm-dialog-stub-cancel" @click="$emit('cancel')">cancel</button>
    </div>
  `,
};

const mockRouter = { push: vi.fn(), currentRoute: { value: { path: "/chat" } } };
let pinia: Pinia;

// InputBar stub：声明 send 事件，供 handleSend 附件传递用例触发；渲染 #left 插槽（诊断面板开关按钮）
const InputBarStub = {
  name: "InputBarStub",
  props: ["chips"],
  emits: ["send"],
  template: '<div class="input-bar-stub"><slot name="left" /></div>',
};

function mountChatPanel(): VueWrapper {
  return mount(ChatPanel, {
    global: {
      plugins: [pinia, i18n],
      provide: { router: mockRouter },
      stubs: {
        // 诊断面板裸 div + Teleport：stub 让 Teleport 内容渲染到组件树内（wrapper.find 可及）
        Teleport: { template: "<div><slot /></div>" },
        ErrorBoundary: { template: "<div><slot /></div>" },
        InputBar: InputBarStub,
        // MessageBubble stub：真实组件已移除 data-message-id/data-role（锚点只在回合容器 .msg-entry 上，避免双份元素）
        // 回回合容器层级由 NodeTimeline/回合分组提供 data 锚点
        MessageBubble: {
          props: ["message"],
          template: '<div class="msg-stub" />',
        },
        ThinkingIndicator: { template: "<div />" },
        ContextUsageModal: { props: ["open"], template: "<div />" },
        ManagePanel: { props: ["open", "initialTab"], template: "<div />" },
        ModalShell: ModalShellStub,
        ConfirmDialog: ConfirmDialogStub,
        MarkdownRenderer: { template: "<div />" },
        ChatTimelineNav: { props: ["messages", "timeline", "scrollContainer"], template: "<div />" },
        // stub 渲染 data-todo-panel 标记：方案 A「按需显示」测试断言 TodoPanel 是否被渲染（v-if 控制存在性）
        TodoPanel: { template: "<div class='todo-panel-stub' />" },
        // 待办记录卡 stub：记录卡渲染测试只断言数量与 todos 传递（卡片自身行为在 TodoRecordCard.test 覆盖）
        // data-title 区分：回合记录卡不传 title（空）vs todo 更新节点卡传「更新待办」（2026-08-10 节点复用后）
        TodoRecordCard: {
          props: ["endedAt", "todos", "title"],
          template: "<div class='todo-record-card-stub' :data-title='title ?? \"\"'>todos={{ todos.length }}</div>",
        },
        // 子任务可视化：测试聚焦弹窗/审批交互，子任务卡片/弹窗 stub（真实组件在 ChatPanel 专项测试覆盖）
        // stub 渲染 subtask.summary：预拉摘要注入卡片后可在文本中断言
        SubTaskCard: { props: ["subtask", "expanded"], template: "<div class='subtask-card-stub'>{{ subtask.summary }}</div>" },
        SubTaskMonitor: { props: ["subId"], template: "<div class='subtask-monitor-stub' />" },
        SubTaskDetail: { props: ["subId"], template: "<div class='subtask-detail-stub' />" },
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
    loadSessionLogsMock.mockReset();
    loadSessionLogsMock.mockResolvedValue([null]);
    readServeLogMock.mockReset();
    readServeLogMock.mockResolvedValue([]);
    readRendererLogMock.mockReset();
    readRendererLogMock.mockResolvedValue([]);
    getAppInfoMock.mockReset();
    getAppInfoMock.mockResolvedValue({ name: "分形", version: "1.2.3" });
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
    session.sessions.push({ id: "ses-1", title: "测试会话", createdAt: 1, updatedAt: 2, messageCount: 0, totalTokens: null, totalCost: null, mode: "cc" });
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

  // ── office/二进制附件：chips 弱提示 + 发送前确认（模型端不支持读取）──

  it("office 附件发送：弹 ConfirmDialog，取消 → 不发送（附件保留在 chips）", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    session.setActiveSession("ses-1");
    sendMessageMock.mockResolvedValue({ accepted: true });

    const wrapper = mountChatPanel();
    await flush();

    window.dispatchEvent(new CustomEvent("attach-files", { detail: [{ name: "简历.pdf", path: "C:\\tmp\\简历.pdf" }] }));
    await flush();
    await wrapper.findComponent(InputBarStub).vm.$emit("send", "看下这个pdf");
    await flush();

    // 弹确认框（ConfirmDialog stub 渲染）→ 取消 → 不发送，附件保留在 chips
    const dialog = wrapper.findComponent(ConfirmDialogStub);
    expect(dialog.exists()).toBe(true);
    expect(dialog.props("open")).toBe(true);
    await dialog.vm.$emit("cancel");
    await flush();

    expect(sendMessageMock).not.toHaveBeenCalled();
    const chips = wrapper.findComponent(InputBarStub).props("chips") as Array<{ label: string; warn?: boolean }>;
    expect(chips).toHaveLength(1);
    expect(chips[0].label).toBe("简历.pdf");
    expect(chips[0].warn).toBe(true);  // office 附件带弱提示标记
  });

  it("office 附件发送：弹 ConfirmDialog，确认 → 正常发送", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    session.setActiveSession("ses-1");
    sendMessageMock.mockResolvedValue({ accepted: true });

    const wrapper = mountChatPanel();
    await flush();

    window.dispatchEvent(new CustomEvent("attach-files", { detail: [{ name: "报告.docx", path: "C:\\tmp\\报告.docx" }] }));
    await flush();
    await wrapper.findComponent(InputBarStub).vm.$emit("send", "看下报告");
    await flush();

    // 确认框出现 → 点确认 → 发送
    const dialog = wrapper.findComponent(ConfirmDialogStub);
    expect(dialog.exists()).toBe(true);
    expect(dialog.props("open")).toBe(true);
    await dialog.vm.$emit("confirm");
    await flush();

    expect(sendMessageMock).toHaveBeenCalledOnce();
  });

  // ── 回答中补充消息：立即上屏 + 立即发送（serve 原生支持中间补充，无需前端延迟）──

  it("补充消息：回答中（isProcessing=true）发送 → 立即上屏 + 立即调 sendMessage", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    session.setActiveSession("ses-1");
    chat.isProcessing = true;  // 模拟回答中
    sendMessageMock.mockResolvedValue({ accepted: true });

    const wrapper = mountChatPanel();
    await flush();

    await wrapper.findComponent(InputBarStub).vm.$emit("send", "补充信息A");
    await flush();

    // 立即上屏（serve 中间补充：消息入库后 runLoop 下一步带着继续）
    expect(chat.messages.filter(m => m.role === "user")).toHaveLength(1);
    expect(chat.messages.filter(m => m.role === "user")[0].content).toBe("补充信息A");
    expect(sendMessageMock).toHaveBeenCalledOnce();
    // 无待处理队列/UI（延迟上屏机制已移除；字段已不存在，断言恒真——仅保留 UI 断言）
    expect((chat as any).pendingFollowUps).toBeUndefined();
    expect(wrapper.find(".pending-fu").exists()).toBe(false);
  });

  it("补充消息：回答中发送先打断当前回合再立即发送（Claude Code/Cursor 行为）", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    session.setActiveSession("ses-1");
    chat.isProcessing = true;
    sendMessageMock.mockResolvedValue({ accepted: true });
    stopSessionMock.mockClear();

    const wrapper = mountChatPanel();
    await flush();

    await wrapper.findComponent(InputBarStub).vm.$emit("send", "补充信息B");
    await flush();

    // 消息已上屏（用户消息在时间线尾部）
    const userMsgs = chat.messages.filter(m => m.role === "user");
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0].content).toBe("补充信息B");
    // 先打断当前回合（stopSession 调用一次），再立即发送
    expect(stopSessionMock).toHaveBeenCalledOnce();
    expect(stopSessionMock).toHaveBeenCalledWith("ses-1");
    expect(sendMessageMock).toHaveBeenCalledOnce();
    expect(sendMessageMock).toHaveBeenCalledWith("ses-1", "补充信息B", expect.anything());
  });

  it("补充消息不切断流式文本：补充后 A 继续追加，serve 新轮 B 到达时自动开占位（回归 #8）", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    session.setActiveSession("ses-1");
    sendMessageMock.mockResolvedValue({ accepted: true });

    // 场景：当前轮 A 正在流式生成（已有前半段）
    chat.startAssistantMessage();
    chat.appendText("A 前半段：读取完成");

    const wrapper = mountChatPanel();
    await flush();

    // 补充消息发送（isProcessing=true 模拟回答中）
    chat.isProcessing = true;
    await wrapper.findComponent(InputBarStub).vm.$emit("send", "补充信息C");
    await flush();

    // 补充消息上屏在 A 之后
    const roles = chat.messages.map(m => m.role);
    expect(roles.filter(r => r === "user")).toHaveLength(1);
    // A 仍是流式中的同一条（未被切换占位切断）
    const assistantMsgs = chat.messages.filter(m => m.role === "assistant");
    expect(assistantMsgs).toHaveLength(1);
    // A 的后续流式文本继续追加到 A（不偷到新占位）
    chat.appendText("A 后半段：现在请你插入消息");
    expect(assistantMsgs[0].content).toBe("A 前半段：读取完成A 后半段：现在请你插入消息");
    // 未新增第二个 assistant 占位（补充消息没有强行开占位）
    expect(chat.messages.filter(m => m.role === "assistant")).toHaveLength(1);

    // A 完成 → finishAssistantMessage 清空 currentAssistantMsg
    chat.finishAssistantMessage();
    expect(chat.currentAssistantMsg).toBeNull();

    // serve 新轮 B 的 assistant 事件到达 → appendText 兜底自动开占位，B 独立成条
    chat.appendText("B：受影响后的新回复");
    const msgsAfter = chat.messages.filter(m => m.role === "assistant");
    expect(msgsAfter).toHaveLength(2);
    expect(msgsAfter[1].content).toBe("B：受影响后的新回复");
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

  // ── 诊断面板（方案 D7：事件日志 / 引擎日志两标签页）──

  it("诊断面板：切到引擎日志标签页 → readServeLog(500) 拉取并渲染 serve 行", async () => {
    const session = useSessionStore();
    session.setActiveSession("ses-1");
    // 事件日志非空 → 面板开关按钮出现（按钮显示条件只看事件日志，方案 4.5）；debugJson 需是合法 JSON 数组串
    loadSessionLogsMock.mockResolvedValue(['["debug line"]']);
    readServeLogMock.mockResolvedValue(["[12:00:00] engine boot", "[12:00:01] listening on port 58143"]);

    const wrapper = mountChatPanel();
    await flush();

    const debugBtn = wrapper.find(".debug-btn");
    expect(debugBtn.exists()).toBe(true);
    await debugBtn.trigger("click"); // 打开诊断面板
    await flush();

    expect(wrapper.text()).toContain("Diagnostics");

    // 切到引擎日志标签页 → 自动拉取 serve.log 尾部
    const serveTab = wrapper.findAll("button").find((b) => b.text() === "Engine Log");
    expect(serveTab).toBeDefined();
    await serveTab!.trigger("click");
    await flush();

    expect(readServeLogMock).toHaveBeenCalledWith(500);
    expect(wrapper.text()).toContain("[12:00:00] engine boot");
    expect(wrapper.text()).toContain("[12:00:01] listening on port 58143");
  });

  it("诊断面板：切到控制台日志标签页 → readRendererLog(500) 拉取并渲染 console 行", async () => {
    const session = useSessionStore();
    session.setActiveSession("ses-1");
    loadSessionLogsMock.mockResolvedValue(['["debug line"]']);
    readRendererLogMock.mockResolvedValue(["[10:00:00][info] boot ok", "[10:00:01][warn] something"]);

    const wrapper = mountChatPanel();
    await flush();

    const debugBtn = wrapper.find(".debug-btn");
    expect(debugBtn.exists()).toBe(true);
    await debugBtn.trigger("click"); // 打开诊断面板
    await flush();

    // 切到控制台日志标签页 → 自动拉取 renderer.log 尾部
    const rendererTab = wrapper.findAll("button").find((b) => b.text() === "Console Log");
    expect(rendererTab).toBeDefined();
    await rendererTab!.trigger("click");
    await flush();

    expect(readRendererLogMock).toHaveBeenCalledWith(500);
    expect(wrapper.text()).toContain("[10:00:00][info] boot ok");
    expect(wrapper.text()).toContain("[10:00:01][warn] something");
  });

  it("复制诊断信息 → getAppInfo + readServeLog 组合为「应用名 v版本 + serve 尾部」复制", async () => {
    const session = useSessionStore();
    session.setActiveSession("ses-1");
    loadSessionLogsMock.mockResolvedValue(['["debug line"]']);
    getAppInfoMock.mockResolvedValue({ name: "分形", version: "1.2.3" });
    readServeLogMock.mockResolvedValue(["[12:00:00] engine boot"]);

    // 捕获 copyText 写入的 textarea 值（execCommand 被调用时 textarea 尚未移除）
    const captured: string[] = [];
    const origExec = document.execCommand;
    document.execCommand = ((cmd: string) => {
      const ta = document.querySelector("textarea");
      captured.push(ta ? ta.value : "");
      return true;
    }) as typeof document.execCommand;
    try {
      const wrapper = mountChatPanel();
      await flush();
      await wrapper.find(".debug-btn").trigger("click");
      await flush();

      const copyDiag = wrapper.find('[title="Copy Diagnostics"]');
      expect(copyDiag.exists()).toBe(true);
      await copyDiag.trigger("click");
      await flush();

      expect(getAppInfoMock).toHaveBeenCalled();
      expect(readServeLogMock).toHaveBeenCalledWith(500);
      // 复制正文 = 应用名 + 版本 + 空行 + serve.log 尾部
      expect(captured[0]).toContain("分形 v1.2.3");
      expect(captured[0]).toContain("[12:00:00] engine boot");
    } finally {
      document.execCommand = origExec;
    }
  });

  it("诊断按钮常显：事件日志为空时仍可见（卡思考中也能进引擎日志页，2026-08-10 反馈）", async () => {
    const session = useSessionStore();
    session.setActiveSession("ses-1");
    // 无持久化事件日志（[null] = debug.json 不存在）——按钮显示不再依赖日志非空
    loadSessionLogsMock.mockResolvedValue([null]);

    const wrapper = mountChatPanel();
    await flush();

    const debugBtn = wrapper.find(".debug-btn");
    expect(debugBtn.exists()).toBe(true);
    expect(debugBtn.text()).toContain("Diagnostics");
  });

  it("发送后 30s 无引擎事件 → 自动弹出诊断面板 + 警告行（只提示一次）", async () => {
    vi.useFakeTimers();
    try {
      const chat = useChatStore();
      const session = useSessionStore();
      session.setActiveSession("ses-1");
      const wrapper = mountChatPanel();
      // fake timers 下不能用 flush()（setTimeout(0) 永挂）——advance 0ms 推进挂载期微任务与 0ms 定时器
      await vi.advanceTimersByTimeAsync(0);

      // 模拟发送后进入处理中（handleSend 置 isProcessing=true 触发 watch）
      chat.isProcessing = true;
      // flush Vue scheduler → watch 回调执行（interval 注册）；再推进 35s 触发超时
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(35_000);

      // 诊断面板自动打开（Teleport stub 渲染进组件树：visible=true → .attach-bar 出现；
      // useDebugLog 是工厂函数，visible 为实例私有——只能通过组件 DOM 断言）
      expect(wrapper.find(".attach-bar").exists()).toBe(true);
      // 警告行写入共享 store（按会话分桶；exportLines 直接读共享 store）
      const { useDebugLog } = await import("@/composables/useDebugLog");
      const lines = useDebugLog().exportLines("ses-1");
      expect(lines.some((l) => l.includes("Engine unresponsive"))).toBe(true);

      // 只提示一次：interval 已清理，再推进不重复警告
      const lineCount = lines.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(useDebugLog().exportLines("ses-1").length).toBe(lineCount);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── 历史子任务摘要预拉（用户反馈：完成时卡片直接显示结果梗概，替代展开懒加载）──
  // 数据链路：childSessions(parentId 匹配) + assistant 消息 toolUses(task part) → subTaskMap → 防抖 300ms 并发预拉 → summary 注入卡片

  /** 构造含 task tool part 的 assistant 消息（serve 注入 `<task id>` 输出） */
  function makeAssistantWithTask(msgId: string, subId: string) {
    return {
      id: msgId,
      role: "assistant" as const,
      content: "",
      thinking: "",
      toolUses: [{ id: `t-${msgId}`, name: "task", input: {}, result: `<task id="${subId}" state="completed">\n<task_result>ok</task_result>` }],
      contentBlocks: [],
      timestamp: Date.now(),
      isStreaming: false,
    };
  }

  /** 构造子会话（parentId 匹配活跃会话） */
  function makeChildSession(id: string, parentId: string) {
    return {
      id,
      parentId,
      agent: "工匠",
      title: "分析项目",
      createdAt: Date.now() - 60000,
      updatedAt: Date.now() - 10000,
      messageCount: 0,
      totalTokens: null,
      totalCost: null,
      mode: "",
    };
  }

  it("历史子任务：防抖 300ms 后预拉摘要，注入卡片 summary（收起态直接显示梗概）", async () => {
    vi.useFakeTimers();
    try {
      const chat = useChatStore();
      const session = useSessionStore();
      session.setActiveSession("ses-1");
      // 回合分组要求 user 前导（groupTurns 忽略孤儿 assistant）
      chat.messages.push({ id: "m-user-1", role: "user", content: "开始", thinking: "", toolUses: [], timestamp: Date.now(), isStreaming: false });
      chat.messages.push(makeAssistantWithTask("m-assist-1", "ses_hist_1"));
      session.childSessions.push(makeChildSession("ses_hist_1", "ses-1"));
      listMessagesMock.mockResolvedValue([
        { id: "sub-m1", role: "assistant", content: "子会话最终产出摘要文本", created_at: "2026-01-01T00:00:00" },
      ]);

      const wrapper = mountChatPanel();
      // 防抖 300ms 内不触发
      await vi.advanceTimersByTimeAsync(200);
      expect(listMessagesMock.mock.calls.some((c) => c[0] === "ses_hist_1")).toBe(false);
      // 超过防抖 → 预拉
      await vi.advanceTimersByTimeAsync(200);
      expect(listMessagesMock.mock.calls.some((c) => c[0] === "ses_hist_1")).toBe(true);
      // 摘要注入卡片（stub 渲染 subtask.summary；卡片在 NodeTimeline 的 subtask 节点内——平铺收敛 D13）
      await vi.advanceTimersByTimeAsync(0);
      expect(wrapper.find(".node-timeline .subtask-card-stub").exists()).toBe(true);
      expect(wrapper.text()).toContain("子会话最终产出摘要文本");
    } finally {
      vi.useRealTimers();
    }
  });

  it("历史子任务：预拉失败 summary 留空（卡片无梗概），且不重试", async () => {
    vi.useFakeTimers();
    try {
      const chat = useChatStore();
      const session = useSessionStore();
      session.setActiveSession("ses-1");
      chat.messages.push({ id: "m-user-1", role: "user", content: "开始", thinking: "", toolUses: [], timestamp: Date.now(), isStreaming: false });
      chat.messages.push(makeAssistantWithTask("m-assist-1", "ses_hist_1"));
      session.childSessions.push(makeChildSession("ses_hist_1", "ses-1"));
      listMessagesMock.mockRejectedValue(new Error("boom"));

      const wrapper = mountChatPanel();
      await vi.advanceTimersByTimeAsync(400);
      expect(listMessagesMock.mock.calls.some((c) => c[0] === "ses_hist_1")).toBe(true);
      // 卡片 summary 为空（stub 渲染空字符串）
      expect(wrapper.find(".node-timeline .subtask-card-stub").text()).toBe("");
      // 失败不重试：消息再变化触发新防抖周期，也不再拉同一子会话
      chat.messages.push(makeAssistantWithTask("m-assist-2", "ses_hist_1"));
      await vi.advanceTimersByTimeAsync(400);
      const histCalls = listMessagesMock.mock.calls.filter((c) => c[0] === "ses_hist_1");
      expect(histCalls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("历史子任务：连续消息变化重置防抖定时器，只取最后一次变化后 300ms 触发一次", async () => {
    vi.useFakeTimers();
    try {
      const chat = useChatStore();
      const session = useSessionStore();
      session.setActiveSession("ses-1");
      session.childSessions.push(makeChildSession("ses_hist_1", "ses-1"));
      listMessagesMock.mockResolvedValue([
        { id: "sub-m1", role: "assistant", content: "产出", created_at: "2026-01-01T00:00:00" },
      ]);

      const wrapper = mountChatPanel();
      await vi.advanceTimersByTimeAsync(300); // 初始无消息 → 空跑
      chat.messages.push(makeAssistantWithTask("m-a", "ses_hist_1"));
      await vi.advanceTimersByTimeAsync(200); // 防抖中
      chat.messages.push(makeAssistantWithTask("m-b", "ses_hist_1"));
      await vi.advanceTimersByTimeAsync(200); // 第二次变化后 200ms（仍 <300）
      expect(listMessagesMock.mock.calls.some((c) => c[0] === "ses_hist_1")).toBe(false);
      await vi.advanceTimersByTimeAsync(200); // 第二次变化后 400ms → 触发一次
      const histCalls = listMessagesMock.mock.calls.filter((c) => c[0] === "ses_hist_1");
      expect(histCalls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── 工作清单按需显示（方案 A）：无 todo 零空间，有 todo 才渲染 TodoPanel ──

  it("A: 无 todos → 不渲染 TodoPanel（零空间，空态文案不再占用）", async () => {
    const chat = useChatStore();
    expect(chat.todos).toHaveLength(0);

    const wrapper = mountChatPanel();
    await flush();

    expect(wrapper.find(".todo-panel-stub").exists()).toBe(false);
  });

  it("A: 有 todos → 渲染 TodoPanel", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    session.setActiveSession("ses-1");
    chat.setTodos([{ content: "写 README", status: "pending" }]);

    const wrapper = mountChatPanel();
    await flush();

    expect(wrapper.find(".todo-panel-stub").exists()).toBe(true);
  });

  it("A: todos 清空 → TodoPanel 随 v-if 移除（显示条件只看存在性）", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    session.setActiveSession("ses-1");
    chat.setTodos([{ content: "写 README", status: "pending" }]);

    const wrapper = mountChatPanel();
    await flush();
    expect(wrapper.find(".todo-panel-stub").exists()).toBe(true);

    chat.setTodos([]);
    await flush();
    expect(wrapper.find(".todo-panel-stub").exists()).toBe(false);
  });

  // ── 待办记录卡渲染（v2：消息流内，从 serve 消息历史 todowrite 工具卡提取）──

  it("消息流中全完成 todowrite → 该消息后渲染记录卡（todos 数透传）", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    session.setActiveSession("ses-1");
    const wrapper = mountChatPanel();
    await flush();

    // 实时流式：assistant 消息携带全完成 todowrite → watch(messages) 全量重提取 → 消息后渲染记录卡
    chat.addUserMessage("完成收尾");
    chat.startAssistantMessage();
    chat.addToolUse({
      id: "tu_1",
      name: "todowrite",
      input: { todos: [{ content: "a", status: "completed" }, { content: "b", status: "cancelled" }] },
    });
    chat.finishAssistantMessage();
    await flush();

    const cards = wrapper.findAll(".todo-record-card-stub");
    // 回合记录卡（title 空）1 个——todo 更新节点卡（title 非空）不算
    const recordCards = cards.filter((c) => c.attributes("data-title") === "");
    expect(recordCards).toHaveLength(1);
    expect(recordCards[0].text()).toContain("todos=2");
    // 更新节点卡并存（todowrite 工具节点本身也渲染 TodoRecordCard，title 非空）
    expect(cards.length).toBe(2);
  });

  it("消息流中 todowrite 部分完成 → 不渲染记录卡", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    session.setActiveSession("ses-1");
    const wrapper = mountChatPanel();
    await flush();

    chat.addUserMessage("进行中");
    chat.startAssistantMessage();
    chat.addToolUse({
      id: "tu_1",
      name: "todowrite",
      input: { todos: [{ content: "a", status: "completed" }, { content: "b", status: "pending" }] },
    });
    chat.finishAssistantMessage();
    await flush();

    const cards = wrapper.findAll(".todo-record-card-stub");
    // 部分完成 → 回合记录卡（title 空）不渲染；更新节点卡（title 非空）照常存在
    expect(cards.filter((c) => c.attributes("data-title") === "")).toHaveLength(0);
    expect(cards.some((c) => c.attributes("data-title") !== "")).toBe(true);
  });

  it("恢复历史：loadFullHistory 含全完成 todowrite → 记录卡随消息渲染", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    session.setActiveSession("ses-restore");
    const doneJson = JSON.stringify({
      text: "回合结束",
      thinking: "",
      toolUses: [{ id: "t1", name: "todowrite", input: { todos: [{ content: "x", status: "completed" }] } }],
      contentBlocks: [
        { type: "tool_use", toolUse: { id: "t1", name: "todowrite", input: { todos: [{ content: "x", status: "completed" }] } } },
      ],
    });

    const wrapper = mountChatPanel();
    await flush();

    // 模拟历史加载（切会话/compact 路径调用 loadFullHistory）→ messages 更新 → watch 全量重提取
    chat.loadFullHistory([
      { id: "m0", role: "user", content: "开始", created_at: "2026-01-01T00:00:00" },
      { id: "m1", role: "assistant", content: doneJson, created_at: "2026-01-01T00:01:00" },
    ]);
    await flush();

    const cards = wrapper.findAll(".todo-record-card-stub");
    const recordCards = cards.filter((c) => c.attributes("data-title") === "");
    expect(recordCards).toHaveLength(1);
    expect(recordCards[0].text()).toContain("todos=1");
  });

  // ── 回合分组 + 平铺收敛（3b 时间线化：D1 回合级 / D13 平铺收敛）──

  it("回合分组：user 消息开新回合，assistant 消息归当前回合（回合数 = user 数）", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    session.setActiveSession("ses-1");
    const wrapper = mountChatPanel();
    await flush();

    chat.addUserMessage("问题一");
    await flush();
    expect(wrapper.findAll(".msg-entry")).toHaveLength(1);

    // 流式 assistant 归当前回合，不新增回合容器
    chat.startAssistantMessage();
    chat.appendText("回答一");
    chat.finishAssistantMessage();
    await flush();
    expect(wrapper.findAll(".msg-entry")).toHaveLength(1);
    expect(wrapper.findAll(".node-timeline")).toHaveLength(1);

    // 新 user 消息 → 第二个回合
    chat.addUserMessage("问题二");
    await flush();
    expect(wrapper.findAll(".msg-entry")).toHaveLength(2);
  });

  it("回合分组：流式 step 吸收——回合最后一个 assistant 流式期间新增 step 消息仍归当前回合", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    session.setActiveSession("ses-1");
    const wrapper = mountChatPanel();
    await flush();

    chat.addUserMessage("问题一");
    chat.startAssistantMessage();
    chat.finishAssistantMessage();
    await flush();
    expect(wrapper.findAll(".msg-entry")).toHaveLength(1);

    // 新 step：startAssistantMessage push 新的 assistant 消息（isStreaming）→ 归当前回合
    chat.startAssistantMessage();
    chat.appendText("step 输出");
    await flush();
    expect(wrapper.findAll(".msg-entry")).toHaveLength(1);
    expect(wrapper.findAll(".node-timeline")).toHaveLength(1);
  });

  it("左右对话布局（制图师截图反馈）：助手回合包在 .assistant-col 左侧列（头像「分」+ 时间线），与用户右侧气泡呼应", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    session.setActiveSession("ses-1");
    const wrapper = mountChatPanel();
    await flush();

    // 无助手回复 → 不渲染 assistant-col
    chat.addUserMessage("你好");
    await flush();
    expect(wrapper.find(".assistant-col").exists()).toBe(false);

    // 有助手回复 → assistant-col 含头像 + NodeTimeline
    chat.startAssistantMessage();
    chat.appendText("你好，我是分形");
    chat.finishAssistantMessage();
    await flush();
    expect(wrapper.find(".assistant-col").exists()).toBe(true);
    // 2026-08-10：分形头像由文字 '分' 换为 logo img——断言图片存在与 alt（src 会被 vite 内联为 data URI，不比较）
    const avatar = wrapper.find(".assistant-col__avatar");
    expect(avatar.exists()).toBe(true);
    expect(avatar.attributes("alt")).toBe("分形");
    expect(wrapper.find(".assistant-col .node-timeline").exists()).toBe(true);
    // 用户消息容器与 assistant-col 同属回合容器
    expect(wrapper.find(".msg-entry .assistant-col").exists()).toBe(true);
  });

  it("平铺收敛：实时 running 子任务只在回合时间线 subtask 节点内渲染（无全局平铺副本）", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    session.setActiveSession("ses-1");
    const wrapper = mountChatPanel();
    await flush();

    // 构造 task 工具块（input.metadata.sessionId 为实时子会话键，与 3.6 提取逻辑一致）
    chat.addUserMessage("派个子任务");
    chat.startAssistantMessage();
    chat.addToolUse({
      id: "tu_task_1",
      name: "task",
      input: { metadata: { sessionId: "ses_run_1" } },
    });
    // 实时子任务状态（running）注入 store
    chat.subTasks["ses_run_1"] = {
      id: "ses_run_1",
      agent: "工匠",
      status: "running",
      deltaText: "正在分析…",
      parts: [],
      startedAt: Date.now(),
    };
    await flush();

    // 收敛后：子智能体卡片只存在于回合时间线（.msg-entry > .assistant-col > .node-timeline）内，全 DOM 仅一份
    const stubs = wrapper.findAll(".subtask-card-stub");
    expect(stubs).toHaveLength(1);
    expect(wrapper.find(".msg-entry .assistant-col .node-timeline .subtask-card-stub").exists()).toBe(true);
    // 原全局平铺位置（TransitionGroup 外的实时平铺）已移除
    expect(wrapper.find(".chat-messages-inner > .subtask-card-stub").exists()).toBe(false);
  });

  it("锚点单份（反馈 #8 修复）：data-role=user 只在回合容器上，数量 = user 数（无 MessageBubble 内重复锚点）", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    session.setActiveSession("ses-1");
    const wrapper = mountChatPanel();
    await flush();

    chat.addUserMessage("问题一");
    chat.startAssistantMessage();
    chat.appendText("回答一");
    chat.finishAssistantMessage();
    chat.addUserMessage("问题二");
    await flush();

    // 两个回合 → 恰好 2 个 data-role=user 锚点（迁移前 MessageBubble 根节点重复渲染 → 4 个）
    expect(wrapper.findAll('[data-role="user"]')).toHaveLength(2);
    expect(wrapper.findAll('[data-role="user"]')).toHaveLength(wrapper.findAll(".msg-entry").length);
    // 每个锚点都带稳定 message-id（scrollToTimelineIndex 定位目标）
    const ids = wrapper.findAll('[data-role="user"]').map((el) => el.attributes("data-message-id"));
    expect(ids).toContain(chat.messages[0].id);
  });
});

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
