<script setup lang="ts">
import { computed } from "vue";
import { useChatStore } from "@/stores/chat";
import { useSettingsStore } from "@/stores/settings";
import { formatNum } from "@/lib/utils";

defineEmits<{ click: [] }>();

const chat = useChatStore();
const settings = useSettingsStore();

// 模型上下文窗口大小（tokens）
// DeepSeek v4 系列支持 1M 上下文，模型名中的 [1M] 后缀也明确标注
// Claude 模型为 200k
const contextLimits: Record<string, number> = {
  "deepseek-v4-pro": 1_000_000,
  "deepseek-v4": 1_000_000,
  "deepseek-v4-flash": 128_000,
  "claude-sonnet-4-6": 200_000,
  "claude-opus-4-8": 200_000,
  "claude-haiku-4-5": 200_000,
};

const limit = computed(() => {
  // 手动设置优先
  if (settings.contextLimit > 0) return settings.contextLimit;
  // 模型名中的 [1M] / [1m] 后缀直接指示 1M 上下文
  const modelLower = settings.model.toLowerCase();
  if (modelLower.includes("[1m]") || modelLower.includes("[1M]")) {
    return 1_000_000;
  }
  for (const [key, val] of Object.entries(contextLimits)) {
    if (modelLower.includes(key)) return val;
  }
  return 128_000; // 默认保守值
});

const usedTokens = computed(() => {
  let total = 0;
  for (const msg of chat.messages) {
    total += msg.inputTokens || 0;
    total += msg.outputTokens || 0;
  }
  return total;
});

const pct = computed(() => Math.min(100, Math.round((usedTokens.value / limit.value) * 100)));

const statusColor = computed(() => {
  if (pct.value >= 90) return "var(--coral)";
  if (pct.value >= 75) return "var(--amber)";
  return "var(--accent)";
});

const tooltip = computed(() =>
  `${formatNum(usedTokens.value)} / ${formatNum(limit.value)} tokens (${pct.value}%)`
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
  font-size: 10px;
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
