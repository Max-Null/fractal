// events 映射层单元测试：用 stage0 实测的真实 serve 事件验证 mapServeEvent
// 说明：events.test.ts 只测纯映射函数（mapServeEvent + createMapContext），
// 不建立真实 SSE 连接（SSE 连接留阶段 4 冒烟）
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import type { Event as ServeEvent, Part } from '@opencode-ai/sdk'
import { mapServeEvent, createMapContext, subscribeEvents, type MapContext, type StreamFrontendEvent } from './events'

const fixturePath = resolve(process.cwd(), 'electron/tests/fixtures')

function loadEvents(name: string): ServeEvent[] {
  return JSON.parse(readFileSync(resolve(fixturePath, name), 'utf-8')) as ServeEvent[]
}

/** 便利构造：合成一条 serve 事件（fixture 无 assistant 输出的真实报文，分派逻辑用合成数据验证） */
// Event 联合类型不含 SSE 外层 id 字段（实际报文有），用 & 扩展承载测试数据
function synthEvent(type: string, properties: Record<string, unknown>): ServeEvent {
  return { id: 'evt_test', type: type as ServeEvent['type'], properties } as ServeEvent
}

/** 合成 Part：公共字段补齐 + 状态类 part 的 time 由具体 state 对象提供（测试用宽松结构绕过 SDK 严格校验） */
function synthPart(part: Record<string, unknown>): Part {
  return { id: 'prt_test', sessionID: 'ses_test', messageID: 'msg_test', ...part } as unknown as Part
}

describe('mapServeEvent 真实 fixture（events-round2.json，21 条）', () => {
  it('server.connected / session.created / session.updated / session.status 不产出事件', () => {
    const ctx = createMapContext()
    const evts = loadEvents('events-round2.json')
    const mapped = evts.flatMap((e) => mapServeEvent(e, ctx))
    // 21 条中仅 session.idle（2）→ result、session.error（4）→ error 有产出，其余 15 条为内部状态
    expect(mapped.filter((e) => e.type === 'result')).toHaveLength(2)
    expect(mapped.filter((e) => e.type === 'error')).toHaveLength(4)
    expect(mapped.filter((e) => e.type === 'assistant')).toHaveLength(0)
    expect(mapped.filter((e) => e.type === 'user')).toHaveLength(0)
  })

  it('session.idle → result(is_final) 并携带 session_id', () => {
    const ctx = createMapContext()
    const evts = loadEvents('events-round2.json')
    const results = evts.flatMap((e) => mapServeEvent(e, ctx)).filter((e) => e.type === 'result')
    // 实测会话两个：ses_02cbe716dffeirzgVVoA5LwnJc / ses_02cbe6fabffeBNPRLdgT1l0Xgw
    expect(results.map((r) => (r.type === 'result' ? r.session_id : undefined)).sort()).toEqual([
      'ses_02cbe6fabffeBNPRLdgT1l0Xgw',
      'ses_02cbe716dffeirzgVVoA5LwnJc',
    ])
    for (const r of results) {
      if (r.type !== 'result') continue
      expect(r.is_final).toBe(true)
      expect(r.text).toBe('')
      expect(r.thinking).toBe('')
    }
  })

  it('session.error → error 事件，message 从 error.data.message 提取', () => {
    const ctx = createMapContext()
    const evts = loadEvents('events-round2.json')
    const errors = evts.flatMap((e) => mapServeEvent(e, ctx)).filter((e) => e.type === 'error')
    expect(errors.length).toBeGreaterThan(0)
    // 实测 error 结构 {name:"UnknownError", data:{message:"Model not found: ..."}}
    expect(errors[0].type).toBe('error')
    if (errors[0].type !== 'error') return
    expect(errors[0].error).toContain('Model not found')
  })

  it('text part（user 消息回显）不产出事件——前端已本地 addUserMessage', () => {
    const ctx = createMapContext()
    const evts = loadEvents('events-round2.json')
    const textParts = evts.filter((e) => e.type === 'message.part.updated' && (e.properties as { part?: Part }).part?.type === 'text')
    expect(textParts.length).toBeGreaterThan(0)
    // 先按真实到达顺序跑完整序列（message.updated 先行填充 ctx.messageRoles），再验证回显文本不产出
    evts.forEach((e) => mapServeEvent(e, ctx))
    const mapped = textParts.flatMap((e) => mapServeEvent(e, ctx))
    // 实测两个 text part 均属 role=user 的用户消息（"只回复两个字：你好" / "用工具读取当前目录的文件列表"）
    expect(mapped).toHaveLength(0)
  })
})

describe('mapServeEvent 真实 fixture（events-all.json，35 条，含 fork 会话）', () => {
  it('完整流程：4 会话含 fork，仅 idle/error 有产出', () => {
    const ctx = createMapContext()
    const evts = loadEvents('events-all.json')
    const mapped = evts.flatMap((e) => mapServeEvent(e, ctx))
    // all 含 3 个 session.idle + 6 个 session.error（含 abort 轮）
    expect(mapped.filter((e) => e.type === 'result')).toHaveLength(3)
    expect(mapped.filter((e) => e.type === 'error')).toHaveLength(6)
    expect(mapped.filter((e) => e.type === 'assistant')).toHaveLength(0)
    expect(mapped.filter((e) => e.type === 'user')).toHaveLength(0)
  })
})

