<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { useChatStore, type TodoItem } from "@/stores/chat";

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
    case "completed": return "✓"; // 完成：对勾 + 主题蓝（规格 D5，原 ☑ 换 ✓ 语义更清晰）
    case "in_progress": return "●";
    case "pending": return "☐";
    case "cancelled": return "✕";
    default: return "";
  }
}

/** 序号转圆圈数字（1-20 有 unicode，超出回退普通数字——todo 列表理论上可超 20） */
function toCircled(n: number): string {
  if (n >= 1 && n <= 20) return "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳"[n - 1];
  return String(n);
}

// ── hover 展开/收起（D4）：mouseenter 展开 / mouseleave 收起；删除原点击 toggle ──
// 注意：声明必须在 watch 之前——immediate watch 在 setup 同步执行，TDZ 引用会 ReferenceError
const hoverExpanded = ref(false);

// ── 自动展开（D2）：生成/真实变化 → 展开 15s 后收起 ──
const AUTO_EXPAND_MS = 15_000;
const autoExpanded = ref(false);
let autoTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => chat.todos,
  (newVal, oldVal) => {
    // 内容级检测：JSON 序列化对比——引擎重复全量 TodoWrite（内容未变）不触发展开
    const changed = JSON.stringify(newVal) !== JSON.stringify(oldVal);
    if (!changed) return;
    // 不续期：展开期间的变化不重置计时（避免引擎频繁 TodoWrite 导致面板永不收起——用户反馈「15s 收起效果没了」）
    // 收起状态下的真实变化才重新展开 15s
    if (!autoExpanded.value && !hoverExpanded.value) {
      autoExpanded.value = true;
      if (autoTimer) clearTimeout(autoTimer);
      autoTimer = setTimeout(() => {
        autoExpanded.value = false;
      }, AUTO_EXPAND_MS);
    }
  },
  // immediate：首建 todo 时组件才挂载（v-if），watch 注册晚于变化——立即触发才能捕捉「建立待办列表」这一下
  { deep: true, immediate: true },
);
onUnmounted(() => {
  // 组件卸载后清理计时器（防止泄漏：chat.todos 后续变化不再触发本组件）
  if (autoTimer) clearTimeout(autoTimer);
});

// expanded = autoExpanded || hoverExpanded（D3：15s 到点鼠标仍在面板内 → hover 保持展开）
const expanded = computed(() => autoExpanded.value || hoverExpanded.value);

// ── 折叠态当前项（D1）：第一个 in_progress，无则第一 pending；序号 = visibleTodos 中 index+1 ──
const currentTodo = computed(() => {
  if (visibleTodos.value.length === 0) return null;
  return (
    visibleTodos.value.find(t => t.status === "in_progress")
    ?? visibleTodos.value.find(t => t.status === "pending")
    ?? null
  );
});
const currentTodoIndex = computed(() => {
  if (!currentTodo.value) return 0;
  return visibleTodos.value.indexOf(currentTodo.value) + 1;
});
// 折叠态文案：内容取 activeForm || content（activeForm 是 CC 动词化形式，如「列出 docs 目录结构」）
const currentTodoLabel = computed(() => {
  const t = currentTodo.value;
  if (!t) return "";
  return t.activeForm || t.content;
});

// ── 面板隐藏（D10 v2）：全部 completed/cancelled → 面板隐藏，记录卡替代 ──
// v2 去快照依赖：记录卡从消息工具卡提取（消息流 watch 刷新），面板只由 todos 状态驱动——
// 新回合 TodoWrite（出现 pending/in_progress）→ 面板重新显示（todos 变化天然驱动）
const hidePanel = computed(() => {
  if (visibleTodos.value.length === 0) return false;
  const allFinished = visibleTodos.value.every(t => t.status === "completed" || t.status === "cancelled");
  return allFinished;
});
</script>

