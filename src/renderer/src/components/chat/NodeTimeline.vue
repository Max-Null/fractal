<script setup lang="ts">
// 回合级时间线（3b）：左侧竖线 + 节点序列（NodeCard）+ 回合完成标记（D9）
// 数据源：turn（user + 多条 assistant 消息聚合）；节点序列 computed 缓存（D17 流式性能）
import { ref, computed } from "vue";
import { useI18n } from "vue-i18n";
import type { Message, SubTask, TodoItem } from "@/stores/chat";
import { buildTurnNodes, type TimelineNode } from "@/lib/node-timeline";
import { formatNum } from "@/lib/utils";
import NodeCard from "./NodeCard.vue";
import TodoRecordCard from "./TodoRecordCard.vue";

const { t } = useI18n();

const props = defineProps<{
  turn: { user: Message; assistants: Message[] };
  /** 实时子任务状态（chat.subTasks 传入）：subtask 节点按 taskId 查询 running/done/failed/stale */
  subtaskState?: Record<string, SubTask>;
  /** 历史已完成子任务索引（按 taskId；ChatPanel 由 buildSubTaskMap + childSessions + 预拉摘要构建） */
  historySubtasks?: Record<string, SubTask>;
  /** 历史 done 摘要懒加载兜底（未预拉成功时展开调用） */
  subtaskSummaryLoader?: (subId: string) => Promise<string | undefined>;
  /** 回合完成时刻（D9 系统时间；测试可注入固定值，缺省 Date.now） */
  completedAt?: number;
  /** 回合待办记录（反馈 #6：TodoRecordCard 并入时间线做成结束节点；由 ChatPanel 从最后 assistant 提取） */
  todoRecord?: { endedAt: number; todos: TodoItem[] } | null;
}>();

const emit = defineEmits<{
  "subtask-detail": [sub: SubTask];
  "subtask-monitor": [id: string];
}>();

// D17：节点序列 computed 缓存——流式增量只触发 block 内容更新（contentBlocks 引用不变时序列不重建）
// turnComplete：最后 assistant 已 idle（非流式）→ 才标总结节点；流式中最后 text 只是临时位置，
// 标记会随增量翻转（总结闪烁 + summary/lead-text 样式反复切换，2026-08-13 用户实测）
const turnComplete = computed(() => {
  const last = props.turn.assistants[props.turn.assistants.length - 1];
  return !last?.isStreaming;
});
const nodes = computed<TimelineNode[]>(() => buildTurnNodes(props.turn, turnComplete.value));

/** todo 更新节点（todowrite 工具）判定：圆点用主题色（2026-08-10 反馈：待办节点圆圈应与待办主题一致） */
const isTodoNode = computed(() => (n: TimelineNode) =>
  n.kind === "tool" && String(n.tool?.name).toLowerCase() === "todowrite"
);

/**
 * 进行中节点集合（D8）：
 * - 工具：startedAt 已开始且未完成（无 executionDurationMs / 无 result）→ busy
 * - 尾部流式块（thinking/text 增量）：对应回合内最后一个同类节点 busy（按类型反查节点，避开 key 索引差异）
 * 仅当回合最后一条 assistant 消息仍 isStreaming 时才有 busy 节点
 */
const busyKeys = computed(() => {
  const keys = new Set<string>();
  const last = props.turn.assistants[props.turn.assistants.length - 1];
  if (!last?.isStreaming) return keys;
  for (const tu of last.toolUses) {
    if (tu.startedAt && !tu.executionDurationMs && tu.result === undefined) keys.add(tu.id);
  }
  const blocks = last.contentBlocks ?? [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.type === "tool_result") continue;
    if (b.type === "thinking" || b.type === "text") {
      const target = [...nodes.value].reverse().find((n) => n.kind === b.type);
      if (target) keys.add(target.key);
    } else if (b.type === "tool_use" && b.toolUse?.startedAt && !b.toolUse.executionDurationMs && b.toolUse.result === undefined) {
      keys.add(b.toolUse.id);
    }
    break;
  }
  return keys;
});

// ── 展开状态：thinking/tool 默认收起，subtask 摘要行内展开（D5/D6/D14）──
const expandedKeys = ref<Set<string>>(new Set());
function toggleExpanded(key: string) {
  const next = new Set(expandedKeys.value);
  if (next.has(key)) next.delete(key); else next.add(key);
  expandedKeys.value = next;
}

/** subtask 节点数据解析：实时优先，历史兜底，均查不到 → null（NodeCard 显示 D6 容错占位） */
function subtaskFor(node: TimelineNode): SubTask | null {
  if (node.kind !== "subtask" || !node.taskId) return null;
  return props.subtaskState?.[node.taskId] ?? props.historySubtasks?.[node.taskId] ?? null;
}

