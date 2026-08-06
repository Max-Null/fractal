import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useChatStore } from "@/stores/chat";
import { useSessionStore } from "@/stores/session";
import { useStreamProcessor } from "./useStreamProcessor";

const { listeners, saveMessageMock } = vi.hoisted(() => ({
  listeners: new Map<string, (payload: any) => void>(),
  saveMessageMock: vi.fn(),
}));

// 桩 window.electronBridge：useStreamProcessor 的事件订阅入口（原 @tauri-apps/api/event listen）
window.electronBridge = {
  invoke: (() => Promise.resolve()) as any,
  on: (eventName: string, callback: (payload: any) => void) => {
    listeners.set(eventName, callback);
    return () => listeners.delete(eventName);
  },
};

vi.mock("@/composables/useDebugLog", () => ({
  useDebugLog: () => ({
    add: vi.fn(),
    clear: vi.fn(),
    visible: { value: false },
    setSession: vi.fn(),
    exportLines: vi.fn().mockReturnValue([]),
  }),
}));

vi.mock("@/composables/useStderrLog", () => ({
  useStderrLog: () => ({
    add: vi.fn(),
    clear: vi.fn(),
    lines: { value: [] },
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
    saveSessionStderrLog: vi.fn().mockResolvedValue(undefined),
    listSessions: vi.fn().mockResolvedValue([]),
  };
});

describe("useStreamProcessor", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    listeners.clear();
    saveMessageMock.mockReset();
    saveMessageMock.mockResolvedValue(undefined);
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