describe('mapServeEvent 合成事件：message.part.updated 分派', () => {
  function ctxWithRole(role: string): MapContext {
    const ctx = createMapContext()
    ctx.messageRoles.set('msg_test', role)
    return ctx
  }

  it('text part（assistant）→ assistant 事件，delta 优先于全量', () => {
    const ctx = ctxWithRole('assistant')
    const evt = synthEvent('message.part.updated', {
      sessionID: 'ses_test',
      part: synthPart({ type: 'text', text: '你好，我是助手' }),
      delta: '，我是助手',
    })
    const out = mapServeEvent(evt, ctx)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ type: 'assistant', session_id: 'ses_test', text: '，我是助手', thinking: '' })
  })

  it('text part（assistant，无 delta）→ 用全量 part.text', () => {
    const ctx = ctxWithRole('assistant')
    const evt = synthEvent('message.part.updated', {
      sessionID: 'ses_test',
      part: synthPart({ type: 'text', text: '完整文本' }),
    })
    const out = mapServeEvent(evt, ctx)
    expect(out[0]).toMatchObject({ type: 'assistant', text: '完整文本' })
  })

  it('reasoning part → assistant(thinking)（思考阶段）', () => {
    const ctx = ctxWithRole('assistant')
    const evt = synthEvent('message.part.updated', {
      sessionID: 'ses_test',
      part: synthPart({ type: 'reasoning', text: '让我想想' }),
    })
    const out = mapServeEvent(evt, ctx)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ type: 'assistant', thinking: '让我想想', text: '' })
  })

  it('reasoning part 带 time → assistant(thinking) 携带 thinkingDurationMs（2026-08-10 服务端思考耗时透传）', () => {
    const ctx = ctxWithRole('assistant')
    const evt = synthEvent('message.part.updated', {
      sessionID: 'ses_test',
      part: synthPart({ type: 'reasoning', text: '思考完成', time: { start: 1000, end: 2500 } }),
    })
    const out = mapServeEvent(evt, ctx)
    expect(out[0]).toMatchObject({ type: 'assistant', thinking: '思考完成', thinkingDurationMs: 1500 })
  })

  it('tool part（pending，首次）→ assistant(tool_use) 创建工具卡片', () => {
    const ctx = ctxWithRole('assistant')
    const evt = synthEvent('message.part.updated', {
      sessionID: 'ses_test',
      part: synthPart({
        type: 'tool',
        callID: 'call_1',
        tool: 'Bash',
        state: { status: 'pending', input: { command: 'ls' }, raw: '' },
      }),
    })
    const out = mapServeEvent(evt, ctx)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      type: 'assistant',
      tool_use: [{ id: 'call_1', name: 'Bash', input: { command: 'ls' } }],
    })
  })

  it('tool part（running，同一 callID 第二次）→ 不再重复发 tool_use', () => {
    const ctx = ctxWithRole('assistant')
    const pending = synthEvent('message.part.updated', {
      sessionID: 'ses_test',
      part: synthPart({ type: 'tool', callID: 'call_1', tool: 'Bash', state: { status: 'pending', input: {}, raw: '' } }),
    })
    mapServeEvent(pending, ctx)
    const running = synthEvent('message.part.updated', {
      sessionID: 'ses_test',
      part: synthPart({
        type: 'tool',
        callID: 'call_1',
        tool: 'Bash',
        state: { status: 'running', input: {}, title: '运行中' },
      }),
    })
    const out = mapServeEvent(running, ctx)
    expect(out).toHaveLength(0)
  })

  it('tool part input 变化（pending {} → running 完整）→ 补发 tool_use（前端 upsert 幂等，2026-08-10）', () => {
    const ctx = ctxWithRole('assistant')
    const pending = synthEvent('message.part.updated', {
      sessionID: 'ses_test',
      part: synthPart({ type: 'tool', callID: 'call_in', tool: 'Read', state: { status: 'pending', input: {} } }),
    })
    const out1 = mapServeEvent(pending, ctx)
    expect(out1[0]).toMatchObject({ type: 'assistant', tool_use: [{ id: 'call_in', input: {} }] })
    // serve 状态流转：running 携带完整 input（1.18.15 实测无 delta field='input'）→ 必须补发
    const running = synthEvent('message.part.updated', {
      sessionID: 'ses_test',
      part: synthPart({
        type: 'tool',
        callID: 'call_in',
        tool: 'Read',
        state: { status: 'running', input: { filePath: 'H:\\a.txt' } },
      }),
    })
    const out2 = mapServeEvent(running, ctx)
    expect(out2).toHaveLength(1)
    expect(out2[0]).toMatchObject({ type: 'assistant', tool_use: [{ id: 'call_in', input: { filePath: 'H:\\a.txt' } }] })
    // 第三次 input 无变化 → 不补发
    const running2 = synthEvent('message.part.updated', {
      sessionID: 'ses_test',
      part: synthPart({
        type: 'tool',
        callID: 'call_in',
        tool: 'Read',
        state: { status: 'running', input: { filePath: 'H:\\a.txt' } },
      }),
    })
    expect(mapServeEvent(running2, ctx)).toHaveLength(0)
  })

  it('task 工具：state.metadata.sessionId 合并进 input.metadata（前端 subtask 节点归属查询键，2026-08-10）', () => {
    const ctx = ctxWithRole('assistant')
    // running 态 serve 即带 metadata.sessionId（1.18.15 实测），input 里没有
    const running = synthEvent('message.part.updated', {
      sessionID: 'ses_test',
      part: synthPart({
        type: 'tool',
        callID: 'call_task',
        tool: 'task',
        state: {
          status: 'running',
          input: { description: '查天气', prompt: '请搜索…', subagent_type: '侦查兵' },
          metadata: { parentSessionId: 'ses_test', sessionId: 'ses_sub_1' },
        },
      }),
    })
    const out = mapServeEvent(running, ctx)
    expect(out[0]).toMatchObject({
      type: 'assistant',
      tool_use: [
        {
          id: 'call_task',
          input: {
            description: '查天气',
            prompt: '请搜索…',
            subagent_type: '侦查兵',
            metadata: { sessionId: 'ses_sub_1' },
          },
        },
      ],
    })
  })

  it('task 工具 metadata 合并不覆盖 input 自带 metadata（键级合并）', () => {
    const ctx = ctxWithRole('assistant')
    const running = synthEvent('message.part.updated', {
      sessionID: 'ses_test',
      part: synthPart({
        type: 'tool',
        callID: 'call_task2',
        tool: 'task',
        state: {
          status: 'running',
          input: { description: '查', metadata: { extra: 1 } },
          metadata: { sessionId: 'ses_sub_2' },
        },
      }),
    })
    const out = mapServeEvent(running, ctx)
    expect(out[0]).toMatchObject({
      type: 'assistant',
      tool_use: [{ id: 'call_task2', input: { metadata: { extra: 1, sessionId: 'ses_sub_2' } } }],
    })
  })

  it('tool 耗时用首次 start（time.start 每次 running 更新都变 → end-末次 start 是假象，2026-08-10）', () => {
    const ctx = ctxWithRole('assistant')
    const run1 = synthEvent('message.part.updated', {
      sessionID: 'ses_test',
      part: synthPart({
        type: 'tool',
        callID: 'call_dur',
        tool: 'Bash',
        state: { status: 'running', input: { command: 'ls' }, time: { start: 1000 } },
      }),
    })
    mapServeEvent(run1, ctx)
    const run2 = synthEvent('message.part.updated', {
      sessionID: 'ses_test',
      part: synthPart({
        type: 'tool',
        callID: 'call_dur',
        tool: 'Bash',
        state: { status: 'running', input: { command: 'ls' }, time: { start: 2000 } },
      }),
    })
    mapServeEvent(run2, ctx)
    const completed = synthEvent('message.part.updated', {
      sessionID: 'ses_test',
      part: synthPart({
        type: 'tool',
        callID: 'call_dur',
        tool: 'Bash',
        state: { status: 'completed', input: { command: 'ls' }, output: 'ok', time: { start: 3000, end: 3100 } },
      }),
    })
    const out = mapServeEvent(completed, ctx)
    const user = out.find((e) => e.type === 'user')
    if (user?.type !== 'user') throw new Error('期望 user 事件')
    // 首次 start=1000 → 3100-1000=2100；若误用末次 start=3000 则只有 100
    expect(user.tool_results).toEqual([{ tool_use_id: 'call_dur', content: 'ok', is_error: false, executionDurationMs: 2100 }])
  })

  it('tool part（completed）→ user(tool_results) 回填输出', () => {
    const ctx = ctxWithRole('assistant')
    const completed = synthEvent('message.part.updated', {
      sessionID: 'ses_test',
      part: synthPart({
        type: 'tool',
        callID: 'call_1',
        tool: 'Bash',
        state: { status: 'completed', input: {}, output: 'file list', title: '完成', metadata: {} },
      }),
    })
    const out = mapServeEvent(completed, ctx)
    expect(out).toHaveLength(2) // 首次见 → tool_use + completed → tool_results
    const user = out.find((e) => e.type === 'user')
    expect(user).toBeDefined()
    if (user?.type !== 'user') return
    expect(user.tool_results).toEqual([{ tool_use_id: 'call_1', content: 'file list', is_error: false }])
  })

  it('同一工具重复 completed updated → tool_results 只回填一次（sentToolResults 去重，2026-08-10）', () => {
    const ctx = ctxWithRole('assistant')
    const first = synthEvent('message.part.updated', {
      sessionID: 'ses_test',
      part: synthPart({ type: 'tool', callID: 'call_dup', tool: 'Bash', state: { status: 'completed', input: {}, output: '一次' } }),
    })
    mapServeEvent(first, ctx)
    const second = synthEvent('message.part.updated', {
      sessionID: 'ses_test',
      part: synthPart({ type: 'tool', callID: 'call_dup', tool: 'Bash', state: { status: 'completed', input: {}, output: '二次' } }),
    })
    const out = mapServeEvent(second, ctx)
    // 非首次 updated：不发 tool_use（已发）；completed 但已回填 → 也不发 tool_results
    expect(out).toHaveLength(0)
  })

  it('tool part（error）→ user(tool_results) is_error=true', () => {
    const ctx = ctxWithRole('assistant')
    const err = synthEvent('message.part.updated', {
      sessionID: 'ses_test',
      part: synthPart({
        type: 'tool',
        callID: 'call_2',
        tool: 'Bash',
        state: { status: 'error', input: {}, error: 'command failed' },
      }),
    })
    const out = mapServeEvent(err, ctx)
    const user = out.find((e) => e.type === 'user')
    if (user?.type !== 'user') throw new Error('期望 user 事件')
    expect(user.tool_results).toEqual([{ tool_use_id: 'call_2', content: 'command failed', is_error: true }])
  })

  it('tool part 带 time（running 首次）→ tool_use 携带 startedAt（2026-08-10 服务端耗时透传）', () => {
    const ctx = ctxWithRole('assistant')
    const evt = synthEvent('message.part.updated', {
      sessionID: 'ses_test',
      part: synthPart({
        type: 'tool',
        callID: 'call_t',
        tool: 'Bash',
        state: { status: 'running', input: {}, time: { start: 1000, end: 3000 } },
      }),
    })
    const out = mapServeEvent(evt, ctx)
    expect(out[0]).toMatchObject({ type: 'assistant', tool_use: [{ id: 'call_t', name: 'Bash', startedAt: 1000 }] })
  })

  it('tool part 带 time（completed）→ tool_results 携带 executionDurationMs=end-start', () => {
    const ctx = ctxWithRole('assistant')
    const evt = synthEvent('message.part.updated', {
      sessionID: 'ses_test',
      part: synthPart({
        type: 'tool',
        callID: 'call_t2',
        tool: 'Bash',
        state: { status: 'completed', input: {}, output: 'ok', time: { start: 1000, end: 3000 } },
      }),
    })
    const out = mapServeEvent(evt, ctx)
    const user = out.find((e) => e.type === 'user')
    if (user?.type !== 'user') throw new Error('期望 user 事件')
    expect(user.tool_results).toEqual([{ tool_use_id: 'call_t2', content: 'ok', is_error: false, executionDurationMs: 2000 }])
  })

  it('未知 part 类型（file/step 等）→ 不产出 [待实测]', () => {
    const ctx = ctxWithRole('assistant')
    const evt = synthEvent('message.part.updated', {
      sessionID: 'ses_test',
      part: synthPart({ type: 'file', mime: 'text/plain', url: 'file:///a.txt' }),
    })
    expect(mapServeEvent(evt, ctx)).toHaveLength(0)
  })
})

