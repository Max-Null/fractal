import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { listMessages } from "@/lib/electron-bridge";

export interface AttachedFile {
  name: string;
  path: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking: string;
  toolUses: ToolUse[];
  /** 保持 CC 原始块顺序的数组（text/thinking/tool_use 交替），用于按时间线渲染 */
  contentBlocks?: ContentBlock[];
  timestamp: number;
  isStreaming: boolean;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUSD?: number;
  attachments?: AttachedFile[];
  /** 用户手动停止（非自然结束） */
  wasStopped?: boolean;
}

export interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  /** 该工具调用前的思考耗时（毫秒） */
  thinkingDurationMs?: number;
  /** 该工具执行耗时（毫秒），从工具调用到下一个思考/文本开始的间隔 */
  executionDurationMs?: number;
  /** 工具开始执行的时间戳（Date.now()），用于流式期间显示实时计时 */
  startedAt?: number;
}

/** 工具执行结果（来自 user 事件的 tool_result 块） */
export interface ToolResult {
  toolUseId: string;
  content: string;
  isError?: boolean;
}

/** CC 内容块（保持原始顺序），解决"文字全堆在工具调用后面"的问题 */
export interface ContentBlock {
  type: "text" | "thinking" | "tool_use" | "tool_result";
  /** text/thinking 块的文本内容 */
  content?: string;
  /** tool_use 块的工具信息 */
  toolUse?: ToolUse;
  /** tool_result 块的执行结果 */
  toolResult?: ToolResult;
}

export interface ControlRequest {
  subtype: string;
  tool_name?: string;
  tool_input: Record<string, unknown>;
  /** 控制请求的唯一 ID，响应时必须原样带回 */
  request_id?: string;
  /** Resolved: 'allow' | 'deny' | null (pending) */
  resolution?: string;
  /** permission.asked 的免审批建议（通配符，如 ["echo *"]）——「总是允许」展示 */
  always?: string[];
  /** question.asked 的问题列表（subtype='question' 时）——提问弹窗渲染 */
  questions?: Array<{
    question: string;
    header?: string;
    options?: Array<{ label: string; description?: string }>;
    multiple?: boolean;
  }>;
}

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

/** CC TodoWrite / TaskCreate / serve todo.updated 产出的工作清单项 */
export interface TodoItem {
  content: string
  status: "pending" | "in_progress" | "completed" | "cancelled" | "deleted"
  activeForm: string
  /** TaskCreate/TaskUpdate 使用的任务 ID（TodoWrite 无此字段） */
  taskId?: string
  /** serve 原生 todo.updated 的优先级（CC TodoWrite 无此字段） */
  priority?: "high" | "medium" | "low"
}

/** 全量历史拉取上限：超限截断（后续虚拟滚动放开）。进入会话一次拉全，内存建索引 + DOM 分页渲染 */
export const FULL_HISTORY_LIMIT = 500;

// ── 子任务（子智能体）可视化 ──

/** 子任务 deltaText 累积上限：超限丢头部保留尾部（动态行只展示最新进度） */
export const SUBTASK_DELTA_MAX = 500;
/** 子任务 parts 数组上限：超限滚动丢最旧（监视弹窗长跑不爆内存） */
export const SUBTASK_PARTS_MAX = 200;
/** idle 拉取的 summary 截断长度（最后一条 assistant 文本前 500 字符） */
export const SUBTASK_SUMMARY_MAX = 500;

/** 子任务 part（监视弹窗的流式块：text 段落 / thinking 折叠区 / tool 工具卡片） */
export interface SubTaskPart {
  type: "text" | "thinking" | "tool";
  tool?: string;
  state?: string;
  text?: string;
}

/** 子任务（task 派生子 agent 的可视化卡片数据源） */
export interface SubTask {
  id: string;
  /** 子 agent 名（session.created 的 info.agent；未知时默认 '子智能体'） */
  agent: string;
  /** 主会话 id（当前活跃会话，created 事件携带）——详情弹窗「返回主会话」入口 */
  parentId?: string;
  status: "running" | "done";
  /** 会话切换期间子任务事件丢失（规格 4.6 降级态）：恢复时 running 且无 endedAt → 状态未知 */
  stale?: boolean;
  /** 子会话 session.error → 失败标记（卡片显「❌ 失败」） */
  failed?: boolean;
  /** 动态行文本（deltaText 累积，截断尾部保留） */
  deltaText: string;
  /** 有序块流（监视弹窗渲染源，上限滚动；相邻 text/thinking 合并防碎片） */
  parts: SubTaskPart[];
  startedAt: number;
  endedAt?: number;
  /** idle 后从子会话消息拉取的最终摘要（最后 assistant 文本前 500 字符） */
  summary?: string;
  /** idle 拉取摘要失败（与「无 assistant 文本」区分——失败显「摘要获取失败」） */
  summaryFailed?: boolean;
}

// ── 历史子任务提取（D1-D6：重启后/切回旧会话时已完成子会话在消息级可见）──

/** 历史子任务条目（buildSubTaskMap 返回值元素；详情取自 serve 子会话列表） */
export interface HistorySubTask {
  id: string;
  agent: string;
  title: string;
  createdAt: number;
  endedAt?: number;
}

/** buildSubTaskMap 的子会话来源项（session store childSessions 的结构化子集——避免 chat↔session 循环依赖） */
export interface SubTaskChildRef {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  agent?: string;
}

/**
 * 从 task 工具输出文本提取全部子会话 id。
 * serve 在 task tool part 的 output 动态注入 `<task id="ses_xxx" state="completed">`，可含多个。
 */
export function extractSubTaskIds(text: string): string[] {
  const ids: string[] = [];
  const re = /<task id="(ses_[^"]+)"[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    ids.push(m[1]);
  }
  return ids;
}

