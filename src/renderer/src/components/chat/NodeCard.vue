<script setup lang="ts">
// 时间线节点卡片（3b）：6 变体渲染（thinking/text/tool/todo/subtask/summary）+ D8 两态（进行中/完成）
// 职责：单个节点内容的展示与展开收起；时间线样式（竖线/圆点）由 NodeTimeline 提供
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import {
  Brain, Globe, FileText, Pencil, Terminal, Wrench, Flag, ChevronDown,
} from "lucide-vue-next";
import type { Component } from "vue";
import type { TimelineNode } from "@/lib/node-timeline";
import { toolSummary, thinkingSummary } from "@/lib/nodeSummary";
import type { SubTask, TodoItem } from "@/stores/chat";
import MarkdownRenderer from "../shared/MarkdownRenderer.vue";
import SubTaskCard from "./SubTaskCard.vue";
import TodoRecordCard from "./TodoRecordCard.vue";

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

/** todo 变体判定：tool 节点工具名为 todowrite（2026-08-10 用户拍板：复用 TodoRecordCard 折叠卡，样式与回合记录节点统一） */
const isTodo = computed(() =>
  props.node.kind === "tool" && String(props.node.tool?.name).toLowerCase() === "todowrite"
);

/** summary 变体判定：回合最后 text 节点（D7） */
const isSummaryNode = computed(() => props.node.kind === "text" && props.node.isSummary);

/** 展开判定：text/summary 恒展开；todo 由 TodoRecordCard 内部状态管理（不参与受控展开）；thinking/tool 受控 */
const isExpanded = computed(() => {
  if (props.node.kind === "text" || isSummaryNode.value) return true;
  if (isTodo.value) return false;
  return !!props.expanded;
});

/** 可展开判定：thinking/tool（D5/D6 可点击收起展开）；chevron 仅在可展开节点显示；todo 走 TodoRecordCard 自带 ▾ */
const isCollapsible = computed(() =>
  props.node.kind === "thinking" || (props.node.kind === "tool" && !isTodo.value)
);

/** todo 变体待办列表：todowrite input.todos 数组——信息型展示，不是工具卡片 */
const todoItems = computed<TodoItem[]>(() => {
  if (!isTodo.value) return [];
  const todos = (props.node.tool?.input as { todos?: unknown } | undefined)?.todos;
  return Array.isArray(todos) ? (todos as TodoItem[]) : [];
});

/** todo 变体完成判定：全部 completed/cancelled（含空列表=false——无任务不算完成）→ 「待办完成」+ ✓ 标记 */
const todoAllDone = computed(() => {
  if (!isTodo.value) return false;
  const items = todoItems.value;
  return items.length > 0 && items.every(t => t.status === "completed" || t.status === "cancelled");
});

/** todo 变体标题：全部完成 → 「待办完成」；有进行中/待办 → 「更新待办」（2026-08-10 反馈） */
const todoTitle = computed(() => t(todoAllDone.value ? "chat.todoDone" : "chat.todoUpdate"));

/** todo 变体摘要：全部完成 → 「n/m 完成」（复用 TodoRecordCard 默认 count 语义，不显示「正在：」）；
 *  有进行中 → 「正在：xxx」（toolSummary todowrite 分支） */
const todoSummary = computed(() =>
  todoAllDone.value ? `${todoItems.value.length}/${todoItems.value.length} ${t("chat.todoRecordDone")}` : toolSummary(props.node.tool?.name ?? "", props.node.tool?.input)
);

/** todo 变体状态标记：全部完成 → ok ✓（有进行中/待办 → undefined 不显示，避免「正在：+✓」语义冲突） */
const todoStatus = computed<"ok" | "error" | undefined>(() => {
  if (!isTodo.value || !props.node.tool) return undefined;
  if (props.node.tool.isError) return "error";
  return todoAllDone.value ? "ok" : undefined;
});

/** 标题行点击：thinking/tool 可展开收起（D5/D6）；todo 展开由 TodoRecordCard header 内部处理 */
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

/** 毫秒 → 展示文本：<100ms 显示 "<0.1s"（0.0s 会误读为无耗时/计时错误） */
function formatDuration(ms: number): string {
  const s = ms / 1000;
  return s < 0.1 ? "<0.1s" : s.toFixed(1) + "s";
}

