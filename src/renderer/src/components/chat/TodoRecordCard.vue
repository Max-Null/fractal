<script setup lang="ts">
import { computed, ref } from "vue";
import { ListTodo, ChevronDown } from "lucide-vue-next";
import type { TodoItem } from "@/stores/chat";

// 待办回合记录卡（D9）：从 serve 消息历史 todowrite 工具卡提取的数据（v2，替代 v1 快照）；默认折叠，点击展开明细
// 折叠状态独立（本地 ref，不与其他卡片联动）——恢复历史时逐卡独立开关
// embedded：时间线结束节点内嵌模式（3b 反馈 #6）——去除独立卡片 max-width/背景，融入节点卡样式
// 2026-08-10 变体化（用户拍板）：todo 更新节点复用本组件（title/summaryText/timeText 覆盖默认摘要行；
//   busy 进行中三连点 / status 完成标记）——时间线内所有待办卡视觉统一
const props = defineProps<{
  endedAt: number;
  todos: TodoItem[];
  embedded?: boolean;
  /** 标题覆盖（默认「待办记录」；todo 更新节点传「更新待办」） */
  title?: string;
  /** 摘要文本覆盖（默认「n/m 完成」；todo 更新节点传「正在：<进行中任务>」） */
  summaryText?: string;
  /** 时间文本覆盖（默认 endedAt → HH:mm；todo 更新节点传工具耗时如 0.3s） */
  timeText?: string;
  /** 进行中态：header 渲染三连点跳动（流式 todowrite 执行中） */
  busy?: boolean;
  /** 完成态标记：ok=✓ / error=✗（todo 工具完成/出错） */
  status?: "ok" | "error";
}>();

const expanded = ref(false);

// 完成数 = completed + cancelled（cancelled 在记录中视同「处理完毕」，灰色退场）
const doneCount = computed(
  () => props.todos.filter(t => t.status === "completed" || t.status === "cancelled").length
);

// 回合结束时间 → HH:mm（会话多为短时轮次，不跨天，不显示日期）；endedAt 缺失（0）→ '--:--'
const timeLabel = computed(() => {
  if (!props.endedAt) return "--:--";
  const d = new Date(props.endedAt);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
});

function statusIcon(s: string): string {
  switch (s) {
    case "completed": return "✓";
    case "cancelled": return "✕";
    default: return "☐";
  }
}
</script>

<template>
  <div class="todo-record-card" :class="{ 'todo-record-card--embedded': embedded }">
    <!-- 折叠摘要：图标 + 标题 + 摘要（默认「n/m 完成」，可覆盖「正在：xxx」）+ 状态标记 + 三连点(busy) + 时间 + ▾
         （点击展开/收起；aria-expanded 供测试与辅助技术） -->
    <button
      type="button"
      class="todo-record-card__header"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <ListTodo class="todo-record-card__icon" :size="12" />
      <span class="todo-record-card__title">{{ title ?? $t('chat.todoRecord') }}</span>
      <span v-if="summaryText" class="todo-record-card__summary">{{ summaryText }}</span>
      <span v-else class="todo-record-card__count">
        {{ doneCount }}/{{ todos.length }} {{ $t('chat.todoRecordDone') }}
      </span>
      <!-- 完成/出错态标记；busy 进行中不显示（避免「正在执行 + ✓」语义冲突，制图师截图反馈） -->
      <span
        v-if="status && !busy"
        class="todo-record-card__status"
        :class="{ 'todo-record-card__status--error': status === 'error' }"
      >{{ status === "ok" ? "✓" : "✗" }}</span>
      <span v-if="busy" class="todo-record-card__dots"><i /><i /><i /></span>
      <span class="todo-record-card__time">{{ timeText ?? timeLabel }}</span>
      <!-- 展开箭头与其他节点一致（lucide ChevronDown，2026-08-10 反馈：原 ▾ 文本与 NodeCard chevron 不一致） -->
      <ChevronDown class="todo-record-card__arrow" :size="12" :class="{ 'todo-record-card__arrow--expanded': expanded }" />
    </button>
    <!-- 展开明细：completed ✓ 主题蓝 / cancelled ✕ 灰；样式复用 todo-chip 体系（scoped 局部） -->
    <div v-if="expanded" class="todo-record-card__list">
      <div
        v-for="(t, i) in todos"
        :key="i"
        class="todo-record-chip"
        :class="`todo-record-chip--${t.status}`"
      >
        <span class="todo-record-chip__status">{{ statusIcon(t.status) }}</span>
        <span class="todo-record-chip__text">{{ t.content }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.todo-record-card {
  padding: 0.25rem 0.75rem;
  margin: 0 auto 0.25rem;
  background: var(--bg-elevated);
  border: 1px solid var(--border-dim);
  border-radius: 0.375rem;
  user-select: none;
  max-width: 760px;
  width: 100%;
}

/* 时间线结束节点内嵌模式（反馈 #6）：去掉独立卡片 max-width/居中边距/背景，由节点容器统一时间线样式 */
.todo-record-card--embedded {
  margin: 0;
  max-width: none;
  background: transparent;
  border: none;
  border-radius: 0;
  padding: 0.25rem 0;
}

/* 折叠摘要整行可点击：重置 button 默认样式（full-width + 左对齐） */
.todo-record-card__header {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  width: 100%;
  padding: 0.125rem 0;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  font: inherit;
  color: inherit;
}

/* 图标：lucide ListTodo（2026-08-10 反馈：原 📋 emoji 与 NodeCard lucide 体系不一致） */
.todo-record-card__icon {
  color: var(--accent);
  flex-shrink: 0;
}

/* 标题：与 NodeCard thinking 标题（node-card-label）同规格——11px/600/主题色
   （2026-08-10 反馈：原 10px muted 与思考过程标题不一致） */
.todo-record-card__title {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
  flex-shrink: 0;
}

.todo-record-card__count {
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--accent);
  flex-shrink: 0;
}