/**
 * 构建「消息 → 历史子任务」映射。
 * 数据源：assistant 消息的 toolUses（name==='task' 的 result 含 serve 注入的 `<task id>` 输出）
 * + contentBlocks 的 tool_use/tool_result 块（G2 还原后的同一份数据，Set 去重防双计）。
 * children 按 id 补详情（agent/标题/时间）；children 找不到的 task id 跳过（子会话已删除/超限）。
 */
export function buildSubTaskMap(
  messages: Message[],
  children: SubTaskChildRef[]
): Map<string, HistorySubTask[]> {
  const childById = new Map(children.map((c) => [c.id, c]));
  const map = new Map<string, HistorySubTask[]>();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const ids = new Set<string>();
    // 主数据源：toolUses（task 工具的 result 即 serve 输出）
    for (const tu of msg.toolUses) {
      if (tu.name === "task" && tu.result) {
        for (const id of extractSubTaskIds(tu.result)) ids.add(id);
      }
    }
    // 兜底：contentBlocks 时间线块（与 toolUses 同源冗余，但旧存档可能只有 contentBlocks）
    for (const block of msg.contentBlocks ?? []) {
      if (block.type === "tool_use" && block.toolUse?.name === "task" && block.toolUse.result) {
        for (const id of extractSubTaskIds(block.toolUse.result)) ids.add(id);
      }
      if (block.type === "tool_result" && block.toolResult?.content) {
        for (const id of extractSubTaskIds(block.toolResult.content)) ids.add(id);
      }
    }
    if (ids.size === 0) continue;
    const list: HistorySubTask[] = [];
    for (const id of ids) {
      const child = childById.get(id);
      if (!child) continue; // children 缺失跳过（D6 容错）
      list.push({
        id,
        agent: child.agent ?? "",
        title: child.title,
        createdAt: child.createdAt,
        // 子会话无独立结束时间，用会话列表最后更新时间近似（完成后不再更新 ≈ 结束时刻）
        endedAt: child.updatedAt,
      });
    }
    if (list.length > 0) map.set(msg.id, list);
  }
  return map;
}

// ── 待办记录卡提取（v2：serve 消息历史 todowrite 工具卡 → 记录卡，替代 v1 本地快照链路）──

/** 待办记录卡条目（ChatPanel 消息内渲染数据源） */
export interface TodoRecord {
  /** 承载全完成 todowrite 工具卡的消息 id（记录卡贴在该消息后） */
  messageId: string;
  /** 消息时间戳（无则 0——渲染时显示「--:--」） */
  endedAt: number;
  /** 该轮完整待办列表（todowrite input.todos） */
  todos: TodoItem[];
}

/**
 * 从消息流提取「全完成 todowrite」记录卡数据。
 * 遍历消息的 toolUses + contentBlocks（双遍历参考 buildSubTaskMap），找 tool 名（小写化）=== 'todowrite' 的 part。
 * input 容错：{todos:[...]} 对象或 JSON 字符串（parse 失败跳过该条）。
 * 条件：todos 长度 > 0 && every(status === 'completed' || status === 'cancelled') → 产出记录。
 * 同一条工具卡在 toolUses 与 contentBlocks 同源冗余（G2 还原）——按工具 id 去重防双计；
 * 引擎重复写 TodoWrite（不同 id）→ 每条都产（v2 简化，不去重轮次）。
 */
export function extractTodoRecords(messages: Message[]): TodoRecord[] {
  const records: TodoRecord[] = [];
  for (const msg of messages) {
    // 收集本条消息的全部 todowrite 工具 part（toolUses + contentBlocks 的 tool_use 块，按 id 去重防双计）
    const seen = new Set<string>();
    const parts: ToolUse[] = [...msg.toolUses];
    for (const block of msg.contentBlocks ?? []) {
      if (block.type === "tool_use" && block.toolUse) parts.push(block.toolUse);
    }
    for (const part of parts) {
      // 工具名大小写兼容（todowrite / TodoWrite）；id 存在则跳过重复（同源冗余），无 id 时照常处理
      if (!part.name || part.name.toLowerCase() !== "todowrite") continue;
      if (part.id && seen.has(part.id)) continue;
      if (part.id) seen.add(part.id);
      // input 容错：对象 {todos:[...]} 或 JSON 字符串（损坏 parse 失败跳过，不产记录卡）
      const rawTodos = extractTodoInputTodos(part.input);
      if (!rawTodos || rawTodos.length === 0) continue;
      // 全完成条件：所有项 completed/cancelled（任一 pending/in_progress 即不产）
      if (!rawTodos.every((t) => t.status === "completed" || t.status === "cancelled")) continue;
      records.push({ messageId: msg.id, endedAt: msg.timestamp || 0, todos: rawTodos });
    }
  }
  return records;
}

/** 从 todowrite input 提取 todos 数组：对象直接取 .todos；JSON 字符串 parse 后取（损坏/结构不符 → null） */
function extractTodoInputTodos(input: unknown): TodoItem[] | null {
  if (input === null || input === undefined) return null;
  let obj: unknown = input;
  if (typeof input === "string") {
    try {
      obj = JSON.parse(input);
    } catch {
      // JSON 字符串损坏 → 跳过该条（不产记录卡，规格异常流程 6.2）
      return null;
    }
  }
  if (typeof obj !== "object" || obj === null) return null;
  const todos = (obj as { todos?: unknown }).todos;
  return Array.isArray(todos) ? (todos as TodoItem[]) : null;
}