/** 节点耗时：tool 用执行耗时（流式实时 startedAt→now）；thinking 用构建期回填的 thinkingDurationMs；
 *  text/summary 有构建期 durationMs（消息级耗时）则显示——无精确数据省略（不虚构） */
const durationLabel = computed(() => {
  const n = props.node;
  if (n.kind === "tool" && n.tool) {
    if (n.tool.executionDurationMs) return formatDuration(n.tool.executionDurationMs);
    if (props.busy && n.tool.startedAt) return formatDuration(now.value - n.tool.startedAt);
    return "";
  }
  if (n.kind === "thinking" && n.durationMs) return formatDuration(n.durationMs);
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

/** 首 text 节点（思考结果块）判定：轮内第一条 text 且轮内有 ≥2 条 text（node-timeline 构建期标记 isLeadText，
 * 不靠标题文字匹配——主 agent 措辞会漂移：###思考结论 / ###思考结果 实测都出现） */
const isLeadTextNode = computed(() => props.node.kind === "text" && !!props.node.isLeadText);

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
      // 2026-08-10 统一边框：按变体加（text 无边框；subtask 2026-08-10 反馈——边框上移到
      // node-card 层，SubTaskCard 自带边框+margin 造成双重边框与圆点不对齐）
      'node-card--thinking': node.kind === 'thinking',
      'node-card--tool': node.kind === 'tool',
      'node-card--subtask': node.kind === 'subtask',
      // 首 text 节点（思考结果块）：主题色正文，其余与普通 text 一致（结构标记见 isLeadTextNode）
      'node-card--lead-text': isLeadTextNode,
    }"
  >
    <!-- ═══ thinking：标题行（收起态只渲染标题行——流式性能 D17）+ 点击展开全文 ═══ -->
    <template v-if="node.kind === 'thinking'">
      <div class="node-card-head node-card-head--thinking" @click="toggle">
        <span class="node-card-head-left">
          <Brain class="node-card-icon" :size="13" />
          <span class="node-card-label">{{ t('chat.thinkingDone') }}</span>
          <span class="node-card-snippet">{{ snippet }}</span>
        </span>
        <span class="node-card-head-right">
          <span v-if="durationLabel" class="node-card-stat">🧠{{ durationLabel }}</span>
          <span v-if="busy" class="node-card-dots"><i /><i /><i /></span>
          <!-- D5/D6 chevron：可展开节点收起态朝下，展开态朝上 -->
          <ChevronDown class="node-card-chevron" :size="12" :class="{ 'node-card-chevron--up': isExpanded }" />
        </span>
      </div>
      <div v-if="isExpanded" class="node-card-body node-card-body--thinking">{{ node.text }}</div>
    </template>

    <!-- ═══ text / summary：无标题行直接正文（始终展开）；2026-08-10 用户拍板：text 不显示耗时（demo 中耗时只在节点标题行） ═══ -->
    <div v-else-if="node.kind === 'text'" class="node-card-text">
      <!-- D7 总结节点：绿底渐变 + Flag + 总结（视觉强调回合最终产出） -->
      <div v-if="isSummaryNode" class="node-card-summary-head">
        <Flag class="node-card-icon" :size="13" />
        <span class="node-card-label">{{ t('chat.timelineSummary') }}</span>
      </div>
      <!-- 首 text 节点（思考结果块）：无头行，与普通 text 同构（差异仅正文主题色，见 .node-card--lead-text） -->
      <MarkdownRenderer :content="node.text ?? ''" />
    </div>

    <!-- ═══ tool（非 todo）/ todo（2026-08-10：复用 TodoRecordCard 折叠卡——单行「正在：xxx」+ 点击展开 chips 列表，
         样式与回合结束记录节点统一；busy 三连点 / ✓✗ 状态 / 工具耗时 由新 props 透传）═══ -->
    <template v-else-if="node.kind === 'tool' && node.tool">
      <div v-if="isTodo" class="node-card-todo">
        <TodoRecordCard
          :todos="todoItems"
          :ended-at="0"
          embedded
          :title="todoTitle"
          :summary-text="todoSummary"
          :time-text="durationLabel"
          :busy="busy"
          :status="todoStatus"
        />
      </div>

      <!-- 普通工具节点：标题行（icon+工具名+梗概 左 / 状态+耗时+三连点+chevron 右） -->
      <div v-else class="node-card-tool" @click="toggle">
        <div class="node-card-head node-card-head--tool">
          <span class="node-card-head-left">
            <component :is="toolIcon" class="node-card-icon" :size="13" />
            <span class="node-card-tool-name">{{ toolLabel(node.tool.name) }}</span>
            <span class="node-card-snippet">{{ toolSummary(node.tool.name, node.tool.input) }}</span>
          </span>
          <span class="node-card-head-right">
            <span
              v-if="statusMark"
              class="node-card-status"
              :class="{ 'node-card-status--error': node.tool.isError }"
            >{{ statusMark }}</span>
            <span v-if="durationLabel" class="node-card-stat">⚡{{ durationLabel }}</span>
            <span v-if="busy" class="node-card-dots"><i /><i /><i /></span>
            <ChevronDown class="node-card-chevron" :size="12" :class="{ 'node-card-chevron--up': isExpanded }" />
          </span>
        </div>
        <!-- 展开区：input + result -->
        <template v-if="isExpanded">
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
    </template>

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
      <!-- 启动中：task 工具已发出但 serve 尚未下发 sessionId（pending 窗口，taskId 为空）→ 委派提示 -->
      <div v-else-if="!node.taskId" class="node-card-subtask-fallback node-card-subtask-fallback--starting">
        {{ t('chat.subTaskStarting') }}<span class="node-card-subtask-dots"><i /><i /><i /></span>
      </div>
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
  /* D7 总结节点：2026-08-10 反馈——绿底渐变导致内容灰字对比度不足 → 去背景只保留绿色边框，
     内容文字颜色由 .node-card-text 显式加深（下方） */
  border-color: rgba(34, 197, 94, 0.35);
  padding: 2px 10px;
  background: transparent;
}
/* 普通 text 正文默认色：primary（正文常规色）——不用 secondary（浅灰偏弱，2026-08-11 用户反馈）；
   MarkdownRenderer 的 prose 自带 primary（--tw-prose-body），显式声明保证与 lead 节点对比清晰 */