describe('mapServeEvent 合成事件：message.part.delta（打字机增量）', () => {
  it('text delta → assistant(text) 增量（partTypes 已记录 part 类型）', () => {
    const ctx = createMapContext()
    ctx.partTypes.set('prt_text', 'text')
    const evt = synthEvent('message.part.delta', {
      sessionID: 'ses_test',
      messageID: 'msg_test',
      partID: 'prt_text',
      field: 'text',
      delta: '你好',
    })
    expect(mapServeEvent(evt, ctx)).toEqual([{ type: 'assistant', session_id: 'ses_test', text: '你好', thinking: '' }])
  })

  it('reasoning delta → assistant(thinking) 增量', () => {
    const ctx = createMapContext()
    ctx.partTypes.set('prt_reason', 'reasoning')
    const evt = synthEvent('message.part.delta', {
      sessionID: 'ses_test',
      messageID: 'msg_test',
      partID: 'prt_reason',
      field: 'text',
      delta: '让我想想',
    })
    const out = mapServeEvent(evt, ctx)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ type: 'assistant', thinking: '让我想想', text: '' })
  })

  it('tool input delta → 累积并按 callID 补发 tool_use（前端 upsert 幂等）', () => {
    const ctx = createMapContext()
    ctx.partTypes.set('prt_tool', 'tool')
    ctx.partCallIDs.set('prt_tool', 'call_1')
    ctx.seenToolCallIDs.add('call_1')
    const evt = synthEvent('message.part.delta', {
      sessionID: 'ses_test',
      messageID: 'msg_test',
      partID: 'prt_tool',
      field: 'input',
      delta: '{"command":"ls"}',
    })
    const out = mapServeEvent(evt, ctx)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ type: 'assistant', tool_use: [{ id: 'call_1', input: { command: 'ls' } }] })
    // 累积可被后续 updated 复用：第二次 delta 合并而非覆盖
    const evt2 = synthEvent('message.part.delta', {
      sessionID: 'ses_test',
      messageID: 'msg_test',
      partID: 'prt_tool',
      field: 'input',
      delta: '{"cwd":"/tmp"}',
    })
    const out2 = mapServeEvent(evt2, ctx)
    expect(out2[0]).toMatchObject({ type: 'assistant', tool_use: [{ id: 'call_1', input: { command: 'ls', cwd: '/tmp' } }] })
  })

  it('tool input delta（未发过卡片 / partID 无映射）→ 不产出（updated 首次下发兜底）', () => {
    const ctx = createMapContext()
    ctx.partTypes.set('prt_tool', 'tool')
    // seenToolCallIDs 无该 callID → 不补发
    const evt = synthEvent('message.part.delta', {
      sessionID: 'ses_test',
      messageID: 'msg_test',
      partID: 'prt_tool',
      field: 'input',
      delta: '{"command":"ls"}',
    })
    expect(mapServeEvent(evt, ctx)).toHaveLength(0)
  })

  it('partTypes 查不到（先行的 updated 未到）→ 跳过', () => {
    const ctx = createMapContext()
    const evt = synthEvent('message.part.delta', {
      sessionID: 'ses_test',
      messageID: 'msg_test',
      partID: 'prt_unknown',
      field: 'text',
      delta: 'x',
    })
    expect(mapServeEvent(evt, ctx)).toHaveLength(0)
  })

  it('field 非 text（如 output/其他）→ 不产出', () => {
    const ctx = createMapContext()
    ctx.partTypes.set('prt_text', 'text')
    const evt = synthEvent('message.part.delta', {
      sessionID: 'ses_test',
      messageID: 'msg_test',
      partID: 'prt_text',
      field: 'other',
      delta: 'x',
    })
    expect(mapServeEvent(evt, ctx)).toHaveLength(0)
  })
})