export const useChatStore = defineStore("chat", () => {
  const messages = ref<Message[]>([]);
  /** 全量历史缓存（进入会话一次拉取 ≤FULL_HISTORY_LIMIT，不渲染 DOM，供滚动到顶切片与时间线索引） */
  const fullHistory = ref<Message[]>([]);
  /** 已从 fullHistory 尾部加载显示到 messages 的条数（含 prepend 累计），决定下次切片起点 */
  const loadedFromFull = ref(0);
  const currentAssistantMsg = ref<Message | null>(null);
  const isProcessing = ref(false);
  /** 历史消息加载失败标记（serve 未就绪时 message:list 报错）——消息区展示离线占位而非正常空态 */
  const historyError = ref(false);
  /** 历史消息加载中标记（切会话全量拉取 message:list 期间）——消息区展示加载占位，避免「白屏等待」误判 */
  const historyLoading = ref(false);
  // CC 工作清单（TodoWrite / TaskCreate → 前端实时展示）
  const todos = ref<TodoItem[]>([]);
  // 待办记录卡（从 serve 消息历史 todowrite 工具卡提取——v2 移除本地快照链路；ChatPanel 消息内渲染数据源）
  const todoRecords = ref<TodoRecord[]>([]);
  // 子任务（task 派生子 agent）可视化：subId → SubTask（serve 广播事件累积，idle 后拉摘要）
  const subTasks = ref<Record<string, SubTask>>({});
  // 审批队列：防止子 agent 并发 control_request 互相覆盖
  const pendingControlRequests = ref<ControlRequest[]>([]);
  // 兼容旧引用：队列头即当前待审批项
  const pendingControlRequest = computed(() =>
    pendingControlRequests.value.length > 0 ? pendingControlRequests.value[0] : null
  );

  // 会话消息缓存：切换会话时保留进行中的流式消息、工作清单和子任务卡（DB 只有已完成的消息）
  const sessionCache = new Map<string, { messages: Message[]; todos: TodoItem[]; subTasks: Record<string, SubTask> }>();
  const MAX_CACHE_SIZE = 20; // LRU 淘汰上限

  /** 将当前消息、工作清单和子任务深拷贝存入缓存（切换会话前调用） */
  function saveSessionCache(sessionId: string) {
    if (!sessionId) return;
    sessionCache.set(sessionId, {
      messages: JSON.parse(JSON.stringify(messages.value)),
      todos: JSON.parse(JSON.stringify(todos.value)),
      subTasks: JSON.parse(JSON.stringify(subTasks.value)),
    });
    // LRU 淘汰：超出上限时删除最旧条目
    if (sessionCache.size > MAX_CACHE_SIZE) {
      const firstKey = sessionCache.keys().next().value;
      if (firstKey) sessionCache.delete(firstKey);
    }
  }

  /** 从缓存恢复消息、工作清单和子任务；缓存无数据则返回 null。命中时将条目移到 LRU 末尾 */
  function loadFromCache(sessionId: string): Message[] | null {
    const cached = sessionCache.get(sessionId);
    if (cached) {
      // LRU: 删除后重新插入，使其成为最新条目
      sessionCache.delete(sessionId);
      sessionCache.set(sessionId, cached);
      todos.value = cached.todos;
      subTasks.value = cached.subTasks || {};
      // #4 降级态：恢复时仍 running 且无 endedAt → 子任务事件在切走期间丢失（规格 4.6 状态未知）
      for (const t of Object.values(subTasks.value)) {
        if (t.status === "running" && !t.endedAt) t.stale = true;
      }
      return cached.messages;
    }
    return null;
  }

  /** 清空全部会话缓存（数据模式切换后旧数据目录的会话缓存已失效——serve 数据目录已切换） */
  function clearSessionCache() {
    sessionCache.clear();
  }

  /**
   * 处理后台会话的流式事件（当前活跃会话不是该 session 时调用）。
   * 将增量数据写入 sessionCache，切回时 loadFromCache 即可恢复完整状态。
   */
  // event 用 any 避免跨模块类型依赖
  function handleBackgroundStreamEvent(sessionId: string, event: any) {
    const cached = sessionCache.get(sessionId);
    const cachedMessages = cached?.messages || [];
    const cachedTodos = cached?.todos || [];
    let last = cachedMessages[cachedMessages.length - 1];

    if (event.type === 'assistant') {
      // 确保有进行中的 assistant 消息
      if (!last || last.role !== 'assistant' || !last.isStreaming) {
        last = {
          id: genId(), role: 'assistant', content: '', thinking: '',
          toolUses: [], timestamp: Date.now(), isStreaming: true,
        };
        cachedMessages.push(last);
      }
      // 文本去重（同 useStreamProcessor 逻辑）
      if (event.text) {
        if (last.content && event.text.startsWith(last.content)) {
          const newPart = event.text.slice(last.content.length);
          if (newPart) last.content += newPart;
        } else {
          last.content += event.text;
        }
      }
      // thinking 去重
      if (event.thinking) {
        if (last.thinking && event.thinking.startsWith(last.thinking)) {
          const newPart = event.thinking.slice(last.thinking.length);
          if (newPart) last.thinking += newPart;
        } else {
          last.thinking += event.thinking;
        }
      }
      if (event.tool_use) {
        for (const tu of event.tool_use) {
          last.toolUses.push({ id: tu.id, name: tu.name, input: tu.input || {} });
        }
      }
      if (event.input_tokens != null) last.inputTokens = event.input_tokens;
      if (event.output_tokens != null) last.outputTokens = event.output_tokens;
      if (event.cost_usd != null) last.costUSD = event.cost_usd;
    } else if (event.type === 'user' && event.tool_results) {
      // 后台会话：追加工具执行结果（无对应 assistant 消息时跳过，不创建幽灵消息）
      if (!last || last.role !== 'assistant') return;
      for (const tr of event.tool_results) {
        const tu = last.toolUses.find((t: ToolUse) => t.id === tr.tool_use_id);
        if (tu) {
          tu.result = tr.content;
          tu.isError = tr.is_error;
        }
        if (last.contentBlocks) {
          last.contentBlocks.push({
            type: 'tool_result',
            toolResult: { toolUseId: tr.tool_use_id, content: tr.content, isError: tr.is_error },
          });
        }
      }
    } else if (event.type === 'result' || event.type === 'done') {
      if (last && last.isStreaming) {
        last.isStreaming = false;
        last.durationMs = event.duration_ms;
        last.inputTokens = event.input_tokens ?? last.inputTokens;
        last.outputTokens = event.output_tokens ?? last.outputTokens;
        last.costUSD = event.cost_usd ?? last.costUSD;
        // 后台会话可能没有 content_blocks，从旧字段合成
        if (!last.contentBlocks?.length) {
          last.contentBlocks = synthesizeBlocks(last.thinking, last.toolUses, last.content);
        }
      }
    } else if (event.type === 'error') {
      if (last && last.isStreaming) {
        last.content += `\n\n> ⚠️ ${event.error || 'Unknown error'}`;
        last.isStreaming = false;
      }
    } else if (event.type === 'token_usage') {
      if (last) {
        if (event.input_tokens != null) last.inputTokens = event.input_tokens;
        if (event.output_tokens != null) last.outputTokens = event.output_tokens;
      }
    } else if (event.type === 'todo' && Array.isArray(event.todos)) {
      // 后台会话：serve 原生 todo.updated → 整体覆盖缓存工作清单（切回时 loadFromCache 恢复）
      cachedTodos.splice(0, cachedTodos.length,
        ...(event.todos as Array<{ content: string; status: string; priority?: string }>).map(t => ({
          content: t.content,
          status: t.status as TodoItem["status"],
          activeForm: t.content,
          priority: t.priority as TodoItem["priority"],
        })),
      );
    }

    // 后台会话也拦截 TodoWrite / TaskCreate / TaskUpdate 更新工作清单
    if (event.tool_use) {
      for (const tu of event.tool_use) {
        const input = tu.input || {};
        if (tu.name === "TodoWrite" && Array.isArray(input.todos)) {
          cachedTodos.splice(0, cachedTodos.length, ...input.todos as TodoItem[]);
        } else if (tu.name === "TaskCreate" && typeof input.subject === "string") {
          cachedTodos.push({ content: input.subject, status: "pending" as const, activeForm: (input.activeForm as string) || input.subject, taskId: input.taskId as string | undefined });
        } else if (tu.name === "TaskUpdate" && typeof input.taskId === "string") {
          const idx = cachedTodos.findIndex(t => t.taskId === input.taskId);
          if (idx >= 0 && typeof input.status === "string") {
            cachedTodos[idx] = { ...cachedTodos[idx], status: input.status as TodoItem["status"] };
          }
        }
      }
    }

    // 后台会话消息/工作清单增量写回缓存（切回时 loadFromCache 恢复）。
    // 注意：不再写 subTasks——子任务卡归属父会话（parentId），由 handleSubTaskEvent 按 parentId 写缓存，
    // 此处若写当前 subTasks.value（切走后已是别的会话）会把错误数据覆盖进本会话缓存（军师 #1）
    sessionCache.set(sessionId, {
      messages: cachedMessages,
      todos: cachedTodos,
      subTasks: cached?.subTasks || {},
    });
  }

  // ── 子任务（子智能体）事件处理 ──

  /**
   * 处理 serve 广播的子会话活动（type='subtask'，主进程 events.ts 识别）。
   * 异步（idle 拉摘要）——调用方（useStreamProcessor）不 await，避免阻塞事件循环。
   * @param activeSessionId 当前活跃会话 id（useStreamProcessor 传入）——决定 created 卡归属视图还是仅缓存：
   *   parentId === activeSessionId → 卡显示在消息流；切走后（parentId ≠ 活跃）→ 只写父会话缓存（#1/#2）
   */
  async function handleSubTaskEvent(
    evt: {
      subId?: string;
      kind?: string;
      agent?: string;
      parentId?: string;
      text?: string;
      part?: SubTaskPart | { type: string; tool?: string; state?: string; text?: string };
    },
    activeSessionId = "",
  ) {
    const subId = evt?.subId;
    if (!subId) return;
    const kind = evt?.kind;
    const parentId = evt?.parentId;

    if (kind === "created") {
      // #7 去重：重复 created（重连后 serve 重发）→ 跳过，不重置已累积进度
      const existing = subTasks.value[subId] || (parentId ? sessionCache.get(parentId)?.subTasks?.[subId] : undefined);
      if (existing) {
        // 仅补缺失字段（agent/parentId），不重置 deltaText/parts/status
        if (evt.agent && !existing.agent) existing.agent = evt.agent;
        if (parentId && !existing.parentId) existing.parentId = parentId;
        return;
      }
      const task: SubTask = {
        id: subId,
        agent: evt.agent || "子智能体",
        parentId,
        status: "running",
        deltaText: "",
        parts: [],
        startedAt: Date.now(),
      };
      // 归属：无 parentId（旧事件/测试语义）或父会话是当前活跃 → 显示在视图；
      // 切走后（parentId ≠ 活跃）→ 只进父缓存（防污染当前会话消息流）
      const isActiveParent = !parentId || parentId === activeSessionId;
      if (isActiveParent) {
        subTasks.value = { ...subTasks.value, [subId]: task };
      }
      // 持久归属：写父会话缓存（切走后事件也累积到同一卡；同引用，视图/缓存双写一致）
      if (parentId) {
        let entry = sessionCache.get(parentId);
        if (!entry) {
          entry = { messages: [], todos: [], subTasks: {} };
          sessionCache.set(parentId, entry);
        }
        entry.subTasks = entry.subTasks || {};
        entry.subTasks[subId] = task;
      }
      return;
    }

    // 非 created：先找当前视图（活跃父会话），再找父缓存（切走后事件）
    const findTask = (): SubTask | undefined =>
      subTasks.value[subId] || (parentId ? sessionCache.get(parentId)?.subTasks?.[subId] : undefined);

    const task = findTask();
    if (!task) return; // created 未到（异常乱序）→ 忽略后续增量

    if (kind === "delta") {
      // 打字机增量：deltaText 累积（截断尾部保留）+ parts 追加（相邻 text 自动合并防碎片）
      const text = evt.text ?? "";
      if (!text) return;
      task.deltaText = (task.deltaText + text).slice(-SUBTASK_DELTA_MAX);
      pushSubTaskPart(task, { type: "text", text });
      return;
    }

    if (kind === "part") {
      const part = evt.part;
      if (!part) return;
      if (part.type === "text" && part.text) {
        // #6 updated 全量去重：已累积 deltaText 以全量开头 → 只取新后缀（对齐 MessageBubble text 模式）
        const existing = task.deltaText;
        if (existing && part.text.startsWith(existing)) {
          const suffix = part.text.slice(existing.length);
          if (suffix) {
            task.deltaText = (task.deltaText + suffix).slice(-SUBTASK_DELTA_MAX);
            pushSubTaskPart(task, { type: "text", text: suffix });
          }
          // suffix 空 → 全量等于增量，跳过（避免重复）
        } else {
          task.deltaText = (task.deltaText + part.text).slice(-SUBTASK_DELTA_MAX);
          pushSubTaskPart(task, { type: "text", text: part.text });
        }
      } else if (part.type === "thinking" && part.text) {
        // thinking 折叠：相邻 thinking 合并（连续 updated 追加到同一块）
        pushSubTaskPart(task, { type: "thinking", text: part.text });
      } else if (part.type === "tool") {
        // tool 记录：工具名 + state（task 无 tool part 流转，但其他子 agent 可能有）
        pushSubTaskPart(task, { type: "tool", tool: part.tool, state: part.state });
      }
      return;
    }

    if (kind === "error") {
      // #5 子会话 session.error → 失败标记（卡片显「❌ 失败」）
      task.status = "done";
      task.endedAt = Date.now();
      task.failed = true;
      task.summary = undefined;
      task.summaryFailed = false;
      return;
    }

    if (kind === "idle") {
      // 完成：标记 done + 拉摘要（最后 assistant 文本前 500 字符）
      task.status = "done";
      task.endedAt = Date.now();
      try {
        const msgs = await listMessages(subId);
        // #3 异步竞态：await 期间可能切走/卡片被重排 → 重新取引用再写，不写已脱离的对象
        const liveTask = findTask();
        if (!liveTask) return;
        const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
        if (lastAssistant && String(lastAssistant.content || "").trim()) {
          liveTask.summary = String(lastAssistant.content || "").slice(0, SUBTASK_SUMMARY_MAX);
          liveTask.summaryFailed = false; // #9：有文本
        } else {
          liveTask.summary = undefined; // #9：无 assistant 文本 → 「无摘要」
          liveTask.summaryFailed = false;
        }
      } catch (err) {
        // #9 摘要获取失败（与「无文本」区分）：显「摘要获取失败」；日志带 subId 上下文（排查弹窗/卡片异常用）
        const liveTask = findTask();
        if (!liveTask) return;
        liveTask.summary = undefined;
        liveTask.summaryFailed = true;
        console.error("[subtask] 摘要获取失败", subId, err);
      }
    }
  }

  /** 追加子任务 part，超上限滚动丢最旧；相邻同类（text/thinking）合并防碎片（#6） */
  function pushSubTaskPart(task: SubTask, part: SubTaskPart) {
    const last = task.parts[task.parts.length - 1];
    if ((part.type === "text" || part.type === "thinking") && last?.type === part.type) {
      last.text = (last.text || "") + (part.text || "");
    } else {
      task.parts.push({ ...part });
    }
    if (task.parts.length > SUBTASK_PARTS_MAX) {
      task.parts.splice(0, task.parts.length - SUBTASK_PARTS_MAX);
    }
  }

  /**
   * 将 CC content_blocks 合并到消息的 contentBlocks 时间线。
   * CC 的完整 assistant 事件包含所有块的最新状态，直接覆盖。
   */
  function setContentBlocks(blocks: ContentBlock[]) {
    if (!currentAssistantMsg.value) return;
    currentAssistantMsg.value.contentBlocks = blocks;
  }

  function addUserMessage(content: string, attachments?: AttachedFile[]): string {
    const id = genId();
    messages.value.push({
      id,
      role: "user",
      content,
      thinking: "",
      toolUses: [],
      timestamp: Date.now(),
      isStreaming: false,
      attachments: attachments?.length ? attachments : undefined,
    });
    return id;
  }

  function startAssistantMessage(): string {
    const id = genId();
    const msg: Message = {
      id,
      role: "assistant",
      content: "",
      thinking: "",
      toolUses: [],
      timestamp: Date.now(),
      isStreaming: true,
    };
    currentAssistantMsg.value = msg;
    messages.value.push(msg);
    isProcessing.value = true;  // 中途发送场景：CC 完成上一轮后继续下一轮时恢复 isProcessing
    return id;
  }

  function appendText(text: string) {
    if (!currentAssistantMsg.value) startAssistantMessage();
    currentAssistantMsg.value!.content += text;
  }

  function appendThinking(thinking: string) {
    if (!currentAssistantMsg.value) startAssistantMessage();
    currentAssistantMsg.value!.thinking += thinking;
  }

  function addToolUse(tool: ToolUse) {
    if (!currentAssistantMsg.value) startAssistantMessage();
    currentAssistantMsg.value!.toolUses.push(tool);
    // 追踪 agent 使用：tool name 可能是 Agent 或 Task
    if ((tool.name === "Agent" || tool.name === "Task") && tool.input) {
      const agentType = (tool.input as any).subagent_type || (tool.input as any).agent_type;
      if (agentType && typeof agentType === "string") {
        const next = new Set(usedAgents.value);
        next.add(agentType);
        usedAgents.value = next;
      }
    }
  }

  /** 从 TodoWrite / TaskCreate 工具调用中提取工作清单 */
  function updateTodosFromTool(name: string, input: Record<string, unknown>) {
    if (name === "TodoWrite" && Array.isArray(input.todos)) {
      todos.value = input.todos as TodoItem[];
    } else if (name === "TaskCreate" && typeof input.subject === "string") {
      todos.value.push({
        content: input.subject as string,
        status: "pending",
        activeForm: (input.activeForm as string) || input.subject as string,
        taskId: input.taskId as string | undefined,
      });
    } else if (name === "TaskUpdate" && typeof input.taskId === "string") {
      const idx = todos.value.findIndex(t => t.taskId === input.taskId);
      if (idx >= 0 && typeof input.status === "string") {
        todos.value[idx] = { ...todos.value[idx], status: input.status as TodoItem["status"] };
      }
    }
  }

  /** serve 原生 todo.updated 事件 → 整体覆盖工作清单（status 含 cancelled；无 activeForm/taskId 的 CC 扩展字段） */
  function setTodos(updated: Array<{ content: string; status: string; priority?: string }>) {
    todos.value = updated.map(t => ({
      content: t.content,
      status: t.status as TodoItem["status"],
      activeForm: t.content,
      priority: t.priority as TodoItem["priority"],
    }));
  }

  /**
   * 会话收尾补偿（用户 2026-08-09 拍板方案）：todo 只剩最后一项未完成且回合已结束 → 视为完成。
   * 依据：模型收尾步习惯性漏勾 TodoWrite（社区 #28961/#27560 确认的 DeepSeek 系行为——任务实际
   * 做完但最后一步不勾）；中间步骤未完成不处理——可能是真没做完，保留 serve 真实状态。
   * cancelled/deleted 不参与判定；唯一未完成项必须是数组最后一项（前面全部完成）才补勾。
   */
  function settleIncompleteFinalTodo() {
    const list = todos.value.filter(t => t.status !== "cancelled" && t.status !== "deleted");
    const last = list[list.length - 1];
    if (!last) return;
    const uncompleted = list.filter(t => t.status !== "completed");
    // 引用比较成立：filter 不复制对象，uncompleted[0] 与 last 是同一元素
    if (uncompleted.length === 1 && uncompleted[0] === last) {
      last.status = "completed";
    }
  }

  /**
   * 全量重建待办记录卡（调 extractTodoRecords 提取 serve 消息历史中的全完成 todowrite 工具卡）。
   * 调用时机：loadMessages/loadFullHistory 后 + ChatPanel 消息流 watch（消息量 ≤500，全量重提取可接受）。
   */
  function refreshTodoRecords(msgs: Message[]) {
    todoRecords.value = extractTodoRecords(msgs);
  }

  /** 追加工具执行结果，同时更新 toolUses 数组和 contentBlocks 时间线 */
  function appendToolResult(toolUseId: string, content: string, isError?: boolean) {
    const msg = currentAssistantMsg.value;
    if (!msg) return;

    // 1. 更新 toolUses 数组中对应工具的 result
    const toolUse = msg.toolUses.find(t => t.id === toolUseId);
    if (toolUse) {
      toolUse.result = content;
      toolUse.isError = isError;
    }

    // 2. 初始化 contentBlocks（如果需要）
    if (!msg.contentBlocks) {
      msg.contentBlocks = [];
    }
    // 3. 在 contentBlocks 末尾追加 tool_result 块
    msg.contentBlocks.push({
      type: "tool_result",
      toolResult: {
        toolUseId,
        content,
        isError,
      },
    });
  }

  function markStopped() {
    if (currentAssistantMsg.value) {
      currentAssistantMsg.value.wasStopped = true;
    }
  }

  function finishAssistantMessage(durationMs?: number, inputTokens?: number, outputTokens?: number, costUSD?: number) {
    if (currentAssistantMsg.value) {
      const msg = currentAssistantMsg.value;
      // 空消息（无内容、无思考、无工具调用）→ 删除，不留残留气泡
      if (!msg.content && !msg.thinking && !msg.toolUses.length) {
        const idx = messages.value.indexOf(msg);
        if (idx !== -1) messages.value.splice(idx, 1);
      } else {
        msg.isStreaming = false;
        msg.durationMs = durationMs;
        msg.inputTokens = inputTokens;
        msg.outputTokens = outputTokens;
        msg.costUSD = costUSD;
      }
    }
    currentAssistantMsg.value = null;
    isProcessing.value = false;
  }

  function addControlRequest(cr: ControlRequest) {
    pendingControlRequests.value = [...pendingControlRequests.value, cr];
  }

  function resolveControlRequest(resolution: string) {
    if (pendingControlRequests.value.length > 0) {
      pendingControlRequests.value[0].resolution = resolution;
      pendingControlRequests.value = pendingControlRequests.value.slice(1);
    }
  }

  /** 当前会话中使用过的 agent 类型（如 "pr-review-toolkit:code-simplifier"） */
  const usedAgents = ref<Set<string>>(new Set());

  function clearMessages() {
    messages.value = [];
    todos.value = [];
    todoRecords.value = [];
    currentAssistantMsg.value = null;
    isProcessing.value = false;
    pendingControlRequests.value = [];
    usedAgents.value = new Set();
    subTasks.value = {};
    // 切会话/清空时重置分页与内存全量状态（避免旧会话"还有更早/全量缓存/时间线"残留到新会话）
    hasMoreHistory.value = false;
    fullHistory.value = [];
    loadedFromFull.value = 0;
  }

  /** 设置历史消息加载失败标记（true=serve 未就绪，消息区灰显离线占位；false=恢复可加载） */
  function setHistoryError(v: boolean) {
    historyError.value = v;
  }

  function setHistoryLoading(v: boolean) {
    historyLoading.value = v;
  }

  /** Update a specific message's content (for edit) */
  function updateMessage(id: string, content: string) {
    const msg = messages.value.find(m => m.id === id);
    if (msg) msg.content = content;
  }

  /** Remove all messages after (and including) the given index. Returns the removed count. */
  function truncateFromIndex(index: number): number {
    if (index < 0 || index >= messages.value.length) return 0;
    const removed = messages.value.length - index;
    messages.value.splice(index, removed);
    if (currentAssistantMsg.value && !messages.value.includes(currentAssistantMsg.value)) {
      currentAssistantMsg.value = null;
    }
    return removed;
  }

  /** Remove all messages after the given message ID (exclusive — keeps the message itself) */
  function truncateAfterMessage(id: string): number {
    const idx = messages.value.findIndex(m => m.id === id);
    if (idx < 0) return 0;
    return truncateFromIndex(idx + 1);
  }

  /**
   * Build an export Markdown string for the current session.
   * Includes thinking blocks, tool uses, and token stats.
   */
  function exportMarkdown(sessionTitle: string): string {
    const lines: string[] = [];
    lines.push(`# ${sessionTitle}`);
    lines.push(`> Exported at ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`);
    lines.push('');
    for (const msg of messages.value) {
      const roleLabel = msg.role === 'user' ? '## You' : '## 分形';
      lines.push(roleLabel);
      if (msg.thinking) {
        lines.push('');
        lines.push('> **Thinking:**');
        lines.push('> ' + msg.thinking.replace(/\n/g, '\n> '));
      }
      if (msg.toolUses.length > 0) {
        lines.push('');
        for (const tu of msg.toolUses) {
          lines.push(`> 🔧 **${tu.name}**`);
          const preview = JSON.stringify(tu.input, null, 2);
          lines.push('> ```json');
          lines.push('> ' + preview.replace(/\n/g, '\n> '));
          lines.push('> ```');
          if (tu.result) {
            const shortResult = tu.result.length > 500 ? tu.result.slice(0, 500) + '…' : tu.result;
            lines.push('> **Result:**');
            lines.push('> ```');
            lines.push('> ' + shortResult.replace(/\n/g, '\n> '));
            lines.push('> ```');
          }
        }
      }
      if (msg.content) {
        lines.push('');
        lines.push(msg.content);
      }
      if (msg.role === 'assistant' && !msg.isStreaming) {
        const stats: string[] = [];
        if (msg.durationMs) stats.push(`⏱ ${(msg.durationMs / 1000).toFixed(1)}s`);
        if (msg.inputTokens) stats.push(`↑${msg.inputTokens}`);
        if (msg.outputTokens) stats.push(`↓${msg.outputTokens}`);
        if (msg.costUSD !== undefined) stats.push(`$${msg.costUSD.toFixed(4)}`);
        if (stats.length) lines.push(`\n*${stats.join(' | ')}*`);
      }
      lines.push('');
      lines.push('---');
      lines.push('');
    }
    return lines.join('\n');
  }

  /**
   * 从旧格式字段重建 contentBlocks 时间线（thinking → tools → text）。
   * 用于无 content_blocks 的历史消息和新协议未启用的后端。
   */
  function synthesizeBlocks(thinking: string, toolUses: ToolUse[], text: string): ContentBlock[] {
    const blocks: ContentBlock[] = [];
    if (thinking) blocks.push({ type: "thinking", content: thinking });
    for (const tu of toolUses) {
      blocks.push({ type: "tool_use", toolUse: tu });
      // 如果从 JSON blob 恢复了 tool_result 数据，也一起合成
      if (tu.result !== undefined) {
        blocks.push({
          type: "tool_result",
          toolResult: {
            toolUseId: tu.id,
            content: tu.result || "",
            isError: tu.isError,
          },
        });
      }
    }
    if (text) blocks.push({ type: "text", content: text });
    return blocks;
  }

  /** 是否还有更早消息（首屏尾部 50 条未达全量 → 还有更早；已到顶 → false） */
  const hasMoreHistory = ref(false);

  /** 设置是否还有更早消息 */
  function setHasMoreHistory(v: boolean) {
    hasMoreHistory.value = v;
  }

  /**
   * 将单个历史消息记录还原为 Message（JSON blob 解析 + contentBlocks 重建）。
   * loadMessages（全量清空重载）与 prependMessages（头部拼接加载更早）共用同一解析逻辑。
   */
  function recordToMessage(rec: { id: string; role: string; content: string; created_at: string }): Message {
    let textContent = rec.content;
    let thinking = "";
    let toolUses: ToolUse[] = [];
    let durationMs: number | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let costUSD: number | undefined;

    // Try to parse JSON for assistant messages (new format)
    let attachments: AttachedFile[] | undefined;
    let contentBlocks: ContentBlock[] | undefined;

    // Try JSON parse for both user and assistant messages
    try {
      const parsed = JSON.parse(rec.content);
      if (parsed && typeof parsed === "object") {
        if (rec.role === "assistant") {
          textContent = parsed.text || "";
          thinking = parsed.thinking || "";
          toolUses = parsed.toolUses || [];
          durationMs = parsed.durationMs;
          inputTokens = parsed.inputTokens;
          outputTokens = parsed.outputTokens;
          costUSD = parsed.costUSD;
          // 新存档已有 contentBlocks，旧存档从现有字段重建时间线
          contentBlocks = parsed.contentBlocks || synthesizeBlocks(thinking, toolUses, textContent);
        } else if (rec.role === "user" && Array.isArray(parsed.attachments)) {
          textContent = parsed.text || "";
          attachments = parsed.attachments;
        }
      }
    } catch {
      // Old format: plain text, use as-is
    }
    // 纯文本旧格式也重建时间线
    if (rec.role === "assistant" && !contentBlocks) {
      contentBlocks = synthesizeBlocks(thinking, toolUses, textContent);
    }

    return {
      id: rec.id,
      role: rec.role as "user" | "assistant",
      content: textContent,
      thinking,
      toolUses,
      contentBlocks,
      timestamp: new Date(rec.created_at + "Z").getTime(),
      isStreaming: false,
      durationMs,
      inputTokens,
      outputTokens,
      costUSD,
      attachments,
    };
  }

  /** Restore messages from database records */
  function loadMessages(records: Array<{ id: string; role: string; content: string; created_at: string }>) {
    clearMessages();
    for (const rec of records) {
      messages.value.push(recordToMessage(rec));
    }
  }

  /**
   * 头部拼接更早消息（滚动到顶加载历史用，不清空现有消息）。
   * records 按时间升序（旧→新），unshift 从后往前保证最终顺序仍为旧→新。
   */
  function prependMessages(records: Array<{ id: string; role: string; content: string; created_at: string }>) {
    for (let i = records.length - 1; i >= 0; i--) {
      messages.value.unshift(recordToMessage(records[i]));
    }
  }

  /**
   * 时间线全量索引：fullHistory 全量锚点 + messages 中超出 fullHistory 的新消息（流式新增）锚点合并去重。
   * preview = content 前 80 字——50 条外锚点的 tooltip 数据源（messages 只渲染尾部，query 不到更早内容）。
   * 流式消息在 messages 尾部 push 但不在 fullHistory（DB 尚未落库），需要追加锚点保证时间线完整。
   */
  const timelineIndex = computed<Array<{ id: string; created: number; role: string; preview: string }>>(() => {
    const fullIds = new Set(fullHistory.value.map(m => m.id));
    const toAnchor = (m: Message) => ({ id: m.id, created: m.timestamp || 0, role: m.role, preview: (m.content || "").slice(0, 80) });
    return [
      ...fullHistory.value.map(toAnchor),
      ...messages.value
        .filter(m => !fullIds.has(m.id))
        .map(toAnchor),
    ];
  });

  /**
   * 全量历史加载（进入会话时一次拉取 ≤FULL_HISTORY_LIMIT）：
   * fullHistory 存全量（内存缓存 + timelineIndex 索引源），DOM 仍只渲染尾部 50 条（内存分页，秒出）。
   * 内部 clearMessages 清空旧会话残留并负责 setHistoryLoading(false)，调用处勿重复设置。
   */
  function loadFullHistory(records: Array<{ id: string; role: string; content: string; created_at: string }>) {
    clearMessages();
    fullHistory.value = records.map(recordToMessage);
    // 首屏只渲染尾部 50 条，其余留在内存供滚动到顶与时间线跳转切片
    messages.value = fullHistory.value.slice(-50);
    loadedFromFull.value = Math.min(50, fullHistory.value.length);
    setHasMoreHistory(fullHistory.value.length > 50);
    setHistoryLoading(false);
  }

  /**
   * 从 fullHistory 内存切片更早消息（同步、无网络），prepend 到头部保持旧→新顺序。
   * 返回 true=切出内容；false=已到顶（无更多历史）。
   */
  function prependFromFullHistory(): boolean {
    // 已加载数量达到全量 → 没有更早消息
    if (loadedFromFull.value >= fullHistory.value.length) return false;
    const next = fullHistory.value.slice(
      Math.max(0, fullHistory.value.length - loadedFromFull.value - 50),
      fullHistory.value.length - loadedFromFull.value,
    );
    if (next.length === 0) return false;
    // next 已是旧→新，从后往前 unshift 保证整体仍为旧→新
    for (let i = next.length - 1; i >= 0; i--) {
      messages.value.unshift(next[i]);
    }
    loadedFromFull.value += next.length;
    setHasMoreHistory(loadedFromFull.value < fullHistory.value.length);
    return true;
  }

  return {
    messages,
    fullHistory,
    loadedFromFull,
    timelineIndex,
    currentAssistantMsg,
    isProcessing,
    historyError,
    setHistoryError,
    historyLoading,
    setHistoryLoading,
    hasMoreHistory,
    setHasMoreHistory,
    todos,
    todoRecords,
    refreshTodoRecords,
    pendingControlRequest,
    pendingControlRequests,
    addUserMessage,
    startAssistantMessage,
    appendText,
    appendThinking,
    addToolUse,
    appendToolResult,
    setContentBlocks,
    addControlRequest,
    resolveControlRequest,
    setTodos,
    settleIncompleteFinalTodo,
    markStopped,
    finishAssistantMessage,
    updateTodosFromTool,
    usedAgents,
    subTasks,
    handleSubTaskEvent,
    clearMessages,
    loadMessages,
    prependMessages,
    loadFullHistory,
    prependFromFullHistory,
    saveSessionCache,
    loadFromCache,
    clearSessionCache,
    handleBackgroundStreamEvent,
    sessionCache,
    updateMessage,
    truncateFromIndex,
    truncateAfterMessage,
    exportMarkdown,
  };
});
