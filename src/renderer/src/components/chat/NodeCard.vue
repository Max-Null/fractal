<script setup lang="ts">
// 时间线节点卡片（3b）：6 变体渲染（thinking/text/tool/todo/subtask/summary）+ D8 两态（进行中/完成）
// 职责：单个节点内容的展示与展开收起；时间线样式（竖线/圆点）由 NodeTimeline 提供
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import {
  Brain, Globe, FileText, Pencil, Terminal, Wrench, SquareCheck, Flag,
} from "lucide-vue-next";
import type { Component } from "vue";
import type { TimelineNode } from "@/lib/node-timeline";
import { toolSummary, thinkingSummary } from "@/lib/nodeSummary";
import type { SubTask } from "@/stores/chat";
import MarkdownRenderer from "../shared/MarkdownRenderer.vue";
import SubTaskCard from "./SubTaskCard.vue";

const { t } = useI18n();

const props = defineProps<{
  node: TimelineNode;
  /** 展开态（受控）：thinking/tool 默认收起；text/summary 恒展开；todo 无展开（D11） */
  expanded?: boolean;
  /** D8 进行中态：thinking/text 流式增量 / tool 未完成 → 琥珀脉冲 + 三连点 */
  busy?: boolean;
  /** subtask 变体数据（NodeTimeline 解析后传入）：实时 subTasks / 历史 done 映射；null 表示查不到（D6 容错） */
  subtask?: SubTask | null;
  /** subtask 历史摘要懒加载兜底（历史 done 未预拉摘要时展开调用） */
  subtaskSummaryLoader?: (subId: string) => Promise<string | undefined>;
}>();

const emit = defineEmits<{
  "update:expanded": [value: boolean];
  "subtask-expand": [id: string];
  "subtask-detail": [sub: SubTask];
  "subtask-monitor": [id: string];
}>();

// 每秒 tick：流式期间工具 startedAt → 实时耗时（原 MessageBubble 逻辑迁移）
const now = ref(Date.now());
let nowTimer: ReturnType<typeof setInterval> | null = null;
onMounted(() => { nowTimer = setInterval(() => { now.value = Date.now(); }, 1000); });
onUnmounted(() => { if (nowTimer) clearInterval(nowTimer); });

/** todo 变体判定：tool 节点工具名为 todowrite（D11 单行无展开） */
const isTodo = computed(() =>
  props.node.kind === "tool" && String(props.node.tool?.name).toLowerCase() === "todowrite"
);

/** summary 变体判定：回合最后 text 节点（D7） */
const isSummaryNode = computed(() => props.node.kind === "text" && props.node.isSummary);

/** 展开判定：text/summary 恒展开；todo 无展开；thinking/tool 受控 */
const isExpanded = computed(() => {
  if (props.node.kind === "text" || isSummaryNode.value) return true;
  if (isTodo.value) return false;
  return !!props.expanded;
});

/** 标题行点击：thinking/tool 可展开收起（D5/D6）；todo 无展开交互（D11） */
function toggle() {
  if (props.node.kind !== "thinking" && props.node.kind !== "tool") return;
  if (isTodo.value) return;
  emit("update:expanded", !props.expanded);
}

/** D18 工具图标映射：websearch=globe / read=file-text / edit=pencil / bash=terminal / 未知=wrench */
const toolIcon = computed<Component>(() => {
  switch (String(props.node.tool?.name).toLowerCase()) {
    case "websearch": return Globe;
    case "read": return FileText;
    case "edit": return Pencil;
    case "bash": return Terminal;
    default: return Wrench;
  }
});

/** 工具名本地化：locales/tools 翻译失败返回原名（原 MessageBubble toolLabel 迁移） */
function toolLabel(name: string): string {
  const key = `tools.${name}`;
  const translated = t(key);
  return translated !== key ? translated : name;
}

/** 节点耗时：tool 用执行耗时（流式实时 startedAt→now）；thinking 用构建期回填的 thinkingDurationMs */
const durationLabel = computed(() => {
  const n = props.node;
  if (n.kind === "tool" && n.tool) {
    if (n.tool.executionDurationMs) return (n.tool.executionDurationMs / 1000).toFixed(1) + "s";
    if (props.busy && n.tool.startedAt) return ((now.value - n.tool.startedAt) / 1000).toFixed(1) + "s";
    return "";
  }
  if (n.kind === "thinking" && n.durationMs) return (n.durationMs / 1000).toFixed(1) + "s";
  return "";
});

