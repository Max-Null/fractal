import { useRouter } from "vue-router";
import { useChatStore } from "@/stores/chat";
import { useSessionStore } from "@/stores/session";
import { listMessages } from "@/lib/electron-bridge";

/**
 * 会话切换逻辑（AppShell rail + SessionSidebar 共用）。
 * 切换前缓存当前消息，切回时优先从缓存恢复（保留后台累积的流式消息），
 * 缓存未命中则从 DB 加载。
 *
 * switchTo / zenSwitchTo 共享 doSwitch 实现，消除重复代码。
 */
export function useSessionSwitch() {
  const chat = useChatStore();
  const session = useSessionStore();
  const router = useRouter();

  /** 获取当前模式下的活跃会话 ID，用于竞态 guard */
  function currentActiveId(isZen: boolean): string {
    return isZen ? session.zenActiveId : session.activeSessionId;
  }

  /** 设置当前模式下的活跃会话 ID */
  function setActiveId(id: string, isZen: boolean) {
    if (isZen) {
      session.zenActiveId = id;
    } else {
      session.setActiveSession(id);
    }
  }

  /** 核心切换逻辑，CC 和 Zen 共用 */
  async function doSwitch(id: string, isZen: boolean) {
    const prevId = currentActiveId(isZen);

    // 第一步：保存当前会话缓存（在任何状态变更之前）
    if (prevId) {
      chat.saveSessionCache(prevId);
    }

    // 第二步：立即清空消息（防止第二个 switch 在中途保存错误数据）
    chat.clearMessages();

    // 第三步：设置新活跃会话
    setActiveId(id, isZen);

    // 只清除已完成的会话指示器，处理中的保留绿点
    if (session.sessionActivity[id] !== 'processing') {
      session.setSessionActivity(id, null);
    }

    // 优先从缓存恢复，缓存无数据则从 DB 加载
    const cached = chat.loadFromCache(id);
    if (cached) {
      chat.messages.push(...cached);
      // 恢复流式状态：若最后一条消息在流式中，保持引用以继续接收事件
      const last = chat.messages[chat.messages.length - 1];
      if (last?.role === "assistant" && last.isStreaming) {
        chat.currentAssistantMsg = last;
        chat.isProcessing = true;
      }
    } else {
      try {
        const msgs = await listMessages(id);
        // Ponytail 竞态 guard：异步期间可能已切换到其他会话，检查后丢弃过期结果
        if (currentActiveId(isZen) !== id) return;
        chat.loadMessages(
          msgs.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            created_at: m.created_at,
          })),
        );
      } catch {
        if (currentActiveId(isZen) !== id) return;
        // messages 已在第二步清空，无需额外清理
      }
    }

    // 最终 guard：避免在已切换后还 push router
    if (currentActiveId(isZen) !== id) return;
    // 确保导航完成后再发事件（否则 ChatPanel 可能尚未挂载，监听器未注册）
    await router.push("/chat").catch(() => {});
    window.dispatchEvent(new CustomEvent("session-switched"));
  }

  async function switchTo(id: string) {
    return doSwitch(id, false);
  }

  async function zenSwitchTo(id: string) {
    return doSwitch(id, true);
  }

  return { switchTo, zenSwitchTo };
}
