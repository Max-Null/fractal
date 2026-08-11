// 回合 → 时间线节点构建纯函数（3b 渲染层 NodeTimeline 的数据源）
// 输入为回合（用户消息 + 全部 assistant 消息），输出按真实输出序排列的节点数组；
// 纯函数——同一输入恒同输出，便于单测与 computed 缓存

import type { Message, ContentBlock, ToolUse } from "@/stores/chat";

/** 时间线节点（D4/D7/D12）：text/thinking 为折叠节点，tool 为工具节点，subtask 为子智能体节点 */
export interface TimelineNode {
  /** 稳定 key（D17）：text/thinking 用首个块索引 `m{mi}-b{bi}`；tool/subtask 用工具 id 兜底索引 */
  key: string;
  /** 'summary' 为 3b 渲染层总结变体的预留枚举（buildTurnNodes 实际以 kind='text' + isSummary 输出） */
  kind: "thinking" | "text" | "tool" | "subtask" | "summary";
  /** text/thinking 节点合并后的内容 */
  text?: string;
  /** tool 节点（kind='tool'）或 subtask 节点（kind='subtask'，task 工具，供 SubTaskCard 复用） */
  tool?: ToolUse;
  /** 回合最后 text 节点标记为 ✅ 总结（D7） */
  isSummary?: boolean;
  /** 回合首 text 节点（轮内 text 节点数 ≥2 时标记）：即主 agent 的「思考结果/结论」块——
   *  结构位置判断替代标题文字匹配（措辞会漂移：###思考结论 / ###思考结果 实测都出现，2026-08-11 用户拍板） */
  isLeadText?: boolean;
  /** subtask 节点（kind='subtask'）的子会话 id：task 块 input.metadata.sessionId 或 input/result 的 <task id="ses_..."> 提取。
   *  实时 subTasks / 历史子会话映射的查询键（3.6 统一节点数据模型） */
  taskId?: string;
  /** 节点耗时（ms）：thinking 节点 = 其后相邻工具块的 thinkingDurationMs 回填（原 MessageBubble 逻辑迁移）；
   *  tool 节点耗时由 NodeCard 自取 toolUse.executionDurationMs（流式实时从 startedAt 计时），不在构建期填充 */
  durationMs?: number;
}

/** 三段式降级（旧存档无 contentBlocks）：thinking → tool_use(+tool_result) → text */
function synthesizeBlocks(msg: Message): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (msg.thinking) blocks.push({ type: "thinking", content: msg.thinking });
  for (const tu of msg.toolUses) {
    blocks.push({ type: "tool_use", toolUse: tu });
    if (tu.result !== undefined) {
      blocks.push({
        type: "tool_result",
        toolResult: { toolUseId: tu.id, content: tu.result || "", isError: tu.isError },
      });
    }
  }
  if (msg.content) blocks.push({ type: "text", content: msg.content });
  return blocks;
}

/** D12：task 块判定按小写工具名——serve 实测 part.tool 是小写 "task"（前端历史可能存大写 "Task"） */
function isTaskToolBlock(b: ContentBlock): boolean {
  return b.type === "tool_use" && String(b.toolUse?.name).toLowerCase() === "task";
}

/**
 * 从 task 工具块提取子会话 id（D12 历史场景归属）：
 * 优先 input.metadata.sessionId（实时 running 事件实测字段）；兜底 input/result 文本中的
 * `<task id="ses_...">`（serve 在 task tool part 输出动态注入，与 chat.ts extractSubTaskIds 同正则——
 * 纯函数模块内联正则，避免依赖 store 模块）
 */
function extractTaskId(tu: ToolUse): string | undefined {
  const meta = (tu.input as { metadata?: { sessionId?: unknown } } | undefined)?.metadata?.sessionId;
  if (typeof meta === "string" && meta) return meta;
  const haystack = [JSON.stringify(tu.input ?? {}), tu.result ?? ""].join("\n");
  const m = /<task id="(ses_[^"]+)"[^>]*>/.exec(haystack);
  return m?.[1];
}

/** 合并同类块内容到节点：非空块用换行分隔追加（保序；空块跳过不产生空段） */
function appendBlockContent(node: TimelineNode, content?: string) {
  const c = content || "";
  if (!c) return;
  node.text = node.text ? `${node.text}\n${c}` : c;
}

