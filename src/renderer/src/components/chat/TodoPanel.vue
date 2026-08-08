<script setup lang="ts">
import { computed, ref } from "vue";
import { useChatStore, type TodoItem } from "@/stores/chat";

// 折叠态持久化键（sb-* 前缀遵循项目本地存储命名规范；todo 折叠是 UI 瞬态偏好，不进 settings store）
const COLLAPSE_KEY = "sb-todo-collapsed";
const collapsed = ref(localStorage.getItem(COLLAPSE_KEY) === "1");

// 切换展开/折叠并持久化（写入失败仅丢失偏好，不影响交互）
function toggleCollapsed() {
  collapsed.value = !collapsed.value;
  try {
    localStorage.setItem(COLLAPSE_KEY, collapsed.value ? "1" : "0");
  } catch (e) {
    console.error("todo-collapsed 持久化失败:", e);
  }
}

const chat = useChatStore();

// 过滤 deleted，保留原始顺序（cancelled 保留显示但灰掉，仅 deleted 视为已移除）
const visibleTodos = computed(() =>
  chat.todos.filter(t => t.status !== "deleted")
);

const completedCount = computed(() =>
  chat.todos.filter(t => t.status === "completed").length
);

const hasTodos = computed(() => visibleTodos.value.length > 0);

function statusIcon(s: TodoItem["status"]): string {
  switch (s) {
    case "completed": return "☑";
    case "in_progress": return "●";
    case "pending": return "☐";
    case "cancelled": return "✕";
    default: return "";
  }
}
</script>

<template>
  <div class="todo-panel">
    <template v-if="hasTodos">
      <!-- 标题栏整行可点击切换折叠：标题 + 总数徽标 + 完成计数（仅展开时）+ 方向箭头 -->
      <button
        type="button"
        class="todo-panel-header"
        :title="collapsed ? $t('chat.todoExpand') : $t('chat.todoCollapse')"
        :aria-expanded="!collapsed"
        @click="toggleCollapsed"
      >
        <span class="todo-panel-title">📋 {{ $t('chat.todos') }}</span>
        <span class="todo-count-badge">{{ visibleTodos.length }}</span>
        <span v-if="completedCount > 0 && !collapsed" class="todo-count">
          {{ completedCount }}/{{ visibleTodos.length }}
        </span>
        <span class="todo-arrow" :class="{ 'todo-arrow--collapsed': collapsed }">▾</span>
      </button>
      <!-- 列表用 v-if 而非 v-show：折叠时从 DOM 完全卸载（Vue Transition 管理 enter/leave，收起动画结束后移除） -->
      <Transition name="todo-collapse">
        <div v-if="!collapsed" class="todo-panel-list">
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
      </Transition>
    </template>
    <!-- 空态兜底：无可见 todo（含全 deleted 或 v-if 时序）时仍显示提示，防御极端时序 -->
    <div v-else class="todo-panel-empty">{{ $t('chat.noTodos') }}</div>
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
  max-width: 760px;
  width: 100%;
}

/* 标题栏整行可点击：重置 button 默认样式，布局与旧 div 版保持一致（full-width + 左对齐） */
.todo-panel-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.25rem;
  width: 100%;
  padding: 0;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  font: inherit;
  color: inherit;
}

/* 标题栏 hover 反馈：仅提示可点击，不改变布局 */
.todo-panel-header:hover .todo-panel-title {
  color: var(--text-bright);
}

.todo-panel-title {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-muted);
  transition: color 0.15s ease;
}

/* 总数徽标（折叠态也显示）：满足「待办清单 · N」折叠显示需求 */
.todo-count-badge {
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--accent);
}

.todo-count {
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
  opacity: 0.7;
}

/* 方向箭头：右对齐；折叠时 ▾ 旋转 90° 变右指（▸），CSS 变换替代切换字符 */
.todo-arrow {
  margin-left: auto;
  font-size: 10px;
  color: var(--text-muted);
  transition: transform 0.2s ease;
}

.todo-arrow--collapsed {
  transform: rotate(-90deg);
}

/* 折叠动画：max-height 伸缩（chips 行数不定，用足够上限 + overflow hidden 近似高度过渡） */
.todo-collapse-enter-active,
.todo-collapse-leave-active {
  transition: max-height 0.2s ease, opacity 0.2s ease;
  overflow: hidden;
}

.todo-collapse-enter-from,
.todo-collapse-leave-to {
  max-height: 0;
  opacity: 0;
}

.todo-collapse-enter-to,
.todo-collapse-leave-from {
  max-height: 300px;
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

/* 已取消：比已完成更淡的灰 + 删除线，视觉上完全退场 */
.todo-chip--cancelled {
  color: var(--text-muted);
  background: var(--bg-root);
  border-color: transparent;
  text-decoration: line-through;
  opacity: 0.55;
}

.todo-panel-empty {
  font-size: 10px;
  color: var(--text-muted);
  padding: 0.15rem 0;
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
