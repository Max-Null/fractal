import { defineStore } from "pinia";
import { ref, computed } from "vue";

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
}

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

/** CC TodoWrite / TaskCreate 工具产出的工作清单项 */
export interface TodoItem {
  content: string
  status: "pending" | "in_progress" | "completed" | "deleted"
  activeForm: string
  /** TaskCreate/TaskUpdate 使用的任务 ID（TodoWrite 无此字段） */
  taskId?: string
}

export const useChatStore = defineStore("chat", () => {
  const messages = ref<Message[]>([]);
  const currentAssistantMsg = ref<Message | null>(null);
  const isProcessing = ref(false);
  // CC 工作清单（TodoWrite / TaskCreate → 前端实时展示）
  const todos = ref<TodoItem[]>([]);
  // 审批队列：防止子 agent 并发 control_request 互相覆盖
  const pendingControlRequests = ref<ControlRequest[]>([]);
  // 兼容旧引用：队列头即当前待审批项
  const pendingControlRequest = computed(() =>
    pendingControlRequests.value.length > 0 ? pendingControlRequests.value[0] : null
  );

  // 会话消息缓存：切换会话时保留进行中的流式消息和工作清单（DB 只有已完成的消息）
  const sessionCache = new Map<string, { messages: Message[]; todos: TodoItem[] }>();
  const MAX_CACHE_SIZE = 20; // LRU 淘汰上限

  /** 将当前消息和工作清单深拷贝存入缓存（切换会话前调用） */
  function saveSessionCache(sessionId: string) {
    if (!sessionId) return;
    sessionCache.set(sessionId, {
      messages: JSON.parse(JSON.stringify(messages.value)),
      todos: JSON.parse(JSON.stringify(todos.value)),
    });
    // LRU 淘汰：超出上限时删除最旧条目
    if (sessionCache.size > MAX_CACHE_SIZE) {
      const firstKey = sessionCache.keys().next().value;
      if (firstKey) sessionCache.delete(firstKey);
    }
  }

  /** 从缓存恢复消息和工作清单；缓存无数据则返回 null。命中时将条目移到 LRU 末尾 */
  function loadFromCache(sessionId: string): Message[] | null {
    const cached = sessionCache.get(sessionId);
    if (cached) {
      // LRU: 删除后重新插入，使其成为最新条目
      sessionCache.delete(sessionId);
      sessionCache.set(sessionId, cached);
      todos.value = cached.todos;
      return cached.messages;
    }
    return null;
  }

  /**
   * 处理后台会话的流式事件（当前活跃会话不是该 session 时调用）。
   * 将增量数据写入 sessionCache，切回时 loadFromCache 即可恢复完整状态。
   */
  // ponytail: event 用 any 避免跨模块类型依赖
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

    sessionCache.set(sessionId, { messages: cachedMessages, todos: cachedTodos });
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
    currentAssistantMsg.value = null;
    isProcessing.value = false;
    pendingControlRequests.value = [];
    usedAgents.value = new Set();
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
      const roleLabel = msg.role === 'user' ? '## You' : '## Claude';
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

  /** Restore messages from database records */
  function loadMessages(records: Array<{ id: string; role: string; content: string; created_at: string }>) {
    clearMessages();
    for (const rec of records) {
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

      messages.value.push({
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
      });
    }
  }

  return {
    messages,
    currentAssistantMsg,
    isProcessing,
    todos,
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
    markStopped,
    finishAssistantMessage,
    updateTodosFromTool,
    usedAgents,
    clearMessages,
    loadMessages,
    saveSessionCache,
    loadFromCache,
    handleBackgroundStreamEvent,
    sessionCache,
    updateMessage,
    truncateFromIndex,
    truncateAfterMessage,
    exportMarkdown,
  };
});
