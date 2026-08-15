<script setup lang="ts">
import { computed } from "vue";
import { useChatStore } from "@/stores/chat";
import { formatNum } from "@/lib/utils";
import { useContextUsage, contextStatusColor } from "@/composables/useContextUsage";

defineEmits<{ click: [] }>();

const chat = useChatStore();

// 上下文占用统一口径（useContextUsage：最后消息 input+cacheRead+cacheWrite + 固定开销）
// 2026-08-15 修复：此前只算 inputTokens 且无固定开销（弹窗显示 9% 工具栏 1%），与弹窗分叉——
// 现两组件共用同一计算，数字一致
const { limit, totalUsed, pctRounded } = useContextUsage();

const pct = computed(() => pctRounded.value);
const statusColor = computed(() => contextStatusColor(pct.value));

const tooltip = computed(() =>
  `${formatNum(totalUsed.value)} / ${formatNum(limit.value)} tokens (${pct.value}%)`
);

// Progress bar segments
const barSegments = 10;
</script>

<template>
  <div
    v-if="chat.messages.length > 0"
    class="context-indicator"
    :title="tooltip"
    @click="$emit('click')"
  >
    <!-- Mini progress bar -->
    <div class="context-bar">
      <div
        v-for="i in barSegments"
        :key="i"
        class="context-bar-segment"
        :style="{
          height: (i / barSegments) * 10 + 'px',
          background: i <= Math.round(pct / (100 / barSegments)) ? statusColor : 'var(--border-dim)',
          opacity: i <= Math.round(pct / (100 / barSegments)) ? 1 : 0.4,
        }"
      ></div>
    </div>
    <!-- Label -->
    <span class="context-pct" :style="{ color: statusColor }">
      {{ pct }}%
    </span>
  </div>
</template>

<style scoped>
.context-indicator {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.714rem;
  flex-shrink: 0;
  cursor: pointer;
  color: var(--text-muted);
}
.context-bar {
  display: flex;
  gap: 1px;
  align-items: flex-end;
  height: 10px;
}
.context-bar-segment {
  width: 4px;
  border-radius: 2px;
  transition: background-color 150ms, opacity 150ms;
}
.context-pct {
  font-variant-numeric: tabular-nums;
}
</style>
