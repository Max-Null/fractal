// NodeTimeline 测试：回合级时间线（序列/相邻合并/回合完成标记/subtask 节点/busy 态）
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import NodeTimeline from "./NodeTimeline.vue";
import type { Message, ContentBlock, SubTask } from "@/stores/chat";

const i18n = createI18n({
  legacy: false,
  locale: "en",
  messages: {
    en: {
      chat: {
        turnComplete: "Turn complete",
      },
    },
  },
});

// NodeCard stub：暴露收到的 props（断言变体/展开/busy/subtask 传递）+ 可触发事件
const NodeCardStub = {
  name: "NodeCard",
  props: ["node", "expanded", "busy", "subtask", "subtaskSummaryLoader"],
  emits: ["update:expanded", "subtask-expand", "subtask-detail", "subtask-monitor"],
  // subtask id 放文本（模板属性值内不能嵌套双引号字符串）
  template: '<div class="node-card-stub" :data-kind="node.kind" :data-key="node.key" :data-expanded="expanded" :data-busy="busy">{{ subtask ? subtask.id : "" }}</div>',
};

function mountTimeline(overrides: Partial<{ turn: { user: Message; assistants: Message[] }; subtaskState: Record<string, SubTask>; historySubtasks: Record<string, SubTask>; completedAt: number }>) {
  const user: Message = {
    id: "u1", role: "user", content: "你好", thinking: "", toolUses: [], timestamp: 0, isStreaming: false,
  };
  return mount(NodeTimeline, {
    props: {
      turn: overrides.turn ?? { user, assistants: [] },
      subtaskState: overrides.subtaskState,
      historySubtasks: overrides.historySubtasks,
      completedAt: overrides.completedAt,
    },
    global: { plugins: [i18n], stubs: { NodeCard: NodeCardStub } },
  });
}

function asst(overrides: Partial<Message> & { id?: string }): Message {
  return {
    id: overrides.id ?? "a1",
    role: "assistant",
    content: "",
    thinking: "",
    toolUses: [],
    timestamp: 0,
    isStreaming: false,
    ...overrides,
  };
}

function textBlock(content: string): ContentBlock {
  return { type: "text", content };
}
function thinkingBlock(content: string): ContentBlock {
  return { type: "thinking", content };
}
function toolBlock(id: string, name = "Bash", extra: Partial<Message["toolUses"][number]> = {}): ContentBlock {
  return { type: "tool_use", toolUse: { id, name, input: { command: "ls" }, ...extra } };
}

function cards(wrapper: ReturnType<typeof mountTimeline>) {
  return wrapper.findAll(".node-card-stub");
}