describe('mapServeEvent 真实 fixture message.part.delta（events-round3-success.json，23 条）', () => {
  it('先喂 updated 填 partTypes，再喂 delta：产出连续 thinking/text 增量且与全量不重复', () => {
    const evts = loadEvents('events-round3-success.json')
    const ctx = createMapContext()
    // 先按真实顺序喂全部 updated（填充 partTypes），再喂 delta——模拟「updated 先到」时序
    const updated = evts.filter((e) => e.type === 'message.part.updated')
    // message.part.delta 是 serve 实测输出但 SDK 类型未生成（同 events.ts），比较前放宽为 string
    const deltas = evts.filter((e) => (e as { type: string }).type === 'message.part.delta')
    for (const e of updated) mapServeEvent(e, ctx)
    const deltaOut = deltas.flatMap((e) => mapServeEvent(e, ctx))

    const textDeltas = deltaOut.filter((e) => e.type === 'assistant' && e.text)
    const thinkingDeltas = deltaOut.filter((e) => e.type === 'assistant' && e.thinking)
    // 期望条数从 fixture 动态计算：fixture 由集成测试真实模型运行生成，thinking 增量条数不固定（22/19 均可能）
    const expectedThinking = deltas.filter((d) => (d.properties as { field?: string }).field === 'text').length - 1 // 总 text 增量含 1 条回复文本
    expect(thinkingDeltas).toHaveLength(expectedThinking)
    expect(textDeltas.map((e) => (e.type === 'assistant' ? e.text : ''))).toEqual(['你好'])

    // 增量拼接 = reasoning 全量（打字机增量不丢字，前端 appendText startsWith 去重后不重复）
    const joinedThinking = thinkingDeltas.map((e) => (e.type === 'assistant' ? e.thinking : '')).join('')
    const reasoningFull = updated
      .map((e) => (e.properties as { part?: Part }).part)
      .filter((p): p is Part & { type: 'reasoning'; text: string } => !!p && p.type === 'reasoning' && Boolean((p as { text?: string }).text))
      .at(-1)?.text
    expect(reasoningFull).toBeTruthy()
    expect(joinedThinking).toBe(reasoningFull)
  })

  it('delta 先行（partTypes 空）不产出，updated 全量兜底仍产出最终文本', () => {
    // 订阅中途才收到 updated 的场景：delta 全部丢弃，但最终全量 part 仍能渲染（不丢答案）
    const evts = loadEvents('events-round3-success.json')
    const ctx = createMapContext()
    const mapped = evts.flatMap((e) => mapServeEvent(e, ctx))
    const assistantTexts = mapped.filter((e) => e.type === 'assistant' && e.text).map((e) => (e.type === 'assistant' ? e.text : ''))
    // 全量 updated 产出 "你好"（assistant 文本最终完整，不受 delta 丢失影响）
    expect(assistantTexts.some((t) => t.includes('你好'))).toBe(true)
  })
})

