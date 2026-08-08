<script setup lang="ts">
import { computed, ref } from "vue";
import type { TodoSnapshot } from "@/lib/electron-bridge";

// 待办回合记录卡（D9）：一轮全完成后的固化快照；默认折叠，点击展开明细
// 折叠状态独立（本地 ref，不与其他卡片联动）——恢复历史时逐卡独立开关
const props = defineProps<{ snapshot: TodoSnapshot }>();

const expanded = ref(false);

// 完成数 = completed + cancelled（cancelled 在记录中视同「处理完毕」，灰色退场）
const doneCount = computed(
  () => props.snapshot.todos.filter(t => t.status === "completed" || t.status === "cancelled").length
);

// 回合结束时间 → HH:mm（会话多为短时轮次，不跨天，不显示日期）
const timeLabel = computed(() => {
  const d = new Date(props.snapshot.endedAt);
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
  <div class="todo-record-card">
    <!-- 折叠摘要：📋 待办 n/m 完成 · HH:mm（点击展开/收起；aria-expanded 供测试与辅助技术） -->
    <button
      type="button"
      class="todo-record-card__header"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <span class="todo-record-card__icon">📋</span>
      <span class="todo-record-card__title">{{ $t('chat.todoRecord') }}</span>
      <span class="todo-record-card__count">
        {{ doneCount }}/{{ snapshot.todos.length }} {{ $t('chat.todoRecordDone') }}
      </span>
      <span class="todo-record-card__time">{{ timeLabel }}</span>
      <span class="todo-record-card__arrow" :class="{ 'todo-record-card__arrow--expanded': expanded }">▾</span>
    </button>
    <!-- 展开明细：completed ✓ 主题蓝 / cancelled ✕ 灰；样式复用 todo-chip 体系（scoped 局部） -->
    <div v-if="expanded" class="todo-record-card__list">
      <div
        v-for="(t, i) in snapshot.todos"
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

.todo-record-card__icon {
  font-size: 10px;
  flex-shrink: 0;
}

.todo-record-card__title {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-muted);
  flex-shrink: 0;
}

.todo-record-card__count {
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--accent);
  flex-shrink: 0;
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
