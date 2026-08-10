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
 *   "current-empty" — 当前会话已是空会话，无需操作（调用方负责提示）
 */
export function useNewSession() {
  const router = useRouter();
  const sessionStore = useSessionStore();
  const chatStore = useChatStore();
  const debugLog = useDebugLog();
  const settings = useSettingsStore();

  async function handleNew(): Promise<"created" | "current-empty"> {
    // 当前会话无消息 → 已是新会话（不做任何跳转/创建）
    if (chatStore.messages.length === 0) return "current-empty";

    // 新建（cwd 绑当前工作区：会话跟随工作区，否则列表刷新后消失）
    await sessionStore.createSession(settings.model, settings.cwd, undefined, settings.locale);
    chatStore.clearMessages();
    debugLog.clear();
    router.push("/chat");
    return "created";
  }

  return { handleNew };
}