describe('mapServeEvent 合成事件：权限 / 会话生命周期', () => {
  // 旧 permission.updated 用例（SDK 类型结构）已删除：实测 serve 1.18.5 事件为 permission.asked，
  // 结构以实测为准（下方 permission.asked 用例 + permission.updated 兼容用例覆盖）

  it('session.idle 附带最后一条 assistant 消息的消息级 tokens + 人民币成本', () => {
    const ctx = createMapContext()
    // 消息级 usage：serve 回合完成的 message.updated 携带（input=100 为该回合新增输入，非累计）
    // （2026-08-13 修复：此前用 session.updated 的会话累计值，前端二次累加导致弹窗 110% 超估）
    const updated = synthEvent('message.updated', {
      sessionID: 'ses_test',
      info: {
        id: 'msg_1',
        role: 'assistant',
        sessionID: 'ses_test',
        modelID: 'deepseek-v4-pro',
        providerID: 'deepseek',
        tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 0, write: 0 } },
      },
    })
    mapServeEvent(updated, ctx)
    const idle = synthEvent('session.idle', { sessionID: 'ses_test' })
    const out = mapServeEvent(idle, ctx)
    // pro 价：100/1e6×3 + 50/1e6×6 = 0.0006 元（浮点精度 → 近似断言）
    expect(out[0]).toMatchObject({ type: 'result', is_final: true, input_tokens: 100, output_tokens: 50 })
    expect((out[0] as { cost_cny?: number }).cost_cny).toBeCloseTo(0.0006, 8)
  })

  it('message.updated 消息级 tokens 优先于 session.updated 累计值（累计二次累加防回归）', () => {
    const ctx = createMapContext()
    // session.updated 携带多轮累计值——不能覆盖消息级值（否则 result 下发累计，前端二次累加超估）
    const updated = synthEvent('session.updated', {
      sessionID: 'ses_test',
      info: {
        id: 'ses_test',
        model: { id: 'deepseek-v4-pro', providerID: 'deepseek' },
        tokens: { input: 999999, output: 999999, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    })
    mapServeEvent(updated, ctx)
    // 消息级：本回合真实 usage input=1000
    const msgUpdated = synthEvent('message.updated', {
      sessionID: 'ses_test',
      info: {
        id: 'msg_1',
        role: 'assistant',
        sessionID: 'ses_test',
        modelID: 'deepseek-v4-pro',
        providerID: 'deepseek',
        tokens: { input: 1000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    })
    mapServeEvent(msgUpdated, ctx)
    const idle = synthEvent('session.idle', { sessionID: 'ses_test' })
    const out = mapServeEvent(idle, ctx)
    expect(out[0]).toMatchObject({ type: 'result', input_tokens: 1000, output_tokens: 0 })
    // 成本按消息级（1000/1e6×3 = 0.003），而非累计 999999
    expect((out[0] as { cost_cny?: number }).cost_cny).toBeCloseTo(0.003, 8)
  })

  it('result 透传消息级 cache tokens（弹窗算「当前上下文占用」= input+cacheRead+cacheWrite）', () => {
    const ctx = createMapContext()
    const msgUpdated = synthEvent('message.updated', {
      sessionID: 'ses_test',
      info: {
        id: 'msg_1',
        role: 'assistant',
        sessionID: 'ses_test',
        tokens: { input: 2000, output: 10, reasoning: 0, cache: { read: 8000, write: 500 } },
      },
    })
    mapServeEvent(msgUpdated, ctx)
    const idle = synthEvent('session.idle', { sessionID: 'ses_test' })
    const out = mapServeEvent(idle, ctx)
    expect(out[0]).toMatchObject({
      type: 'result',
      input_tokens: 2000,
      output_tokens: 10,
      cache_read_tokens: 8000,
      cache_write_tokens: 500,
    })
  })

  it('session.idle 成本含缓存命中优惠（cache.read 用缓存价）', () => {
    const ctx = createMapContext()
    // 消息级：input=2000（adjusted 口径，已减缓存命中）+ cache.read=8000 单独按缓存价
    // 未命中 2000×3/1e6 + 命中 8000×0.025/1e6 = 0.006 + 0.0002 = 0.0062 元
    const updated = synthEvent('message.updated', {
      sessionID: 'ses_test',
      info: {
        id: 'msg_1',
        role: 'assistant',
        sessionID: 'ses_test',
        modelID: 'deepseek-v4-pro',
        providerID: 'deepseek',
        tokens: { input: 2000, output: 0, reasoning: 0, cache: { read: 8000, write: 0 } },
      },
    })
    mapServeEvent(updated, ctx)
    const idle = synthEvent('session.idle', { sessionID: 'ses_test' })
    const out = mapServeEvent(idle, ctx)
    expect((out[0] as { cost_cny?: number }).cost_cny).toBeCloseTo(0.0062, 8)
  })

  it('session.idle 输出 duration_ms（session.created 起始计时）', () => {
    // 注入可变时间源：created 时刻 t=100，idle 时刻 t=500 → duration_ms=400
    let t = 100
    const ctx = createMapContext(() => t)
    const created = synthEvent('session.created', {
      sessionID: 'ses_test',
      info: { id: 'ses_test', tokens: { input: 0, output: 0, cost: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
    })
    mapServeEvent(created, ctx)
    t = 500
    const idle = synthEvent('session.idle', { sessionID: 'ses_test' })
    const out = mapServeEvent(idle, ctx)
    expect(out[0]).toMatchObject({ type: 'result', duration_ms: 400 })
  })

  it('session.updated 缺 model 时保留旧 modelId（异常事件不把整会话成本打成兜底价）', () => {
    const ctx = createMapContext()
    // 首次 updated 带 model → 记 pro
    const first = synthEvent('session.updated', {
      sessionID: 'ses_test',
      info: {
        id: 'ses_test',
        model: { id: 'deepseek-v4-pro', providerID: 'deepseek' },
        tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    })
    mapServeEvent(first, ctx)
    // 第二次 updated 只带 tokens 缺 model（serve 异常变体）→ modelId 不应被清空
    const second = synthEvent('session.updated', {
      sessionID: 'ses_test',
      info: { id: 'ses_test', tokens: { input: 200, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } },
    })
    mapServeEvent(second, ctx)
    const idle = synthEvent('session.idle', { sessionID: 'ses_test' })
    const out = mapServeEvent(idle, ctx)
    // 仍按 pro 价：200/1e6×3 + 10/1e6×6 = 0.00066（若被清空 → flash 兜底 0.00022）
    expect((out[0] as { cost_cny?: number }).cost_cny).toBeCloseTo(0.00066, 8)
  })

  it('session.idle 无起始记录时不输出 duration_ms', () => {
    // 订阅中途加入（未经历 created）→ 不产出 duration_ms，避免脏数据
    const ctx = createMapContext()
    const idle = synthEvent('session.idle', { sessionID: 'ses_test' })
    const out = mapServeEvent(idle, ctx)
    expect(out[0]).toMatchObject({ type: 'result' })
    expect((out[0] as { duration_ms?: number }).duration_ms).toBeUndefined()
  })

  it('server.connected → 不产出（订阅层 onConnected 处理）', () => {
    const ctx = createMapContext()
    const evt = synthEvent('server.connected', {})
    expect(mapServeEvent(evt, ctx)).toHaveLength(0)
  })

  it('todo.updated → todo 事件（实测 2026-08-07 报文结构）', () => {
    const ctx = createMapContext()
    const evt = synthEvent('todo.updated', {
      sessionID: 'ses_test',
      todos: [
        { content: '1 写README', status: 'pending', priority: 'high' },
        { content: '运行测试', status: 'pending', priority: 'high' }
      ]
    })
    const out = mapServeEvent(evt, ctx)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      type: 'todo',
      session_id: 'ses_test',
      todos: [
        { content: '1 写README', status: 'pending', priority: 'high' },
        { content: '运行测试', status: 'pending', priority: 'high' }
      ]
    })
  })

  it('permission.asked → control_request（实测结构：permission/patterns/metadata/always）', () => {
    const ctx = createMapContext()
    const evt = synthEvent('permission.asked', {
      id: 'per_test123',
      sessionID: 'ses_test',
      permission: 'bash',
      patterns: ['echo probe-permission-check'],
      metadata: { command: 'echo probe-permission-check' },
      always: ['echo *'],
      tool: { messageID: 'msg_x', callID: 'call_x' }
    })
    const out = mapServeEvent(evt, ctx)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      type: 'control_request',
      session_id: 'ses_test',
      control_request: {
        subtype: 'approval',
        tool_name: 'bash',
        tool_input: { command: 'echo probe-permission-check' },
        request_id: 'per_test123',
        always: ['echo *']
      }
    })
  })

  it('permission.updated（SDK 旧名）兼容映射', () => {
    const ctx = createMapContext()
    const evt = synthEvent('permission.updated', {
      id: 'per_old',
      sessionID: 'ses_test',
      permission: 'edit',
      metadata: { file_path: 'a.ts' },
      always: ['edit **/*.ts']
    })
    const out = mapServeEvent(evt, ctx)
    expect(out[0]).toMatchObject({ type: 'control_request', control_request: { request_id: 'per_old', tool_name: 'edit' } })
  })

  it('question.asked → control_request(subtype=question) 携带 questions', () => {
    const ctx = createMapContext()
    const evt = synthEvent('question.asked', {
      id: 'que_test123',
      sessionID: 'ses_test',
      questions: [
        {
          question: '你更偏好哪个配色方案？',
          header: '配色方案',
          options: [
            { label: 'A 深色', description: '深色主题配色' },
            { label: 'B 浅色', description: '浅色主题配色' }
          ]
        }
      ],
      tool: { messageID: 'msg_x', callID: 'call_x' }
    })
    const out = mapServeEvent(evt, ctx)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      type: 'control_request',
      session_id: 'ses_test',
      control_request: {
        subtype: 'question',
        tool_name: 'AskUserQuestion',
        request_id: 'que_test123',
        questions: [
          {
            question: '你更偏好哪个配色方案？',
            header: '配色方案',
            options: [
              { label: 'A 深色', description: '深色主题配色' },
              { label: 'B 浅色', description: '浅色主题配色' }
            ]
          }
        ]
      }
    })
  })
})

