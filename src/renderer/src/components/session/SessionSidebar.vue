<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";

import { useSessionStore } from "@/stores/session";
import { useChatStore } from "@/stores/chat";
import { useSettingsStore } from "@/stores/settings";

import { stopSession } from "@/lib/electron-bridge";
import { useNewSession } from "@/composables/useNewSession";
import { useSessionSwitch } from "@/composables/useSessionSwitch";
import { useSessionDrafts } from "@/composables/useSessionDrafts";
import { emitChatCommand } from "@/composables/useCommandPalette";
import { formatTokenCount } from "@/lib/utils";

const emit = defineEmits<{
  navigate: [id: string];
  collapse: [];
}>();

const { t } = useI18n();
const router = useRouter();

const sessionStore = useSessionStore();
const chatStore = useChatStore();
const settings = useSettingsStore();

const { handleNew } = useNewSession();
const { switchTo } = useSessionSwitch();
const { hasDraft, clearDraft, version: draftVersion } = useSessionDrafts();

// 草稿版本号 → 本地响应式 tick：Map 非响应式，模板必须依赖 tick 才能在 saveDraft/clearDraft 后重渲染
// （watch 空回调不触发重渲染——军师 P1-2，2026-08-15 审查发现）
const draftTick = ref(0);
watch(draftVersion, () => { draftTick.value++; });
/** 会话是否有草稿（列表标记；活跃会话正在编辑不标记） */
function hasDraftFor(id: string): boolean {
  void draftTick.value; // 建立响应式依赖：版本号变化时本函数重算，标记才刷新
  return id !== activeId.value && hasDraft(id);
}

/** 切换会话 */
function switchByMode(id: string) {
  return switchTo(id);
}

/** 新会话按钮：当前会话无消息时给出「已是新会话」提示，否则 handleNew 内部创建并跳转 */
async function newSession() {
  const result = await handleNew();
  if (result === "current-empty") {
    emitChatCommand("show-status:" + t("session.alreadyNew"));
  }
}

// 当前活跃会话 ID
const activeId = computed(() => sessionStore.activeSessionId);

const searchQuery = ref("");
const editingId = ref<string | null>(null);
const editingTitle = ref("");

const filteredSessions = computed(() => {
  const all = sessionStore.sessions;
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return all;
  return all.filter(s => s.title.toLowerCase().includes(q));
});

// 挂载时按当前工作区加载会话（无 cwd = 全量）。仅空列表时加载：
// 折叠时 AppShell 已负责加载（数据在 store），展开挂载再拉会闪转圈、覆盖进行中的流式刷新（2026-08-08）
onMounted(async () => {
  if (sessionStore.sessions.length === 0) await sessionStore.loadSessions(settings.cwd || undefined)
});

async function handleSelect(id: string) {
  await switchByMode(id);
}

