// buildTurnNodes 纯函数测试（D4 相邻合并 / D7 总结标记 / D12 task→subtask / 降级 / 空回合）
import { describe, it, expect } from "vitest";
import { buildTurnNodes, type TimelineNode } from "./node-timeline";
import type { Message, ContentBlock } from "@/stores/chat";

function makeAssistant(overrides: Partial<Message> & { id?: string }): Message {
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

function userMsg(id = "u1"): Message {
  return {
    id,
    role: "user",
    content: "你好",
    thinking: "",
    toolUses: [],
    timestamp: 0,
    isStreaming: false,
  };
}

/** 简写：contentBlocks 构造辅助 */
function blocks(...bs: ContentBlock[]): ContentBlock[] {
  return bs;
}

function textBlock(content: string): ContentBlock {
  return { type: "text", content };
}

function thinkingBlock(content: string): ContentBlock {
  return { type: "thinking", content };
}

function toolBlock(id: string, name = "Bash"): ContentBlock {
  return { type: "tool_use", toolUse: { id, name, input: { command: "ls" } } };
}

function taskBlock(id: string, name = "task"): ContentBlock {
  return { type: "tool_use", toolUse: { id, name, input: { prompt: "子任务" } } };
}

describe("buildTurnNodes", () => {
  it("空回合（无 assistants）→ 空数组", () => {
    expect(buildTurnNodes({ user: userMsg(), assistants: [] })).toEqual([]);
  });

  it("thinking + text → 两个节点，最后 text 标记总结（D7）", () => {
    const nodes = buildTurnNodes({
      user: userMsg(),
      assistants: [makeAssistant({ contentBlocks: blocks(thinkingBlock("思考中"), textBlock("回答")) })],
    });
    expect(nodes.map((n) => n.kind)).toEqual(["thinking", "text"]);
    expect(nodes[0].text).toBe("思考中");
    expect(nodes[1].text).toBe("回答");
    expect(nodes[1].isSummary).toBe(true);
  });

  it("相邻 text 合并：同消息多 text 块 → 单节点（内容换行保序）", () => {
    const nodes = buildTurnNodes({
      user: userMsg(),
      assistants: [makeAssistant({ contentBlocks: blocks(textBlock("第一段"), textBlock("第二段")) })],
    });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe("text");
    expect(nodes[0].text).toBe("第一段\n第二段");
    expect(nodes[0].isSummary).toBe(true);
  });

  it("相邻合并跨消息边界（D4 回合级）：msg1 text + msg2 text → 单 text 节点", () => {
    const nodes = buildTurnNodes({
      user: userMsg(),
      assistants: [
        makeAssistant({ id: "a1", contentBlocks: blocks(textBlock("第一轮输出")) }),
        makeAssistant({ id: "a2", contentBlocks: blocks(textBlock("第二轮输出")) }),
      ],
    });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe("text");
    expect(nodes[0].text).toBe("第一轮输出\n第二轮输出");
  });

  it("相邻 thinking 合并跨消息：msg1 thinking + msg2 thinking → 单 thinking 节点", () => {
    const nodes = buildTurnNodes({
      user: userMsg(),
      assistants: [
        makeAssistant({ id: "a1", contentBlocks: blocks(thinkingBlock("思考一")) }),
        makeAssistant({ id: "a2", contentBlocks: blocks(thinkingBlock("思考二")) }),
      ],
    });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe("thinking");
    expect(nodes[0].text).toBe("思考一\n思考二");
    expect(nodes[0].isSummary).toBeUndefined();
  });

  it("工具打断后 text 独立：text → tool → text，最后 text 总结", () => {
    const nodes = buildTurnNodes({
      user: userMsg(),
      assistants: [
        makeAssistant({
          contentBlocks: blocks(textBlock("准备执行"), toolBlock("t1"), textBlock("执行完成")),
        }),
      ],
    });
    expect(nodes.map((n) => n.kind)).toEqual(["text", "tool", "text"]);
    expect(nodes[0].text).toBe("准备执行");
    expect(nodes[1].tool?.id).toBe("t1");
    expect(nodes[2].text).toBe("执行完成");
    expect(nodes[2].isSummary).toBe(true);
  });

  it("tool_result 块跳过：tool_use + tool_result → 仅 tool 节点", () => {
    const nodes = buildTurnNodes({
      user: userMsg(),
      assistants: [
        makeAssistant({
          contentBlocks: blocks(
            toolBlock("t1"),
            { type: "tool_result", toolResult: { toolUseId: "t1", content: "ls 结果" } },
            textBlock("完成"),
          ),
        }),
      ],
    });
    expect(nodes.map((n) => n.kind)).toEqual(["tool", "text"]);
  });

  it("task 工具 → subtask 节点（D12 小写规范化：task/Task 均识别）", () => {
    for (const name of ["task", "Task"]) {
      const nodes = buildTurnNodes({
        user: userMsg(),
        assistants: [
          makeAssistant({ contentBlocks: blocks(taskBlock("sub_1", name), textBlock("子任务后")) }),
        ],
      });
      expect(nodes.map((n) => n.kind)).toEqual(["subtask", "text"]);
      expect(nodes[0].tool?.id).toBe("sub_1");
      expect(nodes[0].kind).toBe("subtask");
      expect(nodes[0].text).toBeUndefined();
    }
  });

  it("tool/subtask 不合并：连续两个工具 → 两个独立节点", () => {
    const nodes = buildTurnNodes({
      user: userMsg(),
      assistants: [
        makeAssistant({ contentBlocks: blocks(toolBlock("t1"), toolBlock("t2")) }),
      ],
    });
    expect(nodes.map((n) => n.kind)).toEqual(["tool", "tool"]);
    expect(nodes[0].key).toBe("t1");
    expect(nodes[1].key).toBe("t2");
  });

  it("回合最后是工具 → 无总结标记", () => {
    const nodes = buildTurnNodes({
      user: userMsg(),
      assistants: [makeAssistant({ contentBlocks: blocks(textBlock("思考"), toolBlock("t1")) })],
    });
    expect(nodes).toHaveLength(2);
    expect(nodes[1].kind).toBe("tool");
    expect(nodes[1].isSummary).toBeUndefined();
  });

  it("无 contentBlocks → synthesizeBlocks 降级（thinking → tool → text）", () => {
    const msg = makeAssistant({
      thinking: "分析中",
      toolUses: [{ id: "t1", name: "Bash", input: { command: "ls" }, result: "file1.txt" }],
      content: "完成",
    });
    // 明确无 contentBlocks（降级路径）
    delete (msg as { contentBlocks?: ContentBlock[] }).contentBlocks;
    const nodes = buildTurnNodes({ user: userMsg(), assistants: [msg] });
    expect(nodes.map((n) => n.kind)).toEqual(["thinking", "tool", "text"]);
    expect(nodes[0].text).toBe("分析中");
    expect(nodes[1].tool?.id).toBe("t1");
    expect(nodes[2].text).toBe("完成");
    expect(nodes[2].isSummary).toBe(true);
  });

  it("key 稳定：text/thinking 用块索引，tool 用工具 id", () => {
    const nodes = buildTurnNodes({
      user: userMsg(),
      assistants: [
        makeAssistant({
          contentBlocks: blocks(thinkingBlock("思考"), textBlock("回答"), toolBlock("t1")),
        }),
      ],
    });
    expect(nodes[0].key).toBe("m0-b0");
    expect(nodes[1].key).toBe("m0-b1");
    expect(nodes[2].key).toBe("t1");
  });

  it("多消息混合：跨消息 text 合并但工具打断各自独立", () => {
    const nodes = buildTurnNodes({
      user: userMsg(),
      assistants: [
        makeAssistant({ id: "a1", contentBlocks: blocks(textBlock("第一段")) }),
        makeAssistant({ id: "a2", contentBlocks: blocks(toolBlock("t1")) }),
        makeAssistant({ id: "a3", contentBlocks: blocks(textBlock("最后总结")) }),
      ],
    });
    expect(nodes.map((n) => n.kind)).toEqual(["text", "tool", "text"]);
    expect(nodes[0].text).toBe("第一段");
    expect(nodes[2].text).toBe("最后总结");
    expect(nodes[2].isSummary).toBe(true);
  });

  it("空 contentBlocks（[]）→ 无节点", () => {
    const nodes = buildTurnNodes({
      user: userMsg(),
      assistants: [makeAssistant({ contentBlocks: [] })],
    });
    expect(nodes).toEqual([]);
  });
});

// 类型断言：kind 联合包含 summary 预留枚举（编译期校验）
const _typeCheck: TimelineNode["kind"] = "summary";
void _typeCheck;