/** 工具状态标记：错误 ✗（珊瑚）/ 有结果 ✓（绿）/ 其余空（进行中由 busy 三连点接管） */
const statusMark = computed(() => {
  if (props.node.kind !== "tool" || !props.node.tool) return "";
  if (props.node.tool.isError) return "✗";
  if (props.node.tool.result !== undefined) return "✓";
  return "";
});

/** thinking 梗概（前 60 字 + 超出省略） */
const snippet = computed(() => {
  if (props.node.kind !== "thinking") return "";
  const s = thinkingSummary(props.node.text ?? "");
  return s.length < (props.node.text ?? "").length ? s + "…" : s;
});

/** tool 展开区：input/result 格式化展示（原 MessageBubble formatJSON 迁移） */
function formatJSON(obj: unknown): string {
  if (typeof obj === "string") return obj;
  return JSON.stringify(obj, null, 2);
}
</script>

<template>
  <div
    class="node-card"
    :class="{
      'node-card--busy': busy,
      'node-card--summary': isSummaryNode,
      'node-card--todo': isTodo,
    }"
  >
    <!-- ═══ thinking：标题行（收起态只渲染标题行——流式性能 D17）+ 点击展开全文 ═══ -->
    <template v-if="node.kind === 'thinking'">
      <div class="node-card-head node-card-head--thinking" @click="toggle">
        <Brain class="node-card-icon" :size="13" />
        <span class="node-card-label">{{ t('chat.thinkingDone') }}</span>
        <span class="node-card-snippet">{{ snippet }}</span>
        <span v-if="durationLabel" class="node-card-stat">🧠{{ durationLabel }}</span>
        <span v-if="busy" class="node-card-dots"><i /><i /><i /></span>
      </div>
      <div v-if="isExpanded" class="node-card-body node-card-body--thinking">{{ node.text }}</div>
    </template>

    <!-- ═══ text / summary：无标题行直接正文（始终展开）═══ -->
    <div v-else-if="node.kind === 'text'" class="node-card-text">
      <!-- D7 总结节点：绿底渐变 + Flag + 总结（视觉强调回合最终产出） -->
      <div v-if="isSummaryNode" class="node-card-summary-head">
        <Flag class="node-card-icon" :size="13" />
        <span class="node-card-label">{{ t('chat.timelineSummary') }}</span>
      </div>
      <MarkdownRenderer :content="node.text ?? ''" />
    </div>

    <!-- ═══ tool / todo ═══ -->
    <div v-else-if="node.kind === 'tool' && node.tool" class="node-card-tool" @click="toggle">
      <!-- 标题行：icon + 工具名 + 梗概 + 状态 + 耗时 -->
      <div class="node-card-head node-card-head--tool">
        <component :is="toolIcon" class="node-card-icon" :size="13" />
        <span class="node-card-tool-name">{{ toolLabel(node.tool.name) }}</span>
        <!-- todo 变体：更新待办 · 正在：<进行中任务>（toolSummary 已拼「正在：」前缀） -->
        <span v-if="isTodo" class="node-card-snippet">{{ t('chat.todoUpdate') }} · {{ toolSummary(node.tool.name, node.tool.input) }}</span>
        <span v-else class="node-card-snippet">{{ toolSummary(node.tool.name, node.tool.input) }}</span>
        <span
          v-if="statusMark"
          class="node-card-status"
          :class="{ 'node-card-status--error': node.tool.isError }"
        >{{ statusMark }}</span>
        <span v-if="durationLabel" class="node-card-stat">⚡{{ durationLabel }}</span>
        <span v-if="busy" class="node-card-dots"><i /><i /><i /></span>
      </div>
      <!-- 展开区：input + result（todo 无展开 D11） -->
      <template v-if="!isTodo && isExpanded">
        <div class="node-card-section-label">{{ t('chat.toolInput') }}</div>
        <pre class="node-card-pre">{{ formatJSON(node.tool.input) }}</pre>
        <div
          v-if="node.tool.result !== undefined"
          class="node-card-tool-result"
          :class="{ 'node-card-tool-result--error': node.tool.isError }"
        >
          <div class="node-card-section-label">{{ node.tool.isError ? t('chat.toolError') : t('chat.toolOutput') }}</div>
          <pre class="node-card-result-body">{{ node.tool.result }}</pre>
        </div>
      </template>
    </div>

    <!-- ═══ subtask：SubTaskCard 复用（D14 功能全复用，节点容器只提供时间线样式）═══ -->
    <div v-else-if="node.kind === 'subtask'" class="node-card-subtask">
      <SubTaskCard
        v-if="subtask"
        :subtask="subtask"
        :expanded="expanded"
        :summary-loader="subtaskSummaryLoader"
        @expand="emit('subtask-expand', subtask.id)"
        @monitor="emit('subtask-monitor', subtask.id)"
        @detail="emit('subtask-detail', subtask)"
      />
      <!-- D6 容错：子会话已删除/超限（实时/历史都查不到）→ 占位保持 task 动作可见 -->
      <div v-else class="node-card-subtask-fallback">{{ t('chat.subTaskUnavailable') }}</div>
    </div>
  </div>
