// buildTurnNodes 纯函数测试（D4 相邻合并 / D7 总结标记 / D12 task→subtask / 降级 / 空回合）
import { describe, it, expect } from "vitest";
import { buildTurnNodes, groupTurns, type TimelineNode } from "./node-timeline";
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

/** 完成态包装：buildTurnNodes(turn, true)——测试多为静态回合断言（isSummary 仅在完成态标记）。
 * 流式态（isStreaming 中）不标总结的用例单独用 buildTurnNodes(turn)（无第二参）验证 */
function buildDone(turn: { user: Message; assistants: Message[] }): TimelineNode[] {
  return buildTurnNodes(turn, true);
}

describe("buildTurnNodes", () => {
  it("空回合（无 assistants）→ 空数组", () => {
    expect(buildDone({ user: userMsg(), assistants: [] })).toEqual([]);
  });

  it("thinking + text → 两个节点，最后 text 标记总结（D7）", () => {
    const nodes = buildDone({
      user: userMsg(),
      assistants: [makeAssistant({ contentBlocks: blocks(thinkingBlock("思考中"), textBlock("回答")) })],
    });
    expect(nodes.map((n) => n.kind)).toEqual(["thinking", "text"]);
    expect(nodes[0].text).toBe("思考中");
    expect(nodes[1].text).toBe("回答");
    expect(nodes[1].isSummary).toBe(true);
  });

  it("相邻 text 合并：同消息多 text 块 → 单节点（内容换行保序）", () => {
    const nodes = buildDone({
      user: userMsg(),
      assistants: [makeAssistant({ contentBlocks: blocks(textBlock("第一段"), textBlock("第二段")) })],
    });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe("text");
    expect(nodes[0].text).toBe("第一段\n第二段");
    expect(nodes[0].isSummary).toBe(true);
  });

  it("相邻合并跨消息边界（D4 回合级）：msg1 text + msg2 text → 单 text 节点", () => {
    const nodes = buildDone({
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
    const nodes = buildDone({
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

  it("流式态（turnComplete 缺省/false）：最后 text 不标总结——总结标记只在回合完成（2026-08-13 用户实测闪烁）", () => {
    // 输出中的回合：最后 assistant 仍 isStreaming（buildTurnNodes 不传第二参 = 流式态）
    const nodes = buildTurnNodes({
      user: userMsg(),
      assistants: [makeAssistant({ isStreaming: true, contentBlocks: blocks(textBlock("正在输出中...")) })],
    });
    expect(nodes[0].kind).toBe("text");
    expect(nodes[0].isSummary).toBeUndefined();
    // 完成态（显式 true）才标总结
    const done = buildDone({
      user: userMsg(),
      assistants: [makeAssistant({ isStreaming: false, contentBlocks: blocks(textBlock("最终回答")) })],
    });
    expect(done[0].isSummary).toBe(true);
  });

  it("工具打断后 text 独立：text → tool → text，最后 text 总结", () => {
    const nodes = buildDone({
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

  it("首 text 节点标记（2026-08-11）：轮内 ≥2 条 text → 第一条 isLeadText（思考结果块），最后一条 isSummary", () => {
    const nodes = buildDone({
      user: userMsg(),
      assistants: [
        makeAssistant({
          contentBlocks: blocks(textBlock("###思考结果 先看一下现状"), toolBlock("t1"), textBlock("执行完成，总结如下")),
        }),
      ],
    });
    expect(nodes.map((n) => n.kind)).toEqual(["text", "tool", "text"]);
    expect(nodes[0].isLeadText).toBe(true);
    expect(nodes[0].isSummary).toBeUndefined();
    expect(nodes[2].isLeadText).toBeUndefined();
    expect(nodes[2].isSummary).toBe(true);
  });

  it("唯一 text 轮（仅一条正文）→ 不标记 isLeadText（避免把唯一内容当思考结果强调）", () => {
    const nodes = buildDone({
      user: userMsg(),
      assistants: [makeAssistant({ contentBlocks: blocks(textBlock("唯一回答")) })],
    });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].isLeadText).toBeUndefined();
    expect(nodes[0].isSummary).toBe(true);
  });

  it("tool_result 块跳过：tool_use + tool_result → 仅 tool 节点", () => {
    const nodes = buildDone({
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
      const nodes = buildDone({
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
    const nodes = buildDone({
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
    const nodes = buildDone({
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
    const nodes = buildDone({ user: userMsg(), assistants: [msg] });
    expect(nodes.map((n) => n.kind)).toEqual(["thinking", "tool", "text"]);
    expect(nodes[0].text).toBe("分析中");
    expect(nodes[1].tool?.id).toBe("t1");
    expect(nodes[2].text).toBe("完成");
    expect(nodes[2].isSummary).toBe(true);
  });

  it("key 稳定：text/thinking 用块索引，tool 用工具 id", () => {
    const nodes = buildDone({
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
    const nodes = buildDone({
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
    const nodes = buildDone({
      user: userMsg(),
      assistants: [makeAssistant({ contentBlocks: [] })],
    });
    expect(nodes).toEqual([]);
  });

  // ── taskId 提取（3b：subtask 节点 → 子会话 id 查询键）──

  it("task 块 input.metadata.sessionId → taskId（实时 running 事件字段）", () => {
    const nodes = buildDone({
      user: userMsg(),
      assistants: [
        makeAssistant({
          contentBlocks: [{
            type: "tool_use",
            toolUse: { id: "t1", name: "task", input: { metadata: { sessionId: "ses_live_1" } } },
          }],
        }),
      ],
    });
    expect(nodes[0].kind).toBe("subtask");
    expect(nodes[0].taskId).toBe("ses_live_1");
  });

  it("task 块 result 的 <task id> → taskId（历史完成态，extractSubTaskIds 同正则）", () => {
    const nodes = buildDone({
      user: userMsg(),
      assistants: [
        makeAssistant({
          contentBlocks: [{
            type: "tool_use",
            toolUse: { id: "t1", name: "task", input: {}, result: '<task id="ses_hist_1" state="completed">\n<task_result>ok</task_result>' },
          }],
        }),
      ],
    });
    expect(nodes[0].kind).toBe("subtask");
    expect(nodes[0].taskId).toBe("ses_hist_1");
  });

  it("task 块无 sessionId / <task id> → taskId 缺省", () => {
    const nodes = buildDone({
      user: userMsg(),
      assistants: [makeAssistant({ contentBlocks: [{ type: "tool_use", toolUse: { id: "t1", name: "task", input: {} } }] })],
    });
    expect(nodes[0].kind).toBe("subtask");
    expect(nodes[0].taskId).toBeUndefined();
  });

  it("thinking 节点 durationMs 回填：其后相邻 tool 块的 thinkingDurationMs", () => {
    const nodes = buildDone({
      user: userMsg(),
      assistants: [
        makeAssistant({
          contentBlocks: [
            thinkingBlock("思考"),
            { type: "tool_use", toolUse: { id: "t1", name: "Bash", input: { command: "ls" }, thinkingDurationMs: 1500 } },
          ],
        }),
      ],
    });
    expect(nodes[0].kind).toBe("thinking");
    expect(nodes[0].durationMs).toBe(1500);
  });

  it("thinking 节点 durationMs 直接取块自带值（历史路径 serve ReasoningPart.time 透传，2026-08-10）", () => {
    const nodes = buildDone({
      user: userMsg(),
      assistants: [
        makeAssistant({
          contentBlocks: [
            { type: "thinking", content: "历史思考", durationMs: 900 },
            { type: "text", content: "回答" },
          ],
        }),
      ],
    });
    expect(nodes[0].kind).toBe("thinking");
    expect(nodes[0].durationMs).toBe(900);
    // 块自带值与相邻工具块回填不冲突：已有时不回填（node-timeline 的 undefined 检查）
    const merged = buildDone({
      user: userMsg(),
      assistants: [
        makeAssistant({
          contentBlocks: [
            { type: "thinking", content: "思考", durationMs: 900 },
            { type: "tool_use", toolUse: { id: "t1", name: "Bash", input: {}, thinkingDurationMs: 1500 } },
          ],
        }),
      ],
    });
    expect(merged[0].durationMs).toBe(900);
  });
});

// ── groupTurns 回合分组（D1：user 开新回合，assistant 归当前回合）──

describe("groupTurns", () => {
  function u(id: string): Message {
    return userMsg(id);
  }
  function a(id: string): Message {
    return makeAssistant({ id });
  }

  it("空列表 → 空回合数组", () => {
    expect(groupTurns([])).toEqual([]);
  });

  it("user + assistant → 单回合（assistant 归该 user）", () => {
    const turns = groupTurns([u("u1"), a("a1")]);
    expect(turns).toHaveLength(1);
    expect(turns[0].user.id).toBe("u1");
    expect(turns[0].assistants.map((m) => m.id)).toEqual(["a1"]);
  });

  it("多 user 消息 → 多回合，assistant 归最近 user", () => {
    const turns = groupTurns([u("u1"), a("a1"), u("u2"), a("a2"), a("a3")]);
    expect(turns).toHaveLength(2);
    expect(turns[0].assistants.map((m) => m.id)).toEqual(["a1"]);
    expect(turns[1].assistants.map((m) => m.id)).toEqual(["a2", "a3"]);
  });

  it("孤儿 assistant（无前导 user）忽略", () => {
    const turns = groupTurns([a("a0"), u("u1"), a("a1")]);
    expect(turns).toHaveLength(1);
    expect(turns[0].user.id).toBe("u1");
    expect(turns[0].assistants.map((m) => m.id)).toEqual(["a1"]);
  });

  it("流式吸收：assistant 消息 push 后重算归入当前回合（流式 step 插入不断线）", () => {
    const messages: Message[] = [u("u1"), a("a1")];
    const first = groupTurns(messages);
    expect(first[0].assistants).toHaveLength(1);
    // 流式新 step：新 assistant 消息 push 进 messages
    messages.push(a("a2"));
    const second = groupTurns(messages);
    expect(second[0].assistants.map((m) => m.id)).toEqual(["a1", "a2"]);
  });
});

// 类型断言：kind 联合包含 summary 预留枚举（编译期校验）
const _typeCheck: TimelineNode["kind"] = "summary";
void _typeCheck;
