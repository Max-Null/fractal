<script setup lang="ts">
import { computed } from "vue";
import { useChatStore, type TodoItem } from "@/stores/chat";

const chat = useChatStore();

// 过滤 deleted，保留原始顺序（pending / in_progress / completed 按 CC 产出顺序排列）
const visibleTodos = computed(() =>
  chat.todos.filter(t => t.status !== "deleted")
);

const completedCount = computed(() =>
  chat.todos.filter(t => t.status === "completed").length
);

const hasTodos = computed(() => visibleTodos.value.length > 0);

function statusIcon(s: TodoItem["status"]): string {
  switch (s) {
    case "completed": return "✓";
    case "in_progress": return "●";
    case "pending": return "○";
    default: return "";
  }
}
</script>

<template>
  <div v-if="hasTodos" class="todo-panel">
    <div class="todo-panel-header">
      <span class="todo-panel-title">📋 {{ $t('chat.todos') }}</span>
      <span v-if="completedCount > 0" class="todo-count">
        {{ completedCount }}/{{ visibleTodos.length }}
      </span>
    </div>
    <div class="todo-panel-list">
      <div
        v-for="(t, i) in visibleTodos"
        :key="i"
        class="todo-chip"
        :class="`todo-chip--${t.status}`"
        :title="t.content"
      >
        <span class="todo-chip-num">{{ i + 1 }}</span>
        <span class="todo-chip-status">{{ statusIcon(t.status) }}</span>
        <span class="todo-chip-text">{{ t.status === 'in_progress' ? t.activeForm || t.content : t.content }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.todo-panel {
  padding: 0.375rem 0.75rem;
  margin: 0 auto 0.25rem;
  background: var(--bg-elevated);
  border: 1px solid var(--border-dim);
  border-radius: 0.375rem;
  user-select: none;
  max-width: 48rem;
  width: 100%;
}

.todo-panel-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.25rem;
}

.todo-panel-title {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-muted);
}

.todo-count {
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--accent);
}

.todo-panel-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}

.todo-chip {
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

.todo-chip--pending {
  color: var(--text-muted);
  background: var(--bg-root);
}

.todo-chip--in_progress {
  color: var(--accent);
  background: var(--accent-glow);
  border-color: var(--accent-dim);
}

/* 已完成：同色背景 + 删除线——与待处理（普通文字）和进行中（accent 高亮）形成三种视觉层级 */
.todo-chip--completed {
  color: var(--text-muted);
  background: var(--bg-root);
  border-color: transparent;
  text-decoration: line-through;
}

.todo-chip-num {
  flex-shrink: 0;
  font-size: 8px;
  color: var(--text-muted);
  opacity: 0.5;
  min-width: 1em;
}

.todo-chip-status {
  flex-shrink: 0;
  font-size: 8px;
}

.todo-chip--in_progress .todo-chip-status {
  animation: todo-pulse 1.5s ease-in-out infinite;
}

@keyframes todo-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.todo-chip-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
