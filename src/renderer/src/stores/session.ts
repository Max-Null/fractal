import { defineStore } from "pinia";
import { ref, watch } from "vue";
import { useChatStore } from "./chat";
import {
  createSession as createSessionBackend,
  listSessions,
  deleteSession as deleteSessionBackend,
  renameSession as renameSessionBackend,
  setActiveSession as setActiveSessionBridge,
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
  totalTokens: number | null;
  totalCost: number | null;
  mode: string;
  /** 会话绑定的工作区目录（serve directory；前端过滤用） */
  cwd?: string;
  /** 子会话归属的主会话 id（serve parentID；主会话无此字段） */
  parentId?: string;
  /** 子会话 agent 名（serve 会话列表实测返回） */
  agent?: string;
}

export const useSessionStore = defineStore("session", () => {
  const sessions = ref<Session[]>([]);
  /** 子会话列表（parentId 非空，主会话的 task 派生子智能体会话）——历史子任务归属数据源，
   *  与 sessions 同源拆分：主进程 session:list 返回全量，此处按 parentId 分桶（2026-08-09） */
  const childSessions = ref<Session[]>([]);
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
  /** 会话列表加载中（供空态显示「加载中」而非「暂无会话」——serve 未就绪时列表会短暂为空，误导用户） */
  const sessionsLoading = ref(false);
  let pendingLoads = 0;
  async function loadSessions(directory?: string) {
    const seq = ++loadSeq;
    pendingLoads++;
    sessionsLoading.value = true;
    try {
      // 全量拉取 + 前端过滤（2026-08-08 根治）：serve 的 ?directory= 参数会触发目标目录「实例化」
      // （creating instance → bootstrapping），doc-edit 项目场景 serve 实例化时崩溃退出（code=1 无输出）——
      // 列表加载不再触发实例化；全量 186 会话量级可接受，过滤在内存完成
      const list = await listSessions();
      if (seq !== loadSeq) return; // 已有更新的加载请求，丢弃过期结果
      const filtered = directory
        ? list.filter((s) => normalizeDir(s.directory || s.cwd) === normalizeDir(directory))
        : list;
      const all = filtered.map(toLocalSession);
      // 主/子会话拆分：侧边栏/rail 只用主会话（方案 A），子会话供历史子任务归属（parentId 匹配）
      sessions.value = all.filter((s) => !s.parentId);
      childSessions.value = all.filter((s) => s.parentId);
      // Don't auto-select: user should start fresh or pick one explicitly
    } catch (err) {
      console.error("Failed to load sessions:", err);
    } finally {
      pendingLoads--;
      if (pendingLoads <= 0) sessionsLoading.value = false;
    }
  }

  // 目录规范化：分隔符/尾斜杠/大小写统一（serve 存正斜杠，前端可能传反斜杠）
  function normalizeDir(p?: string): string {
    return (p || "").replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
  }

  /** Create a new session via backend，可指定 CWD 和 mode。locale 用于本地化默认标题 */
  async function createSession(model?: string, cwd?: string, mode?: string, locale?: string, title?: string): Promise<string> {
    // 切换会话前保存当前会话消息缓存——防止流式中的会话被新会话覆盖后切回时消息丢失
    if (activeSessionId.value) {
      useChatStore().saveSessionCache(activeSessionId.value);
    }
    const finalTitle = title || defaultTitle(locale);
    try {
      // 后端不传 title：serve 用 OC 默认格式（New session - <ISO>）创建，
      // ensureTitle 才会在首条消息后触发 small_model 自动生成标题（isDefaultTitle 正则只认默认格式）
      const s = await createSessionBackend(model, cwd, mode, title ? finalTitle : undefined);
      sessions.value.unshift(toLocalSession(s));
      setActiveSession(s.id);
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
        totalTokens: null,
        totalCost: null,
        mode: "cc",
        // fallback 也保留 cwd：后端恢复后按工作区过滤列表时该会话仍能归位
        cwd,
      };
      sessions.value.unshift(session);
      setActiveSession(id);
      return id;
    }
  }

  function setActiveSession(id: string) {
    // 幂等去重：active 未变化时跳过 IPC 通知——子会话识别只需知道「当前活跃会话」，
    // 重复广播是纯噪音（fire-and-forget 无校验），未来若高频调用（列表刷新等）也不会放大
    if (activeSessionId.value === id) return;
    activeSessionId.value = id;
    // 通知主进程活跃会话变化（子会话识别依赖；fire-and-forget，失败静默）
    setActiveSessionBridge(id);
  }

  // 主进程活跃会话通知兜底：watch 统一覆盖所有赋值路径（含 URL 窗口切 cwd 激活、删除会话
  // 自动切换等不经过 action 的直接赋值——2026-08-09 实测子会话卡片不显示，主进程 Map 为空）。
  // action 幂等已挡同值重复，这里仅补「值变化但未走 action」的路径；同值不触发 watch。
  watch(activeSessionId, (id) => {
    if (id) setActiveSessionBridge(id);
  });

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

  /** 会话标题自动更新（serve 首条消息后重命名，session_title 事件驱动）——只改本地，不调后端 */
  function updateSessionTitle(id: string, title: string) {
    const s = sessions.value.find((s) => s.id === id);
    if (s && s.title !== title) {
      s.title = title;
      s.updatedAt = Date.now();
    }
    const c = childSessions.value.find((s) => s.id === id);
    if (c && c.title !== title) {
      c.title = title;
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
    childSessions,
    activeSessionId,
    serving,
    setServing,
    sessionsLoading,
    insertSession,
    loadSessions,
    createSession,
    setActiveSession,
    renameSession,
    updateSessionTitle,
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
    cwd: s.directory || s.cwd,
    parentId: s.parentId,
    agent: s.agent,
  };
}