describe('mapServeEvent 合成事件：子会话识别（activeSessionId ≠ sessionID → subtask）', () => {
  /** 构造已设置活跃会话的 ctx（模拟 renderer 已上报 ses_main） */
  function ctxWithActive(): MapContext {
    const ctx = createMapContext()
    ctx.activeSessionId = 'ses_main'
    return ctx
  }

  it('子会话 session.created → subtask created（携带 agent 与 parentId）', () => {
    const ctx = ctxWithActive()
    const evt = synthEvent('session.created', {
      sessionID: 'ses_sub_1',
      info: { id: 'ses_sub_1', agent: '工匠' },
    })
    const out = mapServeEvent(evt, ctx)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      type: 'subtask',
      subId: 'ses_sub_1',
      parentId: 'ses_main',
      agent: '工匠',
      kind: 'created',
    })
  })

  it('子会话 message.part.delta（text）→ subtask delta', () => {
    const ctx = ctxWithActive()
    ctx.partTypes.set('prt_sub_text', 'text')
    const evt = synthEvent('message.part.delta', {
      sessionID: 'ses_sub_1',
      messageID: 'msg_sub',
      partID: 'prt_sub_text',
      field: 'text',
      delta: '正在处理',
    })
    const out = mapServeEvent(evt, ctx)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      type: 'subtask',
      subId: 'ses_sub_1',
      parentId: 'ses_main',
      kind: 'delta',
      text: '正在处理',
    })
  })

  it('子会话 message.part.updated → subtask part（text/thinking/tool 分派）', () => {
    const ctx = ctxWithActive()

    const textOut = mapServeEvent(
      synthEvent('message.part.updated', {
        sessionID: 'ses_sub_1',
        part: synthPart({ id: 'prt_a', type: 'text', text: '子任务回复' }),
      }),
      ctx,
    )
    expect(textOut[0]).toMatchObject({ type: 'subtask', subId: 'ses_sub_1', kind: 'part', part: { type: 'text', text: '子任务回复' } })

    const thinkOut = mapServeEvent(
      synthEvent('message.part.updated', {
        sessionID: 'ses_sub_1',
        part: synthPart({ id: 'prt_b', type: 'reasoning', text: '思考过程' }),
      }),
      ctx,
    )
    expect(thinkOut[0]).toMatchObject({ type: 'subtask', subId: 'ses_sub_1', kind: 'part', part: { type: 'thinking', text: '思考过程' } })

    const toolOut = mapServeEvent(
      synthEvent('message.part.updated', {
        sessionID: 'ses_sub_1',
        part: synthPart({ id: 'prt_c', type: 'tool', callID: 'call_sub', tool: 'Bash', state: { status: 'running', input: {} } }),
      }),
      ctx,
    )
    expect(toolOut[0]).toMatchObject({ type: 'subtask', subId: 'ses_sub_1', kind: 'part', part: { type: 'tool', tool: 'Bash', state: 'running' } })
  })

  it('子会话 session.idle → subtask idle（不产出 result）', () => {
    const ctx = ctxWithActive()
    const idle = synthEvent('session.idle', { sessionID: 'ses_sub_1' })
    const out = mapServeEvent(idle, ctx)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ type: 'subtask', subId: 'ses_sub_1', parentId: 'ses_main', kind: 'idle' })
    expect(out[0].type).not.toBe('result')
  })

  it('主会话事件（sessionID = 活跃会话）不产生 subtask，现有映射不变', () => {
    const ctx = ctxWithActive()
    // session.created（主会话）→ 内部状态不产出（与无活跃会话时行为一致）
    const created = synthEvent('session.created', {
      sessionID: 'ses_main',
      info: { id: 'ses_main', tokens: { input: 0, output: 0, cost: 0 } },
    })
    expect(mapServeEvent(created, ctx)).toHaveLength(0)
    // 主会话 text part → assistant 事件（不受子会话识别影响）
    ctx.messageRoles.set('msg_main', 'assistant')
    const part = synthEvent('message.part.updated', {
      sessionID: 'ses_main',
      part: synthPart({ id: 'prt_main', type: 'text', text: '主会话回复' }),
    })
    const out = mapServeEvent(part, ctx)
    expect(out[0]).toMatchObject({ type: 'assistant', session_id: 'ses_main', text: '主会话回复' })
    // 主会话 idle → result
    const idle = synthEvent('session.idle', { sessionID: 'ses_main' })
    expect(mapServeEvent(idle, ctx)[0].type).toBe('result')
  })

  it('子会话 session.error → subtask error（不产主会话 error），透传错误文本（顶层 message 结构）', () => {
    const ctx = ctxWithActive()
    const err = synthEvent('session.error', {
      sessionID: 'ses_sub_1',
      error: { name: 'AI_APICallError', message: 'The engine is currently overloaded, please try again later' },
    })
    const out = mapServeEvent(err, ctx)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      type: 'subtask', subId: 'ses_sub_1', parentId: 'ses_main', kind: 'error',
      error: 'The engine is currently overloaded, please try again later',
    })
  })

  it('子会话 session.error 透传 data.message 结构（旧 serve 错误格式仍兼容）', () => {
    const ctx = ctxWithActive()
    const err = synthEvent('session.error', {
      sessionID: 'ses_sub_1',
      error: { name: 'ProviderAuthError', data: { message: 'API key 无效' } },
    })
    const out = mapServeEvent(err, ctx)
    expect(out[0]).toMatchObject({ type: 'subtask', kind: 'error', error: 'API key 无效' })
  })

  it('子会话 session.error 无 message → 退化为错误名', () => {
    const ctx = ctxWithActive()
    const err = synthEvent('session.error', { sessionID: 'ses_sub_1', error: { name: 'UnknownError' } })
    const out = mapServeEvent(err, ctx)
    expect(out[0]).toMatchObject({ type: 'subtask', kind: 'error', error: 'UnknownError' })
  })

  it('主会话 session.error → error 通道（不受子会话识别影响）', () => {
    const ctx = ctxWithActive()
    const err = synthEvent('session.error', {
      sessionID: 'ses_main',
      error: { message: '认证失败' },
    })
    const out = mapServeEvent(err, ctx)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ type: 'error', session_id: 'ses_main' })
  })

  it('多窗口：不同 ctx 的 activeSessionId 各自独立判定（窗口 B 切换不劫持窗口 A）', () => {
    // 模拟窗口 A（活跃 ses_a）与窗口 B（活跃 ses_b）的独立订阅实例
    const ctxA = createMapContext()
    ctxA.activeSessionId = 'ses_a'
    const ctxB = createMapContext()
    ctxB.activeSessionId = 'ses_b'

    // 会话 ses_a：窗口 A 视为主会话（assistant 事件），窗口 B 视为子会话（subtask）
    ctxA.messageRoles.set('msg_a', 'assistant')
    const evt = synthEvent('message.part.updated', {
      sessionID: 'ses_a',
      part: synthPart({ id: 'prt_a', type: 'text', text: 'A 的回复' }),
    })
    const outA = mapServeEvent(evt, ctxA)
    expect(outA[0]).toMatchObject({ type: 'assistant', session_id: 'ses_a' })
    const outB = mapServeEvent(evt, ctxB)
    expect(outB[0]).toMatchObject({ type: 'subtask', subId: 'ses_a', parentId: 'ses_b' })

    // 会话 ses_b：窗口 B 视为主会话（result），窗口 A 视为子会话（subtask idle）
    const idle = synthEvent('session.idle', { sessionID: 'ses_b' })
    expect(mapServeEvent(idle, ctxB)[0].type).toBe('result')
    expect(mapServeEvent(idle, ctxA)[0]).toMatchObject({ type: 'subtask', subId: 'ses_b', parentId: 'ses_a', kind: 'idle' })
  })

  it('活跃会话未设置（activeSessionId 空）→ 不识别子会话（保持旧行为）', () => {
    const ctx = createMapContext() // activeSessionId 默认 ''
    const created = synthEvent('session.created', {
      sessionID: 'ses_any',
      info: { id: 'ses_any', agent: '工匠' },
    })
    expect(mapServeEvent(created, ctx)).toHaveLength(0)
    const idle = synthEvent('session.idle', { sessionID: 'ses_any' })
    expect(mapServeEvent(idle, ctx)[0].type).toBe('result')
  })
})


