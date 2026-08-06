<script setup lang="ts">
/** 聊天输入栏——多行输入 + 拖放文件 + / 命令补全 + Enter/Shift+Enter 发送换行 */
import { ref, computed, nextTick } from "vue";
import { optimizePrompt } from "@/lib/electron-bridge";
import { useSettingsStore } from "@/stores/settings";
import { useSlashCommands } from "@/composables/useSlashCommands";

const props = defineProps<{ disabled: boolean; autoMode?: boolean; apiKey?: string; baseUrl?: string }>();
const emit = defineEmits<{ send: [text: string]; files: [files: Array<{ name: string; path: string }>]; stop: [] }>();

function onDrop(e: DragEvent) {
  e.preventDefault();
  isDragOver.value = false;
  const files = e.dataTransfer?.files;
  if (!files || files.length === 0) return;

  const attached: Array<{ name: string; path: string }> = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    attached.push({ name: f.name, path: (f as any).path || f.name });
  }
  emit("files", attached);
}

const input = ref("");
const focused = ref(false);
const isDragOver = ref(false);

function send() {
  const text = input.value.trim();
  if (!text) return;
  showSlashMenu.value = false;
  emit("send", text);
  input.value = "";
  autoResize();
}

// ── 斜杠命令自动补全 ──
const { favorites, recentCommands } = useSlashCommands();
const slashMenuIdx = ref(0);
const showSlashMenu = ref(false);

const slashSuggestions = computed(() => {
  const val = input.value;
  // 仅当输入以 / 开头且无空格时弹出（单行命令模式）
  if (!val.startsWith("/") || val.includes(" ")) return [];
  const query = val.slice(1).toLowerCase();
  // 合并：最近使用在前，收藏在后，去重
  const seen = new Set<string>();
  const items: string[] = [];
  for (const r of recentCommands.value) {
    if (!seen.has(r) && r.toLowerCase().includes(query)) { items.push(r); seen.add(r); }
  }
  for (const f of favorites.value) {
    if (!seen.has(f) && f.toLowerCase().includes(query)) { items.push(f); seen.add(f); }
  }
  // 如果输入只有 /，加一个快速补全当前内容为 /command 而非过滤
  return items.slice(0, 8);
});

function applySlashSuggestion(suggestion: string) {
  showSlashMenu.value = false;
  // 斜杠命令选择后直接发送
  emit("send", "/" + suggestion);
  input.value = "";
  autoResize();
}

function onBlurSlash() {
  focused.value = false;
  setTimeout(() => { showSlashMenu.value = false; }, 150);
}

function onInputSlash() {
  const val = input.value;
  if (val.startsWith("/") && !val.includes(" ") && val.length >= 1) {
    showSlashMenu.value = true;
    slashMenuIdx.value = 0;
  } else {
    showSlashMenu.value = false;
  }
}

// ── Drag & drop files ──
function onDragOver(e: DragEvent) {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  isDragOver.value = true;
}

function onDragLeave() {
  isDragOver.value = false;
}

function onKeydown(e: KeyboardEvent) {
  if (showSlashMenu.value && slashSuggestions.value.length > 0) {
    if (e.key === "ArrowDown") { e.preventDefault(); slashMenuIdx.value = Math.min(slashMenuIdx.value + 1, slashSuggestions.value.length - 1); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); slashMenuIdx.value = Math.max(slashMenuIdx.value - 1, 0); return; }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); applySlashSuggestion(slashSuggestions.value[slashMenuIdx.value]); return; }
    if (e.key === "Escape") { e.preventDefault(); showSlashMenu.value = false; return; }
  }
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
}

function onPaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items;
  if (!items) return;
  const files: Array<{ name: string; path: string }> = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === "file") {
      const file = item.getAsFile();
      if (file) {
        files.push({ name: file.name, path: (file as any).path || file.name });
      }
    }
  }
  if (files.length > 0) {
    e.preventDefault();
    emit("files", files);
  }
}

// ── 提示词优化 ──
const settings = useSettingsStore();
const optimizing = ref(false);
const optimizeError = ref("");

async function handleOptimize() {
  const text = input.value.trim();
  if (!text || !props.apiKey || !props.baseUrl) return;
  if (!settings.optimizeApiUrl) {
    optimizeError.value = "请先在设置中配置「聊天 API 地址」";
    setTimeout(() => { optimizeError.value = ""; }, 5000);
    return;
  }
  optimizing.value = true;
  optimizeError.value = "";
  try {
    const result = await optimizePrompt(props.apiKey, props.baseUrl, text, settings.optimizeApiUrl || undefined);
    input.value = result;
    await nextTick();
    autoResize();
  } catch (e) {
    optimizeError.value = typeof e === "string" ? e : (e as Error).message || String(e);
    setTimeout(() => { optimizeError.value = ""; }, 5000);
  } finally {
    optimizing.value = false;
  }
}

