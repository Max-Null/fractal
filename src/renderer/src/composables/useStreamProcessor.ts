import { useI18n } from "vue-i18n";
import { useChatStore, type ToolUse, type ContentBlock, type ToolResult } from "@/stores/chat";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import { useDebugLog } from "@/composables/useDebugLog";
import { useStderrLog } from "@/composables/useStderrLog";
import { saveMessage, saveSessionDebugLog, saveSessionStderrLog, listMessages, type StreamEvent, type ProcessExitedEvent } from "@/lib/electron-bridge";
import { translateError } from "@/lib/utils";

let unlisten: (() => void) | null = null;
let unlistenStatus: (() => void) | null = null;

function notifyComplete(durationMs?: number, inputTokens?: number, outputTokens?: number) {
  if (!("Notification" in window)) return;
  if (Notification.permission === "denied") return;
  const body = [
    durationMs ? `${(durationMs / 1000).toFixed(1)}s` : "",
    inputTokens ? `↑${inputTokens}` : "",
    outputTokens ? `↓${outputTokens}` : "",
  ].filter(Boolean).join(" · ");
  if (Notification.permission === "granted") {
    new Notification("分形 — 完成", { body: body || undefined, silent: true });
  } else {
    Notification.requestPermission().then(p => {
      if (p === "granted") new Notification("分形 — 完成", { body: body || undefined, silent: true });
    });
  }
}

/** 归一化 tool_result.content 的三种形态 → 纯文本 */
export function extractToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text: string } => b?.type === "text" && typeof b.text === "string")
      .map(b => b.text)
      .join("");
  }
  return "";
}

/**
 * 将 CC content_blocks 原始数据合并为有序 ContentBlock 数组。
 *
 * CC 2.1+ 协议：assistant 事件的 message.content[] 始终是该时刻的完整状态，
 * 与后端（Anthropic/DeepSeek/OpenRouter）无关。stream_event delta 先到，
 * 完整 assistant 后到，后者携带全量 content_blocks。
 *
 * - existing 为空：全量事件 → 从 raw 全新构建
 * - existing 非空：增量事件 → 合并到已有数组末尾
 *
 * 合并策略：
 * - text/thinking：跨 block 类型的新文本视为独立步骤，不合并
 * - tool_use：按 ID 去重
 * - tool_result：按 toolUseId 去重
 */
export function buildContentBlocks(
  raw: StreamEvent["content_blocks"],
  existing?: ContentBlock[],
): ContentBlock[] {
  if (!raw?.length) return existing || [];
  const result: ContentBlock[] = existing ? [...existing] : [];
  for (const block of raw) {
    if (block.type === "text" || block.type === "thinking") {
      const txt: string = (block as any).text || (block as any).thinking || "";
      // 回查同类型上一个块
      let sameTypeLast: ContentBlock | undefined;
      let sameTypeIdx = -1;
      for (let j = result.length - 1; j >= 0; j--) {
        if (result[j].type === block.type) {
          sameTypeLast = result[j];
          sameTypeIdx = j;
          break;
        }
      }
      if (sameTypeLast) {
        const old = sameTypeLast.content || "";
        // CC 全量事件：新内容以旧内容开头 → 直接替换（累积更新）
        if (txt.startsWith(old)) {
          sameTypeLast.content = txt;
        } else {
          // 否则检查同类型旧块后面是否有其它类型隔断
          const hasIntervening = result.slice(sameTypeIdx + 1).some(b => b.type !== block.type);
          if (hasIntervening) {
            result.push({ type: block.type as "text" | "thinking", content: txt });
          } else {
            // 无隔断 → DeepSeek 增量追加
            sameTypeLast.content = old + txt;
          }
        }
      } else {
        result.push({ type: block.type as "text" | "thinking", content: txt });
      }
    } else if (block.type === "tool_use") {
      const tuId = (block as any).id || "";
      // 去重：同 ID tool_use 已存在则跳过
      if (tuId && result.some(b => b.type === "tool_use" && b.toolUse?.id === tuId)) continue;
      result.push({
        type: "tool_use",
        toolUse: {
          id: tuId,
          name: (block as any).name || "",
          input: (block as any).input || {},
        },
      });
    } else if (block.type === "tool_result") {
      // tool_result 也可能出现在 assistant 事件的 content_blocks 中（较少见）
      const trId = (block as any).tool_use_id || "";
      // 去重：同 ID 已存在则跳过
      if (trId && result.some(b => b.type === "tool_result" && b.toolResult?.toolUseId === trId)) continue;
      result.push({
        type: "tool_result",
        toolResult: {
          toolUseId: trId,
          content: extractToolResultContent((block as any).content),
          isError: (block as any).is_error,
        },
      });
    }
  }
  return result;
}

