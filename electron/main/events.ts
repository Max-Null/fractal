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

/**
 * ToolState 联合的时间字段（SDK：仅 running/completed/error 有 time，pending 无——
 * 联合类型直接访问会报 TS2339，须先断言为本类型）
 */
export type ToolStateTime = { time?: { start?: number; end?: number } }

/**
 * 耗时差计算（end - start）带保护：serve 时钟异常时 end<start 会出负数，
 * NodeCard 无负值保护 → 钳到 0；两端任一缺失 → undefined（不显示耗时）
 */
export function positiveDuration(start: number | undefined, end: number | undefined): number | undefined {
  return start !== undefined && end !== undefined ? Math.max(0, end - start) : undefined
}

/** 工具调用（嵌在 assistant 事件的 tool_use 字段） */
export interface StreamToolUse {
  id: string
  name: string
  input: Record<string, unknown>
  /** 工具开始执行时间戳（serve ToolState.time.start；2026-08-10 补——此前流式无耗时） */
  startedAt?: number
}

/** 工具执行结果（嵌在 user 事件的 tool_results 字段） */
export interface StreamToolResult {
  tool_use_id: string
  content: string
  is_error?: boolean
  /** 工具执行耗时 ms（serve ToolState.time.end - time.start；2026-08-10 补） */
  executionDurationMs?: number
}

