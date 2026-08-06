<script setup lang="ts">
import { computed, watch, ref, nextTick, defineAsyncComponent } from "vue";
import { useHighlight } from "@/composables/useHighlight";
import { marked, type Token } from "marked";

const MermaidRenderer = defineAsyncComponent(() => import("./MermaidRenderer.vue"));

/** 标题文本 → URL 安全 id（中英文兼容） */
function slug(text: string): string {
  return text.toLowerCase().replace(/[^\w一-鿿]+/g, "-").replace(/^-|-$/g, "");
}

marked.use({
  renderer: {
    // 标题添加 id 锚点，保留内联格式（bold/code 等）
    heading(token: { depth: number; text: string; tokens: Token[] }) {
      // marked re-exports Token but vue-tsc doesn't resolve it; cast at call site
      const rendered = this.parser.parseInline(token.tokens as Parameters<typeof this.parser.parseInline>[0]);
      return `<h${token.depth} id="${slug(token.text)}">${rendered}</h${token.depth}>`;
    },
    // 转义原始 HTML 防 XSS（不影响 marked 自身生成的标签）
    html(token: { text?: string; raw?: string }) {
      const t = token.text || token.raw || "";
      return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    },
  },
});

const props = defineProps<{ content: string }>();
const { highlight } = useHighlight();
const container = ref<HTMLElement | null>(null);

interface Block {
  type: "markdown" | "mermaid";
  content: string;
}

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const regex = /```mermaid\n([\s\S]*?)```/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      blocks.push({ type: "markdown", content: text.slice(lastIdx, match.index) });
    }
    blocks.push({ type: "mermaid", content: match[1].trim() });
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < text.length) {
    blocks.push({ type: "markdown", content: text.slice(lastIdx) });
  }
  return blocks.length > 0 ? blocks : [{ type: "markdown", content: text }];
}

/** GFM 规范 Markdown → HTML */
function renderMarkdown(text: string): string {
  return marked.parse(text, { async: false }) as string;
}

const blocks = computed(() => parseBlocks(props.content));

/** 拦截链接点击，用默认浏览器打开 */
async function onLinkClick(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest("a");
  if (!a) return;
  const href = a.getAttribute("href");
  if (!href) return;
  e.preventDefault();
  // 主进程 setWindowOpenHandler 已拦截 window.open → shell.openExternal，走系统默认浏览器
  window.open(href, "_blank");
}

watch(() => props.content, async () => {
  await nextTick();
  highlight(container.value);
});
</script>

<template>
  <div ref="container" class="markdown-body" @click="onLinkClick">
    <template v-for="(block, idx) in blocks" :key="idx">
      <div v-if="block.type === 'markdown'" v-html="renderMarkdown(block.content)"></div>
      <MermaidRenderer v-else :code="block.content" />
    </template>
  </div>
</template>

<style scoped>
.markdown-body :deep(p) { margin: 0.25em 0; line-height: 1.65; }
.markdown-body :deep(p:first-child) { margin-top: 0; }
.markdown-body :deep(p:last-child) { margin-bottom: 0; }
.markdown-body :deep(h1) { font-size: 1.25em; font-weight: 700; margin: 0.75em 0 0.4em; color: var(--text-bright); }
.markdown-body :deep(h2) { font-size: 1.1em; font-weight: 600; margin: 0.65em 0 0.3em; color: var(--text-bright); }
.markdown-body :deep(h3) { font-size: 1em; font-weight: 600; margin: 0.5em 0 0.25em; color: var(--text-bright); }
.markdown-body :deep(h4) { font-size: 0.95em; font-weight: 600; margin: 0.45em 0 0.2em; color: var(--text-primary); }
.markdown-body :deep(h5) { font-size: 0.9em; font-weight: 500; margin: 0.4em 0 0.2em; color: var(--text-primary); }
.markdown-body :deep(h6) { font-size: 0.85em; font-weight: 500; margin: 0.35em 0 0.15em; color: var(--text-secondary); }
.markdown-body :deep(strong) { color: var(--text-bright); font-weight: 600; }
.markdown-body :deep(em) { color: var(--text-secondary); }
.markdown-body :deep(ul), .markdown-body :deep(ol) { margin: 0.35em 0; padding-left: 1.5em; }
.markdown-body :deep(li) { margin: 0.12em 0; line-height: 1.55; }
.markdown-body :deep(ul) { list-style-type: disc; }
.markdown-body :deep(ol) { list-style-type: decimal; }
.markdown-body :deep(blockquote) { margin: 0.5em 0; padding: 0.3em 1em; border-left: 2px solid var(--border-bright); color: var(--text-secondary); font-style: italic; }
.markdown-body :deep(code) { font-family: var(--font-mono); font-size: 0.85em; background: var(--bg-hover); padding: 0.12em 0.35em; border-radius: 3px; }
.markdown-body :deep(pre) { margin: 0.5em 0; overflow-x: auto; }
.markdown-body :deep(pre code) { background: transparent; padding: 0; white-space: pre-wrap; word-break: break-word; }
.markdown-body :deep(hr) { margin: 0.75em 0; border: none; border-top: 1px solid var(--border-dim); }
.markdown-body :deep(table) { width: 100%; border-collapse: collapse; margin: 0.5em 0; font-size: 0.9em; }
.markdown-body :deep(th) { background: var(--bg-hover); text-align: left; padding: 0.4em 0.8em; border: 1px solid var(--border-dim); font-weight: 600; color: var(--text-bright); }
.markdown-body :deep(td) { padding: 0.3em 0.8em; border: 1px solid var(--border-dim); color: var(--text-primary); }
.markdown-body :deep(a) { color: var(--accent); text-decoration: none; }
.markdown-body :deep(a:hover) { text-decoration: underline; }
.markdown-body :deep(del) { text-decoration: line-through; color: var(--text-muted); }
.markdown-body :deep(img) { max-width: 100%; border-radius: 4px; }
.markdown-body :deep(li input[type=checkbox]) { margin-right: 0.4em; accent-color: var(--accent); cursor: default; }
</style>
