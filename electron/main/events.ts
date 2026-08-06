// OC 会话事件处理：serve SSE 事件流 → StreamFrontendEvent 映射层
// 契约：与 renderer 的 StreamEvent（src/renderer/src/lib/electron-bridge.ts）完全一致，前端零改造
// 事件源：serve /event SSE（sdk.event.subscribe，1.18.13 v1），事件名见阶段 0 实测 fixtures/events-*.json
// 映射表：docs/设计/分形-设计方案.md 3.1.2（v1.15 更新为 serve 实测事件名）

import { createOpencodeClient } from '@opencode-ai/sdk'
import type { Event as ServeEvent, Part } from '@opencode-ai/sdk'
import { basicAuthHeader } from './oc-sdk'

// ══════════════════════════════════════════════════════════════════
// StreamFrontendEvent（与 renderer StreamEvent 同构；renderer 是 type: string 通配，
// 此处枚举实际消费的 type，保证映射层不会产出前端无法处理的类型）
// ══════════════════════════════════════════════════════════════════

/** 工具调用（嵌在 assistant 事件的 tool_use 字段） */
export interface StreamToolUse {
  id: string
  name: string
  input: Record<string, unknown>
}

/** 工具执行结果（嵌在 user 事件的 tool_results 字段） */
export interface StreamToolResult {
  tool_use_id: string
  content: string
  is_error?: boolean
}

/** 前端可消费的事件（type 枚举见 useStreamProcessor switch + handleBackgroundStreamEvent） */
export type StreamFrontendEvent =
  | {
      type: 'assistant'
      session_id?: string
      text: string
      thinking: string
      tool_use?: StreamToolUse[]
    }
  | {
      type: 'user'
      session_id?: string
      text: string
      thinking: string
      tool_results?: StreamToolResult[]
    }
  | {
      type: 'control_request'
      session_id?: string
      text: string
      thinking: string
      control_request: {
        subtype: string
        tool_name?: string
        tool_input: Record<string, unknown>
        request_id?: string
        /** permission.asked 的免审批建议（通配符，如 ["echo *"]）——前端「总是允许」展示 */
        always?: string[]
        /** question.asked 的问题列表（subtype='question' 时）——提问弹窗渲染 */
        questions?: Array<{
          question: string
          header?: string
          options?: Array<{ label: string; description?: string }>
          multiple?: boolean
        }>
      }
    }
  | {
      type: 'result' | 'done'
      session_id?: string
      text: string
      thinking: string
      is_final: boolean
      duration_ms?: number
      input_tokens?: number
      output_tokens?: number
      cost_usd?: number
    }
  | {
      type: 'error'
      session_id?: string
      text: string
      thinking: string
      error: string
    }
  | {
      // serve todo.updated → 待办面板数据（实测 2026-08-07：properties.todos[{content,status,priority}]）
      type: 'todo'
      session_id?: string
      text: string
      thinking: string
      todos: Array<{ content: string; status: string; priority: string }>
    }

// ══════════════════════════════════════════════════════════════════
// 映射上下文（跨事件状态，subscribeEvents 维护、测试可注入）
// ══════════════════════════════════════════════════════════════════

/**
 * mapServeEvent 的跨事件状态。
 * - messageRoles：message.updated 先于 message.part.updated 到达，记录 messageID→role，
 *   用于区分 text part 是用户消息回显（role=user，前端已本地 addUserMessage）还是助手回答
 * - partTypes：message.part.updated 先于 message.part.delta 到达，记录 partID→partType，
 *   用于 delta 事件判定流向（delta 事件本身无 type 字段，靠 partID 反查）
 * - seenToolCallIDs：serve 对工具状态流转发多条 part.updated（pending/running/completed），
 *   前端 addToolUse 不去重——只在首次见 callID 时下发 tool_use，避免重复工具卡片
 * - sessionTokens：最近一次 session.updated 携带 tokens，session.idle 时附到 result 事件
 */
export interface MapContext {
  messageRoles: Map<string, string>
  partTypes: Map<string, string>
  seenToolCallIDs: Set<string>
  sessionTokens: Map<string, { input: number; output: number; cost: number }>
  /** 回合起始时间（session.created 记录），session.idle 时计算 result.duration_ms */
  sessionStartTime: Map<string, number>
  /** 时间源（测试可注入固定值，默认 Date.now） */
  now: () => number
}

/** 创建空映射上下文（subscribeEvents 与测试共用） */
export function createMapContext(now: () => number = Date.now): MapContext {
  return {
    messageRoles: new Map(),
    partTypes: new Map(),
    seenToolCallIDs: new Set(),
    sessionTokens: new Map(),
    sessionStartTime: new Map(),
    now,
  }
}

