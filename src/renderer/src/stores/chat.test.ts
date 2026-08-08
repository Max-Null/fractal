import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useChatStore, SUBTASK_DELTA_MAX, SUBTASK_PARTS_MAX, extractSubTaskIds, buildSubTaskMap, type Message, type SubTaskChildRef } from "./chat";

// mock electron-bridge：仅覆盖 listMessages（子任务 idle 拉摘要用），其余保留原模块
const { listMessagesMock } = vi.hoisted(() => ({ listMessagesMock: vi.fn() }));
vi.mock("@/lib/electron-bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/electron-bridge")>();
  return { ...actual, listMessages: listMessagesMock };
});

describe("chat store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    listMessagesMock.mockReset();
    listMessagesMock.mockResolvedValue([]);
  });

  it("starts with empty messages", () => {
    const chat = useChatStore();
    expect(chat.messages).toHaveLength(0);
    expect(chat.isProcessing).toBe(false);
  });

  it("adds user message", () => {
    const chat = useChatStore();
    const id = chat.addUserMessage("Hello");
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0].role).toBe("user");
    expect(chat.messages[0].content).toBe("Hello");
    expect(chat.messages[0].isStreaming).toBe(false);
  });

  it("creates assistant message and streams text", () => {
    const chat = useChatStore();
    chat.addUserMessage("Hi");
    const id = chat.startAssistantMessage();

    expect(chat.messages).toHaveLength(2);
    expect(chat.currentAssistantMsg).not.toBeNull();
    expect(chat.currentAssistantMsg!.isStreaming).toBe(true);

    chat.appendText("Hello ");
    chat.appendText("world!");
    expect(chat.currentAssistantMsg!.content).toBe("Hello world!");
  });

  it("handles thinking content", () => {
    const chat = useChatStore();
    chat.addUserMessage("Think");
    chat.startAssistantMessage();

    chat.appendThinking("Let me think...");
    chat.appendThinking("Done thinking.");
    expect(chat.currentAssistantMsg!.thinking).toBe("Let me think...Done thinking.");
  });

  it("handles tool use", () => {
    const chat = useChatStore();
    chat.addUserMessage("Run command");
    chat.startAssistantMessage();

    chat.addToolUse({
      id: "tu_001",
      name: "Bash",
      input: { command: "ls" },
    });

    expect(chat.currentAssistantMsg!.toolUses).toHaveLength(1);
    expect(chat.currentAssistantMsg!.toolUses[0].name).toBe("Bash");
  });

  it("finishes assistant message", () => {
    const chat = useChatStore();
    chat.addUserMessage("Done");
    chat.startAssistantMessage();

    chat.appendText("All done.");
    chat.finishAssistantMessage();

    expect(chat.currentAssistantMsg).toBeNull();
    expect(chat.messages[1].isStreaming).toBe(false);
    expect(chat.isProcessing).toBe(false);
  });

  it("clears all messages", () => {
    const chat = useChatStore();
    chat.addUserMessage("msg1");
    chat.addUserMessage("msg2");
    expect(chat.messages).toHaveLength(2);

    chat.clearMessages();
    expect(chat.messages).toHaveLength(0);
    expect(chat.currentAssistantMsg).toBeNull();
  });

  // ── Control Request ──

  it("adds and resolves control request", () => {
    const chat = useChatStore();
    const cr = { subtype: "can_use_tool", tool_name: "Bash", tool_input: { command: "ls" } };
    chat.addControlRequest(cr);
    expect(chat.pendingControlRequest).not.toBeNull();
    expect(chat.pendingControlRequest!.tool_name).toBe("Bash");

    chat.resolveControlRequest("allow");
    expect(chat.pendingControlRequest).toBeNull();
  });

  it("control request is cleared with clearMessages", () => {
    const chat = useChatStore();
    chat.addControlRequest({ subtype: "can_use_tool", tool_name: "Read", tool_input: { file_path: "x" } });
    expect(chat.pendingControlRequest).not.toBeNull();

    chat.clearMessages();
    expect(chat.pendingControlRequest).toBeNull();
  });

  // ── Token & Duration Stats ──

  it("records token and duration stats on finish", () => {
    const chat = useChatStore();
    chat.addUserMessage("Hi");
    chat.startAssistantMessage();
    chat.appendText("Done.");

    chat.finishAssistantMessage(1234, 50, 30, 0.005);
    const msg = chat.messages[1];
    expect(msg.isStreaming).toBe(false);
    expect(msg.durationMs).toBe(1234);
    expect(msg.inputTokens).toBe(50);
    expect(msg.outputTokens).toBe(30);
    expect(msg.costUSD).toBe(0.005);
  });

  it("finish without stats works (backward compat)", () => {
    const chat = useChatStore();
    chat.addUserMessage("Hi");
    chat.startAssistantMessage();
    chat.appendText("reply");  // 空消息会被 finishAssistantMessage 删除，需有内容
    chat.finishAssistantMessage();
    expect(chat.messages[1].durationMs).toBeUndefined();
    expect(chat.messages[1].inputTokens).toBeUndefined();
  });

  // ── Load Messages from DB ──

  it("loadMessages restores user messages", () => {
    const chat = useChatStore();
    chat.loadMessages([
      { id: "u1", role: "user", content: "Hello", created_at: "2026-01-01T00:00:00" },
      { id: "u2", role: "user", content: "World", created_at: "2026-01-01T00:01:00" },
    ]);
    expect(chat.messages).toHaveLength(2);
    expect(chat.messages[0].role).toBe("user");
    expect(chat.messages[0].content).toBe("Hello");
  });

  it("loadMessages parses user attachment JSON only when attachments exist", () => {
    const chat = useChatStore();
    chat.loadMessages([
      {
        id: "u1",
        role: "user",
        content: JSON.stringify({
          text: "Hello",
          attachments: [{ name: "foo.txt", path: "C:/tmp/foo.txt" }],
        }),
        created_at: "2026-01-01T00:00:00",
      },
    ]);
    expect(chat.messages[0].content).toBe("Hello");
    expect(chat.messages[0].attachments).toEqual([{ name: "foo.txt", path: "C:/tmp/foo.txt" }]);
  });

  it("loadMessages keeps raw user JSON text when it is not attachment metadata", () => {
    const chat = useChatStore();
    const raw = "{\"text\":\"hello\"}";
    chat.loadMessages([
      { id: "u1", role: "user", content: raw, created_at: "2026-01-01T00:00:00" },
    ]);
    expect(chat.messages[0].content).toBe(raw);
    expect(chat.messages[0].attachments).toBeUndefined();
  });

  it("loadMessages parses assistant JSON content", () => {
    const chat = useChatStore();
    chat.loadMessages([
      {
        id: "a1",
        role: "assistant",
        content: JSON.stringify({
          text: "Answer text",
          thinking: "Deep thought",
          toolUses: [{ id: "t1", name: "Bash", input: { command: "ls" } }],
          durationMs: 500,
          inputTokens: 10,
          outputTokens: 20,
          costUSD: 0.001,
        }),
        created_at: "2026-01-01T00:00:00",
      },
    ]);
    expect(chat.messages).toHaveLength(1);
    const msg = chat.messages[0];
    expect(msg.content).toBe("Answer text");
    expect(msg.thinking).toBe("Deep thought");
    expect(msg.toolUses).toHaveLength(1);
    expect(msg.toolUses[0].name).toBe("Bash");
    expect(msg.durationMs).toBe(500);
    expect(msg.costUSD).toBe(0.001);
  });

  it("loadMessages falls back to plain text for old format", () => {
    const chat = useChatStore();
    chat.loadMessages([
      { id: "a1", role: "assistant", content: "Plain old text", created_at: "2026-01-01T00:00:00" },
    ]);
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0].content).toBe("Plain old text");
    expect(chat.messages[0].thinking).toBe("");
    expect(chat.messages[0].toolUses).toEqual([]);
  });

  it("loadMessages clears existing messages first", () => {
    const chat = useChatStore();
    chat.addUserMessage("existing");
    expect(chat.messages).toHaveLength(1);

    chat.loadMessages([{ id: "n1", role: "user", content: "new", created_at: "2026-01-01T00:00:00" }]);
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0].content).toBe("new");
  });

  // ── updateMessage ──

  it("updates message content by id", () => {
    const chat = useChatStore();
    const id = chat.addUserMessage("Original");
    chat.updateMessage(id, "Edited");
    expect(chat.messages[0].content).toBe("Edited");
  });

  it("updateMessage does nothing for unknown id", () => {
    const chat = useChatStore();
    chat.addUserMessage("Hello");
    chat.updateMessage("nonexistent", "Should not work");
    expect(chat.messages[0].content).toBe("Hello");
    expect(chat.messages).toHaveLength(1);
  });

  // ── truncateFromIndex ──

  it("truncateFromIndex removes messages from index", () => {
    const chat = useChatStore();
    chat.addUserMessage("msg1");
    chat.addUserMessage("msg2");
    chat.addUserMessage("msg3");
    expect(chat.messages).toHaveLength(3);

    chat.truncateFromIndex(1);
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0].content).toBe("msg1");
  });

  it("truncateFromIndex returns 0 for out-of-bounds index", () => {
    const chat = useChatStore();
    chat.addUserMessage("msg1");
    expect(chat.truncateFromIndex(5)).toBe(0);
    expect(chat.truncateFromIndex(-1)).toBe(0);
    expect(chat.messages).toHaveLength(1);
  });

  // ── truncateAfterMessage ──

  it("truncateAfterMessage removes messages after given id", () => {
    const chat = useChatStore();
    const id1 = chat.addUserMessage("msg1");
    chat.addUserMessage("msg2");
    chat.addUserMessage("msg3");
    expect(chat.messages).toHaveLength(3);

    chat.truncateAfterMessage(id1);
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0].content).toBe("msg1");
  });

  it("truncateAfterMessage does nothing for unknown id", () => {
    const chat = useChatStore();
    chat.addUserMessage("msg1");
    chat.addUserMessage("msg2");
    chat.truncateAfterMessage("unknown");
    expect(chat.messages).toHaveLength(2);
  });

  // ── exportMarkdown ──

  it("exportMarkdown produces markdown with user and assistant messages", () => {
    const chat = useChatStore();
    chat.addUserMessage("Hello AI");
    chat.startAssistantMessage();
    chat.appendText("Hello human");
    chat.finishAssistantMessage(1000, 10, 20, 0.001);

    const md = chat.exportMarkdown("Test Session");
    expect(md).toContain("# Test Session");
    expect(md).toContain("## You");
    expect(md).toContain("Hello AI");
    expect(md).toContain("## 分形");
    expect(md).toContain("Hello human");
    expect(md).toContain("⏱ 1.0s");
  });

  it("exportMarkdown includes thinking and tool uses", () => {
    const chat = useChatStore();
    chat.addUserMessage("Run command");
    chat.startAssistantMessage();
    chat.appendThinking("Let me think...");
    chat.addToolUse({ id: "t1", name: "Bash", input: { command: "ls" } });
    chat.appendText("Done");
    chat.finishAssistantMessage();

    const md = chat.exportMarkdown("Test");
    expect(md).toContain("**Thinking:**");
    expect(md).toContain("Let me think...");
    expect(md).toContain("🔧 **Bash**");
  });

  // ── appendToolResult ──

  it("appendToolResult updates toolUse result and adds tool_result contentBlock", () => {
    const chat = useChatStore();
    chat.addUserMessage("Run");
    chat.startAssistantMessage();
    chat.addToolUse({ id: "t1", name: "Bash", input: { command: "ls" } });
    // 建立 contentBlocks 时间线
    chat.setContentBlocks([{ type: "tool_use", toolUse: { id: "t1", name: "Bash", input: { command: "ls" } } }]);

    chat.appendToolResult("t1", "file1.txt\nfile2.txt", false);

    const msg = chat.currentAssistantMsg!;
    // toolUses 中对应工具被更新
    expect(msg.toolUses[0].result).toBe("file1.txt\nfile2.txt");
    expect(msg.toolUses[0].isError).toBe(false);
    // contentBlocks 中追加了 tool_result
    expect(msg.contentBlocks).toHaveLength(2);
    expect(msg.contentBlocks![1].type).toBe("tool_result");
    expect(msg.contentBlocks![1].toolResult!.toolUseId).toBe("t1");
    expect(msg.contentBlocks![1].toolResult!.content).toBe("file1.txt\nfile2.txt");
  });

  it("appendToolResult with error flag", () => {
    const chat = useChatStore();
    chat.addUserMessage("Run");
    chat.startAssistantMessage();
    chat.addToolUse({ id: "t1", name: "Bash", input: { command: "bad" } });
    chat.setContentBlocks([{ type: "tool_use", toolUse: { id: "t1", name: "Bash", input: { command: "bad" } } }]);

    chat.appendToolResult("t1", "command not found", true);

    expect(chat.currentAssistantMsg!.toolUses[0].result).toBe("command not found");
    expect(chat.currentAssistantMsg!.toolUses[0].isError).toBe(true);
    expect(chat.currentAssistantMsg!.contentBlocks![1].toolResult!.isError).toBe(true);
  });

  it("appendToolResult does nothing without currentAssistantMsg", () => {
    const chat = useChatStore();
    // 没有 startAssistantMessage → currentAssistantMsg 为 null → 不应崩溃
    expect(() => chat.appendToolResult("t1", "result", false)).not.toThrow();
  });

  // ── synthesizeBlocks with tool_result ──

  it("synthesizeBlocks includes tool_result when toolUses have results", () => {
    const chat = useChatStore();
    chat.addUserMessage("Run");
    chat.startAssistantMessage();
    chat.addToolUse({ id: "t1", name: "Bash", input: { command: "ls" } });
    // 建立 contentBlocks 时间线（模拟 stream processor 的行为）
    chat.setContentBlocks([{ type: "tool_use", toolUse: { id: "t1", name: "Bash", input: { command: "ls" } } }]);
    chat.appendToolResult("t1", "output.txt", false);
    chat.appendText("Done");
    chat.finishAssistantMessage();

    const blocks = chat.messages[1].contentBlocks!;
    expect(blocks.some(b => b.type === "tool_use")).toBe(true);
    expect(blocks.some(b => b.type === "tool_result")).toBe(true);
    // text 通过 appendText 添加到 content，但 contentBlocks 中的 text 需要通过 buildContentBlocks 或 synthesizeBlocks
    // finishAssistantMessage 保留现有的 contentBlocks，不重新合成
    expect(blocks.some(b => b.type === "text") || chat.messages[1].content).toBeTruthy();
  });

  // ── loadMessages with tool_result in contentBlocks ──

  it("loadMessages restores tool_result from contentBlocks JSON", () => {
    const chat = useChatStore();
    const json = JSON.stringify({
      text: "",
      thinking: "分析中...",
      toolUses: [{ id: "t1", name: "Read", input: { file_path: "a.md" }, result: "content", isError: false }],
      contentBlocks: [
        { type: "thinking", content: "分析中..." },
        { type: "tool_use", toolUse: { id: "t1", name: "Read", input: { file_path: "a.md" } } },
        { type: "tool_result", toolResult: { toolUseId: "t1", content: "content", isError: false } },
      ],
      durationMs: 3000,
    });
    chat.loadMessages([{ id: "a1", role: "assistant", content: json, created_at: "2026-01-01T00:00:00" }]);

    const msg = chat.messages[0];
    expect(msg.contentBlocks).toHaveLength(3);
    expect(msg.contentBlocks![2].type).toBe("tool_result");
    expect(msg.contentBlocks![2].toolResult).toBeDefined();
    expect(msg.contentBlocks![2].toolResult!.content).toBe("content");
  });

  // ── updateTodosFromTool ──

  it("updateTodosFromTool handles TodoWrite with full todo list", () => {
    const chat = useChatStore();
    chat.updateTodosFromTool("TodoWrite", {
      todos: [
        { content: "Task 1", status: "completed", activeForm: "Doing task 1" },
        { content: "Task 2", status: "in_progress", activeForm: "Doing task 2" },
        { content: "Task 3", status: "pending", activeForm: "Doing task 3" },
      ],
    });
    expect(chat.todos).toHaveLength(3);
    expect(chat.todos[0].content).toBe("Task 1");
    expect(chat.todos[1].status).toBe("in_progress");
  });

  it("updateTodosFromTool handles TaskCreate", () => {
    const chat = useChatStore();
    chat.updateTodosFromTool("TaskCreate", {
      subject: "New task",
      activeForm: "Creating new task",
      taskId: "task_001",
    });
    expect(chat.todos).toHaveLength(1);
    expect(chat.todos[0].content).toBe("New task");
    expect(chat.todos[0].status).toBe("pending");
    expect(chat.todos[0].taskId).toBe("task_001");
  });

  it("updateTodosFromTool handles TaskUpdate", () => {
    const chat = useChatStore();
    chat.updateTodosFromTool("TaskCreate", { subject: "Task A", taskId: "t1" });
    chat.updateTodosFromTool("TaskUpdate", { taskId: "t1", status: "completed" });
    expect(chat.todos).toHaveLength(1);
    expect(chat.todos[0].status).toBe("completed");
  });

  it("updateTodosFromTool ignores unknown tool names", () => {
    const chat = useChatStore();
    chat.updateTodosFromTool("Bash", { command: "ls" });
    expect(chat.todos).toHaveLength(0);
  });

  // ── session cache with todos ──

  it("saveSessionCache and loadFromCache preserve todos", () => {
    const chat = useChatStore();
    chat.addUserMessage("Hello");
    chat.todos.push({ content: "Task", status: "pending", activeForm: "Working" });

    chat.saveSessionCache("test-session");
    chat.clearMessages();

    const cached = chat.loadFromCache("test-session");
    expect(cached).not.toBeNull();
    expect(cached!).toHaveLength(1);
    expect(chat.todos).toHaveLength(1);
    expect(chat.todos[0].content).toBe("Task");
  });

  it("clearMessages clears todos", () => {
    const chat = useChatStore();
    chat.addUserMessage("Hi");
    chat.todos.push({ content: "Task", status: "pending", activeForm: "Working" });
    chat.clearMessages();
    expect(chat.messages).toHaveLength(0);
    expect(chat.todos).toHaveLength(0);
  });

  it("clearSessionCache 清空全部缓存（数据模式切换后旧数据目录缓存失效）", () => {
    const chat = useChatStore();
    chat.addUserMessage("Hello");
    chat.todos.push({ content: "Task", status: "pending", activeForm: "Working" });
    chat.saveSessionCache("ses-a");
    chat.clearMessages();
    chat.addUserMessage("Second");
    chat.saveSessionCache("ses-b");
    expect(chat.sessionCache.size).toBe(2);
    chat.clearSessionCache();
    expect(chat.sessionCache.size).toBe(0);
    expect(chat.loadFromCache("ses-a")).toBeNull();
    expect(chat.loadFromCache("ses-b")).toBeNull();
  });

  // ── setTodos（serve 原生 todo.updated）──

  it("setTodos 覆盖 serve 原生 todo.updated 数据（含 cancelled）", () => {
    const chat = useChatStore();
    chat.setTodos([
      { content: "写 README", status: "pending", priority: "high" },
      { content: "运行测试", status: "in_progress", priority: "medium" },
      { content: "git 提交", status: "completed", priority: "low" },
      { content: "已取消任务", status: "cancelled" },
    ]);
    expect(chat.todos).toHaveLength(4);
    expect(chat.todos[0]).toEqual({ content: "写 README", status: "pending", activeForm: "写 README", priority: "high" });
    expect(chat.todos[1].status).toBe("in_progress");
    expect(chat.todos[2].status).toBe("completed");
    expect(chat.todos[3].status).toBe("cancelled");
    expect(chat.todos[3].priority).toBeUndefined();
  });

  it("setTodos 空数组清空 todos", () => {
    const chat = useChatStore();
    chat.setTodos([{ content: "x", status: "pending" }]);
    expect(chat.todos).toHaveLength(1);
    chat.setTodos([]);
    expect(chat.todos).toHaveLength(0);
  });

  // ── historyError（G3：serve 未就绪离线灰显标记）──

  it("historyError 默认 false，setHistoryError 可置位/清除", () => {
    const chat = useChatStore();
    expect(chat.historyError).toBe(false);
    chat.setHistoryError(true);
    expect(chat.historyError).toBe(true);
    chat.setHistoryError(false);
    expect(chat.historyError).toBe(false);
  });

  it("loadMessages 成功不重置 historyError（标记由调用方在 IPC 成败处管理）", () => {
    const chat = useChatStore();
    chat.setHistoryError(true);
    chat.loadMessages([{ id: "a1", role: "user", content: "x", created_at: "2026-01-01T00:00:00" }]);
    // loadMessages 只管还原消息，不擅自改离线状态（避免覆盖 IPC 层判断）
    expect(chat.historyError).toBe(true);
  });

  // ── prependMessages（滚动到顶加载更早：头部拼接）──

  it("prependMessages 头部拼接且保持升序（旧→新）", () => {
    const chat = useChatStore();
    chat.loadMessages([
      { id: "m3", role: "user", content: "已有第三条", created_at: "2026-01-01T00:03:00" },
      { id: "m4", role: "user", content: "已有第四条", created_at: "2026-01-01T00:04:00" },
    ]);
    // 更早消息按升序传入（m1 最旧）→ prepend 后整体仍为 m1,m2,m3,m4
    chat.prependMessages([
      { id: "m1", role: "user", content: "更早一", created_at: "2026-01-01T00:01:00" },
      { id: "m2", role: "user", content: "更早二", created_at: "2026-01-01T00:02:00" },
    ]);
    expect(chat.messages.map(m => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(chat.messages[0].content).toBe("更早一");
  });

  it("prependMessages 解析 assistant JSON blob（与 loadMessages 同解析逻辑）", () => {
    const chat = useChatStore();
    chat.loadMessages([{ id: "m2", role: "user", content: "已有", created_at: "2026-01-01T00:02:00" }]);
    chat.prependMessages([
      {
        id: "m1",
        role: "assistant",
        content: JSON.stringify({ text: "早前回答", thinking: "早前思考" }),
        created_at: "2026-01-01T00:01:00",
      },
    ]);
    expect(chat.messages[0].content).toBe("早前回答");
    expect(chat.messages[0].thinking).toBe("早前思考");
  });

  it("prependMessages 不触碰现有尾部消息（加载更早与流式追加互不干扰）", () => {
    const chat = useChatStore();
    chat.addUserMessage("尾部消息");
    chat.prependMessages([{ id: "m1", role: "user", content: "更早", created_at: "2026-01-01T00:01:00" }]);
    expect(chat.messages).toHaveLength(2);
    expect(chat.messages[1].content).toBe("尾部消息");
  });

  // ── hasMoreHistory（分页状态）──

  it("hasMoreHistory 默认 false，setter 可置位/清除", () => {
    const chat = useChatStore();
    expect(chat.hasMoreHistory).toBe(false);
    chat.setHasMoreHistory(true);
    expect(chat.hasMoreHistory).toBe(true);
    chat.setHasMoreHistory(false);
    expect(chat.hasMoreHistory).toBe(false);
  });

  it("loadMessages（全量重载）重置分页状态：hasMoreHistory 归零", () => {
    const chat = useChatStore();
    chat.setHasMoreHistory(true);
    chat.loadMessages([{ id: "a1", role: "user", content: "x", created_at: "2026-01-01T00:00:00" }]);
    // 全量重载 = 清空重建，旧会话分页状态不应残留
    expect(chat.hasMoreHistory).toBe(false);
  });

  it("clearMessages 重置分页状态（切会话防残留）", () => {
    const chat = useChatStore();
    chat.setHasMoreHistory(true);
    chat.clearMessages();
    expect(chat.hasMoreHistory).toBe(false);
  });

  // ── loadFullHistory（内存全量 + DOM 分页：fullHistory 存全量，messages 只渲染尾部 50 条）──

  /** 构造 N 条升序历史记录（m0 最旧） */
  function makeRecords(n: number): Array<{ id: string; role: string; content: string; created_at: string }> {
    return Array.from({ length: n }, (_, i) => ({
      id: `m${i}`,
      role: "user",
      content: `msg ${i}`,
      created_at: `2026-01-01T00:${String(i % 60).padStart(2, "0")}:00`,
    }));
  }

  it("loadFullHistory 存全量并只渲染尾部 50 条（DOM 分页）", () => {
    const chat = useChatStore();
    chat.loadFullHistory(makeRecords(120));

    // fullHistory 全量缓存 + 时间线索引源
    expect(chat.fullHistory).toHaveLength(120);
    // messages 只渲染尾部 50 条（首屏秒出）
    expect(chat.messages).toHaveLength(50);
    expect(chat.messages[0].id).toBe("m70");
    expect(chat.messages[49].id).toBe("m119");
    expect(chat.loadedFromFull).toBe(50);
    // 全量 > 50 → 还有更早
    expect(chat.hasMoreHistory).toBe(true);
    // 内部负责退出加载态
    expect(chat.historyLoading).toBe(false);
  });

  it("loadFullHistory 返回 ≤50 条 → 全部渲染且 hasMore=false", () => {
    const chat = useChatStore();
    chat.loadFullHistory(makeRecords(30));
    expect(chat.fullHistory).toHaveLength(30);
    expect(chat.messages).toHaveLength(30);
    expect(chat.loadedFromFull).toBe(30);
    expect(chat.hasMoreHistory).toBe(false);
  });

  it("loadFullHistory 先清空旧会话残留（messages/fullHistory 同步重置）", () => {
    const chat = useChatStore();
    chat.loadFullHistory(makeRecords(120));
    chat.loadFullHistory(makeRecords(10));
    expect(chat.fullHistory).toHaveLength(10);
    expect(chat.messages).toHaveLength(10);
    expect(chat.loadedFromFull).toBe(10);
  });

  it("loadFullHistory 后 timelineIndex 覆盖全量（含 assistant 锚点）", () => {
    const chat = useChatStore();
    chat.loadFullHistory([
      { id: "u1", role: "user", content: "问1", created_at: "2026-01-01T00:01:00" },
      { id: "a1", role: "assistant", content: "答1", created_at: "2026-01-01T00:02:00" },
      { id: "u2", role: "user", content: "问2", created_at: "2026-01-01T00:03:00" },
      { id: "a2", role: "assistant", content: "答2", created_at: "2026-01-01T00:04:00" },
    ]);
    expect(chat.timelineIndex.map(m => m.id)).toEqual(["u1", "a1", "u2", "a2"]);
    expect(chat.timelineIndex[0].role).toBe("user");
    expect(chat.timelineIndex[1].role).toBe("assistant");
    expect(chat.timelineIndex[0].created).toBeGreaterThan(0);
  });

  // ── prependFromFullHistory（从内存切片加载更早，同步无网络）──

  it("prependFromFullHistory 从内存切片更早 50 条且保持旧→新顺序", () => {
    const chat = useChatStore();
    chat.loadFullHistory(makeRecords(120)); // 首屏 m70..m119

    expect(chat.prependFromFullHistory()).toBe(true);
    // 切片 m20..m69 → 整体 m20..m119
    expect(chat.messages).toHaveLength(100);
    expect(chat.messages[0].id).toBe("m20");
    expect(chat.messages[49].id).toBe("m69");
    expect(chat.loadedFromFull).toBe(100);
    expect(chat.hasMoreHistory).toBe(true);

    // 再次切片 m0..m19 → 全量加载完
    expect(chat.prependFromFullHistory()).toBe(true);
    expect(chat.messages).toHaveLength(120);
    expect(chat.messages[0].id).toBe("m0");
    expect(chat.loadedFromFull).toBe(120);
    expect(chat.hasMoreHistory).toBe(false);

    // 已到顶 → 返回 false 且不修改
    expect(chat.prependFromFullHistory()).toBe(false);
    expect(chat.messages).toHaveLength(120);
  });

  it("prependFromFullHistory 全量 ≤50 时直接到顶（返回 false）", () => {
    const chat = useChatStore();
    chat.loadFullHistory(makeRecords(30));
    expect(chat.prependFromFullHistory()).toBe(false);
    expect(chat.messages).toHaveLength(30);
    expect(chat.hasMoreHistory).toBe(false);
  });

  // ── clearMessages 重置内存全量状态 ──

  it("clearMessages 重置 fullHistory/loadedFromFull/timelineIndex（防旧会话残留）", () => {
    const chat = useChatStore();
    chat.loadFullHistory(makeRecords(120));
    expect(chat.fullHistory).toHaveLength(120);
    expect(chat.timelineIndex).toHaveLength(120);

    chat.clearMessages();
    expect(chat.fullHistory).toHaveLength(0);
    expect(chat.loadedFromFull).toBe(0);
    expect(chat.timelineIndex).toHaveLength(0);
    expect(chat.hasMoreHistory).toBe(false);
  });

  // ── timelineIndex 合并流式新增消息 ──

  it("timelineIndex 合并流式新增消息（messages push 后出现在时间线且不重复）", () => {
    const chat = useChatStore();
    chat.loadFullHistory(makeRecords(5));
    const before = chat.timelineIndex.length;

    // 流式新增：id 不在 fullHistory（DB 尚未落库）
    const newId = chat.addUserMessage("流式新消息");
    expect(chat.timelineIndex).toHaveLength(before + 1);
    expect(chat.timelineIndex[chat.timelineIndex.length - 1].id).toBe(newId);

    // 全量锚点（fullHistory 部分）不因 messages 尾部渲染而重复
    const ids = chat.timelineIndex.map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // ── 子任务（子智能体）可视化 ──

  it("subtask created → 初始化 SubTask（agent 默认子智能体 + startedAt）", () => {
    const chat = useChatStore();
    chat.handleSubTaskEvent({ subId: "sub-1", kind: "created", agent: "工匠" });
    expect(chat.subTasks["sub-1"]).toBeDefined();
    expect(chat.subTasks["sub-1"].agent).toBe("工匠");
    expect(chat.subTasks["sub-1"].status).toBe("running");
    expect(chat.subTasks["sub-1"].deltaText).toBe("");
    expect(chat.subTasks["sub-1"].parts).toHaveLength(0);
    expect(chat.subTasks["sub-1"].startedAt).toBeGreaterThan(0);

    // 无 agent → 默认「子智能体」
    chat.handleSubTaskEvent({ subId: "sub-2", kind: "created" });
    expect(chat.subTasks["sub-2"].agent).toBe("子智能体");
  });

  it("subtask delta → deltaText 累积（截断 SUBTASK_DELTA_MAX 尾部保留）+ parts 追加 text 块", () => {
    const chat = useChatStore();
    chat.handleSubTaskEvent({ subId: "sub-1", kind: "created" });
    chat.handleSubTaskEvent({ subId: "sub-1", kind: "delta", text: "正在分析代码…" });
    chat.handleSubTaskEvent({ subId: "sub-1", kind: "delta", text: "继续处理" });

    expect(chat.subTasks["sub-1"].deltaText).toBe("正在分析代码…继续处理");
    // #6 相邻 delta 合并：连续 text 块合成一块（防碎片化）
    expect(chat.subTasks["sub-1"].parts.map(p => p.text)).toEqual(["正在分析代码…继续处理"]);

    // 截断：超过上限丢弃头部（尾部保留）——此时 deltaText = long 的尾部 500 字符
    const long = "x".repeat(SUBTASK_DELTA_MAX + 100);
    chat.handleSubTaskEvent({ subId: "sub-1", kind: "delta", text: long });
    expect(chat.subTasks["sub-1"].deltaText.length).toBe(SUBTASK_DELTA_MAX);
    expect(chat.subTasks["sub-1"].deltaText).toBe(long.slice(-SUBTASK_DELTA_MAX));
  });

  it("subtask part → thinking 折叠记录 / tool 记录 / text 追加", () => {
    const chat = useChatStore();
    chat.handleSubTaskEvent({ subId: "sub-1", kind: "created" });

    chat.handleSubTaskEvent({ subId: "sub-1", kind: "part", part: { type: "thinking", text: "推理过程" } });
    chat.handleSubTaskEvent({ subId: "sub-1", kind: "part", part: { type: "tool", tool: "Bash", state: "running" } });
    chat.handleSubTaskEvent({ subId: "sub-1", kind: "part", part: { type: "text", text: "完整文本" } });

    expect(chat.subTasks["sub-1"].parts).toEqual([
      { type: "thinking", text: "推理过程" },
      { type: "tool", tool: "Bash", state: "running" },
      { type: "text", text: "完整文本" },
    ]);
    // text part 同时追加 deltaText（动态行展示）
    expect(chat.subTasks["sub-1"].deltaText).toBe("完整文本");
  });

  it("subtask parts 超上限滚动丢最旧（SUBTASK_PARTS_MAX）", () => {
    const chat = useChatStore();
    chat.handleSubTaskEvent({ subId: "sub-1", kind: "created" });
    // 交替 text/thinking：相邻同类合并只影响连续同类型，交替保证每块独立 push
    for (let i = 0; i < SUBTASK_PARTS_MAX + 10; i++) {
      chat.handleSubTaskEvent({ subId: "sub-1", kind: "delta", text: `块${i}` });
      chat.handleSubTaskEvent({ subId: "sub-1", kind: "part", part: { type: "thinking", text: `思${i}` } });
    }
    expect(chat.subTasks["sub-1"].parts.length).toBe(SUBTASK_PARTS_MAX);
    // 210 组 = 420 parts，保留最后 200 → 丢弃前 110 组；第一块是 i=110 的 text
    expect(chat.subTasks["sub-1"].parts[0].text).toBe("块110");
    // 最后一块是 i=209 的 thinking（交替 text/thinking，末位为 thinking）
    expect(chat.subTasks["sub-1"].parts[chat.subTasks["sub-1"].parts.length - 1].text).toBe("思209");
  });

  it("subtask idle → 标记 done + 拉摘要（最后 assistant 文本前 SUBTASK_SUMMARY_MAX 字符）", async () => {
    const chat = useChatStore();
    chat.handleSubTaskEvent({ subId: "sub-1", kind: "created" });

    // mock 子会话消息：user + assistant（最后 assistant 文本做摘要）
    const longText = "总结".repeat(300); // 900 字符 > 500 上限
    listMessagesMock.mockResolvedValue([
      { id: "m1", session_id: "sub-1", role: "user", content: "问题", token_usage: "", created_at: "2026-01-01T00:01:00" },
      { id: "m2", session_id: "sub-1", role: "assistant", content: longText, token_usage: "", created_at: "2026-01-01T00:02:00" },
    ]);

    await chat.handleSubTaskEvent({ subId: "sub-1", kind: "idle" });
    expect(chat.subTasks["sub-1"].status).toBe("done");
    expect(chat.subTasks["sub-1"].endedAt).toBeGreaterThan(0);
    expect(chat.subTasks["sub-1"].summary).toHaveLength(500);
    expect(chat.subTasks["sub-1"].summary!.startsWith("总结总结")).toBe(true);
  });

  it("subtask idle 拉摘要失败 → summaryFailed 标记（#9 与无文本区分，不阻塞完成态）", async () => {
    const chat = useChatStore();
    chat.handleSubTaskEvent({ subId: "sub-1", kind: "created" });
    listMessagesMock.mockRejectedValue(new Error("serve 未就绪"));

    await chat.handleSubTaskEvent({ subId: "sub-1", kind: "idle" });
    expect(chat.subTasks["sub-1"].status).toBe("done");
    expect(chat.subTasks["sub-1"].summary).toBeUndefined();
    expect(chat.subTasks["sub-1"].summaryFailed).toBe(true);
  });

  it("subtask idle 无 assistant 文本 → summary undefined + summaryFailed false（#9 无摘要）", async () => {
    const chat = useChatStore();
    chat.handleSubTaskEvent({ subId: "sub-1", kind: "created" });
    listMessagesMock.mockResolvedValue([
      { id: "m1", session_id: "sub-1", role: "user", content: "问题", token_usage: "", created_at: "2026-01-01T00:01:00" },
    ]);

    await chat.handleSubTaskEvent({ subId: "sub-1", kind: "idle" });
    expect(chat.subTasks["sub-1"].status).toBe("done");
    expect(chat.subTasks["sub-1"].summary).toBeUndefined();
    expect(chat.subTasks["sub-1"].summaryFailed).toBe(false);
  });

  it("subtask error → status done + failed 标记（#5）", async () => {
    const chat = useChatStore();
    chat.handleSubTaskEvent({ subId: "sub-1", kind: "created" });
    chat.handleSubTaskEvent({ subId: "sub-1", kind: "error" });

    expect(chat.subTasks["sub-1"].status).toBe("done");
    expect(chat.subTasks["sub-1"].failed).toBe(true);
    expect(chat.subTasks["sub-1"].endedAt).toBeGreaterThan(0);
  });

  it("subtask 重复 created 不重置进度（#7）", () => {
    const chat = useChatStore();
    chat.handleSubTaskEvent({ subId: "sub-1", kind: "created", agent: "工匠" });
    chat.handleSubTaskEvent({ subId: "sub-1", kind: "delta", text: "已累积" });
    // 重连后 serve 重发 created
    chat.handleSubTaskEvent({ subId: "sub-1", kind: "created", agent: "工匠" });

    expect(chat.subTasks["sub-1"].deltaText).toBe("已累积"); // 未重置
    expect(chat.subTasks["sub-1"].parts).toHaveLength(1);
    expect(chat.subTasks["sub-1"].startedAt).toBeGreaterThan(0);
  });

  it("subtask 相邻 delta 合并 + updated 全量 startsWith 去重（#6）", () => {
    const chat = useChatStore();
    chat.handleSubTaskEvent({ subId: "sub-1", kind: "created" });
    // 连续 delta 碎片 → 相邻 text part 合并成一块
    chat.handleSubTaskEvent({ subId: "sub-1", kind: "delta", text: "正在" });
    chat.handleSubTaskEvent({ subId: "sub-1", kind: "delta", text: "分析" });
    chat.handleSubTaskEvent({ subId: "sub-1", kind: "delta", text: "代码" });
    expect(chat.subTasks["sub-1"].parts).toEqual([{ type: "text", text: "正在分析代码" }]);

    // updated 全量已覆盖增量 → 跳过重复
    chat.handleSubTaskEvent({ subId: "sub-1", kind: "part", part: { type: "text", text: "正在分析代码" } });
    expect(chat.subTasks["sub-1"].parts).toEqual([{ type: "text", text: "正在分析代码" }]);
    expect(chat.subTasks["sub-1"].deltaText).toBe("正在分析代码");

    // updated 全量含新后缀 → 只追加后缀
    chat.handleSubTaskEvent({ subId: "sub-1", kind: "part", part: { type: "text", text: "正在分析代码完成" } });
    expect(chat.subTasks["sub-1"].parts).toEqual([{ type: "text", text: "正在分析代码完成" }]);
    expect(chat.subTasks["sub-1"].deltaText).toBe("正在分析代码完成");
  });

  it("切走→后台事件（含 subtask）→切回 → 父缓存累积完整（#1）", async () => {
    const chat = useChatStore();
    const parent = "ses-parent";
    // 活跃父会话 A：created 建卡
    chat.handleSubTaskEvent({ subId: "sub-1", kind: "created", agent: "工匠", parentId: parent }, parent);
    chat.handleSubTaskEvent({ subId: "sub-1", kind: "delta", text: "第一段", parentId: parent }, parent);

    // 切走（active 变 B）→ 后台事件写父缓存
    const other = "ses-b";
    chat.handleSubTaskEvent({ subId: "sub-1", kind: "delta", text: "第二段", parentId: parent }, other);
    listMessagesMock.mockResolvedValue([
      { id: "m1", session_id: "sub-1", role: "user", content: "问题", token_usage: "", created_at: "2026-01-01T00:01:00" },
      { id: "m2", session_id: "sub-1", role: "assistant", content: "完成摘要", token_usage: "", created_at: "2026-01-01T00:02:00" },
    ]);
    await chat.handleSubTaskEvent({ subId: "sub-1", kind: "idle", parentId: parent }, other);

    // 切回 A：loadFromCache 恢复完整累积（deltaText 含切走后增量 + summary）
    chat.clearMessages();
    const cached = chat.loadFromCache(parent);
    expect(cached).not.toBeNull();
    expect(chat.subTasks["sub-1"]).toBeDefined();
    expect(chat.subTasks["sub-1"].deltaText).toBe("第一段第二段");
    expect(chat.subTasks["sub-1"].status).toBe("done");
    expect(chat.subTasks["sub-1"].summary).toBe("完成摘要");
  });

  it("切走期间 idle 丢失 → 恢复时 running 卡标 stale 降级态（#4）", async () => {
    const chat = useChatStore();
    const parent = "ses-parent";
    // 活跃时建卡，未收到 idle（切走期间事件丢失）→ running 无 endedAt
    chat.handleSubTaskEvent({ subId: "sub-1", kind: "created", agent: "工匠", parentId: parent }, parent);
    chat.saveSessionCache(parent);
    chat.clearMessages();

    // 切回：恢复时 running 且无 endedAt → stale
    const cached = chat.loadFromCache(parent);
    expect(cached).not.toBeNull();
    expect(chat.subTasks["sub-1"].status).toBe("running");
    expect(chat.subTasks["sub-1"].stale).toBe(true);
  });

  it("idle await 期间切走 → 摘要写回缓存对象而非孤儿（#3 竞态）", async () => {
    const chat = useChatStore();
    const parent = "ses-parent";
    chat.handleSubTaskEvent({ subId: "sub-1", kind: "created", agent: "工匠", parentId: parent }, parent);
    // idle 的 listMessages 挂起
    let resolveList: (v: unknown) => void;
    listMessagesMock.mockReturnValue(new Promise((r) => { resolveList = r; }));

    const pending = chat.handleSubTaskEvent({ subId: "sub-1", kind: "idle", parentId: parent }, parent);
    // await 期间切走：视图 subTasks 清空（loadFromCache 其他会话），但父缓存仍持引用
    chat.clearMessages();
    chat.loadFromCache("ses-other");
    resolveList!([
      { id: "m1", session_id: "sub-1", role: "assistant", content: "竞态摘要", token_usage: "", created_at: "2026-01-01T00:02:00" },
    ]);
    await pending;

    // 摘要写回父缓存中的 task（subTasks.value 已无此卡——clearMessages 重置）
    expect(chat.subTasks["sub-1"]).toBeUndefined();
    const entry = (chat as any).sessionCache.get(parent);
    expect(entry.subTasks["sub-1"].summary).toBe("竞态摘要");
  });

  it("sessionCache 持久化 subTasks（saveSessionCache/loadFromCache 不丢子任务卡）", async () => {
    const chat = useChatStore();
    chat.handleSubTaskEvent({ subId: "sub-1", kind: "created", agent: "工匠" });
    chat.handleSubTaskEvent({ subId: "sub-1", kind: "delta", text: "进行中" });
    listMessagesMock.mockResolvedValue([]);
    await chat.handleSubTaskEvent({ subId: "sub-1", kind: "idle" });

    chat.saveSessionCache("ses-cache-1");
    chat.clearMessages();
    expect(Object.keys(chat.subTasks)).toHaveLength(0); // clearMessages 重置子任务

    const cached = chat.loadFromCache("ses-cache-1");
    expect(cached).not.toBeNull();
    expect(chat.subTasks["sub-1"]).toBeDefined();
    expect(chat.subTasks["sub-1"].agent).toBe("工匠");
    expect(chat.subTasks["sub-1"].status).toBe("done");
    expect(chat.subTasks["sub-1"].deltaText).toBe("进行中");
  });
});

// ══════════════════════════════════════════════════════════════════
// 历史子任务提取（D1-D6）：extractSubTaskIds / buildSubTaskMap 纯函数
// task part 经主进程 toMessageData 还原后落在 Message.toolUses（name==='task' 的 result）
// 与 contentBlocks（tool_use 块 toolUse.result / tool_result 块 toolResult.content）
// ══════════════════════════════════════════════════════════════════

describe("extractSubTaskIds", () => {
  it("提取单个 task id", () => {
    const out = '<task id="ses_0a89" state="completed">\n<task_result>结果</task_result>';
    expect(extractSubTaskIds(out)).toEqual(["ses_0a89"]);
  });

  it("输出含多个 task id → 全部提取（顺序保持）", () => {
    const out = [
      '<task id="ses_a" state="completed">',
      '<task id="ses_b" state="completed">',
      '<task id="ses_c" state="completed">',
    ].join("\n");
    expect(extractSubTaskIds(out)).toEqual(["ses_a", "ses_b", "ses_c"]);
  });

  it("无匹配 → 返回空数组", () => {
    expect(extractSubTaskIds("普通文本没有 task id")).toEqual([]);
    expect(extractSubTaskIds("")).toEqual([]);
  });

  it("非 task 工具输出不误匹配（task 工具名 vs 其他标签）", () => {
    const out = '<task_result>这是结果</task_result><task id="ses_x" state="completed">';
    expect(extractSubTaskIds(out)).toEqual(["ses_x"]);
  });
});

describe("buildSubTaskMap", () => {
  /** 构造 assistant 消息（可指定 toolUses/contentBlocks） */
  function makeAssistantMsg(id: string, over: Partial<Message> = {}): Message {
    return {
      id,
      role: "assistant",
      content: "",
      thinking: "",
      toolUses: [],
      timestamp: 1786029594660,
      isStreaming: false,
      ...over,
    };
  }

  const children: SubTaskChildRef[] = [
    { id: "ses_a", title: "查看项目文档 (@general subagent)", createdAt: 1786029594660, updatedAt: 1786029599000, agent: "工匠" },
    { id: "ses_b", title: "生成测试 (@craftsman subagent)", createdAt: 1786029600000, updatedAt: 1786029605000, agent: "军师" },
  ];

  it("toolUses 中 task 工具 result → 正确归属到该消息（agent/标题/时间补全）", () => {
    const msgs = [
      makeAssistantMsg("m1", {
        toolUses: [
          { id: "call_1", name: "task", input: {}, result: '<task id="ses_a" state="completed">\n<task_result>ok</task_result>' },
        ],
      }),
      makeAssistantMsg("m2"), // 无 task 工具
    ];
    const map = buildSubTaskMap(msgs, children);

    expect(map.has("m1")).toBe(true);
    expect(map.has("m2")).toBe(false);
    const list = map.get("m1")!;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: "ses_a",
      agent: "工匠",
      title: "查看项目文档 (@general subagent)",
      createdAt: 1786029594660,
      endedAt: 1786029599000,
    });
  });

  it("一条消息多个 task → 全部挂载；contentBlocks 冗余数据不重复计数", () => {
    const msgs = [
      makeAssistantMsg("m1", {
        toolUses: [
          { id: "call_1", name: "task", input: {}, result: '<task id="ses_a" state="completed">' },
          { id: "call_2", name: "task", input: {}, result: '<task id="ses_b" state="completed">' },
        ],
        contentBlocks: [
          { type: "tool_use", toolUse: { id: "call_1", name: "task", input: {}, result: '<task id="ses_a" state="completed">' } },
          { type: "tool_result", toolResult: { toolUseId: "call_1", content: '<task id="ses_a" state="completed">' } },
        ],
      }),
    ];
    const map = buildSubTaskMap(msgs, children);
    const list = map.get("m1")!;
    // 去重：ses_a 在 toolUses + contentBlocks 三处出现，只挂一次；ses_b 一次
    expect(list.map((s) => s.id).sort()).toEqual(["ses_a", "ses_b"]);
  });

  it("contentBlocks-only 消息也能提取（旧存档只有 contentBlocks）", () => {
    const msgs = [
      makeAssistantMsg("m1", {
        contentBlocks: [
          { type: "tool_use", toolUse: { id: "call_1", name: "task", input: {}, result: '<task id="ses_b" state="completed">' } },
        ],
      }),
    ];
    const map = buildSubTaskMap(msgs, children);
    expect(map.get("m1")?.[0].id).toBe("ses_b");
  });

  it("children 找不到的 task id → 跳过（子会话已删除/列表超限）", () => {
    const msgs = [
      makeAssistantMsg("m1", {
        toolUses: [
          { id: "call_1", name: "task", input: {}, result: '<task id="ses_ghost" state="completed">' },
          { id: "call_2", name: "task", input: {}, result: '<task id="ses_a" state="completed">' },
        ],
      }),
    ];
    const map = buildSubTaskMap(msgs, children);
    const list = map.get("m1")!;
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("ses_a");
  });

  it("user 消息不参与提取", () => {
    const userMsg: Message = {
      id: "u1",
      role: "user",
      content: "普通用户消息",
      thinking: "",
      toolUses: [],
      timestamp: 1786029594000,
      isStreaming: false,
    };
    const map = buildSubTaskMap([userMsg], children);
    expect(map.size).toBe(0);
  });

  it("children 为空（子会话列表未加载）→ 空 map 不崩溃", () => {
    const msgs = [
      makeAssistantMsg("m1", {
        toolUses: [
          { id: "call_1", name: "task", input: {}, result: '<task id="ses_a" state="completed">' },
        ],
      }),
    ];
    const map = buildSubTaskMap(msgs, []);
    expect(map.size).toBe(0);
  });
});