/** 回合分组（D1）：user 消息开新回合，后续 assistant 消息归当前回合（流式 step 插入自动吸收——groupTurns 是
 * 响应式 computed 的数据源，messages push 后重算即吸收）。无 user 前导的 assistant 消息（异常数据）忽略。
 * 导出为纯函数供 ChatPanel turns computed + 单测。 */
export function groupTurns(messages: Message[]): Array<{ user: Message; assistants: Message[] }> {
  const turns: Array<{ user: Message; assistants: Message[] }> = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      turns.push({ user: msg, assistants: [] });
    } else {
      const last = turns[turns.length - 1];
      // 孤儿 assistant（无前导 user，如历史数据损坏）不产出独立回合
      if (last) last.assistants.push(msg);
    }
  }
  return turns;
}

/** 将回合（user + assistants）折叠为时间线节点数组 */
export function buildTurnNodes(turn: { user: Message; assistants: Message[] }): TimelineNode[] {
  const nodes: TimelineNode[] = [];
  // lastKind 跨消息保留 → 相邻同类（text/thinking）跨消息边界也合并（D4 回合级）
  let lastKind: "thinking" | "text" | "tool" | "subtask" | null = null;
  turn.assistants.forEach((msg, mi) => {
    // contentBlocks 为顺序真相源（D3）；旧存档无 contentBlocks → 三段式降级。
    // 空数组同样降级：3a 的 setContentBlocks 仅空初始化，[] 即"无顺序真相"信号，
    // 历史消息只有 toolUses 时（如测试构造 / 旧存档）需从 toolUses 合成
    const blocks = msg.contentBlocks?.length ? msg.contentBlocks : synthesizeBlocks(msg);
    blocks.forEach((b, bi) => {
      // tool_result 块不产生节点（结果内嵌在 tool 节点展开区，D5）
      if (b.type === "tool_result") return;
      // D12：task 工具由子智能体卡片代替，不渲染 🔧 工具节点
      if (isTaskToolBlock(b)) {
        nodes.push({
          key: b.toolUse?.id || `m${mi}-b${bi}`,
          kind: "subtask",
          tool: b.toolUse,
          // 子会话 id：历史/实时归属查询键（3.6）
          taskId: b.toolUse ? extractTaskId(b.toolUse) : undefined,
        });
        lastKind = "subtask";
        return;
      }
      if (b.type === "text" || b.type === "thinking") {
        // D4：相邻同类合并（工具/子智能体打断后各自独立，tool/subtask 不合并）
        if (lastKind === b.type) {
          appendBlockContent(nodes[nodes.length - 1], b.content);
        } else {
          // 历史路径 thinking 块自带 durationMs（serve ReasoningPart.time 透传）；text 块无耗时
          nodes.push({ key: `m${mi}-b${bi}`, kind: b.type, text: b.content || "", durationMs: b.durationMs });
          lastKind = b.type;
        }
      } else if (b.type === "tool_use") {
        // D6：thinking 节点耗时 = 其后相邻工具块的 thinkingDurationMs（原 MessageBubble
        // contentBlocks[i+1] 逻辑迁移；仅紧邻回填，跨 text 打断不显示——与原逻辑一致）
        const prev = nodes[nodes.length - 1];
        if (prev?.kind === "thinking" && prev.durationMs === undefined && b.toolUse?.thinkingDurationMs) {
          prev.durationMs = b.toolUse.thinkingDurationMs;
        }
        nodes.push({ key: b.toolUse?.id || `m${mi}-b${bi}`, kind: "tool", tool: b.toolUse });
        lastKind = "tool";
      }
    });
  });
  // D7：回合最后 text 块 → ✅ 总结节点（末尾非 text 则无总结标记）
  const last = nodes[nodes.length - 1];
  if (last?.kind === "text") last.isSummary = true;
  // 首 text 节点标记（2026-08-11 用户拍板）：轮内 text ≥2 时第一条即「思考结果」块（主题色渲染）。
  // 单 text 轮（唯一正文/总结）不标记——避免把唯一内容当思考结果强调
  const textNodes = nodes.filter((n) => n.kind === "text");
  if (textNodes.length > 1 && textNodes[0]) textNodes[0].isLeadText = true;
  return nodes;
}
