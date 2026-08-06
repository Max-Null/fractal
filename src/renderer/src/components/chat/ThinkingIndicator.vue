<script setup lang="ts">
/** CC 思考中占位指示器——逐字波动的 "Thinking…" 动画，或在工具执行时显示工具名 */
defineProps<{ toolName?: string }>();
</script>

<template>
  <div class="text-xs select-none" style="color: var(--accent); opacity: 0.9">
    <span v-if="toolName">— ⚡ {{ toolName }} —</span>
    <span v-else class="inline-flex">
      —&nbsp;<span v-for="(c, i) in $t('chat.thinking')" :key="i" class="tl-wave-char" :style="{ animationDelay: i * 0.15 + 's' }">{{ c }}</span>&nbsp;—
    </span>
  </div>
</template>

<style scoped>
.tl-wave-char {
  animation: think-wave 1.2s ease-in-out infinite;
}
@keyframes think-wave {
  0%, 100% { opacity: 0.2; }
  50% { opacity: 1; }
}
</style>
