<script setup lang="ts">
// 子任务详情弹窗（ModalShell）：拉取子会话全量消息做只读展示
// 复用取舍：MessageBubble 耦合 chat store（编辑/重发/useFilePreview），子会话消息只读无交互——
// 采用轻量渲染（text 段落 + thinking 折叠 + tool 卡片），避免把只读数据塞进编辑型组件
import { ref, computed, onMounted } from "vue";
import ModalShell from "@/components/shared/ModalShell.vue";
import { listMessages, type MessageData } from "@/lib/electron-bridge";
import { useChatStore } from "@/stores/chat";
import { useSessionStore } from "@/stores/session";

const props = defineProps<{ subId: string; agent?: string }>();
const emit = defineEmits<{ close: []; backToParent: [parentId: string] }>();

const chat = useChatStore();
const session = useSessionStore();

const loading = ref(true);
const loadError = ref(false);
const rawMessages = ref<MessageData[]>([]);

/** 子任务记录的父会话 id（返回主会话入口；拿不到就不显示链接） */
const parentId = computed(() => chat.subTasks[props.subId]?.parentId);

/** 轻量解析：assistant 消息 content 可能是 JSON blob（{text,thinking,toolUses}），旧格式纯文本 */
interface ParsedMsg {
  id: string;
  role: "user" | "assistant";
  text: string;
  thinking: string;
  tools: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  createdAt: number;
}
const messages = computed<ParsedMsg[]>(() =>
  rawMessages.value.map((m) => {
    let text = m.content;
    let thinking = "";
    let tools: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
    try {
      const parsed = JSON.parse(m.content);
      if (parsed && typeof parsed === "object") {
        if (m.role === "assistant") {
          text = parsed.text || "";
          thinking = parsed.thinking || "";
          tools = (parsed.toolUses || []).map((tu: { id: string; name: string; input?: Record<string, unknown> }) => ({
            id: tu.id,
            name: tu.name,
            input: tu.input || {},
          }));
        }
      }
    } catch {
      // 纯文本旧格式，text 原样
    }
    return {
      id: m.id,
      role: m.role as "user" | "assistant",
      text,
      thinking,
      tools,
      createdAt: new Date(m.created_at + "Z").getTime(),
    };
  })
);

/** 工具 input 摘要（军师 #10）：前 200 字符只读展示；空对象显省略 */
function toolInputPreview(input: Record<string, unknown>): string {
  const keys = Object.keys(input);
  if (keys.length === 0) return "…";
  const s = JSON.stringify(input);
  return s.length > 200 ? s.slice(0, 200) + "…" : s;
}

