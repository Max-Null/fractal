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

/** 合并同类块内容到节点：非空块用换行分隔追加（保序；空块跳过不产生空段） */
function appendBlockContent(node: TimelineNode, content?: string) {
  const c = content || "";
  if (!c) return;
  node.text = node.text ? `${node.text}\n${c}` : c;
}

/** 将回合（user + assistants）折叠为时间线节点数组 */
export function buildTurnNodes(turn: { user: Message; assistants: Message[] }): TimelineNode[] {
  const nodes: TimelineNode[] = [];
  // lastKind 跨消息保留 → 相邻同类（text/thinking）跨消息边界也合并（D4 回合级）
  let lastKind: "thinking" | "text" | "tool" | "subtask" | null = null;
  turn.assistants.forEach((msg, mi) => {
    // contentBlocks 为顺序真相源（D3）；旧存档无 contentBlocks → 三段式降级
    const blocks = msg.contentBlocks ?? synthesizeBlocks(msg);
    blocks.forEach((b, bi) => {
      // tool_result 块不产生节点（结果内嵌在 tool 节点展开区，D5）
      if (b.type === "tool_result") return;
      // D12：task 工具由子智能体卡片代替，不渲染 🔧 工具节点
      if (isTaskToolBlock(b)) {
        nodes.push({ key: b.toolUse?.id || `m${mi}-b${bi}`, kind: "subtask", tool: b.toolUse });
        lastKind = "subtask";
        return;
      }
      if (b.type === "text" || b.type === "thinking") {
        // D4：相邻同类合并（工具/子智能体打断后各自独立，tool/subtask 不合并）
        if (lastKind === b.type) {
          appendBlockContent(nodes[nodes.length - 1], b.content);
        } else {
          nodes.push({ key: `m${mi}-b${bi}`, kind: b.type, text: b.content || "" });
          lastKind = b.type;
        }
      } else if (b.type === "tool_use") {
        nodes.push({ key: b.toolUse?.id || `m${mi}-b${bi}`, kind: "tool", tool: b.toolUse });
        lastKind = "tool";
      }
    });
  });
  // D7：回合最后 text 块 → ✅ 总结节点（末尾非 text 则无总结标记）
  const last = nodes[nodes.length - 1];
  if (last?.kind === "text") last.isSummary = true;
  return nodes;
}