<template>
  <div
    v-if="!hidePanel"
    class="todo-panel"
    @mouseenter="hoverExpanded = true"
    @mouseleave="hoverExpanded = false"
  >
    <template v-if="hasTodos">
      <!-- 折叠态：一行「📋 ● ②/ ④ 内容」+ 完成计数（hover 展开；无点击切换） -->
      <div v-if="!expanded" class="todo-panel-collapsed">
        <span class="todo-panel-title">📋</span>
        <!-- 进行中任务带呼吸蓝点（当前项强调，pending 时不显示） -->
        <span v-if="currentTodo?.status === 'in_progress'" class="todo-current-dot">●</span>
        <span v-if="currentTodo" class="todo-current">
          {{ toCircled(currentTodoIndex) }}<span class="todo-current-sep">/</span>{{ toCircled(visibleTodos.length) }}
        </span>
        <span v-else class="todo-current">{{ $t('chat.todos') }}</span>
        <span class="todo-current-text">{{ currentTodoLabel }}</span>
        <span v-if="completedCount > 0" class="todo-count">
          {{ completedCount }}/{{ visibleTodos.length }} ✓
        </span>
      </div>
      <!-- 展开态：标题 + 列表（hover 在场保持；离开收起） -->
      <template v-else>
        <div class="todo-panel-header">
          <span class="todo-panel-title">📋 {{ $t('chat.todos') }}</span>
          <span class="todo-count-badge">{{ visibleTodos.length }}</span>
          <span v-if="completedCount > 0" class="todo-count">
            {{ completedCount }}/{{ visibleTodos.length }} ✓
          </span>
        </div>
        <!-- 列表用 v-if 而非 v-show：折叠时从 DOM 完全卸载（Vue Transition 管理 enter/leave，收起动画结束后移除） -->
        <Transition name="todo-collapse">
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
              <span class="todo-chip-text">{{ t.activeForm || t.content }}</span>
            </div>
          </div>
        </Transition>
      </template>
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

/* 折叠态单行：图标 + 序号 + 内容 + 计数；hover 整块展开（无点击交互）
   2026-08-10 反馈：收起态文字水平居中（原 flex-start 左对齐，面板居中但内容贴左）；
   垂直居中需 line-height:1——emoji/序号字符自带行高，继承全局 line-height 会撑高整行导致视觉偏上 */
.todo-panel-collapsed {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  min-height: 1.1rem;
  line-height: 1;
  cursor: default;
  /* 淡蓝底增强存在感：收起时当前任务一眼可见（用户反馈「进行中的任务很不明显」） */
  background: color-mix(in srgb, var(--accent) 6%, transparent);
  border-radius: 0.25rem;
  padding: 0.15rem 0.4rem;
}

/* 折叠态进行中呼吸蓝点（当前项状态提示，pending 时不渲染） */
.todo-current-dot {
  font-size: 0.571rem;
  line-height: 1;
  color: var(--accent);
  flex-shrink: 0;
  animation: todo-pulse 1.5s ease-in-out infinite;
}

.todo-panel-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.25rem;
  width: 100%;
  padding: 0;
  cursor: default;
}

/* 折叠态单行 📋 图标（emoji 自带行高，显式 line-height:1 避免撑高整行） */
.todo-panel-title {
  font-size: 0.714rem;
  font-weight: 600;
  line-height: 1;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-muted);
  transition: color 0.15s ease;
}

/* 总数徽标（展开态标题） */
.todo-count-badge {
  font-size: 0.714rem;
  font-variant-numeric: tabular-nums;
  color: var(--accent);
}

/* 进度数字：主题蓝 + 700（用户反馈「1/4 用灰色不明显」——完成进度是正向反馈，用 accent 强调） */
.todo-count {
  font-size: 0.714rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  color: var(--accent);
}

/* 折叠态序号「②/ ④」：accent 强调当前项位置 */
.todo-current {
  font-size: 0.714rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  color: var(--accent);
  flex-shrink: 0;
}

.todo-current-sep {
  opacity: 0.5;
}

/* 折叠态当前任务文案：主题蓝 + 600（用户反馈「收起时进行中的任务很不明显」——用 accent 强调当前项） */
.todo-current-text {
  font-size: 0.714rem;
  font-weight: 600;
  line-height: 1;
  color: var(--accent);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
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
  font-size: 0.714rem;
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

/* 进行中：主题蓝 + 虚线边框 + 8% 蓝底（视觉上「正在跑」的强调层） */
.todo-chip--in_progress {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  border: 1px dashed var(--accent);
}

/* 已完成：主题蓝 + 对勾图标，不划掉（规格 D5：完成 ≠ 退场，用蓝色正向反馈） */
.todo-chip--completed {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  border-color: color-mix(in srgb, var(--accent) 25%, transparent);
  text-decoration: none;
}

/* 已取消：比已完成更淡的灰 + 删除线，视觉上完全退场（现状保留） */
.todo-chip--cancelled {
  color: var(--text-muted);
  background: var(--bg-root);
  border-color: transparent;
  text-decoration: line-through;
  opacity: 0.55;
}

.todo-panel-empty {
  font-size: 0.714rem;
  color: var(--text-muted);
  padding: 0.15rem 0;
}

.todo-chip-num {
  flex-shrink: 0;
  font-size: 0.571rem;
  color: var(--text-muted);
  opacity: 0.5;
  min-width: 1em;
}

.todo-chip-status {
  flex-shrink: 0;
  font-size: 0.571rem;
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
