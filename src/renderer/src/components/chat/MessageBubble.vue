<script setup lang="ts">
import type { Message } from "@/stores/chat";
import { ref, computed, nextTick, onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { useSettingsStore } from "@/stores/settings";

import { isImageFile, useFilePreview } from "@/composables/useFilePreview";
import { formatNum } from "@/lib/utils";
import MarkdownRenderer from "../shared/MarkdownRenderer.vue";

const { t } = useI18n();
const settings = useSettingsStore();
const { getThumbnail, thumbnails } = useFilePreview();

function toolLabel(name: string): string {
  const key = `tools.${name}`;
  const translated = t(key);
  return translated !== key ? translated : name;
}


// 每秒 tick，驱动流式期间的工具执行计时实时更新
const now = ref(Date.now());
let nowTimer: ReturnType<typeof setInterval> | null = null;
onMounted(() => { nowTimer = setInterval(() => now.value = Date.now(), 1000); });
onUnmounted(() => { if (nowTimer) clearInterval(nowTimer); });

const props = defineProps<{ message: Message }>();
const emit = defineEmits<{
  edit: [id: string, content: string];
  resend: [id: string, content: string];
  fork: [id: string];
  editSave: [id: string, newContent: string];
  previewFile: [file: { name: string; path: string }];
}>();
const copied = ref(false);

// ── Inline editing state ──
const isEditing = ref(false);
const editText = ref("");
const editTextarea = ref<HTMLTextAreaElement | null>(null);

function startEdit() {
  editText.value = props.message.content;
  isEditing.value = true;
  nextTick(() => {
    editTextarea.value?.focus();
    editTextarea.value?.select();
  });
}

function cancelEdit() {
  isEditing.value = false;
  editText.value = "";
}

function saveAndResend() {
  const text = editText.value.trim();
  if (!text) return;
  isEditing.value = false;
  emit("editSave", props.message.id, text);
}

function onEditKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    saveAndResend();
  }
  if (e.key === "Escape") {
    e.preventDefault();
    cancelEdit();
  }
}

// ── 思考总耗时：各段 tool_use 前思考时间求和（精确，无需实时计时器）──
function totalThinkingMs(): number {
  return props.message.toolUses.reduce((sum, tu) => sum + (tu.thinkingDurationMs || 0), 0);
}
// ── 总耗时（思考 + 工具执行）──
const totalSeconds = computed(() => {
  if (props.message.durationMs) {
    return (props.message.durationMs / 1000).toFixed(1);
  }
  if (props.message.isStreaming && props.message.timestamp) {
    return ((now.value - props.message.timestamp) / 1000).toFixed(1);
  }
  return null;
});

const totalLabel = computed(() => {
  const s = totalSeconds.value;
  return s ? `⏱${s}s` : "";
});

// 非 Anthropic 提供商的费用估算无意义
const showCost = computed(() => settings.providerId === "anthropic");

// ── 纯思考时间 ──
const thinkingLabel = computed(() => {
  const ms = totalThinkingMs();
  return ms > 0 ? `🧠${(ms / 1000).toFixed(1)}s` : "";
});

// ── Token display ──
const tokenLabel = computed(() => {
  const parts: string[] = [];
  if (props.message.inputTokens) parts.push(`↑${formatNum(props.message.inputTokens)}`);
  if (props.message.outputTokens) parts.push(`↓${formatNum(props.message.outputTokens)}`);
  return parts.join(" ");
});

async function copyContent() {
  await navigator.clipboard.writeText(props.message.content);
  copied.value = true;
  setTimeout(() => copied.value = false, 1500);
}

// ── Tool input display helpers ──
function summarizeInput(input: Record<string, unknown>): string {
  // Bash/PowerShell 命令行：收起时显示 description 而非 command 原文
  if (typeof input.description === "string" && input.description.length > 0) {
    return input.description;
  }
  // Skill 调用：收起时显示 skill 名而非 args 原文
  if (typeof input.skill === "string" && input.skill.length > 0) {
    return input.skill;
  }
  const entries = Object.entries(input);
  if (entries.length === 0) return "(no args)";
  const previews = entries.slice(0, 3).map(([k, v]) => {
    if (typeof v === "string") return `${k}=${v.length > 40 ? v.slice(0, 40) + "…" : v}`;
    if (typeof v === "number" || typeof v === "boolean") return `${k}=${v}`;
    return `${k}={…}`;
  });
  let s = previews.join(", ");
  if (entries.length > 3) s += ` +${entries.length - 3} more`;
  return s;
}