.node-card-text :deep(.markdown-body) {
  color: var(--text-primary);
}
/* 总结正文：加深内容文字（默认 text-secondary 在绿底上偏灰；去底后仍保持强调——
   :deep 穿透 MarkdownRenderer 的 .markdown-body（prose 类自带 color 不随父继承）） */
.node-card--summary .node-card-text {
  color: var(--text-primary);
}
.node-card--summary :deep(.markdown-body) {
  color: var(--text-primary);
}

/* 首 text 节点（思考结果块，2026-08-11 用户拍板）：用主题强调色 accent——暗色主题绿（#34d399）、
   亮色主题蓝（#0ea5e9），随 data-theme 自动切换；与普通正文（primary 灰阶）形成彩色对比 */
.node-card--lead-text .node-card-text,
.node-card--lead-text :deep(.markdown-body) {
  color: var(--accent);
}

/* 2026-08-10 统一边框（用户拍板：除文本节点外，thinking/tool/todo/subtask 统一卡片边框；
   subtask 2026-08-10 反馈：边框从 SubTaskCard 上移——自带边框+margin 导致 busy 双层边框
   且与节点圆点不对齐；text/summary 无边框正文） */
.node-card--thinking,
.node-card--tool,
.node-card--todo,
.node-card--subtask {
  border: 1px solid var(--border-dim);
  border-radius: 6px;
  background: var(--bg-root);
}
/* 思考过程边框：琥珀色（2026-08-10 用户拍板：思考节点边框与标题同色——橘黄）
   rgba 半透明避免纯色过重，与 amber 标题呼应 */
.node-card--thinking {
  border-color: rgba(217, 119, 6, 0.4);
}
/* tool 内部容器不再重复边框（根已提供） */
.node-card--tool .node-card-tool {
  border: none;
  background: transparent;
}
/* subtask 内部 SubTaskCard 去边框/背景/margin（根已提供卡片外观；margin 会破坏与圆点
   对齐——容器 .node-card-subtask 只有 padding 2px 0，卡片贴齐根边框） */
