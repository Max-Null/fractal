import { useRouter } from "vue-router";
import { useSessionStore } from "@/stores/session";
import { useChatStore } from "@/stores/chat";
import { useDebugLog } from "@/composables/useDebugLog";
import { useSettingsStore } from "@/stores/settings";
import { useSessionDrafts } from "@/composables/useSessionDrafts";
import { useSessionSwitch } from "@/composables/useSessionSwitch";
import { emitChatCommand } from "@/composables/useCommandPalette";

/**
 * Shared "new session" logic — used by both the sidebar button and the
 * AppShell navbar button so they stay in sync without duplicating code.
 *
 * Return:
 *   "created"       — 新建了会话，已跳转
 *   "jumped"        — 列表最近会话是空会话，已跳转到它（复用，不创建）
 *   "current-empty" — 当前会话已是空会话，无需操作（调用方负责提示）
 */
export function useNewSession() {
  const router = useRouter();
  const sessionStore = useSessionStore();
  const chatStore = useChatStore();
  const debugLog = useDebugLog();
  const settings = useSettingsStore();
  const { migrateNoneDraft } = useSessionDrafts();
  const { switchTo } = useSessionSwitch();

  async function handleNew(): Promise<"created" | "jumped" | "current-empty"> {
    // 当前会话无消息 → 已是新会话（不做任何跳转/创建）
    if (chatStore.messages.length === 0) return "current-empty";

    // 列表最近一个会话是空会话 → 跳转复用（2026-08-15 用户确认：重启后最近空会话应复用，
    // 避免不断创建堆积空会话；sessions 已按 updatedAt 倒序，sessions[0] 即最近活跃）
    const latestEmpty = sessionStore.sessions.find((s) => s.messageCount === 0);
    if (latestEmpty) {
      await switchTo(latestEmpty.id);
      // 首页无会话草稿迁移到复用的空会话（与「创建新会话」语义一致：进入空白会话时带入首页草稿）
      const migrated = migrateNoneDraft(latestEmpty.id);
      if (migrated) {
        emitChatCommand("draft-migrated");
      }
      chatStore.clearMessages();
      debugLog.clear();
      return "jumped";
    }

    // 新建（cwd 绑当前工作区：会话跟随工作区，否则列表刷新后消失）
    await sessionStore.createSession(settings.model, settings.cwd, undefined, settings.locale);
    // 首页（无会话）输入的草稿迁移到新会话——createSession 内部 setActiveSession 已触发 ChatPanel watch
    // 恢复新会话草稿（当时 NONE 未迁移读到空）；此处显式迁移后发事件让 ChatPanel 重新恢复输入态，
    // 保证「切历史会话再新建」时首页输入不丢（2026-08-15 用户反馈 v1 丢失）
    const migrated = migrateNoneDraft(sessionStore.activeSessionId);
    if (migrated) {
      emitChatCommand("draft-migrated");
    }
    chatStore.clearMessages();
    debugLog.clear();
    router.push("/chat");
    return "created";
  }

  return { handleNew };
}