// ══════════════════════════════════════════════════════════════════
// 事件映射（纯函数：同输入 + 同 ctx → 同输出，可单测）
// ══════════════════════════════════════════════════════════════════

/** 从 serve 错误结构中提取展示用 message（UnknownError/ProviderAuthError/ApiError 的 data.message） */
function extractErrorText(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error ?? '未知错误')
  const data = (error as Record<string, unknown>).data as Record<string, unknown> | undefined
  if (data && typeof data.message === 'string') return data.message
  const name = (error as Record<string, unknown>).name
  return typeof name === 'string' ? name : String(error)
}

/** 判断 tool part 状态是否为完成态（completed/error） */
function isToolTerminal(part: Part & { type: 'tool' }): boolean {
  return part.state?.status === 'completed' || part.state?.status === 'error'
}

/**
 * 将单条 serve 事件映射为 0..n 条 StreamFrontendEvent。
 * 映射依据（serve 实测名 → 前端 type）：
 * - server.connected / session.created / session.updated / session.status → 内部状态，不产出
 *   （server.connected 由订阅层 onConnected 回调上报；session.updated 仅记录 tokens）
 * - message.updated → 记录 messageID→role，不产出（会话信息更新，前端无消费）
 * - message.part.updated:
 *   - text part（role=user）→ 用户回显，不产出（前端已本地 addUserMessage）
 *   - text part（role=assistant）→ assistant(text)（delta 优先，无则用 part.text）
 *   - reasoning part → assistant(thinking)（方案 4.6：thinking part=思考阶段）
 *   - tool part → 首次见 callID 发 assistant(tool_use) 创建工具卡片；
 *     completed/error 发 user(tool_results) 回填结果（方案 4.6：操作阶段，结果回填）
 *   - 其余 part 类型（file/step/snapshot/patch/agent 等）→ 不产出（阶段 0 未实测，见 [待实测]）
 * - session.idle → result(is_final)（回合结束，方案 3.1.2 末行）
 * - session.error → error（错误事件）
 * - permission.updated → control_request（权限请求，前端复用审批弹窗）
 */
