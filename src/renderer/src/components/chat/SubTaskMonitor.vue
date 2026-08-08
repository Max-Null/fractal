<script setup lang="ts">
// 子任务监视弹窗（ModalShell）：运行中实时查看子 agent 的 parts 流（text/thinking/tool）
// 数据源：chat store subTasks[subId]（响应式实时，零轮询）
import { ref, computed, onMounted, onUnmounted } from "vue";
import ModalShell from "@/components/shared/ModalShell.vue";
import { useChatStore } from "@/stores/chat";

const props = defineProps<{ subId: string }>();
const emit = defineEmits<{ close: [] }>();

const chat = useChatStore();
const task = computed(() => chat.subTasks[props.subId]);

// 每秒刷新耗时
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  timer = setInterval(() => { now.value = Date.now(); }, 1000);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
});

const elapsedSec = computed(() => {
  const t = task.value;
  if (!t) return 0;
  const end = t.endedAt ?? now.value;
  return Math.max(0, Math.floor((end - t.startedAt) / 1000));
});

/** 徽标映射（与 SubTaskCard 一致） */
function badgeFor(name: string): string {
  if (!name) return "🤖";
  if (name.includes("工匠")) return "👷";
  if (name.includes("军师") || name.includes("参谋")) return "🧭";
  if (name.includes("侦查兵") || name.includes("侦察兵")) return "🕵️";
  if (name.includes("制图师")) return "🎨";
  return "🤖";
}

const badge = computed(() => badgeFor(task.value?.agent || ""));
</script>

<template>
  <ModalShell :open="true" size="lg" position="top" @close="emit('close')">
    <template #header>
      <span v-if="task" class="monitor-header">
        <span class="monitor-badge">{{ badge }}</span>
        <span class="monitor-agent">{{ task.agent }}</span>
        <span v-if="task.status === 'running'" class="monitor-status monitor-status--running">🔄 运行中 · {{ elapsedSec }}s</span>
        <span v-else class="monitor-status monitor-status--done">✅ 已完成 · {{ elapsedSec }}s</span>
      </span>
    </template>

    <div v-if="!task" class="monitor-empty">—</div>

    <div v-else class="monitor-body">
      <!-- 单 v-for + v-if 链：text/thinking/tool 按原始顺序渲染，避免重复遍历 -->
      <template v-for="(part, i) in task.parts" :key="i">
        <!-- thinking 折叠区 -->
        <details v-if="part.type === 'thinking'" class="monitor-thinking" open>
          <summary class="monitor-thinking-summary">💭 {{ $t('chat.subTaskThinking') }}</summary>
          <div class="monitor-thinking-body">{{ part.text }}</div>
        </details>

        <!-- tool 工具卡片 -->
        <div v-else-if="part.type === 'tool'" class="monitor-tool">
          <span class="monitor-tool-name">🔧 {{ part.tool }}</span>
          <span v-if="part.state" class="monitor-tool-state" :class="{ 'monitor-tool-state--term': ['completed', 'error'].includes(part.state) }">{{ part.state }}</span>
        </div>

        <!-- text 段落 -->
        <p v-else-if="part.type === 'text'" class="monitor-text">{{ part.text }}</p>
      </template>

      <div v-if="task.parts.length === 0" class="monitor-empty">{{ $t('chat.subTaskNoContent') }}</div>
    </div>
  </ModalShell>
</template>

<style scoped>
.monitor-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.monitor-badge {
  font-size: 14px;
  line-height: 1;
}
.monitor-agent {
  font-weight: 600;
  color: var(--violet);
  font-size: 12px;
}
.monitor-status {
  font-size: 10px;
  white-space: nowrap;
}
.monitor-status--running {
  color: var(--accent);
  animation: pulse 1s ease-in-out infinite;
}
.monitor-status--done {
  color: var(--text-muted);
}
.monitor-body {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  max-height: 60vh;
  overflow-y: auto;
}
.monitor-empty {
  color: var(--text-muted);
  font-size: 12px;
}
.monitor-thinking {
  border: 1px solid var(--border-dim);
  border-radius: 6px;
  background: var(--bg-elevated);
}
.monitor-thinking-summary {
  font-size: 11px;
  color: var(--amber);
  padding: 0.4rem 0.6rem;
  cursor: pointer;
  user-select: none;
}
.monitor-thinking-body {
  padding: 0 0.6rem 0.6rem;
  font-size: 11px;
  color: var(--text-secondary);
  white-space: pre-wrap;
}
.monitor-tool {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  border: 1px solid var(--border-dim);
  border-radius: 6px;
  background: var(--bg-surface);
  padding: 0.4rem 0.6rem;
}
.monitor-tool-name {
  font-weight: 600;
  color: var(--violet);
  font-size: 11px;
}
.monitor-tool-state {
  font-size: 10px;
  color: var(--accent);
  white-space: nowrap;
}
.monitor-tool-state--term {
  color: var(--text-muted);
}
.monitor-text {
  margin: 0;
  font-size: 12px;
  color: var(--text-primary);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