/* 摘要覆盖（todo 更新节点「正在：xxx」）：accent 强调进行中任务，省略超长 */
.todo-record-card__summary {
  font-size: 10px;
  color: var(--accent);
  flex-shrink: 0;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 完成态标记：ok ✓ 绿 / error ✗ 珊瑚（与时间线节点状态一致） */
.todo-record-card__status {
  font-size: 10px;
  color: var(--accent);
  flex-shrink: 0;
}
.todo-record-card__status--error {
  color: var(--coral);
}

/* busy 三连点（进行中：依次亮起上跳，与 NodeCard dots 同动画） */
.todo-record-card__dots {
  display: inline-flex;
  gap: 2px;
  align-items: flex-end;
  flex-shrink: 0;
}
.todo-record-card__dots i {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--amber);
  animation: todo-dot-bounce 1.2s ease-in-out infinite;
}
.todo-record-card__dots i:nth-child(2) { animation-delay: 0.15s; }
.todo-record-card__dots i:nth-child(3) { animation-delay: 0.3s; }
@keyframes todo-dot-bounce {
  0%, 100% { opacity: 0.25; transform: translateY(0); }
  50% { opacity: 1; transform: translateY(-2px); }
}

.todo-record-card__time {
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
  opacity: 0.7;
  flex-shrink: 0;
}

/* 箭头右对齐；展开时旋转 180° */
.todo-record-card__arrow {
  margin-left: auto;
  font-size: 10px;
  color: var(--text-muted);
  transition: transform 0.2s ease;
}

.todo-record-card__arrow--expanded {
  transform: rotate(180deg);
}

.todo-record-card__list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  padding: 0.25rem 0 0.125rem;
}

/* 明细 chip：与 TodoPanel 的 todo-chip 同体系（完成蓝 / 取消灰删线） */
.todo-record-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
  font-size: 10px;
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  border: 1px solid var(--border-dim);
}

/* 进行中 chip：主题色字 + 白底 + 主题色虚线边框（2026-08-10 反馈：原无 in_progress 专属样式，
   落到默认灰边框不可辨识；虚线 = 进行中语义，与完成/取消的实线区分） */
.todo-record-chip--in_progress {
  color: var(--accent);
  background: var(--bg-surface);
  border: 1px dashed var(--accent-line);
  animation: todo-chip-pulse 1.6s ease-in-out infinite;
}
@keyframes todo-chip-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.75; }
}

.todo-record-chip--completed {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  border-color: color-mix(in srgb, var(--accent) 25%, transparent);
  text-decoration: none;
}

.todo-record-chip--cancelled {
  color: var(--text-muted);
  background: var(--bg-root);
  border-color: transparent;
  text-decoration: line-through;
  opacity: 0.55;
}

.todo-record-chip__status {
  flex-shrink: 0;
  font-size: 8px;
}

.todo-record-chip__text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