// ── 回合完成标记（D9）：最后 assistant 消息 idle（isStreaming=false）→ 渲染 ──
const lastAssistant = computed(() => props.turn.assistants[props.turn.assistants.length - 1]);
const turnDone = computed(() => !!lastAssistant.value && !lastAssistant.value.isStreaming);
/** 回合耗时：最后消息 durationMs → 秒（保留 1 位）；无则空（历史旧档可能缺失） */
const turnDurationSec = computed(() => {
  const d = lastAssistant.value?.durationMs;
  return d ? (d / 1000).toFixed(1) : null;
});
/** 完成时刻：completedAt prop（测试注入）或 Date.now（系统时间 = 完成时刻） */
const completedAtValue = computed(() => props.completedAt ?? Date.now());
const completedAtLabel = computed(() => {
  const d = new Date(completedAtValue.value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
});
/** token 统计（原 MessageBubble 统计行迁移）：回合最后消息的 ↑↓ token */
const tokenLabel = computed(() => {
  const parts: string[] = [];
  if (lastAssistant.value?.inputTokens) parts.push(`↑${formatNum(lastAssistant.value.inputTokens)}`);
  if (lastAssistant.value?.outputTokens) parts.push(`↓${formatNum(lastAssistant.value.outputTokens)}`);
  return parts.join(" ");
});
</script>

<template>
  <div class="node-timeline">
    <!-- 2026-08-10 用户拍板：去掉「✦ 模型头像 + 模型名」时间线头部——左右对话布局（用户消息右侧气泡，
         分形回复时间线直接开始节点序列，位于左侧） -->
    <div
      v-for="(node, i) in nodes"
      :key="node.key"
      class="node-timeline-item"
      :class="{
        'node-timeline-item--busy': busyKeys.has(node.key),
        // 末节点截断（D1）：最后一项竖线不延伸；有 todo 记录节点时最后节点竖线需延伸到 todo 节点，不截断
        'node-timeline-item--last': i === nodes.length - 1 && !props.todoRecord,
      }"
    >
      <!-- 时间线圆点（类型色；busy 时琥珀呼吸 D8）；todowrite 更新节点用主题色（待办语义） -->
      <div
        class="node-timeline-dot"
        :class="isTodoNode(node) ? 'node-timeline-dot--todo' : 'node-timeline-dot--' + node.kind"
      ></div>
      <div class="node-timeline-content">
        <NodeCard
          :node="node"
          :expanded="expandedKeys.has(node.key)"
          :busy="busyKeys.has(node.key)"
          :subtask="subtaskFor(node)"
          :subtask-summary-loader="props.subtaskSummaryLoader"
          @update:expanded="toggleExpanded(node.key)"
          @subtask-expand="() => toggleExpanded(node.key)"
          @subtask-detail="(sub) => emit('subtask-detail', sub)"
          @subtask-monitor="(id) => emit('subtask-monitor', id)"
        />
      </div>
    </div>

    <!-- 待办记录结束节点（反馈 #6：TodoRecordCard 并入时间线——回合末尾 summary 后渲染；
         只显示条数/时间，点击展开完整列表；竖线截断不延伸到完成标记） -->
    <div v-if="todoRecord" class="node-timeline-item node-timeline-item--todo">
      <div class="node-timeline-dot node-timeline-dot--todo"></div>
      <div class="node-timeline-content">
        <TodoRecordCard :ended-at="todoRecord.endedAt" :todos="todoRecord.todos" embedded />
      </div>
    </div>

    <!-- 回合完成标记（D9）：idle 后渲染；静默结束（最后节点是工具无文字）同样渲染 -->
    <div v-if="turnDone" class="node-timeline-done">
      <span class="node-timeline-done-line">───</span>
      <span class="node-timeline-done-mark">✓</span>
      <span>{{ t('chat.turnComplete') }} · {{ turnDurationSec ?? '--' }}s · {{ completedAtLabel }}</span>
      <span class="node-timeline-done-line">───</span>
      <span v-if="tokenLabel" class="node-timeline-done-token">{{ tokenLabel }}</span>
    </div>
  </div>
</template>

<style scoped>
/* ── 时间线容器 ── */
.node-timeline {
  min-width: 0;
}

/* ── 节点项：每项画竖线段（圆点中心 → 下一圆点中心），末项截断（D1） ── */
.node-timeline-item {
  position: relative;
  padding-left: 26px;
  margin-bottom: 8px;
}
/* 竖线段：当前圆点中心（top 4 + 圆点 8）延伸到下一圆点中心（margin 8 + top 4 + 圆点 8） */
.node-timeline-item::after {
  content: '';
  position: absolute;
  left: 10px;
  top: 12px;
  bottom: -20px;
  width: 2px;
  background: var(--border-dim);
  border-radius: 1px;
}
.node-timeline-item--last::after {
  /* 末节点截断：最后一项不再向下延伸（回合内竖线到此结束） */
  display: none;
}

.node-timeline-dot {
  position: absolute;
  left: 3px;
  top: 4px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-surface);
  border: 1.5px solid var(--border-dim);
  z-index: 1;
}
/* 类型色（D18 语义映射到圆点边框）：思考=琥珀 / 工具=紫 / 子智能体=accent / 文字=亮边框 / 待办记录=accent */
.node-timeline-dot--thinking { border-color: var(--amber); }
.node-timeline-dot--tool { border-color: var(--violet); }
.node-timeline-dot--subtask { border-color: var(--coral); }
.node-timeline-dot--text { border-color: var(--border-bright); }
.node-timeline-dot--todo { border-color: var(--accent); }

/* 待办记录结束节点：竖线截断（不延伸到回合完成标记） */
.node-timeline-item--todo::after {
  display: none;
}

/* D8 进行中：琥珀边框 + 圆点呼吸（box-shadow 扩散脉冲 1.4s） */
.node-timeline-item--busy .node-timeline-dot {
  border-color: var(--amber);
  animation: node-breathe 1.4s ease-in-out infinite;
}
@keyframes node-breathe {
  0%, 100% { box-shadow: 0 0 0 0 rgba(217, 119, 6, 0.45); }
  50% { box-shadow: 0 0 0 6px rgba(217, 119, 6, 0); }
}

.node-timeline-content {
  min-width: 0;
}

/* ── 回合完成标记（D9）：灰字分隔线字符 + ✓ 绿 ── */
.node-timeline-done {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
  font-size: 11px;
  color: var(--text-muted);
  opacity: 0.7;
  user-select: none;
  white-space: nowrap;
}
.node-timeline-done-mark {
  color: var(--accent);
  font-weight: 600;
}
.node-timeline-done-token {
  font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace;
  font-size: 10px;
  opacity: 0.7;
  margin-left: 4px;
}
</style>