export function mapServeEvent(evt: ServeEvent, ctx: MapContext): StreamFrontendEvent[] {
  const props = evt.properties as Record<string, unknown> | undefined
  const sessionID = (props?.sessionID as string | undefined) ?? (props?.info as { id?: string } | undefined)?.id

  // message.part.delta 是 serve 1.18.5 实测输出但 SDK 1.18.13 类型未生成（types.gen.d.ts 无该联合成员），
  // switch 表达式放宽为 string 以支持该 case（各分支均用 props 断言，不依赖 evt.type 收窄）
  switch (evt.type as string) {
    case 'server.connected':
      return [] // 内部状态；server.connected 由订阅层 onConnected 上报
    case 'session.created': {
      // 记录回合起始时间（session.idle 算 duration_ms）+ 初始 tokens（覆盖脏数据，🟡#3）
      if (sessionID && !ctx.sessionStartTime.has(sessionID)) {
        ctx.sessionStartTime.set(sessionID, ctx.now())
      }
      const info = props?.info as { tokens?: { input?: number; output?: number; cost?: number } } | undefined
      if (sessionID && info?.tokens) {
        ctx.sessionTokens.set(sessionID, {
          input: info.tokens.input ?? 0,
          output: info.tokens.output ?? 0,
          cost: info.tokens.cost ?? 0,
        })
      }
      return []
    }
    case 'session.updated': {
      // 记录最新 tokens（session.idle 时附到 result），其余内部状态不产出
      const info = props?.info as { tokens?: { input?: number; output?: number; cost?: number } } | undefined
      if (sessionID && info?.tokens) {
        ctx.sessionTokens.set(sessionID, {
          input: info.tokens.input ?? 0,
          output: info.tokens.output ?? 0,
          cost: info.tokens.cost ?? 0,
        })
      }
      return []
    }
    case 'session.status':
      return [] // busy/idle 轮询状态，前端以 session.idle 为准
    case 'message.updated': {
      // 记录 messageID→role（part 分派依赖），会话信息本身不产出
      const info = props?.info as { id?: string; role?: string } | undefined
      if (info?.id && info?.role) ctx.messageRoles.set(info.id, info.role)
      return []
    }
    case 'message.part.updated': {
      const part = props?.part as Part | undefined
      if (!part) return []
      // 记录 partID→type：先行的 updated 未到时 delta 无法判定流向（delta 事件无 type 字段）
      ctx.partTypes.set(part.id, part.type)
      const partMsgID = (part as { messageID?: string }).messageID
      const role = partMsgID ? ctx.messageRoles.get(partMsgID) : undefined

      if (part.type === 'text') {
        // 用户回显（role=user）：前端发送时已本地 addUserMessage，避免重复气泡
        if (role === 'user') return []
        // assistant text：delta（增量）优先，无则用全量 part.text（前端 appendText 自带 startsWith 去重）
        const text = (props?.delta as string | undefined) ?? part.text
        if (!text) return []
        return [{ type: 'assistant', session_id: sessionID, text, thinking: '' }]
      }
      if (part.type === 'reasoning') {
        // 思考阶段：text 为思考内容（SDK ReasoningPart.text）
        const thinking = (props?.delta as string | undefined) ?? part.text
        if (!thinking) return []
        return [{ type: 'assistant', session_id: sessionID, text: '', thinking }]
      }
      if (part.type === 'tool') {
        const toolPart = part as Part & { type: 'tool' }
        const callID = toolPart.callID
        const out: StreamFrontendEvent[] = []
        // 首次见该 callID → 创建工具卡片（pending/running/completed 的首次都算，后续不再重复）
        if (!ctx.seenToolCallIDs.has(callID)) {
          ctx.seenToolCallIDs.add(callID)
          out.push({
            type: 'assistant',
            session_id: sessionID,
            text: '',
            thinking: '',
            tool_use: [{ id: callID, name: toolPart.tool, input: toolPart.state?.input ?? {} }],
          })
        }
        // 完成态 → 回填工具结果（output 成功 / error 失败）
        if (isToolTerminal(toolPart)) {
          const state = toolPart.state as
            | { status: 'completed'; output?: string; metadata?: Record<string, unknown> }
            | { status: 'error'; error?: string; metadata?: Record<string, unknown> }
          out.push({
            type: 'user',
            session_id: sessionID,
            text: '',
            thinking: '',
            tool_results: [
              {
                tool_use_id: callID,
                content: state.status === 'completed' ? (state.output ?? '') : (state.error ?? ''),
                is_error: state.status === 'error',
              },
            ],
          })
        }
        return out
      }
      // 其余 part 类型（file/step-start/step-finish/snapshot/patch/agent/retry/compaction/subtask）
      // 阶段 0 未实测对应前端消费 → 不产出 [待实测]
      return []
    }
    case 'message.part.delta': {
      // 打字机增量（serve 1.18.5 实测：reasoning/text 逐字 delta 流，事件本身无 part 类型字段）
      // 结构：{ properties: { sessionID, messageID, partID, field, delta } }
      const deltaProps = props as { sessionID?: string; partID?: string; field?: string; delta?: string } | undefined
      // 先行的 message.part.updated 未到（partTypes 查不到）→ 跳过，等待 updated 全量兜底
      if (!deltaProps?.partID || !deltaProps.field || !deltaProps.delta) return []
      const partType = ctx.partTypes.get(deltaProps.partID)
      if (!partType) return []
      // field==='text'：text part → assistant(text)；reasoning part → assistant(thinking)
      // （前端 appendText 自带 startsWith 去重，delta 与后续全量 updated 兼容不重复）
      if (deltaProps.field === 'text' && partType === 'text') {
        return [{ type: 'assistant', session_id: deltaProps.sessionID, text: deltaProps.delta, thinking: '' }]
      }
      if (deltaProps.field === 'text' && partType === 'reasoning') {
        return [{ type: 'assistant', session_id: deltaProps.sessionID, text: '', thinking: deltaProps.delta }]
      }
      // field==='input'（tool part 输入增量）与其他 field → 暂不产出（前端无消费点 [待实测]）
      return []
    }
    case 'session.idle': {
      // 回合结束 → result(is_final)；tokens 附最近 session.updated 值（serve idle 事件本身无 usage）
      const tokens = sessionID ? ctx.sessionTokens.get(sessionID) : undefined
      const startTime = sessionID ? ctx.sessionStartTime.get(sessionID) : undefined
      const evtOut: StreamFrontendEvent = {
        type: 'result',
        session_id: sessionID,
        text: '',
        thinking: '',
        is_final: true,
        // 回合总耗时（前端 finishAssistantMessage 存档依赖；无起始记录时省略）
        duration_ms: startTime !== undefined ? ctx.now() - startTime : undefined,
        input_tokens: tokens?.input,
        output_tokens: tokens?.output,
        cost_usd: tokens?.cost,
      }
      return [evtOut]
    }
    case 'session.error': {
      // 会话错误（模型不存在/认证失败等）→ error 通道
      const errText = extractErrorText(props?.error)
      const evtOut: StreamFrontendEvent = { type: 'error', session_id: sessionID, text: '', thinking: '', error: errText }
      return [evtOut]
    }
    case 'permission.asked':
    case 'permission.updated': {
      // 权限请求 → control_request（前端审批弹窗）
      // 实测结构（serve 1.18.5，2026-08-07 probe-extras）：properties = {id, sessionID,
      //   permission: 'bash', patterns: ['echo x'], metadata: {command: 'echo x'},
      //   always: ['echo *'], tool: {messageID, callID}}
      // （SDK 类型 Permission 与实测不一致——事件名 served 发 asked，结构以实测为准）
      const p = props as unknown as Record<string, unknown>
      const meta = (p.metadata ?? {}) as Record<string, unknown>
      const evtOut: StreamFrontendEvent = {
        type: 'control_request',
        session_id: sessionID,
        text: '',
        thinking: '',
        control_request: {
          subtype: 'approval',
          // 可读名：metadata.tool_name（若 serve 携带）→ properties.permission（工具名）→ callID 兜底
          tool_name: (meta.tool_name as string | undefined) ?? (p.permission as string | undefined) ?? 'tool',
          tool_input: meta,
          request_id: p.id as string | undefined,
          always: Array.isArray(p.always) ? (p.always as string[]) : undefined,
        },
      }
      return [evtOut]
    }
    case 'question.asked': {
      // question 工具提问（实测 2026-08-07）：properties = {id: que_..., sessionID,
      //   questions: [{question, header, options: [{label, description}], multiple?}],
      //   tool: {messageID, callID}} → control_request(subtype='question') 复用审批队列
      const p = props as unknown as Record<string, unknown>
      const evtOut: StreamFrontendEvent = {
        type: 'control_request',
        session_id: sessionID,
        text: '',
        thinking: '',
        control_request: {
          subtype: 'question',
          tool_name: 'AskUserQuestion',
          tool_input: {},
          request_id: p.id as string | undefined,
          questions: Array.isArray(p.questions)
            ? (p.questions as Array<{ question: string; header?: string; options?: Array<{ label: string; description?: string }>; multiple?: boolean }>)
            : undefined,
        },
      }
      return [evtOut]
    }
    case 'todo.updated': {
      // 待办更新（实测 2026-08-07）：properties = {sessionID, todos: [{content, status, priority}]}
      const p = props as unknown as Record<string, unknown>
      const todos = Array.isArray(p.todos)
        ? (p.todos as Array<{ content: string; status: string; priority: string }>)
        : []
      const evtOut: StreamFrontendEvent = { type: 'todo', session_id: sessionID, text: '', thinking: '', todos }
      return [evtOut]
    }
    default:
      // 未知事件类型（todo.updated / file.edited 等）→ 不产出，前端 default 分支仅 debug 记录
      return []
  }
}

