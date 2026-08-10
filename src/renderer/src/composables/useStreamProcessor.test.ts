import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useChatStore } from "@/stores/chat";
import { useSessionStore } from "@/stores/session";
import { useStreamProcessor, getLastStreamEventAt } from "./useStreamProcessor";

const { listeners, saveMessageMock, listMessagesMock, debugLogAddMock } = vi.hoisted(() => ({
  listeners: new Map<string, (payload: any) => void>(),
  saveMessageMock: vi.fn(),
  listMessagesMock: vi.fn(),
  debugLogAddMock: vi.fn(),
}));
// 桩 window.electronBridge：useStreamProcessor 的事件订阅入口（原 @tauri-apps/api/event listen）
window.electronBridge = {
  invoke: (() => Promise.resolve()) as any,
  on: (eventName: string, callback: (payload: any) => void) => {
    listeners.set(eventName, callback);
    return () => listeners.delete(eventName);
  },
  // 多窗口通道：本测试不触发，仅满足 Window 类型声明
  onInitWorkspace: () => () => {},
  debugLog: () => {},
};

vi.mock("@/composables/useDebugLog", () => ({
  useDebugLog: () => ({
    add: debugLogAddMock,
    clear: vi.fn(),
    visible: { value: false },
    setSession: vi.fn(),
    exportLines: vi.fn().mockReturnValue([]),
  }),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@/lib/electron-bridge", async () => {
  const actual = await vi.importActual<typeof import("@/lib/electron-bridge")>("@/lib/electron-bridge");
  return {
    ...actual,
    saveMessage: saveMessageMock,
    saveSessionDebugLog: vi.fn().mockResolvedValue(undefined),
    listSessions: vi.fn().mockResolvedValue([]),
    listMessages: listMessagesMock,
  };
});

describe("useStreamProcessor", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    listeners.clear();
    saveMessageMock.mockReset();
    saveMessageMock.mockResolvedValue(undefined);
    listMessagesMock.mockReset();
    debugLogAddMock.mockReset();
  });

  afterEach(() => {
    useStreamProcessor().stopListening();
    listeners.clear();
  });

  it("saves result to session_id from event, not activeSessionId", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    // 事件必须匹配当前模式的活跃会话才能走 active 处理器（非 active 事件走后台缓存）
    session.setActiveSession("event-session");

    chat.addUserMessage("hello");
    chat.startAssistantMessage();
    chat.appendText("assistant reply");

    const { startListening, stopListening } = useStreamProcessor();
    await startListening();

    listeners.get("engine:event")?.({
      type: "result",
      session_id: "event-session",
      text: "",
      thinking: "",
      is_final: true,
      duration_ms: 1200,
      input_tokens: 10,
      output_tokens: 20,
      cost_usd: 0.001,
    });

    expect(saveMessageMock).toHaveBeenCalledOnce();
    expect(saveMessageMock).toHaveBeenCalledWith(
      expect.any(String),
      "event-session",
      "assistant",
      expect.any(String),
      "{}",
    );

    // 回合完成记录（诊断按钮「有日志」保底入口）：✅ 前缀 + 耗时/token 统计
    expect(debugLogAddMock).toHaveBeenCalledWith(
      expect.stringMatching(/^✅ 回合完成：1200ms \/ in=10 out=20$/),
      "event-session",
    );

    stopListening();
  });

  it("falls back to activeSessionId when event has no session_id", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    session.setActiveSession("active-session");

    chat.addUserMessage("hello");
    chat.startAssistantMessage();
    chat.appendText("assistant reply");

    const { startListening, stopListening } = useStreamProcessor();
    await startListening();

    listeners.get("engine:event")?.({
      type: "result",
      text: "",
      thinking: "",
      is_final: true,
      duration_ms: 1200,
      input_tokens: 10,
      output_tokens: 20,
      cost_usd: 0.001,
    });

    expect(saveMessageMock).toHaveBeenCalledOnce();
    expect(saveMessageMock).toHaveBeenCalledWith(
      expect.any(String),
      "active-session",
      "assistant",
      expect.any(String),
      "{}",
    );

    stopListening();
  });

  it("result 事件 session_id 缺失 → 兜底清活跃会话 activity（绿点不残留，2026-08-10 反馈）", async () => {
    const session = useSessionStore();
    session.setActiveSession("active-session");
    session.setSessionActivity("active-session", "processing");

    const { startListening, stopListening } = useStreamProcessor();
    await startListening();

    listeners.get("engine:event")?.({
      type: "result",
      text: "",
      thinking: "",
      is_final: true,
      duration_ms: 800,
    });

    // setSessionActivity(null) = 删除 key（session store L58），读取为 undefined
    expect(session.sessionActivity["active-session"]).toBeUndefined();

    stopListening();
  });

  it("engine:event 到达更新 lastStreamEventAt（卡死超时检测的活跃基准）", async () => {
    const { startListening, stopListening } = useStreamProcessor();
    await startListening();

    // 模块级时间戳随事件更新：任何事件（含后台会话）都代表 SSE 连接活着
    const t0 = getLastStreamEventAt();
    listeners.get("engine:event")?.({
      type: "assistant",
      session_id: "some-other-session",
      text: "后台输出",
    });
    expect(getLastStreamEventAt()).toBeGreaterThan(t0);

    stopListening();
  });

  it("engine:status → session.serving 连接状态更新", async () => {
    const session = useSessionStore();
    const { startListening, stopListening } = useStreamProcessor();
    await startListening();

    listeners.get("engine:status")?.({ running: true });
    expect(session.serving).toBe(true);
    listeners.get("engine:status")?.({ running: false });
    expect(session.serving).toBe(false);

    stopListening();
  });

  it("G3: engine:status running=true 且 historyError → 自动重载当前会话历史并清除离线标记", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    session.setActiveSession("ses-recover");
    chat.setHistoryError(true);
    // serve 恢复：消息端点返回含 JSON blob 的历史（模拟主进程 toMessageData 输出）
    const assistantBlob = JSON.stringify({
      text: "恢复后的回答",
      thinking: "思考中",
      toolUses: [{ id: "call_x", name: "Bash", input: { command: "ls" }, result: "out.txt", isError: false }],
      contentBlocks: [
        { type: "thinking", content: "思考中" },
        { type: "tool_use", toolUse: { id: "call_x", name: "Bash", input: { command: "ls" } } },
        { type: "tool_result", toolResult: { toolUseId: "call_x", content: "out.txt", isError: false } },
        { type: "text", content: "恢复后的回答" },
      ],
    });
    listMessagesMock.mockResolvedValue([
      { id: "m1", role: "user", content: "原始问题", created_at: "2026-01-01T00:00:00" },
      { id: "m2", role: "assistant", content: assistantBlob, created_at: "2026-01-01T00:00:05" },
    ]);

    const { startListening, stopListening } = useStreamProcessor();
    await startListening();

    listeners.get("engine:status")?.({ running: true });
    await flushPromises();

    // 离线标记清除，消息完整还原（thinking/toolUses/contentBlocks）
    expect(listMessagesMock).toHaveBeenCalledWith("ses-recover", { limit: 500 });
    expect(chat.historyError).toBe(false);
    expect(chat.messages).toHaveLength(2);
    expect(chat.messages[1].thinking).toBe("思考中");
    expect(chat.messages[1].toolUses).toHaveLength(1);
    expect(chat.messages[1].toolUses[0].name).toBe("Bash");
    expect(chat.messages[1].contentBlocks).toHaveLength(4);
    expect(chat.messages[1].content).toBe("恢复后的回答");

    stopListening();
  });

  it("G3: engine:status running=false 不触发重载；running=true 但无 historyError 也不重载", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    session.setActiveSession("ses-1");

    const { startListening, stopListening } = useStreamProcessor();
    await startListening();

    // 无 historyError → 不重载
    listeners.get("engine:status")?.({ running: true });
    await flushPromises();
    expect(listMessagesMock).not.toHaveBeenCalled();

    // running=false → 不重载
    chat.setHistoryError(true);
    listeners.get("engine:status")?.({ running: false });
    await flushPromises();
    expect(listMessagesMock).not.toHaveBeenCalled();

    stopListening();
  });

  it("G3: 自动重载失败 → 保留离线标记等待下次恢复", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    session.setActiveSession("ses-fail");
    chat.setHistoryError(true);
    listMessagesMock.mockRejectedValue(new Error("serve 未就绪"));

    const { startListening, stopListening } = useStreamProcessor();
    await startListening();

    listeners.get("engine:status")?.({ running: true });
    await flushPromises();

    expect(chat.historyError).toBe(true);
    expect(chat.messages).toHaveLength(0);

    stopListening();
  });

  it("control_request 事件 → 审批弹窗数据（pendingControlRequest）", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    session.setActiveSession("ses-1");

    const { startListening, stopListening } = useStreamProcessor();
    await startListening();

    listeners.get("engine:event")?.({
      type: "control_request",
      session_id: "ses-1",
      text: "",
      thinking: "",
      control_request: {
        subtype: "request",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        request_id: "perm-1",
      },
    });

    expect(chat.pendingControlRequest).not.toBeNull();
    expect(chat.pendingControlRequest?.tool_name).toBe("Bash");
    expect(chat.pendingControlRequest?.request_id).toBe("perm-1");
    // 审批中 → 会话活动状态 blocked（橙点，最高优先级）
    expect(session.sessionActivity["ses-1"]).toBe("blocked");

    stopListening();
  });

  it("todo 事件（活跃会话）→ 覆盖 chat.todos", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    session.setActiveSession("ses-todo");

    const { startListening, stopListening } = useStreamProcessor();
    await startListening();

    listeners.get("engine:event")?.({
      type: "todo",
      session_id: "ses-todo",
      text: "",
      thinking: "",
      todos: [
        { content: "写 README", status: "pending", priority: "high" },
        { content: "运行测试", status: "in_progress", priority: "medium" },
        { content: "git 提交", status: "completed", priority: "low" },
      ],
    });

    expect(chat.todos).toHaveLength(3);
    expect(chat.todos[0].content).toBe("写 README");
    expect(chat.todos[0].status).toBe("pending");
    expect(chat.todos[0].priority).toBe("high");
    expect(chat.todos[1].status).toBe("in_progress");
    expect(chat.todos[2].status).toBe("completed");

    stopListening();
  });

  it("todo 事件（后台会话）→ 写入 sessionCache，不污染活跃会话", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    session.setActiveSession("ses-active");
    chat.addUserMessage("hi");

    const { startListening, stopListening } = useStreamProcessor();
    await startListening();

    listeners.get("engine:event")?.({
      type: "todo",
      session_id: "ses-background",
      text: "",
      thinking: "",
      todos: [{ content: "后台任务", status: "pending", priority: "high" }],
    });

    // 活跃会话 todos 未被污染
    expect(chat.todos).toHaveLength(0);

    // 切到后台会话：从缓存恢复待办
    chat.clearMessages();
    const cached = chat.loadFromCache("ses-background");
    expect(cached).not.toBeNull();
    expect(chat.todos).toHaveLength(1);
    expect(chat.todos[0].content).toBe("后台任务");

    stopListening();
  });

  it("error 事件 → debugLog 记录 ❌ 错误内容（D6 精简后补的记录点）", async () => {
    const session = useSessionStore();
    // error 事件带 session_id 且非活跃会话会走后台缓存分支（L187 return），需匹配活跃会话才进 case error
    session.setActiveSession("ses-err");
    const { startListening, stopListening } = useStreamProcessor();
    await startListening();

    listeners.get("engine:event")?.({
      type: "error",
      session_id: "ses-err",
      text: "",
      thinking: "",
      error: "API key 无效",
    });

    // 错误内容写入 debugLog，带 ❌ 前缀（t mock 直接返回 key）
    expect(debugLogAddMock).toHaveBeenCalledWith(expect.stringMatching(/^❌ /), "ses-err");

    stopListening();
  });

  it("精简后无逐条事件流明细（D6：去掉 📨 event: 刷屏记录，防回归）", async () => {
    const session = useSessionStore();
    session.setActiveSession("ses-detail");
    const { startListening, stopListening } = useStreamProcessor();
    await startListening();

    // 触发消息增量事件（原 L182 会记录逐条明细的最高频事件）
    listeners.get("engine:event")?.({
      type: "assistant",
      session_id: "ses-detail",
      text: "增量文本",
      thinking: "",
    });

    // 精简后：任何事件不再写「📨 event: 」前缀的逐条明细
    const detailCalls = debugLogAddMock.mock.calls.filter(
      ([line]) => typeof line === "string" && line.startsWith("📨 event: "),
    );
    expect(detailCalls).toHaveLength(0);

    stopListening();
  });

  it("subtask 事件 → chat.handleSubTaskEvent 建卡并累积（created/delta/part/idle 全链路）", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    session.setActiveSession("ses-main");
    listMessagesMock.mockResolvedValue([]);

    const { startListening, stopListening } = useStreamProcessor();
    await startListening();

    // 子会话 created（主进程 events.ts 识别：sessionID ≠ 活跃会话）
    listeners.get("engine:event")?.({
      type: "subtask",
      session_id: "ses-sub-1",
      subId: "ses-sub-1",
      parentId: "ses-main",
      agent: "工匠",
      kind: "created",
    });
    expect(chat.subTasks["ses-sub-1"]).toBeDefined();
    expect(chat.subTasks["ses-sub-1"].agent).toBe("工匠");
    expect(chat.subTasks["ses-sub-1"].status).toBe("running");

    // delta 增量
    listeners.get("engine:event")?.({
      type: "subtask",
      session_id: "ses-sub-1",
      subId: "ses-sub-1",
      parentId: "ses-main",
      kind: "delta",
      text: "正在处理",
    });
    expect(chat.subTasks["ses-sub-1"].deltaText).toBe("正在处理");

    // part（tool）
    listeners.get("engine:event")?.({
      type: "subtask",
      session_id: "ses-sub-1",
      subId: "ses-sub-1",
      parentId: "ses-main",
      kind: "part",
      part: { type: "tool", tool: "Bash", state: "running" },
    });
    expect(chat.subTasks["ses-sub-1"].parts.some(p => p.type === "tool" && p.tool === "Bash")).toBe(true);

    // idle（异步拉摘要，flushPromises 等待）
    listeners.get("engine:event")?.({
      type: "subtask",
      session_id: "ses-sub-1",
      subId: "ses-sub-1",
      parentId: "ses-main",
      kind: "idle",
    });
    await flushPromises();
    expect(chat.subTasks["ses-sub-1"].status).toBe("done");

    stopListening();
  });

  it("subtask 事件不写后台会话缓存（handleBackgroundStreamEvent 不被触发）", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    session.setActiveSession("ses-main");

    const { startListening, stopListening } = useStreamProcessor();
    await startListening();

    listeners.get("engine:event")?.({
      type: "subtask",
      session_id: "ses-sub-2",
      subId: "ses-sub-2",
      parentId: "ses-main",
      kind: "created",
    });

    // 子会话事件带非活跃 session_id，但不应写入 sessionCache（普通后台会话才写缓存）
    expect(chat.sessionCache.has("ses-sub-2")).toBe(false);
    expect(chat.messages).toHaveLength(0);

    stopListening();
  });

  it("result 回合收尾：最后一项未完成 → settle 补勾（模型漏勾兜底，v2 保留）", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    session.setActiveSession("ses-todo2");

    // 最后一项 in_progress（模型收尾漏勾场景）→ settle 补勾 → 全完成
    chat.setTodos([
      { content: "已完成项", status: "completed" },
      { content: "收尾项", status: "in_progress" },
    ]);

    const { startListening, stopListening } = useStreamProcessor();
    await startListening();

    listeners.get("engine:event")?.({
      type: "result",
      session_id: "ses-todo2",
      text: "",
      thinking: "",
      is_final: true,
      duration_ms: 800,
      input_tokens: 5,
      output_tokens: 8,
      cost_usd: 0,
    });
    await flushPromises();

    expect(chat.todos[1].status).toBe("completed"); // settle 生效

    stopListening();
  });

  it("result 回合收尾：pending 在非末位 → settle 不补勾（真没做完）", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    session.setActiveSession("ses-todo3");

    // pending 放前面：settle 只补「最后一项未完成」，此场景不应被补勾（真没做完）
    chat.setTodos([
      { content: "没完成的", status: "pending" },
      { content: "完成的", status: "completed" },
    ]);

    const { startListening, stopListening } = useStreamProcessor();
    await startListening();

    listeners.get("engine:event")?.({
      type: "result",
      session_id: "ses-todo3",
      text: "",
      thinking: "",
      is_final: true,
      duration_ms: 800,
      input_tokens: 5,
      output_tokens: 8,
      cost_usd: 0,
    });
    await flushPromises();

    expect(chat.todos[0].status).toBe("pending"); // settle 未补勾

    stopListening();
  });

  it("result 回合收尾：后台会话（session_id ≠ 活跃）→ settle 跳过（todos 保持原状）", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    session.setActiveSession("ses-active");

    chat.setTodos([
      { content: "完成项", status: "completed" },
      { content: "后台未收尾", status: "in_progress" },
    ]);

    const { startListening, stopListening } = useStreamProcessor();
    await startListening();

    listeners.get("engine:event")?.({
      type: "result",
      session_id: "ses-background",
      text: "",
      thinking: "",
      is_final: true,
      duration_ms: 800,
      input_tokens: 5,
      output_tokens: 8,
      cost_usd: 0,
    });
    await flushPromises();

    expect(chat.todos[1].status).toBe("in_progress"); // 后台会话不补勾

    stopListening();
  });

  it("result 回合收尾：无 todos → settle 安全空跑", async () => {
    const session = useSessionStore();
    session.setActiveSession("ses-todo4");

    const { startListening, stopListening } = useStreamProcessor();
    await startListening();

    listeners.get("engine:event")?.({
      type: "result",
      session_id: "ses-todo4",
      text: "",
      thinking: "",
      is_final: true,
      duration_ms: 800,
      input_tokens: 5,
      output_tokens: 8,
      cost_usd: 0,
    });
    await flushPromises();

    // 无 todos 空跑不抛错（v2 记录卡由消息历史提取，与 result 事件解耦）
    stopListening();
  });
});