/** 前端可消费的事件（type 枚举见 useStreamProcessor switch + handleBackgroundStreamEvent） */
export type StreamFrontendEvent =
  | {
      type: 'assistant'
      session_id?: string
      text: string
      thinking: string
      /** 思考耗时 ms（serve ReasoningPart.time.end - start；2026-08-10 补——流式 thinking 无耗时） */
      thinkingDurationMs?: number
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
  | {
      // 子会话活动（serve 主会话 SSE 原生广播子会话事件，D1：sessionID ≠ 活跃会话 → 子任务事件流）
      type: 'subtask'
      session_id?: string
      text: string
      thinking: string
      /** 子会话 id（= 子 agent 会话） */
      subId: string
      /** 主会话 id（当前活跃会话）——前端「返回主会话」入口 */
      parentId: string
      /** 子 agent 名（session.created 的 info.agent；无则前端默认 '子智能体'） */
      agent?: string
      kind: 'created' | 'delta' | 'part' | 'idle' | 'error'
      /** kind='part' 时携带分派后的块信息（text/thinking/tool 三态） */
      part?: { type: string; tool?: string; state?: string; text?: string }
    }
  | {
      // 会话标题自动更新（serve 收到首条消息后重命名，session.updated 的 info.title 变化时下发）
      type: 'session_title'
      session_id?: string
      text: string
      thinking: string
      /** 最新会话标题 */
      title: string
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
 * - toolInputs：工具输入累积（callID → 最新 input）。serve 通过 part.updated 与 delta field='input'
 *   增量发送工具输入（阶段 0 实测），首次事件 input 可能为空——累积后 tool_use 事件/补发才带完整
 *   input，前端梗概（read/bash/glob）与 todo 列表（todowrite）才非空
 * - partCallIDs：partID → callID（tool part 的 part.id 与 callID 是两套 ID；delta 事件只带 partID，
 *   反查 callID 才能定位累积的 toolInputs 并补发 tool_use）
 * - sentToolResults：已完成工具只回填一次 tool_results（serve 对同一工具可能发多条 completed 更新）
 * - sentToolInputs：callID → 已下发 tool_use 的 input JSON。serve 对工具输入走 part.updated 状态流转
 *   （pending 空 → running 完整 → completed 完整，1.18.15 实测无 delta field='input'），首次见 callID
 *   时 input 可能为空——后续 input 变化时补发 tool_use（前端 upsert 幂等），梗概/todo 列表才非空
 * - toolStarts：callID → 首次见到的 state.time.start。serve 的 time.start 在每次 running 更新时都变化，
 *   completed 的 start 是最后一次（end-start 只算最后一段，如 bash 假象 22ms）——记录首次 start，
 *   耗时 = 首次 start → completed end 才是真实执行时长
 * - sessionTokens：最近一次 session.updated 携带 tokens，session.idle 时附到 result 事件
 * - sessionTitles：sessionID → 已下发的标题。serve 在收到首条消息后自动更新会话标题
 *   （session.updated 的 info 是完整 Session 含 title），title 变化时产出 session_title 事件——
 *   否则前端会话列表永远显示「新会话」（2026-08-10 用户反馈长存问题）
 */
export interface MapContext {
  messageRoles: Map<string, string>
  partTypes: Map<string, string>
  seenToolCallIDs: Set<string>
  toolInputs: Map<string, Record<string, unknown>>
  partCallIDs: Map<string, string>
  sentToolResults: Set<string>
  sentToolInputs: Map<string, string>
  toolStarts: Map<string, number>
  sessionTokens: Map<string, { input: number; output: number; cost: number }>
  sessionTitles: Map<string, string>
  /** 回合起始时间（session.created 记录），session.idle 时计算 result.duration_ms */
  sessionStartTime: Map<string, number>
  /** 时间源（测试可注入固定值，默认 Date.now） */
  now: () => number
  /** 当前活跃会话 id（renderer 侧 activeSessionId；用于区分主会话事件与子会话事件） */
  activeSessionId: string
}

/** 创建空映射上下文（subscribeEvents 与测试共用） */
export function createMapContext(now: () => number = Date.now): MapContext {
  return {
    messageRoles: new Map(),
    partTypes: new Map(),
    seenToolCallIDs: new Set(),
    toolInputs: new Map(),
    partCallIDs: new Map(),
    sentToolResults: new Set(),
    sentToolInputs: new Map(),
    toolStarts: new Map(),
    sessionTokens: new Map(),
    sessionTitles: new Map(),
    sessionStartTime: new Map(),
    now,
    activeSessionId: '',
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

  // 子会话识别（D1）：sessionID 存在且 ≠ 当前活跃会话 → 该事件属于子 agent 会话
  // （serve 主会话 SSE 原生广播子会话活动；活跃会话事件仍走现有 15+ 映射不动）
  const isSubSession = !!sessionID && !!ctx.activeSessionId && sessionID !== ctx.activeSessionId

  // message.part.delta 是 serve 1.18.5 实测输出但 SDK 1.18.13 类型未生成（types.gen.d.ts 无该联合成员），
  // switch 表达式放宽为 string 以支持该 case（各分支均用 props 断言，不依赖 evt.type 收窄）
  switch (evt.type as string) {
    case 'server.connected':
      return [] // 内部状态；server.connected 由订阅层 onConnected 上报
    case 'session.created': {
      // 子会话创建 → 建卡事件（agent 名供前端徽标映射；不记录回合起始时间——子会话 idle 不产 result）
      if (isSubSession) {
        const info = props?.info as { agent?: string } | undefined
        return [
          {
            type: 'subtask',
            session_id: sessionID,
            text: '',
            thinking: '',
            subId: sessionID,
            parentId: ctx.activeSessionId,
            agent: info?.agent,
            kind: 'created',
          },
        ]
      }
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
      // 记录最新 tokens（session.idle 时附到 result）；标题自动更新（serve 首条消息后改标题）→ session_title
      const info = props?.info as
        | { tokens?: { input?: number; output?: number; cost?: number }; title?: string }
        | undefined
      if (sessionID && info?.tokens) {
        ctx.sessionTokens.set(sessionID, {
          input: info.tokens.input ?? 0,
          output: info.tokens.output ?? 0,
          cost: info.tokens.cost ?? 0,
        })
      }
      // title 变化（首条消息后 serve 自动命名）才下发，避免每次 updated 刷屏
      if (sessionID && typeof info?.title === 'string' && info.title && ctx.sessionTitles.get(sessionID) !== info.title) {
        ctx.sessionTitles.set(sessionID, info.title)
        return [{ type: 'session_title', session_id: sessionID, title: info.title, text: '', thinking: '' }]
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

      // 子会话 part.updated → subtask part（text/thinking/tool 三态分派，供监视弹窗流式渲染）
      if (isSubSession) {
        if (part.type === 'text') {
          const text = (props?.delta as string | undefined) ?? part.text
          if (!text) return []
          return [{ type: 'subtask', session_id: sessionID, text: '', thinking: '', subId: sessionID, parentId: ctx.activeSessionId, kind: 'part', part: { type: 'text', text } }]
        }
        if (part.type === 'reasoning') {
          const text = (props?.delta as string | undefined) ?? part.text
          if (!text) return []
          return [{ type: 'subtask', session_id: sessionID, text: '', thinking: '', subId: sessionID, parentId: ctx.activeSessionId, kind: 'part', part: { type: 'thinking', text } }]
        }
        if (part.type === 'tool') {
          const toolPart = part as Part & { type: 'tool' }
          // 子会话工具（task 无 tool part 流转，但其他子 agent 可能有）→ 记 tool 名 + state
          return [{ type: 'subtask', session_id: sessionID, text: '', thinking: '', subId: sessionID, parentId: ctx.activeSessionId, kind: 'part', part: { type: 'tool', tool: toolPart.tool, state: toolPart.state?.status } }]
        }
        return []
      }

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
        // 全量 updated 携带 reasoning time（delta 无 time）→ 透传思考耗时，
        // 前端填到 thinking 块供 NodeCard 显示（流式路径不再依赖 tool 块紧邻回填——真实输出
        // reasoning → text → tool 顺序下紧邻回填永不触发，2026-08-10 制图师反馈）
        const rPart = part as { time?: { start?: number; end?: number } }
        const thinkingDurationMs = positiveDuration(rPart.time?.start, rPart.time?.end)
        return [{ type: 'assistant', session_id: sessionID, text: '', thinking, thinkingDurationMs }]
      }
      if (part.type === 'tool') {
        const toolPart = part as Part & { type: 'tool' }
        const callID = toolPart.callID
        const out: StreamFrontendEvent[] = []
        // part.id（prt_xxx）与 callID（call_xxx）两套 ID：delta 事件只带 partID，记录映射供 input 累积反查
        ctx.partCallIDs.set(part.id, callID)
        // 输入累积：serve 增量发送工具输入（updated 部分 + delta field='input'），合并保证最新完整
        const mergedInput = { ...(ctx.toolInputs.get(callID) ?? {}), ...(toolPart.state?.input ?? {}) }
        // task 工具：state.metadata.sessionId 是子会话 ID（前端 subtask 节点归属查询键）——
        // serve 只在 state.metadata 携带、input 里没有；合并进 input.metadata 供 extractTaskId 提取
        // （实测 1.18.15：running 态即有 metadata.sessionId；缺则前端 subtask 卡查不到详情显示占位）
        const meta = (toolPart.state as { metadata?: { sessionId?: string } } | undefined)?.metadata
        if (toolPart.tool === 'task' && meta?.sessionId) {
          mergedInput.metadata = { ...(mergedInput.metadata as Record<string, unknown> | undefined), sessionId: meta.sessionId }
        }
        ctx.toolInputs.set(callID, mergedInput)
        // 首次见该 callID → 创建工具卡片（pending/running/completed 的首次都算，后续不再重复）；
        // 后续 part.updated 若 input 变化（serve 状态流转逐步带完整 input）→ 补发 tool_use（upsert 幂等），
        // 前端梗概/todo 列表才有数据（1.18.15 实测：无 delta field='input'，input 走 updated 增量）
        const toolUseEvent: StreamFrontendEvent = {
          type: 'assistant',
          session_id: sessionID,
          text: '',
          thinking: '',
          tool_use: [{ id: callID, name: toolPart.tool, input: mergedInput, startedAt: (toolPart.state as ToolStateTime | undefined)?.time?.start }],
        }
        if (!ctx.seenToolCallIDs.has(callID)) {
          ctx.seenToolCallIDs.add(callID)
          ctx.sentToolInputs.set(callID, JSON.stringify(mergedInput))
          out.push(toolUseEvent)
        } else {
          const sentJson = ctx.sentToolInputs.get(callID)
          const mergedJson = JSON.stringify(mergedInput)
          if (mergedJson !== sentJson) {
            ctx.sentToolInputs.set(callID, mergedJson)
            out.push(toolUseEvent)
          }
        }
        // 首次 start 记录：serve 的 time.start 每次 running 更新都变，只取首次（真实执行起点）
        const curStart = (toolPart.state as ToolStateTime | undefined)?.time?.start
        if (curStart !== undefined && !ctx.toolStarts.has(callID)) {
          ctx.toolStarts.set(callID, curStart)
        }
        // 完成态 → 回填工具结果（output 成功 / error 失败；同一工具多条 completed 更新只回填一次）
        if (isToolTerminal(toolPart) && !ctx.sentToolResults.has(callID)) {
          ctx.sentToolResults.add(callID)
          const state = toolPart.state as
            | { status: 'completed'; output?: string; metadata?: Record<string, unknown>; time?: { start?: number; end?: number } }
            | { status: 'error'; error?: string; metadata?: Record<string, unknown>; time?: { start?: number; end?: number } }
          // 耗时 = 首次 start → completed end（serve 的 time.start 每次 running 更新都会变，
          // completed 携带的 start 是最后一次——直接 end-start 只算最后一段（实测 bash 假象 22ms）；
          // 用 toolStarts 记录的首次 start 才是真实执行时长）
          const duration = positiveDuration(ctx.toolStarts.get(callID) ?? state.time?.start, state.time?.end)
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
                executionDurationMs: duration,
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
      // 子会话 delta（D1：打字机增量）——仅 text part 产出 subtask delta（thinking/tool 由 updated 兜底）
      // subId 用顶部 sessionID（isSubSession 已保证非空；deltaProps.sessionID 可能缺省，避免类型 undefined）
      if (isSubSession && deltaProps.field === 'text' && partType === 'text') {
        return [{ type: 'subtask', session_id: sessionID, text: deltaProps.delta, thinking: '', subId: sessionID, parentId: ctx.activeSessionId, kind: 'delta' }]
      }
      // field==='text'：text part → assistant(text)；reasoning part → assistant(thinking)
      // （前端 appendText 自带 startsWith 去重，delta 与后续全量 updated 兼容不重复）
      if (deltaProps.field === 'text' && partType === 'text') {
        return [{ type: 'assistant', session_id: deltaProps.sessionID, text: deltaProps.delta, thinking: '' }]
      }
      if (deltaProps.field === 'text' && partType === 'reasoning') {
        return [{ type: 'assistant', session_id: deltaProps.sessionID, text: '', thinking: deltaProps.delta }]
      }
      // field==='input'（tool part 输入增量，阶段 0 实测 serve 以 JSON 片段增量发送工具输入）：
      // 累积到 toolInputs 并按 callID 补发 tool_use（前端 addToolUse upsert 幂等）——
      // 否则首次 tool_use 事件 input 为空，read/bash/glob 梗概与 todowrite 列表永远空白
      if (deltaProps.field === 'input' && partType === 'tool') {
        // 输入增量可能是完整 JSON 或片段；解析失败跳过（等 part.updated 全量兜底）
        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(deltaProps.delta)
        } catch {
          return []
        }
        if (typeof parsed !== 'object' || parsed === null) return []
        // delta 只带 partID → 反查 callID（updated 未记录映射时无法定位，跳过等 updated 兜底）
        const callID = ctx.partCallIDs.get(deltaProps.partID)
        if (!callID) return []
        const merged = { ...(ctx.toolInputs.get(callID) ?? {}), ...parsed }
        ctx.toolInputs.set(callID, merged)
        // 仅当该 callID 已发过 tool_use 卡片才补发更新（未发过由 updated 首次下发兜底）
        if (ctx.seenToolCallIDs.has(callID)) {
          const tu = { id: callID, name: '', input: merged }
          return [{ type: 'assistant', session_id: deltaProps.sessionID, text: '', thinking: '', tool_use: [tu] }]
        }
        return []
      }
      // 其他 field → 暂不产出（前端无消费点 [待实测]）
      return []
    }
    case 'session.idle': {
      // 子会话完成 → subtask idle（不产 result，主会话 result 语义仅限活跃会话）
      if (isSubSession) {
        return [{ type: 'subtask', session_id: sessionID, text: '', thinking: '', subId: sessionID, parentId: ctx.activeSessionId, kind: 'idle' }]
      }
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
      // 子会话错误（子 agent 模型/工具失败）→ subtask error（前端标失败，不产主会话 error）
      if (isSubSession) {
        return [{ type: 'subtask', session_id: sessionID, text: '', thinking: '', subId: sessionID, parentId: ctx.activeSessionId, kind: 'error' }]
      }
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
  /**
   * 当前活跃会话 id 读取器（每次事件映射前调用）。
   * 子会话识别依赖（sessionID ≠ 活跃会话 → subtask）；renderer 切会话时由 ipc.ts 模块级变量更新。
   * 缺省时 ctx.activeSessionId 恒为 ''，不启用子会话识别（主会话事件映射不受影响）。
   */
  getActiveSessionId?: () => string
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
        // 每次事件前刷新活跃会话（renderer 切会话是异步通知，事件到达时取最新值）
        ctx.activeSessionId = opts.getActiveSessionId?.() ?? ''
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
