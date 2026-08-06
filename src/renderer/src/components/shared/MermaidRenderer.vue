<script setup lang="ts">
/** Mermaid 图表渲染器——将 Markdown 中的 ```mermaid 代码块转换为 SVG，经 DOMPurify 清洗后展示 */
import { ref, watch, nextTick } from "vue";
import mermaid from "mermaid";
import DOMPurify from "dompurify";

const props = defineProps<{ code: string }>();
const svg = ref("");
const error = ref("");

// 初始化 mermaid：关闭自动渲染（手动调用），strict 安全级别，暗色主题匹配 CC GUI
mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: "dark",
  themeVariables: {
    primaryColor: "#06d6a0",       // --accent
    primaryTextColor: "#c0c0d0",   // --text-secondary
    lineColor: "#2a2a3a",         // --border-dim
    secondaryColor: "#1e1e26",     // --bg-elevated
    tertiaryColor: "#111113",      // --bg-root
  },
});

/** 调用 mermaid.render() 生成 SVG，经 DOMPurify 清洗防 XSS */
async function render() {
  if (!props.code.trim()) return;
  error.value = "";
  try {
    // 每次渲染用唯一 id 避免 mermaid 内部缓存冲突
    const id = "mermaid-" + Math.random().toString(36).slice(2);
    const { svg: result } = await mermaid.render(id, props.code);
    svg.value = DOMPurify.sanitize(result);
  } catch (e: unknown) {
    error.value = (e as Error).message || String(e);
    svg.value = "";
  }
}

// 代码内容变化时重新渲染
watch(() => props.code, async () => {
  await nextTick();
  render();
}, { immediate: true });
</script>

<template>
  <div v-if="svg" class="mermaid-container my-3 flex justify-center" v-html="svg"></div>
  <div v-if="error" class="text-xs p-2 rounded" :style="{ color: 'var(--coral)', background: 'rgba(255,94,91,0.08)' }">
    Mermaid error: {{ error }}
  </div>
</template>
