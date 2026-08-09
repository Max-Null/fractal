<script setup lang="ts">
import type { Message } from "@/stores/chat";
import { ref, computed, nextTick } from "vue";
import { useI18n } from "vue-i18n";

import { isImageFile, useFilePreview } from "@/composables/useFilePreview";
import { useSlashCommands } from "@/composables/useSlashCommands";
import MarkdownRenderer from "../shared/MarkdownRenderer.vue";

const { t } = useI18n();
const { getThumbnail, thumbnails } = useFilePreview();
const { recentCommands } = useSlashCommands();

const props = defineProps<{ message: Message }>();
const emit = defineEmits<{
  edit: [id: string, content: string];
  resend: [id: string, content: string];
  fork: [id: string];
  editSave: [id: string, newContent: string];
  previewFile: [file: { name: string; path: string }];
}>();
const copied = ref(false);

// 用户消息发送时间 → HH:mm:ss（timestamp 缺失（0）→ '--:--'；2026-08-10 由 HH:mm 增补秒）
const timeLabel = computed(() => {
  if (!props.message.timestamp) return "--:--";
  const d = new Date(props.message.timestamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
});

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

async function copyContent() {
  await navigator.clipboard.writeText(props.message.content);
  copied.value = true;
  setTimeout(() => copied.value = false, 1500);
}

// ── D15 指令徽标：@agent（中文词边界） / 斜杠命令（useSlashCommands 使用历史白名单）──
// 注意：ASCII \b 对 CJK 无效，用「空白/中英文标点/行尾」后瞻做词边界（v1.3 修正）
const AGENT_RE = /@(双星|工匠|参谋|军师|侦查兵|制图师|导师|助理)(?=[\s,，。！？!?]|$)/;

/** @agent 徽标文案：匹配到角色名 → `@工匠`；未匹配空串（不显示徽标） */
const agentBadge = computed(() => {
  const m = AGENT_RE.exec(props.message.content);
  return m ? `@${m[1]}` : "";
});

/** 斜杠命令徽标：消息首行首词命中 recentCommands 使用历史（recentCommands 存去前导 / 的命令名）→ 原始命令名；未命中空串 */
const commandBadge = computed(() => {
  const c = props.message.content.trim();
  if (!c.startsWith("/")) return "";
  const raw = c.split("\n")[0].trim().split(/\s+/)[0];
  // useSlashCommands 存的是无斜杠命令名（recordCommand 去前导 /），匹配时去掉再比
  const name = raw.startsWith("/") ? raw.slice(1) : raw;
  return recentCommands.value.some((r) => r === name || r.startsWith(name)) ? raw : "";
});

/** 徽标变体：@agent 优先（紫），命令兜底（蓝）；边框色随变体微调 */
const badgeVariant = computed(() => {
  if (agentBadge.value) return "agent";
  if (commandBadge.value) return "command";
  return "";
});
</script>

<template>
  <!-- 根节点不再携带 data-message-id/data-role：锚点职责由 ChatPanel 回合容器 .msg-entry 承载
       （修复锚点 bug #8：双份相同锚点属性导致 ChatTimelineNav scroll spy 定位错位） -->
  <div :class="['msg-row', message.role === 'user' ? 'msg-row--user' : 'msg-row--assistant']">
    <!-- Avatar：用户首字圆（32px；settings.username 不存在 → '我'）；assistant 兜底分支显示 logo
         （2026-08-10：分形头像由文字 '分' 换为 logo，保持原尺寸与圆形） -->
    <div
      v-if="message.role === 'user'"
      class="msg-avatar msg-avatar--user"
    >
      {{ '我' }}
    </div>
    <img
      v-else
      class="msg-avatar msg-avatar--assistant"
      src="/logo.svg"
      alt="分形"
    />

    <!-- Body -->
    <div :class="['flex-1 min-w-0 space-y-2', message.role === 'user' ? 'flex flex-col items-end' : '']">
      <!-- Name + actions：用户消息显示发送时间（HH:mm），assistant 兜底分支保留 '分形' -->
      <div class="flex items-center gap-1.5 px-0.5">
        <span class="text-[11px] font-medium" style="color:var(--text-muted)">
          {{ message.role === 'user' ? timeLabel : '分形' }}
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

      <!-- ═══ 助手消息时间线已迁移至 NodeTimeline/NodeCard（3b 组件化）——这里不再渲染 contentBlocks ═══ -->

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

      <!-- Assistant 消息兜底（无 contentBlocks 的旧存档消息：纯文本 Markdown）。
           ChatPanel 回合分组后助手消息走 NodeTimeline，此分支仅兼容历史数据/兜底调用。 -->
      <div
        v-if="!message.contentBlocks?.length && message.role === 'assistant' && message.content"
        class="prose text-sm leading-relaxed rounded-lg"
      >
        <MarkdownRenderer :content="message.content" />
        <span v-if="message.isStreaming" class="stream-cursor"></span>
      </div>

      <!-- 用户消息纯文本（无 contentBlocks，不做 Markdown 解析）+ D15 指令徽标 -->
      <div
        v-if="!message.contentBlocks?.length && message.role === 'user' && message.content"
        class="user-bubble-wrap"
      >
        <!-- 指令徽标：@agent 紫 / 斜杠命令 蓝（气泡左上角） -->
        <div v-if="badgeVariant" class="msg-badge" :class="'msg-badge--' + badgeVariant">
          {{ badgeVariant === 'agent' ? agentBadge : commandBadge }}
        </div>
        <div class="user-bubble" :class="badgeVariant ? 'user-bubble--' + badgeVariant : ''">
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
  </div>
</template>

<style scoped>
/* ── 用户消息气泡 ── */
/* wrap：气泡 + 左上角指令徽标（D15）竖向排列，徽标贴气泡左上角 */
.user-bubble-wrap {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  max-width: 100%;
}
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
/* D15 指令徽标边框色：@agent 紫 / 命令 蓝（气泡边框随变体微调） */
.user-bubble--agent { border-color: rgba(124, 58, 237, 0.35); }
.user-bubble--command { border-color: rgba(59, 130, 246, 0.35); }

/* ── D15 指令徽标 ── */
.msg-badge {
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  line-height: 1.5;
  user-select: none;
}
.msg-badge--agent {
  background: rgba(124, 58, 237, 0.12);
  color: #a78bfa;
  border: 1px solid rgba(124, 58, 237, 0.3);
}
.msg-badge--command {
  background: rgba(59, 130, 246, 0.12);
  color: #60a5fa;
  border: 1px solid rgba(59, 130, 246, 0.3);
}

/* ── 消息行：气泡与头像顶部对齐（对齐反馈：与分形头像 flex-start 一致，原 center 垂直居中） ── */
.msg-row { display: flex; gap: 0.75rem; align-items: flex-start; }
/* 用户消息行：限宽 90% + 靠右（margin-left auto），左侧留白与分形消息右侧留白对称
   （对称布局反馈：原占满整行，左缘贴面板左缘；90% 由 76% 放宽） */
.msg-row--user {
  flex-direction: row-reverse;
  max-width: 90%;
  margin-left: auto;
}

/* ── 消息头像（反馈 #1）：用户 32px 首字圆，bg-elevated 底 + 边框；与气泡居中对齐 ── */
.msg-avatar {
  width: 2rem; height: 2rem;
  flex-shrink: 0; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 600;
}
.msg-avatar--user {
  /* 与 .assistant-col__avatar 同款（样式统一反馈）：accent 渐变圆 + 白字，尺寸 2rem 一致 */
  background: linear-gradient(135deg, var(--accent), #0891b2);
  border: 1px solid transparent;
  color: white;
  /* 头像顶对齐气泡顶：名字行（16.5px）+ space-y-2 间距（0.5rem）——
     原对齐 body 顶部导致头像比气泡高出一个名字行 */
  margin-top: calc(16.5px + 0.5rem);
}
.msg-avatar--assistant {
  /* logo 头像：img 替换元素，无文字/背景——圆形裁切由 .msg-avatar 的 border-radius 承担 */
  object-fit: cover;
}

/* ── 消息操作按钮（编辑/重发/复制）── */
.msg-action-btn {
  width: 1rem; height: 1rem;
  display: flex; align-items: center; justify-content: center;
  border-radius: 0.25rem; transition: background-color 150ms;
}
.msg-action-btn:hover { background: var(--bg-hover); }
</style>