describe("NodeTimeline", () => {
  it("空回合（无 assistants）→ 不渲染节点与完成标记", () => {
    const w = mountTimeline({});
    expect(cards(w)).toHaveLength(0);
    expect(w.find(".node-timeline-done").exists()).toBe(false);
  });

  // ═══ 节点序列与合并 ═══

  it("thinking + text → 按序渲染 2 个节点（最后 text 为 summary）", () => {
    const w = mountTimeline({
      turn: { user: { id: "u1", role: "user", content: "q", thinking: "", toolUses: [], timestamp: 0, isStreaming: false }, assistants: [asst({ contentBlocks: [thinkingBlock("思考"), textBlock("回答")] })] },
    });
    const c = cards(w);
    expect(c).toHaveLength(2);
    expect(c[0].attributes("data-kind")).toBe("thinking");
    expect(c[1].attributes("data-kind")).toBe("text");
  });

  it("相邻 text 跨消息合并 → 单节点", () => {
    const w = mountTimeline({
      turn: { user: { id: "u1", role: "user", content: "q", thinking: "", toolUses: [], timestamp: 0, isStreaming: false }, assistants: [
        asst({ id: "a1", contentBlocks: [textBlock("第一段")] }),
        asst({ id: "a2", contentBlocks: [textBlock("第二段")] }),
      ] },
    });
    const c = cards(w);
    expect(c).toHaveLength(1);
    expect(c[0].attributes("data-kind")).toBe("text");
  });

  it("tool 打断：text → tool → text → 3 节点", () => {
    const w = mountTimeline({
      turn: { user: { id: "u1", role: "user", content: "q", thinking: "", toolUses: [], timestamp: 0, isStreaming: false }, assistants: [asst({ contentBlocks: [textBlock("准备"), toolBlock("t1"), textBlock("完成")] })] },
    });
    const kinds = cards(w).map((c) => c.attributes("data-kind"));
    expect(kinds).toEqual(["text", "tool", "text"]);
  });

  // ═══ 回合完成标记（D9）═══

  it("回合结束（idle）→ 渲染完成标记：耗时 + 固定系统时间", () => {
    const w = mountTimeline({
      turn: { user: { id: "u1", role: "user", content: "q", thinking: "", toolUses: [], timestamp: 0, isStreaming: false }, assistants: [asst({ contentBlocks: [textBlock("done")], isStreaming: false, durationMs: 2345 })] },
      completedAt: new Date(2026, 0, 1, 12, 34, 56).getTime(),
    });
    const done = w.find(".node-timeline-done");
    expect(done.exists()).toBe(true);
    expect(done.text()).toContain("Turn complete");
    expect(done.text()).toContain("2.3s");
    expect(done.text()).toContain("12:34:56");
  });

  it("静默结束（最后节点是工具无文字）→ 完成标记仍渲染", () => {
    const w = mountTimeline({
      turn: { user: { id: "u1", role: "user", content: "q", thinking: "", toolUses: [], timestamp: 0, isStreaming: false }, assistants: [asst({ contentBlocks: [toolBlock("t1")], isStreaming: false, durationMs: 1000 })] },
      completedAt: new Date(2026, 0, 1, 1, 2, 3).getTime(),
    });
    expect(w.find(".node-timeline-done").exists()).toBe(true);
    expect(w.find(".node-timeline-done").text()).toContain("1.0s");
  });

  it("流式中（isStreaming）→ 无完成标记", () => {
    const w = mountTimeline({
      turn: { user: { id: "u1", role: "user", content: "q", thinking: "", toolUses: [], timestamp: 0, isStreaming: false }, assistants: [asst({ contentBlocks: [textBlock("partial")], isStreaming: true })] },
    });
    expect(w.find(".node-timeline-done").exists()).toBe(false);
  });

  it("完成标记含 token 统计（↑输入 ↓输出，原 MessageBubble 统计迁移）", () => {
    const w = mountTimeline({
      turn: { user: { id: "u1", role: "user", content: "q", thinking: "", toolUses: [], timestamp: 0, isStreaming: false }, assistants: [asst({ contentBlocks: [textBlock("done")], isStreaming: false, durationMs: 500, inputTokens: 150, outputTokens: 80 })] },
      completedAt: new Date(2026, 0, 1, 0, 0, 0).getTime(),
    });
    const done = w.find(".node-timeline-done");
    expect(done.text()).toContain("↑150");
    expect(done.text()).toContain("↓80");
  });

  // ═══ busy 两态（D8）═══

  it("流式中 + 工具 startedAt 未完成 → 该工具节点 busy", () => {
    const w = mountTimeline({
      turn: { user: { id: "u1", role: "user", content: "q", thinking: "", toolUses: [], timestamp: 0, isStreaming: false }, assistants: [asst({
        contentBlocks: [toolBlock("t1", "Bash", { startedAt: Date.now() })],
        toolUses: [{ id: "t1", name: "Bash", input: {}, startedAt: Date.now() }],
        isStreaming: true,
      })] },
    });
    const c = cards(w)[0];
    expect(c.attributes("data-busy")).toBe("true");
  });

  it("工具已完成（executionDurationMs）→ 不 busy", () => {
    const w = mountTimeline({
      turn: { user: { id: "u1", role: "user", content: "q", thinking: "", toolUses: [], timestamp: 0, isStreaming: false }, assistants: [asst({
        contentBlocks: [toolBlock("t1", "Bash", { startedAt: Date.now(), executionDurationMs: 500 })],
        toolUses: [{ id: "t1", name: "Bash", input: {}, startedAt: Date.now(), executionDurationMs: 500 }],
        isStreaming: true,
      })] },
    });
    expect(cards(w)[0].attributes("data-busy")).toBe("false");
  });

  it("流式中尾部 text 增量 → 最后一个 text 节点 busy", () => {
    const w = mountTimeline({
      turn: { user: { id: "u1", role: "user", content: "q", thinking: "", toolUses: [], timestamp: 0, isStreaming: false }, assistants: [asst({
        contentBlocks: [textBlock("第一段"), textBlock("流式增量…")],
        isStreaming: true,
      })] },
    });
    const c = cards(w);
    expect(c).toHaveLength(1);
    expect(c[0].attributes("data-busy")).toBe("true");
  });

  it("回合结束 → 无 busy 节点", () => {
    const w = mountTimeline({
      turn: { user: { id: "u1", role: "user", content: "q", thinking: "", toolUses: [], timestamp: 0, isStreaming: false }, assistants: [asst({ contentBlocks: [textBlock("done")], isStreaming: false })] },
    });
    expect(cards(w)[0].attributes("data-busy")).toBe("false");
  });

  // ═══ 展开交互 ═══

  it("thinking 展开态由 NodeTimeline 管理（点击 NodeCard 后切换）", async () => {
    const w = mountTimeline({
      turn: { user: { id: "u1", role: "user", content: "q", thinking: "", toolUses: [], timestamp: 0, isStreaming: false }, assistants: [asst({ contentBlocks: [thinkingBlock("思考")] })] },
    });
    expect(cards(w)[0].attributes("data-expanded")).toBe("false");
    const stub = w.findComponent({ name: "NodeCard" });
    await stub.vm.$emit("update:expanded", true);
    expect(cards(w)[0].attributes("data-expanded")).toBe("true");
  });

  // ═══ subtask 节点（D12/D13/D14）═══

  it("task 块 → subtask 节点，subtaskState 实时数据传入 NodeCard", () => {
    const s: SubTask = { id: "ses_1", agent: "工匠", status: "running", deltaText: "工作中", parts: [], startedAt: Date.now() };
    const w = mountTimeline({
      turn: { user: { id: "u1", role: "user", content: "q", thinking: "", toolUses: [], timestamp: 0, isStreaming: false }, assistants: [asst({
        contentBlocks: [{ type: "tool_use", toolUse: { id: "t1", name: "task", input: {}, result: '<task id="ses_1" state="completed">' } }],
      })] },
      subtaskState: { ses_1: s },
    });
    const c = cards(w)[0];
    expect(c.attributes("data-kind")).toBe("subtask");
    expect(c.text()).toBe("ses_1");
  });

  it("subtask 实时缺失 → historySubtasks 历史兜底", () => {
    const h: SubTask = { id: "ses_9", agent: "军师", status: "done", deltaText: "", parts: [], startedAt: 0, endedAt: 1, summary: "历史摘要" };
    const w = mountTimeline({
      turn: { user: { id: "u1", role: "user", content: "q", thinking: "", toolUses: [], timestamp: 0, isStreaming: false }, assistants: [asst({
        contentBlocks: [{ type: "tool_use", toolUse: { id: "t2", name: "task", input: {}, result: '<task id="ses_9" state="completed">' } }],
      })] },
      historySubtasks: { ses_9: h },
    });
    expect(cards(w)[0].text()).toBe("ses_9");
  });

  it("subtask 实时与历史都查不到 → subtask 传 null（NodeCard D6 容错占位）", () => {
    const w = mountTimeline({
      turn: { user: { id: "u1", role: "user", content: "q", thinking: "", toolUses: [], timestamp: 0, isStreaming: false }, assistants: [asst({
        contentBlocks: [{ type: "tool_use", toolUse: { id: "t3", name: "task", input: {}, result: '<task id="ses_ghost" state="completed">' } }],
      })] },
    });
    expect(cards(w)[0].text()).toBe("");
  });

  it("subtask 节点点击转发 detail/monitor 事件", async () => {
    const s: SubTask = { id: "ses_1", agent: "工匠", status: "running", deltaText: "", parts: [], startedAt: Date.now() };
    const w = mountTimeline({
      turn: { user: { id: "u1", role: "user", content: "q", thinking: "", toolUses: [], timestamp: 0, isStreaming: false }, assistants: [asst({
        contentBlocks: [{ type: "tool_use", toolUse: { id: "t1", name: "task", input: {}, result: '<task id="ses_1" state="completed">' } }],
      })] },
      subtaskState: { ses_1: s },
    });
    const stub = w.findComponent({ name: "NodeCard" });
    await stub.vm.$emit("subtask-detail", s);
    expect(w.emitted("subtask-detail")).toEqual([[s]]);
    await stub.vm.$emit("subtask-monitor", "ses_1");
    expect(w.emitted("subtask-monitor")).toEqual([["ses_1"]]);
  });

  // ═══ 节点 key 稳定（D17）═══

  it("节点 key 稳定：tool 用工具 id", () => {
    const w = mountTimeline({
      turn: { user: { id: "u1", role: "user", content: "q", thinking: "", toolUses: [], timestamp: 0, isStreaming: false }, assistants: [asst({ contentBlocks: [toolBlock("t1"), toolBlock("t2")] })] },
    });
    const keys = cards(w).map((c) => c.attributes("data-key"));
    expect(keys).toEqual(["t1", "t2"]);
  });
});