function formatJSON(obj: unknown): string {
  if (typeof obj === "string") return obj;
  return JSON.stringify(obj, null, 2);
}

/** 截断工具输出内容的首行或前 80 字符，用于折叠摘要 */
function summarizeResult(content: string): string {
  if (!content) return "";
  // 取第一行（非空行），截断到 80 字符
  const firstLine = content.trimStart().split("\n")[0] || "";
  if (firstLine.length > 80) return firstLine.slice(0, 80) + "…";
  return firstLine;
}
</script>

<template>
  <div :class="['msg-row', message.role === 'user' ? 'msg-row--user' : 'msg-row--assistant']" :data-role="message.role">
    <!-- Avatar -->
    <div
      class="msg-avatar"
      :style="{
        background: message.role === 'user'
          ? 'linear-gradient(135deg, #3b82f6, #6366f1)'
          : 'linear-gradient(135deg, #06d6a0, #0891b2)',
        color: 'white'
      }"
    >
      {{ message.role === 'user' ? 'U' : 'C' }}
    </div>

    <!-- Body -->
    <div :class="['flex-1 min-w-0 space-y-2', message.role === 'user' ? 'flex flex-col items-end' : '']">
      <!-- Name + actions -->
      <div class="flex items-center gap-1.5 px-0.5">
        <span class="text-[11px] font-medium" style="color:var(--text-muted)">
          {{ message.role === 'user' ? 'You' : 'Claude' }}
        </span>
        <!-- Copy -->
        <button
          v-if="message.content && !message.isStreaming"
          @click="copyContent"
          class="msg-action-btn"
          :style="{ color: copied ? 'var(--accent)' : 'var(--text-secondary)' }"
          :title="copied ? $t('chat.copied') : $t('chat.copy')"
        >
          <svg v-if="!copied" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          <svg v-else width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
        </button>
        <!-- Edit (user messages only) -->
        <button
          v-if="message.role === 'user' && !message.isStreaming && !isEditing"
          @click="startEdit"
          class="msg-action-btn"
          style="color: var(--text-secondary)"
          :title="$t('chat.edit')"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
        </button>
        <!-- Fork（用户消息分叉） -->
        <button
          v-if="message.role === 'user' && !message.isStreaming && !isEditing"
          @click="emit('fork', message.id)"
          class="msg-action-btn"
          style="color: var(--text-secondary)"
          :title="$t('chat.forkSession')"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v8M9 5l3-3 3 3"/><path d="M18 22v-8M18 8v6M6 14v8"/></svg>
        </button>
        <!-- Resend (user messages only) -->
        <button
          v-if="message.role === 'user' && !message.isStreaming && !isEditing"
          @click="emit('resend', message.id, message.content)"
          class="msg-action-btn"
          style="color: var(--text-secondary)"
          :title="$t('chat.resend')"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
        </button>
      </div>

      <!-- ═══ 按时间线渲染（contentBlocks 可用时） ═══ -->
      <div v-if="message.contentBlocks?.length" class="sb-timeline">
        <!-- 跳过独立的 tool_result 块——结果已嵌套在 tool_use 内部展示 -->
        <template v-for="(block, i) in message.contentBlocks" :key="i">
          <div
            v-if="block.type !== 'tool_result'"
            class="sb-timeline-block"
            :class="['tl-' + block.type, { 'tl-last': i === message.contentBlocks.length - 1 && !message.isStreaming }]"
          >
          <!-- 时间线圆点 -->
          <div class="sb-timeline-dot">
            <span v-if="block.type === 'thinking'">💭</span>
            <span v-else-if="block.type === 'tool_use'">🔧</span>
            <span v-else>💬</span>
          </div>

          <!-- 思考块（默认折叠） -->
          <details v-if="block.type === 'thinking'" class="tl-thinking-inner">
            <summary class="tl-thinking-summary">
              💭 {{ (message.isStreaming && i === message.contentBlocks!.length - 1) ? $t('chat.thinking') : $t('chat.thinkingDone') }}
              <!-- 思考耗时：后一个工具块上记录的 thinkingDurationMs -->
              <span v-if="message.contentBlocks[i+1]?.type === 'tool_use' && message.contentBlocks[i+1]?.toolUse?.thinkingDurationMs" class="tl-stat">🧠{{ ((message.contentBlocks[i+1]!.toolUse!.thinkingDurationMs!) / 1000).toFixed(1) }}s</span>
              <span v-if="!(message.isStreaming && i === message.contentBlocks!.length - 1) && block.content" class="tl-thinking-snippet">{{ block.content.slice(0, 60) }}{{ block.content.length > 60 ? '…' : '' }}</span>
              <span v-if="message.isStreaming && i === message.contentBlocks!.length - 1" class="w-1.5 h-1.5 rounded-full animate-pulse ml-1" style="background:var(--accent); display:inline-block"></span>
            </summary>
            <div class="tl-thinking-body">{{ block.content }}</div>
          </details>

          <!-- 工具调用块（结果收进内部展示） -->
          <details
            v-else-if="block.type === 'tool_use' && block.toolUse"
            class="tl-tool"
          >
            <summary>
              <span class="tl-tool-name">{{ toolLabel(block.toolUse.name) }}</span>
              <span v-if="block.toolUse.executionDurationMs" class="tl-stat" :class="{ 'tl-slow': block.toolUse.executionDurationMs > 5000 }">⚡{{ (block.toolUse.executionDurationMs / 1000).toFixed(1) }}s</span>
              <span v-if="!block.toolUse.executionDurationMs && block.toolUse.startedAt && message.isStreaming" class="tl-stat tl-live">⚡{{ ((now - block.toolUse.startedAt) / 1000).toFixed(1) }}s</span>
              <span class="tl-input-preview">{{ summarizeInput(block.toolUse.input) }}</span>
              <!-- 结果简要标记 -->
              <span v-if="block.toolUse.isError" class="tl-stat" style="color:var(--coral)">⚠️</span>
              <span v-else-if="block.toolUse.result" class="tl-stat" style="color:var(--accent)">✓</span>
            </summary>
            <!-- 输入参数 -->
            <div class="tl-tool-section-label">{{ $t('chat.toolInput') }}</div>
            <pre>{{ formatJSON(block.toolUse.input) }}</pre>
            <!-- 工具结果（嵌套在内部） -->
            <div v-if="block.toolUse.result !== undefined" class="tl-tool-result" :class="{ 'tl-tool-result-error': block.toolUse.isError }">
              <div class="tl-tool-section-label">{{ block.toolUse.isError ? $t('chat.toolError') : $t('chat.toolOutput') }}</div>
              <pre class="tl-tool-result-body">{{ block.toolUse.result }}</pre>
            </div>
          </details>

          <!-- 文本块 -->
          <div v-else-if="block.type === 'text' && block.content" class="tl-text">
            <MarkdownRenderer :content="block.content" />
          </div>
        </div>
        </template>
        <!-- 流式光标 -->
        <span v-if="message.isStreaming" class="stream-cursor" style="margin-left:20px"></span>

        <!-- 状态行：流式中「思考中」→ 完成后「已完成」 -->
        <div
          v-if="message.isStreaming || (message.contentBlocks?.length && !message.isStreaming)"
          class="text-xs select-none"
          style="padding-top: 2px; color: var(--text-muted); opacity: 0.6"
        >
          <span v-if="message.isStreaming" class="tl-status-thinking">
            —&nbsp;<template v-for="(c, ci) in $t('chat.thinking')" :key="ci"><span class="tl-wave-char" :style="{ animationDelay: ci * 0.15 + 's' }">{{ c }}</span></template>&nbsp;—
          </span>
          <span v-else-if="message.wasStopped" :style="{ color: 'var(--coral)' }">— {{ $t('chat.stopped') }} —</span>
          <span v-else>— {{ $t('chat.completed') }} —</span>
        </div>

        <!-- 空文本兜底：模型未生成自然语言回复但有工具执行时，显示摘要 -->
        <div
          v-if="!message.isStreaming && !message.content && message.contentBlocks?.length && message.toolUses.length"
          class="text-xs mt-2"
          style="color: var(--text-muted); opacity: 0.6"
        >
          {{ $t('chat.toolsExecuted', { n: message.toolUses.filter(t => t.result).length }) }}
        </div>

        <!-- 统计行：耗时 / token / cost -->
        <div
          v-if="totalLabel || thinkingLabel || tokenLabel || (showCost && message.costUSD !== undefined)"
          class="flex items-center gap-2 text-[11px] mt-2"
          style="color: var(--text-muted)"
        >
          <span v-if="totalLabel" class="font-mono tabular-nums">{{ totalLabel }}</span>
          <span v-if="thinkingLabel" class="font-mono tabular-nums" style="opacity: 0.7">{{ thinkingLabel }}</span>
          <template v-if="!message.isStreaming">
            <span v-if="tokenLabel" style="opacity:0.5">·</span>
            <span v-if="tokenLabel">{{ tokenLabel }}</span>
            <span v-if="showCost && message.costUSD !== undefined">${{ message.costUSD.toFixed(4) }}</span>
          </template>
        </div>
      </div>

      <!-- Edit mode: inline textarea for user messages -->
      <div v-if="isEditing" class="w-full">
        <textarea
          ref="editTextarea"
          v-model="editText"
          @keydown="onEditKeydown"
          rows="3"
          class="w-full resize-none bg-transparent text-sm leading-relaxed p-3 rounded-xl rounded-br-md border outline-none"
          :style="{
            color: 'var(--text-bright)',
            background: 'linear-gradient(135deg, rgba(59,130,246,0.15), rgba(99,102,241,0.10))',
            borderColor: 'var(--accent)',
          }"
        ></textarea>
        <div class="flex items-center gap-2 mt-2 justify-end">
          <button
            @click="cancelEdit"
            class="px-2.5 py-1 rounded-md text-xs transition-colors hover:bg-[var(--bg-hover)]"
            style="color: var(--text-secondary)"
          >{{ $t('chat.cancel') }}</button>
          <button
            @click="saveAndResend"
            :disabled="!editText.trim()"
            class="px-3 py-1 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5"
            :style="{
              background: editText.trim() ? 'var(--accent)' : 'var(--bg-elevated)',
              color: editText.trim() ? 'var(--bg-root)' : 'var(--text-secondary)',
            }"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            {{ $t('chat.saveResend') }}
          </button>
        </div>
      </div>

      <!-- Assistant 消息兜底（无 contentBlocks 时显示纯文本）。
           注意：这里用 v-if 而非 v-else-if，因为上方 v-if="isEditing" 打断了链。 -->
      <div
        v-if="!message.contentBlocks?.length && message.role === 'assistant' && message.content"
        class="prose text-sm leading-relaxed rounded-lg"
      >
        <MarkdownRenderer :content="message.content" />
        <span v-if="message.isStreaming" class="stream-cursor"></span>
      </div>

      <!-- 用户消息纯文本（无 contentBlocks，不做 Markdown 解析） -->
      <div
        v-if="!message.contentBlocks?.length && message.role === 'user' && message.content"
        class="user-bubble"
      >
        {{ message.content }}

        <!-- Attachments in user message -->
        <div
          v-if="message.attachments?.length"
          class="flex flex-wrap gap-1 mt-2 pt-2"
          :style="{ borderTop: '1px solid rgba(59,130,246,0.15)' }"
        >
          <div
            v-for="att in message.attachments"
            :key="att.path"
            class="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] cursor-pointer transition-colors hover:brightness-110 shrink-0"
            style="background: rgba(59,130,246,0.12); color: var(--text-secondary)"
            @click="emit('previewFile', att)"
          >
            <img
              v-if="isImageFile(att.name)"
              :src="thumbnails[att.path] || ''"
              @vue:mounted="getThumbnail(att.path, att.name)"
              class="w-3.5 h-3.5 rounded object-cover shrink-0"
              v-show="thumbnails[att.path]"
            />
            <svg v-else width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" class="shrink-0"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
            <span class="truncate max-w-[120px]">{{ att.name }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ── 用户消息气泡 ── */
.user-bubble {
  padding: 0.625rem 0.875rem;
  border-radius: 1rem 1rem 0.25rem 1rem;
  font-size: 0.875rem;
  line-height: 1.6;
  white-space: pre-wrap;
  background: linear-gradient(135deg, rgba(59,130,246,0.15), rgba(99,102,241,0.10));
  border: 1px solid rgba(59,130,246,0.15);
  color: var(--text-bright);
}

/* ── 消息行 ── */
.msg-row { display: flex; gap: 0.75rem; }
.msg-row--user { flex-direction: row-reverse; }

/* ── 消息头像 ── */
.msg-avatar {
  width: 1.75rem; height: 1.75rem;
  flex-shrink: 0; border-radius: 0.375rem;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 600;
}

/* ── 消息操作按钮（编辑/重发/复制）── */
.msg-action-btn {
  width: 1rem; height: 1rem;
  display: flex; align-items: center; justify-content: center;
  border-radius: 0.25rem; transition: background-color 150ms;
}
.msg-action-btn:hover { background: var(--bg-hover); }

/* ── 时间线 ── */
.sb-timeline {
  position: relative;
}

.sb-timeline-block {
  position: relative;
  padding-left: 26px;
  margin-bottom: 8px;
}
.sb-timeline-block.tl-last {
  margin-bottom: 0;
}
/* 每块画线段穿过圆点中心到下一块，末块不画 */
.sb-timeline-block::after {
  content: '';
  position: absolute;
  left: 10px;
  top: 12px;        /* 当前圆点中心（top 4 + 8） */
  bottom: -20px;     /* 延伸到下一块圆点中心（margin 8 + top 4 + 8） */
  width: 2px;
  background: var(--border-dim);
  border-radius: 1px;
}
.sb-timeline-block.tl-last::after {
  display: none;
}

.sb-timeline-dot {
  position: absolute;
  left: 3px;
  top: 4px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 9px;
  line-height: 1;
  background: var(--bg-surface);
  border: 1.5px solid var(--border-dim);
  z-index: 1;
}
.tl-thinking .sb-timeline-dot   { border-color: var(--amber); }
.tl-tool_use .sb-timeline-dot   { border-color: var(--violet); }
.tl-tool_result .sb-timeline-dot { border-color: var(--accent); }
.tl-text .sb-timeline-dot       { border-color: var(--border-bright); }

/* ── 各块 ── */
.tl-thinking {
  border-radius: 6px;
  background: var(--amber-glow);
}
.tl-thinking-summary {
  padding: 5px 10px;
  font-size: 11px;
  cursor: pointer;
  user-select: none;
  color: var(--amber);
  transition: background 150ms;
  list-style: none;
  display: flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
}
.tl-thinking-summary::-webkit-details-marker { display: none; }
.tl-thinking-summary:hover { background: rgba(255,255,255,0.03); }
.tl-thinking-snippet {
  font-size: 11px;
  color: var(--text-muted);
  opacity: 0.6;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
.tl-thinking-body {
  padding: 6px 10px;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  word-break: break-word;
  color: var(--text-secondary);
  border-top: 1px solid rgba(255,255,255,0.05);
}

.tl-tool {
  font-size: 12px;
  font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace;
  border-radius: 6px;
  background: var(--bg-root);
  border: 1px solid var(--border-dim);
}
.tl-tool summary {
  padding: 6px 10px;
  cursor: pointer;
  user-select: none;
  color: var(--text-secondary);
  transition: background 150ms;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.tl-tool summary:hover { background: var(--bg-hover); }
.tl-tool-name  { font-weight: 600; color: var(--violet); }
.tl-stat       { font-size: 10px; color: var(--text-muted); white-space: nowrap; }
.tl-stat.tl-slow { color: var(--coral); }
.tl-stat.tl-live { color: var(--accent); animation: pulse 1s ease-in-out infinite; }
.tl-input-preview {
  color: var(--text-muted);
  opacity: 0.7;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 200px;
}
.tl-tool pre {
  padding: 8px 10px;
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  overflow-x: auto;
  white-space: pre;
  border-top: 1px solid var(--border-dim);
  color: var(--text-muted);
  max-height: 240px;
}
.tl-tool-section-label {
  padding: 5px 10px 2px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-muted);
  opacity: 0.5;
}
.tl-tool-result {
  border-top: 1px solid var(--accent-dim);
}
.tl-tool-result.tl-tool-result-error {
  border-top-color: var(--coral);
}
.tl-tool-result-body {
  padding: 6px 10px 6px;
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text-secondary);
  max-height: 200px;
  overflow-y: auto;
}

.tl-result {
  font-size: 12px;
  font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace;
  border-radius: 6px;
  background: var(--bg-root);
  border: 1px solid var(--accent-dim);
}
.tl-result.tl-result-error {
  border-color: var(--coral);
}
.tl-result-summary {
  padding: 5px 10px;
  font-size: 11px;
  cursor: pointer;
  user-select: none;
  color: var(--accent);
  transition: background 150ms;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  list-style: none;
}
.tl-result-summary::-webkit-details-marker { display: none; }
.tl-result-summary:hover { background: rgba(255,255,255,0.03); }
.tl-result-error .tl-result-summary {
  color: var(--coral);
}
.tl-result-snippet {
  color: var(--text-muted);
  opacity: 0.7;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 320px;
}
.tl-result-empty {
  color: var(--text-muted);
  opacity: 0.4;
}
.tl-result-body {
  padding: 8px 10px;
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
  border-top: 1px solid var(--border-dim);
  color: var(--text-muted);
  max-height: 300px;
  overflow-y: auto;
}

.tl-text {
  font-size: 14px;
  line-height: 1.65;
}
.tl-text :deep(p) { margin: 0.25em 0; }

/* 思考中波浪闪烁 */
.tl-status-thinking {
  color: var(--accent);
  opacity: 0.9;
}
.tl-wave-char {
  display: inline-block;
  animation: think-wave 1.2s ease-in-out infinite;
}
@keyframes think-wave {
  0%, 100% { opacity: 0.2; }
  50% { opacity: 1; }
}
</style>