</template>

<style scoped>
/* 节点卡片：进行中琥珀边框 + 头部浅琥珀底（D8）；完成态无边框强调 */
.node-card {
  border-radius: 6px;
  border: 1px solid transparent;
  transition: border-color 200ms;
}
.node-card--busy {
  border-color: rgba(217, 119, 6, 0.5);
  background: rgba(217, 119, 6, 0.05);
}
.node-card--summary {
  /* D7 总结节点：绿底渐变（视觉强调回合最终产出） */
  background: linear-gradient(135deg, rgba(34, 197, 94, 0.08), rgba(16, 185, 129, 0.04));
  border-color: rgba(34, 197, 94, 0.18);
  padding: 2px 10px;
}

/* ── 标题行 ── */
.node-card-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  font-size: 11px;
  cursor: pointer;
  user-select: none;
  color: var(--text-secondary);
  transition: background 150ms;
  flex-wrap: wrap;
}
.node-card-head:hover { background: rgba(255, 255, 255, 0.03); }
.node-card-head--thinking { color: var(--amber); }
.node-card-head--tool {
  font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace;
}
.node-card-tool { border-radius: 6px; background: var(--bg-root); border: 1px solid var(--border-dim); }
.node-card-tool .node-card-head:hover { background: var(--bg-hover); }

.node-card-icon { flex-shrink: 0; }
.node-card-label { font-weight: 600; white-space: nowrap; }
.node-card-tool-name { font-weight: 600; color: var(--violet); white-space: nowrap; }
.node-card-snippet {
  color: var(--text-muted);
  opacity: 0.7;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 260px;
  min-width: 0;
  flex: 1;
}
.node-card-stat { font-size: 10px; color: var(--text-muted); white-space: nowrap; }
.node-card-status { font-size: 10px; color: var(--accent); white-space: nowrap; }
.node-card-status--error { color: var(--coral); }

/* ── D8 三连点跳动（进行中：依次亮起上跳） ── */
.node-card-dots {
  display: inline-flex;
  gap: 2px;
  align-items: flex-end;
}
.node-card-dots i {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--amber);
  animation: dot-bounce 1.2s ease-in-out infinite;
}
.node-card-dots i:nth-child(2) { animation-delay: 0.15s; }
.node-card-dots i:nth-child(3) { animation-delay: 0.3s; }
@keyframes dot-bounce {
  0%, 100% { opacity: 0.25; transform: translateY(0); }
  50% { opacity: 1; transform: translateY(-2px); }
}

/* ── thinking 展开全文 ── */
.node-card-body--thinking {
  padding: 6px 10px;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  word-break: break-word;
  color: var(--text-secondary);
  border-top: 1px solid rgba(255, 255, 255, 0.05);
}

/* ── text / summary 正文 ── */
.node-card-text {
  font-size: 14px;
  line-height: 1.65;
}
.node-card-text :deep(p) { margin: 0.25em 0; }
.node-card-summary-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: #16a34a;
  margin-bottom: 2px;
}

/* ── tool 展开区（原 MessageBubble tl-tool 样式迁移） ── */
.node-card-section-label {
  padding: 5px 10px 2px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-muted);
  opacity: 0.5;
}
.node-card-pre {
  padding: 8px 10px;
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  overflow-x: auto;
  white-space: pre;
  border-top: 1px solid var(--border-dim);
  color: var(--text-muted);
  max-height: 240px;
}
.node-card-tool-result {
  border-top: 1px solid var(--accent-dim);
}
.node-card-tool-result--error {
  border-top-color: var(--coral);
}
.node-card-result-body {
  padding: 6px 10px 6px;
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text-secondary);
  max-height: 200px;
  overflow-y: auto;
}

/* ── subtask 容器：时间线圆点/竖线对齐由 NodeTimeline 负责，这里只做边距微调 ── */
.node-card-subtask { padding: 2px 0; }
.node-card-subtask-fallback {
  padding: 4px 10px;
  font-size: 11px;
  color: var(--text-muted);
  opacity: 0.6;
  font-style: italic;
}
</style>