// ── subscribeEvents 原始事件透传（onRawEvent）──
// 说明：其余用例只测纯映射函数；本组用 mock fetch 注入 SSE 流，验证订阅层透传原始 ServeEvent
describe('subscribeEvents onRawEvent（原始事件透传，会话目录缓存维护用）', () => {
  /** 构造 serve v2 SSE 响应体（data: {payload:...} 行 + \n\n 分隔），stub 全局 fetch */
  function mockEventStream(evts: ServeEvent[]) {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const ev of evts) {
          const data = JSON.stringify({ payload: ev })
          controller.enqueue(encoder.encode(`data: ${data}\n\n`))
        }
        controller.close()
      },
    })
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', body: stream }) as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('每条原始事件先经 onRawEvent 透传（含 session.created 的 directory），再走 onEvent 映射', async () => {
    const rawEvents: ServeEvent[] = [
      { id: 'evt_conn', type: 'server.connected', properties: {} } as unknown as ServeEvent,
      {
        id: 'evt_created',
        type: 'session.created',
        properties: { sessionID: 'ses_a', info: { id: 'ses_a', directory: 'H:/work/A' } },
      } as unknown as ServeEvent,
      {
        id: 'evt_part',
        type: 'message.part.updated',
        properties: { sessionID: 'ses_a', part: { id: 'prt1', type: 'text', text: 'hi' } },
      } as unknown as ServeEvent,
    ]
    mockEventStream(rawEvents)
    const rawSeen: ServeEvent[] = []
    const mappedSeen: StreamFrontendEvent[] = []
    const stop = await subscribeEvents({
      baseURL: 'http://127.0.0.1:9999',
      username: 'u',
      password: 'p',
      onRawEvent: (ev) => rawSeen.push(ev),
      onEvent: (evt) => mappedSeen.push(evt),
    })
    try {
      // 流式消费是异步的：mock stream 立即 close，等待事件处理完成
      await new Promise((r) => setTimeout(r, 100))
      // server.connected 走 onConnected 专用通道，不经过 onRawEvent
      expect(rawSeen.map((e) => e.type)).toEqual(['session.created', 'message.part.updated'])
      // 原始事件保留 directory（会话目录缓存维护的数据源）
      expect((rawSeen[0].properties as Record<string, unknown>).info).toMatchObject({ directory: 'H:/work/A' })
      // onEvent 收到映射后的事件（message.part.updated text → assistant）
      expect(mappedSeen.some((e) => e.type === 'assistant')).toBe(true)
    } finally {
      stop()
      vi.unstubAllGlobals()
    }
  })
})