async function autoResize() {
  await nextTick();
  const el = document.querySelector(".chat-textarea") as HTMLTextAreaElement | null;
  if (el) { el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 180) + "px"; }
}

/** 外部设置输入框文本（FilePreview DOM 选择器等） */
defineExpose({ setText: (text: string) => { input.value = text; autoResize(); } });
</script>

<template>
  <div class="sb-input-bar">
    <!-- 斜杠自动补全下拉 — 绝对定位，不挤占消息区域 -->
    <div v-if="showSlashMenu && slashSuggestions.length > 0" class="slash-autocomplete">
      <button
        v-for="(s, i) in slashSuggestions"
        :key="s"
        @mousedown.prevent="applySlashSuggestion(s)"
        :class="['slash-ac-item', i === slashMenuIdx ? 'slash-ac-active' : '']"
      >/{{ s }}</button>
    </div>

    <div
      class="flex items-center max-w-3xl mx-auto rounded-xl transition-colors duration-150"
      :style="{
        background: 'var(--bg-elevated)',
        border: isDragOver ? '2px dashed var(--accent)' : props.autoMode ? '1px solid #0ea5e9' : focused ? '1px solid var(--accent)' : '1px solid var(--border-default)',
        padding: '0 6px 0 0'
      }"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
      <textarea
        v-model="input"
        @keydown="onKeydown"
        @paste="onPaste"
        @input="autoResize(); onInputSlash()"
        @focus="focused = true"
        @blur="onBlurSlash"
        :placeholder="$t('chat.placeholder')"
        rows="1"
        class="chat-textarea flex-1 resize-none bg-transparent text-sm leading-relaxed py-3 pl-4 pr-2 disabled:opacity-30"
        :style="{
          color: 'var(--text-primary)',
          caretColor: 'var(--accent)',
          border: 'none',
          outline: 'none',
          boxShadow: 'none',
          maxHeight: '180px',
          overflowY: 'auto',
          minHeight: '22px'
        }"
      ></textarea>
      <!-- ✨ 提示词优化 -->
      <button
        @click="handleOptimize"
        :disabled="!input.trim() || optimizing"
        class="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg transition-all duration-150"
        :style="{
          background: optimizeError ? 'var(--coral-glow)' : 'transparent',
          color: optimizeError ? 'var(--coral)' : input.trim() ? 'var(--text-secondary)' : 'var(--text-muted)',
          border: 'none',
        }"
        :title="optimizeError || $t('toolbar.optimizeTitle')"
      >
        <!-- loading 旋转动画 -->
        <svg v-if="optimizing" class="animate-spin" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
        </svg>
        <!-- 双星图标 -->
        <svg v-else width="15" height="15" viewBox="1 1 22 22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 0 0-2.455 2.456z"/>
        </svg>
      </button>
      <!-- Stop button (visible when processing) -->
      <button
        v-if="disabled"
        @click="emit('stop')"
        class="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg transition-all duration-150"
        style="background: var(--coral); color: white; border: none"
        :title="$t('chat.stop')"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
      </button>

      <!-- Send button (visible when idle) -->
      <button
        v-else
        :disabled="!input.trim() || optimizing"
        @click="send"
        class="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg transition-all duration-150"
        :style="{
          background: (input.trim() && !optimizing) ? 'var(--accent)' : 'transparent',
          color: (input.trim() && !optimizing) ? 'var(--bg-root)' : 'var(--text-muted)',
          border: 'none'
        }"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="transform: translate(-1px, 1px)">
          <line x1="22" y1="2" x2="11" y2="13" />
          <polygon points="22 2 15 22 11 13 2 9 22 2" />
        </svg>
      </button>
    </div>
    <!-- 优化错误提示 -->
    <div v-if="optimizeError" class="max-w-3xl mx-auto mt-1 text-[11px] px-1" style="color: var(--coral)">
      ✕ {{ optimizeError }}
    </div>
  </div>
</template>

<style scoped>
.slash-autocomplete {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  max-width: 48rem;
  margin: 0 auto 0.25rem;
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: 0.5rem;
  box-shadow: 0 4px 16px rgba(0,0,0,0.3);
  overflow: hidden;
  z-index: 20;
}
.slash-ac-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 0.375rem 0.75rem;
  font-size: 12px;
  font-family: ui-monospace, monospace;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
  transition: background-color 100ms;
}
.slash-ac-item:hover,
.slash-ac-active {
  background: var(--accent-glow);
  color: var(--accent);
}
</style>