export function useStreamProcessor() {
  const chat = useChatStore();
  const session = useSessionStore();
  const settings = useSettingsStore();
  const debugLog = useDebugLog();
  const stderrLog = useStderrLog();
  const { t } = useI18n();

  // 分阶段计时：思考 ↔ 工具执行
  let thinkingStart = 0;
  let toolExecStart = 0;
  /** 最后一个工具调用的引用，用于回填执行耗时 */
  let lastToolUse: ToolUse | null = null;

  function markThinkingStart() {
    if (!thinkingStart) thinkingStart = Date.now();
    // 思考开始 = 上一个工具执行结束
    if (toolExecStart && lastToolUse) {
      lastToolUse.executionDurationMs = Date.now() - toolExecStart;
      toolExecStart = 0;
      lastToolUse = null;
    }
  }
  function popThinkingDuration(): number {
    const dur = thinkingStart ? Date.now() - thinkingStart : 0;
    thinkingStart = 0;
    return dur;
  }
  function markToolExecStart(tool: ToolUse) {
    toolExecStart = Date.now();
    tool.startedAt = toolExecStart;  // 供 MessageBubble 显示实时计时
    lastToolUse = tool;
  }

  /** 将 toolUses 数组中的计时信息和结果同步到 contentBlocks 的 tool_use 条目 */
  function syncBlockTimings(msg: import("@/stores/chat").Message | null) {
    if (!msg?.contentBlocks) return;
    const toolUses = msg.toolUses;
    for (const block of msg.contentBlocks) {
      if (block.type !== "tool_use" || !block.toolUse) continue;
      const match = toolUses.find(tu => tu.id === block.toolUse!.id);
      if (match) {
        block.toolUse.thinkingDurationMs = match.thinkingDurationMs;
        block.toolUse.executionDurationMs = match.executionDurationMs;
        block.toolUse.startedAt = match.startedAt;
        // 同步工具结果（从 user 事件回填）
        if (match.result !== undefined) block.toolUse.result = match.result;
        if (match.isError !== undefined) block.toolUse.isError = match.isError;
      }
    }
  }

  async function startListening() {
    if (unlisten) return;

    // 分形主链路：serve SSE 映射事件（主进程 startEngineEvents 转发 engine:event）
    unlisten = window.electronBridge.on("engine:event", (payload) => {
      const data = payload as StreamEvent;
      debugLog.add(`📨 event: ${data.type} | sid=${data.session_id} | text=${(data.text||'').slice(0,50)} | thinking=${(data.thinking||'').slice(0,50)} | final=${data.is_final}`, data.session_id);

      // 事件是否属于当前活跃会话（后台会话 → 写缓存 + 更新 activity 指示器）
      const isActive = data.session_id === session.activeSessionId;

      // 事件属于后台会话 → 写入缓存，更新 activity 指示器
      if (data.session_id && !isActive) {
        chat.handleBackgroundStreamEvent(data.session_id, data);
        if (data.type === 'control_request') {
          session.setSessionActivity(data.session_id, 'blocked');
        } else if (data.type === 'result' || data.type === 'done') {
          // 不在 blocked 时降级为 unread
          if (session.sessionActivity[data.session_id] !== 'blocked') {
            session.setSessionActivity(data.session_id, 'unread');
          }
        } else if (data.type === 'assistant' || data.type === 'user') {
          if (session.sessionActivity[data.session_id] !== 'blocked') {
            session.setSessionActivity(data.session_id, 'processing');
          }
        }
        return;
      }

      switch (data.type) {
        case "assistant":
          // 活跃会话处理中（不被 blocked 覆盖）
          if (data.session_id && session.sessionActivity[data.session_id] !== 'blocked') {
            session.setSessionActivity(data.session_id, 'processing');
          }
          if (data.text || data.thinking) markThinkingStart();
          if (data.text) {
            // 去重：当完整 assistant 事件携带的文本以已有内容开头时，
            // 说明之前已通过 text_delta 增量事件接收过，只追加新后缀。
            // 对于不发送增量事件的后端（DeepSeek），currentContent 为空，
            // 完整事件的文本会被完整使用。
            // 兜底：若 currentAssistantMsg 已置 null（result 已处理），取最后一条已完成 assistant
            // 消息的内容做 startsWith 比较，防止迟到事件创建重复消息。
            const currentContent = chat.currentAssistantMsg?.content
              || (chat.messages.length > 0 && chat.messages[chat.messages.length - 1].role === "assistant"
                ? chat.messages[chat.messages.length - 1].content
                : "");
            if (currentContent && data.text.startsWith(currentContent)) {
              const newPart = data.text.slice(currentContent.length);
              if (newPart) chat.appendText(newPart);
            } else {
              chat.appendText(data.text);
            }
          }
          if (data.thinking) {
            // 同样的去重逻辑处理 thinking 块
            const currentThinking = chat.currentAssistantMsg?.thinking || "";
            if (currentThinking && data.thinking.startsWith(currentThinking)) {
              const newPart = data.thinking.slice(currentThinking.length);
              if (newPart) chat.appendThinking(newPart);
            } else {
              chat.appendThinking(data.thinking);
            }
          }
          if (data.tool_use) {
            for (const tu of data.tool_use) {
              // 记录该工具调用前的思考耗时，然后重置计时器
              const thinkingDur = popThinkingDuration();
              const toolUse: ToolUse = {
                id: tu.id,
                name: tu.name,
                input: tu.input,
                thinkingDurationMs: thinkingDur,
              };
              chat.addToolUse(toolUse);
              markToolExecStart(toolUse);
              // 提取 TodoWrite / TaskCreate / TaskUpdate 中的工作清单
              chat.updateTodosFromTool(tu.name, tu.input);
            }
          }
          // 构建 contentBlocks 时间线。始终传入 existing，靠块内 startsWith 去重自行判断替换/追加
          if (data.content_blocks && chat.currentAssistantMsg) {
            const blocks = buildContentBlocks(data.content_blocks, chat.currentAssistantMsg.contentBlocks);
            chat.setContentBlocks(blocks);
          }
          // 计时同步必须在 contentBlocks 构建之后、且每次 assistant 事件都执行，
          // 因为 markThinkingStart 可能在无 content_blocks 的事件中更新 executionDurationMs
          if (chat.currentAssistantMsg) {
            syncBlockTimings(chat.currentAssistantMsg);
          }

          // assistant 事件携带 message.usage——实时更新 token 统计（DeepSeek 后端 result 可能不含 usage）
          if (chat.currentAssistantMsg) {
            if (data.input_tokens != null) chat.currentAssistantMsg.inputTokens = data.input_tokens;
            if (data.output_tokens != null) chat.currentAssistantMsg.outputTokens = data.output_tokens;
            if (data.cost_usd != null) chat.currentAssistantMsg.costUSD = data.cost_usd;
          }
          break;

        case "control_request":
          // 需要用户审批/问答 → 橙点（最高优先级）
          if (data.session_id) session.setSessionActivity(data.session_id, 'blocked');
          if (data.control_request) {
            const cr = data.control_request;
            debugLog.add(`  🔐 subtype=${cr.subtype} tool=${cr.tool_name} request_id=${cr.request_id}`);
            debugLog.add(`  🔐 tool_input keys: ${cr.tool_input ? Object.keys(cr.tool_input).join(',') : '(null)'}`);
            chat.addControlRequest(cr);
          }
          break;

        // serve 原生待办更新（todo.updated → type='todo'），整体覆盖活跃会话工作清单
        case "todo":
          if (Array.isArray(data.todos)) chat.setTodos(data.todos);
          break;

        // message_delta 携带该轮 assistant 的最终 output_tokens
        case "token_usage":
          if (chat.currentAssistantMsg) {
            if (data.input_tokens != null) chat.currentAssistantMsg.inputTokens = data.input_tokens;
            if (data.output_tokens != null) chat.currentAssistantMsg.outputTokens = data.output_tokens;
          }
          break;

        // user 事件携带 tool_result 块——工具执行结果
        case "user": {
          if (data.tool_results && chat.currentAssistantMsg) {
            for (const tr of data.tool_results) {
              // 结算对应工具的执行耗时（从 tool_use 发出到 tool_result 到达）
              if (toolExecStart && lastToolUse?.id === tr.tool_use_id) {
                lastToolUse.executionDurationMs = Date.now() - toolExecStart;
                toolExecStart = 0;
                lastToolUse = null;
              }
              chat.appendToolResult(tr.tool_use_id, tr.content, tr.is_error);
            }
          }
          break;
        }

        case "result":
        case "done": {
          // 活跃会话完成 → 用户正在看，无需指示器
          if (data.session_id) session.setSessionActivity(data.session_id, null);
          const msg = chat.currentAssistantMsg;
          if (msg) {
            const targetSessionId = data.session_id || session.activeSessionId;
            // Save full message as JSON blob: content + thinking + toolUses + stats
            const fullContent = JSON.stringify({
              text: msg.content,
              thinking: msg.thinking,
              toolUses: msg.toolUses,
              contentBlocks: msg.contentBlocks,  // 保留时间线顺序供下次加载
              durationMs: data.duration_ms,
              // event 可能不含 token（如 DeepSeek result），fallback 到 message 对象上的值
              inputTokens: data.input_tokens ?? msg.inputTokens,
              outputTokens: data.output_tokens ?? msg.outputTokens,
              costUSD: data.cost_usd ?? msg.costUSD,
            });
            saveMessage(msg.id, targetSessionId, "assistant", fullContent, "{}").catch(() => {});
          }
          // 结算最后的思考和执行计时
          const finalThinking = popThinkingDuration(); // 最后一段思考（无后续 tool_use 触发 pop）
          if (toolExecStart && lastToolUse) {
            lastToolUse.executionDurationMs = Date.now() - toolExecStart;
            // 最终思考时间附加到最后一个工具的 thinkingDurationMs
            if (finalThinking > 0) lastToolUse.thinkingDurationMs = (lastToolUse.thinkingDurationMs || 0) + finalThinking;
            toolExecStart = 0;
            lastToolUse = null;
          } else if (finalThinking > 0 && msg?.toolUses.length) {
            // 有工具但 toolExecStart 已结算（思考在 result 前就开始了）
            const last = msg.toolUses[msg.toolUses.length - 1];
            last.thinkingDurationMs = (last.thinkingDurationMs || 0) + finalThinking;
          }
          // 最终计时同步（结算后 contentBlocks 可能还没拿到最终计时）
          if (msg) syncBlockTimings(msg);
          chat.finishAssistantMessage(
            data.duration_ms,
            data.input_tokens ?? msg?.inputTokens,
            data.output_tokens ?? msg?.outputTokens,
            data.cost_usd ?? msg?.costUSD,
          );
          // 持久化 debug/stderr 日志 + 刷新侧栏统计
          const sid = data.session_id || session.activeSessionId;
          if (sid) {
            saveSessionDebugLog(sid, JSON.stringify(debugLog.exportLines(sid))).catch(() => {});
            saveSessionStderrLog(sid, JSON.stringify(stderrLog.exportLines(sid))).catch(() => {});
            session.loadSessions(settings.cwd || undefined).catch(() => {});  // 刷新侧栏统计（带工作区过滤，否则覆盖为全部）
          }

          // Desktop notification
          notifyComplete(data.duration_ms, data.input_tokens, data.output_tokens);

          // OC 可能修改了工作区文件 → 通知文件面板刷新
          if (msg) {
            const fileModifiers = new Set(["Write", "Edit", "Bash", "PowerShell", "Skill", "Workflow", "Agent"]);
            const didModify = msg.toolUses.some(tu => fileModifiers.has(tu.name));
            if (didModify) window.dispatchEvent(new CustomEvent("cc-file-changed"));
          }
          break;
        }

        case "error": {
          const { key, params } = translateError(data.error || "Unknown error");
          chat.appendText(`\n\n> ⚠️ ${t(key, params as any)}`);
          chat.finishAssistantMessage();
          break;
        }

        default:
          debugLog.add(`📨 unknown type: ${data.type}`);
          break;
      }
    });

    // serve 运行状态（主进程 server-manager onStatusChange → engine:status），前端连接指示
    unlistenStatus = window.electronBridge.on("engine:status", (payload) => {
      const info = payload as { running?: boolean };
      session.setServing(!!info?.running);
      debugLog.add(`🔌 engine status: running=${info?.running}`, session.activeSessionId);
      // G3：serve 恢复（running=true）且当前会话历史加载失败过 → 自动重试加载
      // （离线灰显占位只应短暂存在，引擎就绪后应立即恢复历史消息）
      if (info?.running && chat.historyError && session.activeSessionId) {
        const sid = session.activeSessionId;
        chat.setHistoryLoading(true);
        listMessages(sid)
          .then((msgs) => {
            // 竞态 guard：重试期间可能已切换会话，丢弃过期结果
            if (session.activeSessionId !== sid) return;
            chat.setHistoryLoading(false);
            chat.loadMessages(
              msgs.map((m) => ({
                id: m.id,
                role: m.role,
                content: m.content,
                created_at: m.created_at,
              })),
            );
            chat.setHistoryError(false);
            debugLog.add(`🔌 历史消息已自动重载: ${msgs.length} 条`, sid);
          })
          .catch(() => {
            // 重试仍失败（serve 刚启动但消息端点未就绪）→ 保持离线标记，等待下次 status 事件
            chat.setHistoryLoading(false);
            debugLog.add(`🔌 历史消息重载失败，等待下次恢复`, sid);
          });
      }
    });
    // stream-debug / stream-error / process-exited 已移除：serve 单进程模型无这些事件源
    // （引擎状态经 engine:status 上报，异常退出也走 running=false 指示）
  }

  function stopListening() {
    if (unlisten) { unlisten(); unlisten = null; }
    if (unlistenStatus) { unlistenStatus(); unlistenStatus = null; }
  }

  return { startListening, stopListening };
}