function startRename(id: string, title: string) { editingId.value = id; editingTitle.value = title; }
async function finishRename(id: string) {
  const t = editingTitle.value.trim();
  if (t) await sessionStore.renameSession(id, t);
  editingId.value = null;
}
function cancelRename() { editingId.value = null; }
async function handleDelete(id: string) {
  const wasActive = activeId.value === id;
  // 先终止该会话的 CC 进程（若有），避免后台残留进程
  try { await stopSession(id); } catch { /* 无进程则忽略 */ }
  await sessionStore.deleteSession(id);  // store 内赋值 activeSessionId 到下一个会话
  // 删除会话 → 清理其草稿（hover 删除按钮路径不走 ChatPanel.onDeleteSessionConfirm，需在此补——军师 P2-1）
  clearDraft(id);
  // 竞态 guard：异步期间可能已切到其他会话，重新判断
  if (wasActive && activeId.value === id) {
    const nextId = sessionStore.sessions[0]?.id;
    if (nextId) {
      await switchByMode(nextId);
    } else {
      chatStore.clearMessages();
      router.push("/chat");
    }
  }
}
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- Header -->
    <div class="flex items-center justify-between px-4 pt-4 pb-2">
      <span class="text-[0.786rem] font-semibold uppercase tracking-[0.08em]" style="color:var(--text-secondary)">{{ $t('session.title') }}</span>
      <div class="flex items-center gap-1">
        <button
          @click="newSession"
          class="w-[26px] h-[26px] flex items-center justify-center rounded-[7px] transition-colors hover:bg-[var(--bg-hover)]"
          style="color:var(--text-secondary)"
          :title="$t('session.new')"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
        <button
          @click="emit('collapse')"
          class="w-[26px] h-[26px] flex items-center justify-center rounded-[7px] transition-colors hover:bg-[var(--bg-hover)]"
          style="color:var(--text-muted)"
          title="收起侧栏"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M3 12h18M3 6h18M3 18h18" />
          </svg>
        </button>
      </div>
    </div>

    <!-- Search -->
    <div class="px-3 pb-2">
      <div class="flex items-center gap-2 px-2.5 py-1.5 rounded-[8px] text-xs" :style="{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
        <input
          v-model="searchQuery"
          :placeholder="$t('session.search')"
          class="flex-1 bg-transparent outline-none text-xs"
          :style="{ color: 'var(--text-primary)', caretColor: 'var(--accent)' }"
        />
        <button
          v-if="searchQuery"
          @click="searchQuery = ''"
          class="w-4 h-4 flex items-center justify-center rounded transition-colors hover:bg-[var(--bg-hover)]"
          style="color: var(--text-muted); width: 16px; height: 16px;"
          :title="$t('session.clear')"
        >✕</button>
      </div>
    </div>

    <!-- List -->
    <div class="flex-1 overflow-y-auto px-2 pb-2 space-y-px">
      <button
        v-for="s in filteredSessions"
        :key="s.id"
        @click="handleSelect(s.id)"
        class="w-full flex items-center gap-2.5 px-3 py-2 rounded-[8px] text-left text-[0.893rem] transition-colors group hover:bg-[var(--bg-hover)]"
        :style="{
          background: s.id === activeId ? 'var(--accent-glow)' : 'transparent',
          color: s.id === activeId ? 'var(--text-bright)' : 'var(--text-secondary)',
          border: s.id === activeId ? '1px solid var(--accent-line)' : '1px solid transparent'
        }"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" :style="{ opacity: s.id === activeId ? 1 : 0.35 }">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>

        <input
          v-if="editingId === s.id"
          v-model="editingTitle"
          @keydown.enter="finishRename(s.id)"
          @keydown.escape="cancelRename()"
          @blur="finishRename(s.id)"
          @click.stop
          class="flex-1 bg-transparent border-0 outline-0 text-[0.929rem]"
          :style="{ color: 'var(--text-bright)', borderBottom: '1px solid var(--accent)' }"
          maxlength="50"
        />
        <div v-else class="truncate flex-1 min-w-0">
          <!-- "New Chat" 是 Rust 后端默认标题，前端按 i18n 显示 -->
          <span class="block truncate">{{ s.title === 'New Chat' || s.title === '新会话' ? $t('session.new') : s.title }}</span>
          <span class="block truncate text-[0.714rem]" :style="{ color: 'var(--text-muted)' }">
            <!-- 草稿标记：该会话有未发送草稿（文字/附件/选区任一）且非当前编辑会话 -->
            <span
              v-if="hasDraftFor(s.id)"
              class="mr-1 font-medium"
              :style="{ color: 'var(--accent)' }"
            >{{ $t('session.draftBadge') }}</span>
            <template v-if="s.totalTokens">{{ formatTokenCount(s.totalTokens) }}</template>
          </span>
        </div>

        <!-- Activity dot -->
        <span
          v-if="sessionStore.sessionActivity[s.id]"
          class="activity-dot shrink-0"
          :class="'dot-' + sessionStore.sessionActivity[s.id]"
        />

        <!-- Hover actions — always in layout (invisible) 防止出现时行高抖动 -->
        <div class="invisible group-hover:visible flex items-center gap-0.5 shrink-0 ml-auto">
          <button @click.stop="startRename(s.id, s.title)" class="w-[20px] h-[20px] flex items-center justify-center rounded-[6px] transition-colors hover:bg-[var(--bg-active)]" style="color:var(--text-secondary)" :title="$t('session.rename')">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
          </button>
          <button @click.stop="handleDelete(s.id)" class="w-[20px] h-[20px] flex items-center justify-center rounded-[6px] transition-colors hover:bg-[var(--bg-active)]" style="color:var(--text-secondary)" :title="$t('session.delete')">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </button>

      <!-- 空态引导：加载中显示转圈（serve 未就绪/首次拉取时避免「暂无会话」误导）；
           无会话且未搜索时显示引导；有搜索词无结果才显示 noMatching -->
      <div v-if="!searchQuery && sessionStore.sessionsLoading && filteredSessions.length === 0" class="px-3 py-12 text-center text-xs space-y-2" style="color:var(--text-muted)">
        <div class="flex justify-center">
          <svg class="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
        </div>
        <div>{{ $t('session.loading') }}</div>
      </div>
      <div v-else-if="!searchQuery && filteredSessions.length === 0" class="px-3 py-12 text-center text-xs space-y-2" style="color:var(--text-muted)">
        <div class="text-lg leading-none opacity-50">＋</div>
        <div>{{ $t('session.noSessions') }}</div>
      </div>
      <div v-else-if="filteredSessions.length === 0" class="px-3 py-12 text-center text-xs" style="color:var(--text-muted)">
        {{ $t('session.noMatching') }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.activity-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.dot-processing {
  background: var(--accent);
  animation: dot-blink 1s ease-in-out infinite;
}
.dot-unread {
  background: var(--blue);
}
.dot-blocked {
  background: var(--coral);
  animation: dot-blink 0.6s ease-in-out infinite;
}
@keyframes dot-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.15; }
}
</style>
