<script setup lang="ts">
// 历史子任务入口（D1-D6）：重启后/切回旧会话时，已完成子会话在消息级可见。
// 与实时 SubTaskCard 互斥（D3）：本组件只渲染「已完成且不在实时 subTasks」的历史任务。
// 数据来源为 buildSubTaskMap 提取的 task tool part（serve 动态注入 `<task id>` 输出）。
import { ref, computed } from "vue";
import { useI18n } from "vue-i18n";
import type { HistorySubTask } from "@/stores/chat";

const { t } = useI18n();

const props = defineProps<{
  subTasks: HistorySubTask[];
}>();

const emit = defineEmits<{
  (e: "open", subId: string): void;
}>();

/** 展开/收起列表 */
const expanded = ref(false);

/** 徽标映射：agent 名包含匹配（与 SubTaskCard.badgeFor 一致：工匠👷 军师🧭 参谋🧭 侦查兵🕵️ 制图师🎨 其他🤖） */
function badgeFor(name: string): string {
  if (!name) return "🤖";
  if (name.includes("工匠")) return "👷";
  if (name.includes("军师") || name.includes("参谋")) return "🧭";
  if (name.includes("侦查兵") || name.includes("侦察兵")) return "🕵️";
  if (name.includes("制图师")) return "🎨";
  return "🤖";
}

/** 显示标题：去掉 serve 自动追加的 `(@xx subagent)` 后缀 */
function stripSubagentSuffix(title: string): string {
  return title.replace(/\s*\(@[^)]*subagent\)\s*$/i, "");
}

/** 时间 HH:mm（createdAt 为 ms 时间戳） */
function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 时长秒数（endedAt - createdAt；无 endedAt 时显示 0） */
function fmtDuration(s: HistorySubTask): number {
  if (!s.endedAt) return 0;
  return Math.max(0, Math.round((s.endedAt - s.createdAt) / 1000));
}

const badge = computed(() => (props.subTasks.length > 0 ? "🧩" : "🤖"));
</script>

<template>
  <div class="subtask-history">
    <!-- 入口行：展开/收起箭头 + 子任务数 -->
    <button class="subtask-history-toggle" @click="expanded = !expanded">
      <span class="subtask-history-badge">{{ badge }}</span>
      <span class="subtask-history-count">{{ t("chat.subTaskHistoryCount", { n: subTasks.length }) }}</span>
      <span class="flex-1"></span>
      <span class="subtask-history-arrow" :class="{ 'is-open': expanded }">▾</span>
    </button>

    <!-- 展开列表（Transition 淡入/滑入） -->
    <Transition name="subtask-history">
      <div v-if="expanded" class="subtask-history-list">
        <button
          v-for="sub in subTasks"
          :key="sub.id"
          class="subtask-history-item"
          @click="emit('open', sub.id)"
        >
          <span class="subtask-history-badge">{{ badgeFor(sub.agent) }}</span>
          <span class="subtask-history-agent">{{ sub.agent || t("chat.subTaskMonitorTitle") }}</span>
          <span class="subtask-history-title">{{ stripSubagentSuffix(sub.title) }}</span>
          <span class="subtask-history-meta">{{ fmtTime(sub.createdAt) }} · {{ fmtDuration(sub) }}{{ t("chat.subTaskHistoryUnit") }}</span>
        </button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* 工具卡片风格（同 SubTaskCard）：bg-surface/border-dim/radius 6px */
.subtask-history {
  margin: 0.25rem 0;
  font-size: 12px;
}
/* 入口行：整行可点击，hover 高亮 */
.subtask-history-toggle {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.375rem 0.75rem;
  background: var(--bg-surface);
  border: 1px solid var(--border-dim);
  border-radius: 6px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background-color 150ms;
  user-select: none;
}
.subtask-history-toggle:hover {
  background: var(--bg-hover);
}
.subtask-history-badge {
  font-size: 14px;
  line-height: 1;
}
.subtask-history-count {
  font-size: 12px;
  color: var(--text-secondary);
}
/* 箭头旋转：展开态向下打开 */
.subtask-history-arrow {
  font-size: 10px;
  color: var(--text-muted);
  transition: transform 150ms;
}
.subtask-history-arrow.is-open {
  transform: rotate(180deg);
}
/* 展开列表：内嵌卡片，缩进对齐入口行 */
.subtask-history-list {
  margin-top: 0.25rem;
  border: 1px solid var(--border-dim);
  border-radius: 6px;
  overflow: hidden;
}
/* 列表项：徽标 + agent + 标题 + 时间/时长 */
.subtask-history-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.375rem 0.75rem;
  background: var(--bg-surface);
  border: none;
  border-bottom: 1px solid var(--border-dim);
  color: var(--text-secondary);
  text-align: left;
  cursor: pointer;
  transition: background-color 150ms;
}
.subtask-history-item:last-child {
  border-bottom: none;
}
.subtask-history-item:hover {
  background: var(--bg-hover);
}
.subtask-history-agent {
  font-weight: 600;
  color: var(--violet);
  font-size: 12px;
  white-space: nowrap;
}
/* 标题：省略号防溢出 */
.subtask-history-title {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.subtask-history-meta {
  font-size: 10px;
  color: var(--text-muted);
  white-space: nowrap;
}
/* 展开动画 */
.subtask-history-enter-active {
  transition: all 0.2s ease-out;
}
.subtask-history-leave-active {
  transition: all 0.15s ease-in;
}
.subtask-history-enter-from,
.subtask-history-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