// ══════════════════════════════════════════════════════════════════
// SSE 订阅（含指数退避重连）
// ══════════════════════════════════════════════════════════════════

/** 订阅选项 */
export interface SubscribeEventsOptions {
  baseURL: string
  username: string
  password: string
  /** 每条映射后的 StreamFrontendEvent 回调 */
  onEvent: (evt: StreamFrontendEvent) => void
  /** SSE 连接错误/重连触发（网络错误、服务端 5xx 等） */
  onError?: (err: unknown) => void
  /** serve 就绪（server.connected 事件）回调 */
  onConnected?: () => void
}

/**
 * 建立 serve SSE 事件订阅并持续消费。
 * 重连：SDK createSseClient 内置指数退避（默认 3s 起步、×2 递增、30s 封顶），
 * 连接中断自动重连；onError 上报每次失败，便于上层展示连接状态。
 * 返回 stop()：中断订阅（abort 底层 fetch + 退出消费循环）。
 */
export async function subscribeEvents(opts: SubscribeEventsOptions): Promise<() => void> {
  const controller = new AbortController()
  const client = createOpencodeClient({
    baseUrl: opts.baseURL,
    headers: { Authorization: basicAuthHeader(opts.username, opts.password) },
  })
  const ctx = createMapContext()

  // 消费循环：SDK stream 是 AsyncGenerator（yield 单条 serve 事件），
  // for-await 驱动读取；SDK 内部按指数退避自动重连，直到 signal abort
  const run = (async () => {
    try {
      const { stream } = await client.event.subscribe({ signal: controller.signal })
      for await (const ev of stream) {
        // server.connected 是 serve 就绪信号（连接建立后首个事件），通过独立回调上报
        if (ev.type === 'server.connected') {
          opts.onConnected?.()
          continue
        }
        for (const mapped of mapServeEvent(ev, ctx)) {
          opts.onEvent(mapped)
        }
      }
    } catch (err) {
      // abort 是主动停止（signal.aborted），不视为错误上报
      if (controller.signal.aborted) return
      opts.onError?.(err)
    }
  })()

  return () => {
    controller.abort()
    void run.catch(() => {})
  }
}
