import { defineStore } from "pinia";
import { ref } from "vue";
import { useChatStore } from "./chat";
import {
  createSession as createSessionBackend,
  listSessions,
  deleteSession as deleteSessionBackend,
  renameSession as renameSessionBackend,
  type SessionData,
} from "@/lib/electron-bridge";

/** 根据 locale 返回默认会话标题 */
export function defaultTitle(locale?: string): string {
  return locale?.startsWith("en") ? "New Chat" : "新会话";
}

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  totalTokens?: number | null;
  totalCost?: number | null;
  /** 会话类型（后端返回，分形下恒为 'cc'，无 UI 过滤依赖） */
  mode?: string;
}

export const useSessionStore = defineStore("session", () => {
  const sessions = ref<Session[]>([]);
  const activeSessionId = ref<string>("");
  /** 当前 CC 会话已连接的 MCP 服务器名称列表 */
  const connectedMcpServers = ref<string[]>([]);
  /** serve 引擎连接状态（engine:status 事件驱动，true=serve 运行中；false=未启动/进程退出） */
  const serving = ref(false);

  // ── 会话活动状态指示 ──
  // 'processing' = CC 运行中 → 绿点闪烁
  // 'unread'     = 完成但未查看 → 蓝点
  // 'blocked'    = 等待授权/问答 → 橙点（优先级最高，覆盖 processing）
  type ActivityStatus = 'processing' | 'unread' | 'blocked';
  const sessionActivity = ref<Record<string, ActivityStatus>>({});

  function setSessionActivity(id: string, status: ActivityStatus | null) {
    const next = { ...sessionActivity.value };
    if (status) {
      next[id] = status;
    } else {
      delete next[id];
    }
    sessionActivity.value = next;
  }

  /** 加载会话列表；directory 传入时只加载该工作区的会话（serve ?directory= 过滤） */
  // 竞态守卫：并发 loadSessions（新窗口 onMounted 与 onInitWorkspace 各发一次）时，
  // 只有最后一次调用的结果能写入——先发请求若后返回会覆盖新工作区列表（多窗口切换 bug）
  let loadSeq = 0;
  async function loadSessions(directory?: string) {
    const seq = ++loadSeq;
    try {
      const list = await listSessions(directory);
      if (seq !== loadSeq) return; // 已有更新的加载请求，丢弃过期结果
      sessions.value = list.map(toLocalSession);
      // Don't auto-select: user should start fresh or pick one explicitly
    } catch (err) {
      console.error("Failed to load sessions:", err);
    }
  }

  /** Create a new session via backend，可指定 CWD 和 mode。locale 用于本地化默认标题 */
  async function createSession(model?: string, cwd?: string, mode?: string, locale?: string, title?: string): Promise<string> {
    // 切换会话前保存当前会话消息缓存——防止流式中的会话被新会话覆盖后切回时消息丢失
    if (activeSessionId.value) {
      useChatStore().saveSessionCache(activeSessionId.value);
    }
    const finalTitle = title || defaultTitle(locale);
    try {
      const s = await createSessionBackend(model, cwd, mode, finalTitle);
      sessions.value.unshift(toLocalSession(s));
      activeSessionId.value = s.id;
      return s.id;
    } catch {
      // Fallback: local ID if backend unreachable
      const id = Date.now().toString(36);
      const session: Session = {
        id,
        title: finalTitle,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messageCount: 0,
      };
      sessions.value.unshift(session);
      activeSessionId.value = id;
      return id;
    }
  }

  function setActiveSession(id: string) {
    activeSessionId.value = id;
  }

  /** Rename session via backend */
  async function renameSession(id: string, title: string) {
    try {
      await renameSessionBackend(id, title);
    } catch (err) {
      console.error("Failed to rename session:", err);
    }
    const s = sessions.value.find((s) => s.id === id);
    if (s) {
      s.title = title;
      s.updatedAt = Date.now();
    }
  }

  /** Delete session via backend */
  async function deleteSession(id: string) {
    try {
      await deleteSessionBackend(id);
    } catch (err) {
      console.error("Failed to delete session:", err);
    }
    sessions.value = sessions.value.filter((s) => s.id !== id);
    if (activeSessionId.value === id) {
      activeSessionId.value = sessions.value[0]?.id || "";
    }
  }

  /** 更新 serve 连接状态（useStreamProcessor 的 engine:status 监听回调） */
  function setServing(v: boolean) {
    serving.value = v;
  }

  /** 将后端返回的会话插入列表头部（fork 等 IPC 直连场景，不走 store.createSession 的本地 fallback） */
  function insertSession(s: SessionData) {
    sessions.value.unshift(toLocalSession(s));
  }

  return {
    sessions,
    activeSessionId,
    serving,
    setServing,
    insertSession,
    loadSessions,
    createSession,
    setActiveSession,
    renameSession,
    deleteSession,
    connectedMcpServers,
    sessionActivity,
    setSessionActivity,
  };
});

/** Map backend SessionData to frontend Session */
function toLocalSession(s: SessionData): Session {
  return {
    id: s.id,
    title: s.title,
    createdAt: new Date(s.created_at + "Z").getTime(),
    updatedAt: new Date(s.updated_at + "Z").getTime(),
    messageCount: s.message_count,
    totalTokens: s.total_tokens,
    totalCost: s.total_cost,
    mode: s.mode || "cc",
  };
}
