<script setup lang="ts">
/** 子组件异常捕获容器——onErrorCaptured 拦截渲染错误，展示错误信息 + 重试按钮，防止单组件崩溃波及整个页面 */
import { ref, onErrorCaptured } from "vue";

defineProps<{ name?: string }>();

const error = ref<string | null>(null);
const ready = ref(true);

// 捕获子组件渲染时的异常，return false 阻止向更上层传播
onErrorCaptured((err) => {
  error.value = String(err);
  ready.value = false;
  return false;
});

/** 重置错误状态重新渲染子组件 */
function retry() {
  error.value = null;
  ready.value = true;
}
</script>

<template>
  <div v-if="error" class="flex items-center justify-center p-8">
    <div class="text-center max-w-sm">
      <div class="text-sm font-medium mb-2" style="color: var(--coral)">
        {{ name || 'Component' }} Error
      </div>
      <pre class="text-[11px] mb-4 p-3 rounded-lg text-left max-h-32 overflow-y-auto" style="background:var(--bg-root); color:var(--text-muted); border:1px solid var(--border-dim)">{{ error }}</pre>
      <button
        @click="retry"
        class="px-4 py-1.5 rounded-md text-xs font-medium transition-colors"
        style="background:var(--accent-dim); color:white"
        >{{ $t('error.retry') }}</button>
    </div>
  </div>
  <slot v-else-if="ready" />
</template>