onMounted(async () => {
  try {
    rawMessages.value = await listMessages(props.subId);
  } catch {
    loadError.value = true;
  } finally {
    loading.value = false;
  }
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

const task = computed(() => chat.subTasks[props.subId]);
const badge = computed(() => badgeFor(task.value?.agent || ""));

function onBack() {
  if (parentId.value) emit("backToParent", parentId.value);
}
</script>

<template>
  <ModalShell :open="true" size="xl" position="top" width="min(60vw, 960px)" @close="emit('close')">
    <template #header>
      <span class="detail-header">
        <span class="detail-badge">{{ badge }}</span>
        <span class="detail-agent">{{ agent || task?.agent || "子智能体" }}</span>
        <!-- 状态三态：实时 done → 已完成；实时 running → 运行中；历史场景（subTasks 无记录，detail 从历史入口打开）→
             已完成 · 历史记录——修复「历史子会话误显运行中」bug（不再默认 running） -->
        <span v-if="task?.status === 'done'" class="detail-status">✅ 已完成</span>
        <span v-else-if="!task" class="detail-status">✅ 已完成 · 历史记录</span>
        <span v-else class="detail-status detail-status--running">🔄 运行中</span>
        <span class="flex-1"></span>
        <!-- 返回主会话：parentId 拿不到则隐藏（旧数据/异常场景） -->
        <button v-if="parentId" class="detail-back-btn" @click="onBack">← {{ $t('chat.subTaskBackToParent') }}</button>
      </span>
    </template>

    <div v-if="loading" class="detail-placeholder">{{ $t('chat.subTaskLoading') }}</div>
    <div v-else-if="loadError" class="detail-placeholder">{{ $t('chat.subTaskNoContent') }}</div>

    <div v-else class="detail-body">
      <template v-for="(msg, index) in messages" :key="msg.id">
        <!-- 首条 user 消息 = 主智能体的任务描述（task description）：顶部独立区块，与下方执行流视觉分区 -->
        <div v-if="index === 0 && msg.role === 'user'" class="detail-task-desc">
          <div class="detail-task-desc-head">
            <span class="detail-task-desc-title">🎯 任务描述</span>
          </div>
          <p class="detail-task-desc-text">{{ msg.text || '…' }}</p>
        </div>
        <!-- 后续 user 消息：工具结果，归入执行流（不重复标角色标签） -->
        <div v-else-if="msg.role === 'user'" class="detail-msg detail-msg--user">{{ msg.text || '…' }}</div>
        <!-- assistant 消息：thinking 折叠 + tool 卡片 + 文本 -->
        <div v-else class="detail-msg detail-msg--assistant">
          <details v-if="msg.thinking" class="detail-thinking" open>
            <summary class="detail-thinking-summary">💭 {{ $t('chat.subTaskThinking') }}</summary>
            <div class="detail-thinking-body">{{ msg.thinking }}</div>
          </details>
          <div v-for="tool in msg.tools" :key="tool.id" class="detail-tool">
            <div class="detail-tool-name">🔧 {{ tool.name }}</div>
            <!-- 工具 input 摘要（军师 #10）：前 200 字符只读展示，帮助快速了解工具参数 -->
            <div class="detail-tool-input">{{ toolInputPreview(tool.input) }}</div>
          </div>
          <p v-if="msg.text" class="detail-text">{{ msg.text }}</p>
          <span v-if="!msg.thinking && !msg.tools.length && !msg.text" class="detail-text detail-text--empty">…</span>
        </div>
      </template>
      <div v-if="messages.length === 0" class="detail-placeholder">{{ $t('chat.subTaskNoContent') }}</div>
    </div>
  </ModalShell>
</template>

<style scoped>
.detail-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.detail-badge {
  font-size: 14px;
  line-height: 1;
}
.detail-agent {
  font-weight: 600;
  color: var(--violet);
  font-size: 12px;
}
.detail-status {
  font-size: 10px;
  white-space: nowrap;
}
.detail-status--running {
  color: var(--accent);
  animation: pulse 1s ease-in-out infinite;
}
.detail-back-btn {
  font-size: 10px;
  color: var(--text-muted);
  background: transparent;
  border: 1px solid var(--border-dim);
  border-radius: 4px;
  padding: 0.1rem 0.4rem;
  cursor: pointer;
  transition: color 150ms, background-color 150ms;
}
.detail-back-btn:hover {
  color: var(--text-bright);
  background: var(--bg-hover);
}
.detail-placeholder {
  color: var(--text-muted);
  font-size: 12px;
  padding: 1rem 0;
}
.detail-body {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  max-height: 60vh;
  overflow-y: auto;
}
.detail-msg {
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
}
.detail-msg--user {
  background: var(--bg-elevated);
  border: 1px solid var(--border-dim);
  /* 长文本不撑出 X 轴滚动条：pre-wrap 保留换行 + anywhere 任意断行兜底 */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.detail-msg--assistant {
  background: var(--bg-surface);
  border: 1px solid var(--border-dim);
}
/* 任务描述区（首条 user 消息 = 主智能体派发）：accent 浅底与下方执行流（surface/elevated 灰底）视觉分区 */
.detail-task-desc {
  background: var(--accent-glow);
  border: 1px solid var(--accent-dim);
  border-radius: 6px;
  padding: 0.6rem 0.75rem;
}
.detail-task-desc-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.35rem;
}
.detail-task-desc-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--accent);
}
.detail-task-desc-text {
  margin: 0;
  font-size: 12px;
  color: var(--text-primary);
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.detail-thinking {
  border-bottom: 1px solid var(--border-dim);
  margin-bottom: 0.35rem;
}
.detail-thinking-summary {
  font-size: 11px;
  color: var(--amber);
  padding: 0.2rem 0;
  cursor: pointer;
  user-select: none;
}
.detail-thinking-body {
  font-size: 11px;
  color: var(--text-secondary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  padding-bottom: 0.4rem;
}
.detail-tool {
  font-size: 11px;
  font-weight: 600;
  color: var(--violet);
  margin: 0.2rem 0;
  overflow-wrap: anywhere;
}
.detail-tool-name {
  font-weight: 600;
}
.detail-tool-input {
  font-weight: 400;
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
  overflow-wrap: anywhere;
  margin-top: 0.15rem;
}
.detail-text {
  margin: 0;
  font-size: 12px;
  color: var(--text-primary);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}
.detail-text--empty {
  color: var(--text-muted);
}
</style>