// ── buildContentBlocks 专项测试 ──

import { buildContentBlocks, extractToolResultContent } from "./useStreamProcessor";

describe("buildContentBlocks", () => {
  it("空输入返回空数组", () => {
    expect(buildContentBlocks(undefined)).toEqual([]);
    expect(buildContentBlocks([])).toEqual([]);
  });

  it("空输入保留 existing", () => {
    const existing = [{ type: "text" as const, content: "old" }];
    expect(buildContentBlocks(undefined, existing)).toBe(existing);
    expect(buildContentBlocks([], existing)).toBe(existing);
  });

  it("简单文本块构建", () => {
    const raw = [{ type: "text", text: "Hello" }] as any;
    const result = buildContentBlocks(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: "text", content: "Hello" });
  });

  it("同类型连续块 startsWith → 替换", () => {
    const existing = [{ type: "text" as const, content: "Hello" }];
    const raw = [{ type: "text", text: "Hello world" }] as any;
    const result = buildContentBlocks(raw, existing);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Hello world");
  });

  it("同类型连续块 不 startsWith → 追加（DeepSeek 增量）", () => {
    const existing = [{ type: "text" as const, content: "Hello" }];
    const raw = [{ type: "text", text: " world" }] as any;
    const result = buildContentBlocks(raw, existing);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Hello world");
  });

  it("text 块被 tool_use 隔开时各自独立", () => {
    // 场景：CC 说"我来编辑"→ 调用 Edit 工具 → 工具失败 → CC 说"文件被锁"
    const raw = [
      { type: "thinking", thinking: "需要编辑文件" },
      { type: "text", text: "我来帮你编辑文件" },
      { type: "tool_use", id: "tu_1", name: "Edit", input: { file_path: "a.ts" } },
      { type: "text", text: "文件被锁，无法编辑。需要换个方案。" },
    ] as any;
    const result = buildContentBlocks(raw);
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ type: "thinking", content: "需要编辑文件" });
    expect(result[1]).toEqual({ type: "text", content: "我来帮你编辑文件" });
    expect(result[2].type).toBe("tool_use");
    expect(result[2].toolUse!.id).toBe("tu_1");
    expect(result[3]).toEqual({ type: "text", content: "文件被锁，无法编辑。需要换个方案。" });
  });

  it("thinking 块被 tool_use 隔开时各自独立", () => {
    const raw = [
      { type: "thinking", thinking: "分析问题" },
      { type: "tool_use", id: "tu_1", name: "Read", input: {} },
      { type: "thinking", thinking: "基于读取结果重新分析" },
    ] as any;
    const result = buildContentBlocks(raw);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ type: "thinking", content: "分析问题" });
    expect(result[2]).toEqual({ type: "thinking", content: "基于读取结果重新分析" });
  });

  it("第二次全量事件：旧 text 内容不变，新 tool_use + text 正确追加", () => {
    // 模拟 CC 第二次 assistant 事件携带完整状态
    const existing = [
      { type: "thinking" as const, content: "需要编辑文件" },
      { type: "text" as const, content: "我来帮你编辑文件" },
    ];
    const raw = [
      { type: "thinking", thinking: "需要编辑文件（扩展思考）" },
      { type: "text", text: "我来帮你编辑文件" },           // 同旧块
      { type: "tool_use", id: "tu_1", name: "Edit", input: {} },
      { type: "text", text: "编辑完成！" },                    // 跨 tool_use 的新块
    ] as any;
    const result = buildContentBlocks(raw, existing);
    expect(result).toHaveLength(4);
    expect(result[0].content).toBe("需要编辑文件（扩展思考）"); // startsWith → 替换
    expect(result[1].content).toBe("我来帮你编辑文件");         // startsWith → 替换（无变化）
    expect(result[2].type).toBe("tool_use");
    expect(result[3]).toEqual({ type: "text", content: "编辑完成！" }); // 独立新块
  });

  it("tool_use 按 ID 去重", () => {
    const raw = [
      { type: "tool_use", id: "tu_1", name: "Bash", input: {} },
      { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } },
      { type: "tool_use", id: "tu_2", name: "Read", input: {} },
    ] as any;
    const result = buildContentBlocks(raw);
    expect(result).toHaveLength(2);
    expect(result[0].toolUse!.id).toBe("tu_1");
    expect(result[1].toolUse!.id).toBe("tu_2");
  });

  it("tool_result 按 toolUseId 去重", () => {
    const raw = [
      { type: "tool_result", tool_use_id: "tr_1", content: "result A" },
      { type: "tool_result", tool_use_id: "tr_1", content: "result B" },
    ] as any;
    const result = buildContentBlocks(raw);
    expect(result).toHaveLength(1);
    expect(result[0].toolResult!.toolUseId).toBe("tr_1");
  });

  it("工具耗时服务端透传优先：tool_use.startedAt / tool_results.executionDurationMs 覆盖客户端计时（2026-08-10）", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    session.setActiveSession("ses-t");

    chat.addUserMessage("跑工具");
    chat.startAssistantMessage();

    const { startListening, stopListening } = useStreamProcessor();
    await startListening();

    // assistant 事件：服务端 ToolState.time.start → startedAt（客户端计时会被忽略）
    listeners.get("engine:event")?.({
      type: "assistant",
      session_id: "ses-t",
      text: "",
      thinking: "",
      tool_use: [{ id: "t1", name: "Bash", input: {}, startedAt: 1000 }],
      content_blocks: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
    });
    expect(chat.currentAssistantMsg?.toolUses[0].startedAt).toBe(1000);

    // user 事件：服务端 end-start → executionDurationMs（若走客户端会得到 Date.now() 差值 ≈ 0-2ms）
    listeners.get("engine:event")?.({
      type: "user",
      session_id: "ses-t",
      text: "",
      thinking: "",
      tool_results: [{ tool_use_id: "t1", content: "ok", is_error: false, executionDurationMs: 2000 }],
    });
    expect(chat.currentAssistantMsg?.toolUses[0].executionDurationMs).toBe(2000);
    // syncBlockTimings 同步到 contentBlocks 工具块
    const block = chat.currentAssistantMsg?.contentBlocks?.find((b) => b.type === "tool_use");
    expect(block?.toolUse?.startedAt).toBe(1000);
    expect(block?.toolUse?.executionDurationMs).toBe(2000);

    stopListening();
  });

  it("assistant 事件带 thinkingDurationMs → 回填 thinking 块（serve ReasoningPart.time 透传，2026-08-10）", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    session.setActiveSession("ses-t");

    chat.addUserMessage("思考题");
    chat.startAssistantMessage();

    const { startListening, stopListening } = useStreamProcessor();
    await startListening();

    // 流式 thinking 增量（delta 无耗时）
    listeners.get("engine:event")?.({
      type: "assistant",
      session_id: "ses-t",
      text: "",
      thinking: "让我想想",
    });
    // 全量 updated（带 ReasoningPart.time）→ 耗时透传
    listeners.get("engine:event")?.({
      type: "assistant",
      session_id: "ses-t",
      text: "",
      thinking: "让我想想",
      thinkingDurationMs: 2500,
    });
    const block = chat.currentAssistantMsg?.contentBlocks?.find((b) => b.type === "thinking");
    expect(block?.durationMs).toBe(2500);

    stopListening();
  });

  it("existing 中的隔断块不影响同类型 startsWith 替换", () => {
    // 场景：第一次事件产生了 [text, tool_use]，
    // 第二次 CC 完整事件携带 [text(同), tool_use(同), text(新)]
    const existing = [
      { type: "text" as const, content: "Step 1" },
      { type: "tool_use" as const, toolUse: { id: "tu_1", name: "Read", input: {} } },
    ];
    const raw = [
      { type: "text", text: "Step 1" },
      { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "a.ts" } },
      { type: "text", text: "Step 2 — 读取完成" },
    ] as any;
    const result = buildContentBlocks(raw, existing);
    expect(result).toHaveLength(3);
    expect(result[0].content).toBe("Step 1");       // startsWith → 替换
    expect(result[1].type).toBe("tool_use");
    expect(result[1].toolUse!.id).toBe("tu_1");
    expect(result[2]).toEqual({ type: "text", content: "Step 2 — 读取完成" }); // 独立新块
  });
});

describe("extractToolResultContent", () => {
  it("字符串直通", () => {
    expect(extractToolResultContent("plain text")).toBe("plain text");
  });

  it("提取 content block 数组中的 text", () => {
    expect(extractToolResultContent([
      { type: "text", text: "line 1\n" },
      { type: "text", text: "line 2" },
    ])).toBe("line 1\nline 2");
  });

  it("非字符串非数组返回空串", () => {
    expect(extractToolResultContent(null)).toBe("");
    expect(extractToolResultContent(undefined)).toBe("");
    expect(extractToolResultContent(42)).toBe("");
  });
});

/** 等待微任务队列排空（mockResolvedValue 链 + engine:status 回调内的异步链） */
function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