.node-card--subtask :deep(.subtask-card) {
  border: none;
  background: transparent;
  margin: 0;
}

/* 2026-08-10 反馈：todo 节点边框用主题色（与标题/图标呼应——thinking 标题主题色、
   todo 标题主题色 + 边框主题色，节点视觉体系统一） */
.node-card--todo {
  border-color: var(--accent-line);
}

/* ── 标题行（D5 右对齐布局）：左侧 图标+名称+梗概（flex:1 省略） / 右侧 状态区（flex-shrink:0） ── */
.node-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 5px 10px;
  font-size: 11px;
  cursor: pointer;
  user-select: none;
  color: var(--text-secondary);
  transition: background 150ms;
}
.node-card-head:hover { background: rgba(255, 255, 255, 0.03); }
/* 思考过程标题：琥珀色（2026-08-10 用户拍板：思考过程保持原橘黄语义色，仅更新待办用主题色） */
.node-card-head--thinking { color: var(--amber); }
.node-card-head--tool {
  font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace;
}
/* 左侧组：超出省略（梗概 flex:1 接管剩余宽度） */
.node-card-head-left {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1;
}
/* 右侧状态区：状态/耗时/三连点/chevron 固定不压缩，右对齐 */
.node-card-head-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.node-card-tool { border-radius: 6px; background: var(--bg-root); border: 1px solid var(--border-dim); }
.node-card-tool .node-card-head:hover { background: var(--bg-hover); }

.node-card-icon { flex-shrink: 0; }
.node-card-label { font-weight: 600; white-space: nowrap; }
.node-card-tool-name { font-weight: 600; color: var(--violet); white-space: nowrap; }
/* 梗概：text-secondary（比 muted/faint 深一档，可读性反馈 #7）；不用 opacity 叠淡 */
.node-card-snippet {
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 1;
  opacity: 0.85;
}
.node-card-stat { font-size: 10px; color: var(--text-muted); white-space: nowrap; }
.node-card-stat--summary { margin-left: auto; }
.node-card-status { font-size: 10px; color: var(--accent); white-space: nowrap; }
.node-card-status--error { color: var(--coral); }

/* ── 可展开节点 chevron（D5）：收起态朝下，展开态 180° 朝上 ── */
.node-card-chevron {
  flex-shrink: 0;
  color: var(--text-muted);
  transition: transform 200ms;
}
.node-card-chevron--up { transform: rotate(180deg); }

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

/* ── todo 变体（2026-08-10 用户拍板：复用 TodoRecordCard embedded——单行摘要 + 点击展开 chips 列表，
     样式与回合结束记录节点统一；此处仅保留节点容器边距微调） ── */
.node-card-todo {
  border-radius: 6px;
  margin-bottom: 1px;
}
/* 与 thinking/tool 标题行（padding 5px 10px）视觉对齐：TodoRecordCard embedded 默认 0.25rem 0 贴边，
   与相邻节点差距大（2026-08-10 用户反馈样式不一致） */
.node-card--todo :deep(.todo-record-card) {
  padding: 5px 10px;
}
.node-card--todo :deep(.todo-record-card__header) {
  padding: 0;
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
/* 启动中占位：非斜体正常可读 + 三连点脉冲（委派进行中，区别于错误/缺失的不可用态） */
.node-card-subtask-fallback--starting {
  font-style: normal;
  opacity: 0.85;
  display: flex;
  align-items: center;
  gap: 4px;
}
.node-card-subtask-dots { display: inline-flex; gap: 3px; }
.node-card-subtask-dots i {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--text-muted);
  animation: node-card-dot-bounce 1.2s infinite ease-in-out;
}
.node-card-subtask-dots i:nth-child(2) { animation-delay: 0.15s; }
.node-card-subtask-dots i:nth-child(3) { animation-delay: 0.3s; }
@keyframes node-card-dot-bounce {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
  30% { transform: translateY(-3px); opacity: 1; }
}
</style>
