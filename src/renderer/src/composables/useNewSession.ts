import { useRouter } from "vue-router";
import { useSessionStore } from "@/stores/session";
import { useChatStore } from "@/stores/chat";
import { useDebugLog } from "@/composables/useDebugLog";
import { useSettingsStore } from "@/stores/settings";

/**
 * Shared "new session" logic — used by both the sidebar button and the
 * AppShell navbar button so they stay in sync without duplicating code.
 *
 * Return:
 *   "created"       — 新建了会话，已跳转
 *   "current-empty" — 当前会话已是空会话，无需操作
 *   string (id)     — 存在空闲的最新会话，返回其 id，调用方负责切换
 */
export function useNewSession() {
  const router = useRouter();
  const sessionStore = useSessionStore();
  const chatStore = useChatStore();
  const debugLog = useDebugLog();
  const settings = useSettingsStore();

  async function handleNew(): Promise<"created" | "current-empty" | string> {
    // 当前会话无消息 → 已是新会话
    if (chatStore.messages.length === 0) return "current-empty";

    // 最新会话（按 createdAt 降序）如果为空 → 切换到它，避免堆积空会话
    const sorted = [...sessionStore.sessions].sort((a, b) => b.createdAt - a.createdAt);
    const latest = sorted[0];
    if (latest && latest.messageCount === 0 && latest.id !== sessionStore.activeSessionId) {
      return latest.id;
    }

    // 没有可复用的空会话 → 新建
    await sessionStore.createSession(settings.model, undefined, undefined, settings.locale);
    chatStore.clearMessages();
    debugLog.clear();
    router.push("/chat");
    return "created";
  }

  return { handleNew };
}
