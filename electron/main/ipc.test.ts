// ipc.ts 纯函数单元测试（不依赖 electron 运行时，node 环境）
// 覆盖军师审查 🔴3：路径校验、git status 解析、JSON 持久化往返
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { assertValidFsPath, parseGitStatus, readJsonFile, writeJsonFile, toMessageData, extractAssistantText } from './ipc'
import type { SessionMessage } from './oc-sdk'

describe('assertValidFsPath（路径校验）', () => {
  it('接受正常绝对路径', () => {
    expect(() => assertValidFsPath('C:\\work\\fractal\\src')).not.toThrow()
    expect(() => assertValidFsPath('D:/tmp/file.txt')).not.toThrow()
  })

  it('拒绝空路径与相对路径', () => {
    expect(() => assertValidFsPath('')).toThrow('路径不能为空')
    expect(() => assertValidFsPath('  ')).toThrow('路径不能为空')
    expect(() => assertValidFsPath('relative/path.txt')).toThrow('路径必须是绝对路径')
    expect(() => assertValidFsPath('./x')).toThrow('路径必须是绝对路径')
  })

  it('拒绝 .. 逃逸段', () => {
    expect(() => assertValidFsPath('C:\\work\\..\\secret')).toThrow('路径不能包含 ..')
    expect(() => assertValidFsPath('C:/work/../../secret')).toThrow('路径不能包含 ..')
  })

  it('拒绝非字符串类型', () => {
    expect(() => assertValidFsPath(undefined as unknown as string)).toThrow('路径不能为空')
    expect(() => assertValidFsPath(42 as unknown as string)).toThrow('路径不能为空')
  })
})

describe('parseGitStatus（porcelain v1 解析）', () => {
  it('解析分支行与空仓库', () => {
    const r = parseGitStatus('## main...origin/main\n')
    expect(r.branch).toBe('main')
    expect(r.staged).toHaveLength(0)
    expect(r.modified).toHaveLength(0)
    expect(r.untracked).toHaveLength(0)
  })

  it('分类 staged / modified / untracked', () => {
    const r = parseGitStatus(
      [
        '## feature/x...origin/feature/x',
        ' M src/a.ts', // 工作区修改
        'A  src/new.ts', // 新暂存
        'M  src/b.ts', // 暂存+无工作区变更 → 仅 staged
        '?? untracked.md'
      ].join('\n')
    )
    expect(r.branch).toBe('feature/x')
    expect(r.modified.map((x) => x.path)).toEqual(['src/a.ts'])
    expect(r.staged.map((x) => x.path)).toEqual(['src/new.ts', 'src/b.ts'])
    expect(r.untracked.map((x) => x.path)).toEqual(['untracked.md'])
  })

  it('重命名输出取新路径（old -> new）', () => {
    const r = parseGitStatus('R  old.ts -> new.ts\n')
    expect(r.staged.map((x) => x.path)).toEqual(['new.ts'])
  })

  it('索引与工作区同变时文件只进 staged 一次', () => {
    const r = parseGitStatus('MM src/both.ts\n')
    expect(r.staged.map((x) => x.path)).toEqual(['src/both.ts'])
    expect(r.modified.map((x) => x.path)).toEqual(['src/both.ts'])
  })
})

describe('JSON 持久化往返（readJsonFile / writeJsonFile）', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fsp.mkdtemp(join(tmpdir(), 'ipc-test-'))
  })

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true })
  })

  it('写入后读回内容一致', async () => {
    const file = join(dir, 'cfg.json')
    const data = { provider: { ds: { apiKey: 'sk-test', model: 'deepseek-v4-flash' } }, nested: { a: [1, 2, 3] } }
    await writeJsonFile(file, data)
    const back = await readJsonFile(file, {})
    expect(back).toEqual(data)
  })

  it('文件不存在返回兜底值（首次启动场景）', async () => {
    const back = await readJsonFile(join(dir, 'missing.json'), { fallback: true })
    expect(back).toEqual({ fallback: true })
  })

  it('损坏 JSON 返回兜底值（不崩溃）', async () => {
    const file = join(dir, 'broken.json')
    await fsp.writeFile(file, '{ not valid json', 'utf-8')
    const back = await readJsonFile(file, 'default')
    expect(back).toBe('default')
  })

  it('嵌套目录自动创建（writeJsonFile mkdir recursive）', async () => {
    const file = join(dir, 'a', 'b', 'c.json')
    await writeJsonFile(file, { ok: true })
    expect(await readJsonFile(file, null)).toEqual({ ok: true })
  })
})

// ══════════════════════════════════════════════════════════════════
// toMessageData（G2：消息完整还原——part → 前端 JSON blob 映射）
// 样例结构取自 stage0 实测（events-round3-success.json 的 message.part.updated 报文）
// ══════════════════════════════════════════════════════════════════

/** 构造 serve SessionMessage（{info, parts}，结构对齐 oc-sdk.SessionMessage） */
function makeMessage(role: 'user' | 'assistant', parts: unknown[], extra: Record<string, unknown> = {}): SessionMessage {
  return {
    info: {
      id: `msg_test_${role}`,
      sessionID: 'ses_test',
      role,
      time: { created: 1786029594660, ...(role === 'assistant' ? { completed: 1786029599033 } : {}) },
      ...extra,
    } as SessionMessage['info'],
    parts: parts as SessionMessage['parts'],
  }
}

/** 构造 serve text part（可指定 synthetic——serve 回显占位标记） */
function textPart(text: string, opts: { synthetic?: boolean; type?: string } = {}): Record<string, unknown> {
  return { type: opts.type ?? 'text', text, ...(opts.synthetic ? { synthetic: true } : {}) }
}

describe('toMessageData（G2 完整还原）', () => {
  it('user 消息：text parts 拼接 + FilePart 保留附件', () => {
    const sm = makeMessage('user', [
      textPart('第一行'),
      textPart('第二行'),
      {
        type: 'file',
        filename: 'report.pdf',
        url: 'file:///C:/tmp/report.pdf',
        source: { type: 'file', path: 'C:\\tmp\\report.pdf' },
      },
    ])
    const data = toMessageData(sm)
    expect(data.role).toBe('user')
    const parsed = JSON.parse(data.content) as { text: string; attachments: Array<{ name: string; path: string }> }
    expect(parsed.text).toBe('第一行\n第二行')
    expect(parsed.attachments).toEqual([{ name: 'report.pdf', path: 'C:\\tmp\\report.pdf' }])
    // 时间戳格式化：无毫秒+Z 后缀（前端 toLocalSession 会再拼 "Z"）
    expect(data.created_at).toBe(new Date(1786029594660).toISOString().replace(/\.\d{3}Z$/, ''))
  })

  it('user 消息：无附件 → 纯文本兼容旧格式（不出 JSON blob）', () => {
    const sm = makeMessage('user', [textPart('纯文本内容')])
    const data = toMessageData(sm)
    expect(data.content).toBe('纯文本内容')
  })

  it('assistant 消息：reasoning→thinking、text→content、tool→toolUses、contentBlocks 时间线重建', () => {
    const sm = makeMessage('assistant', [
      textPart('The user is asking', { type: 'reasoning' }), // 真实报文中 reasoning part 无 text 空起步，此处用样例简化
      {
        type: 'tool',
        callID: 'call_1',
        tool: 'Bash',
        state: {
          status: 'completed',
          input: { command: 'ls' },
          output: 'file1.txt\nfile2.txt',
          title: 'List files',
          metadata: {},
          time: { start: 1786029596000, end: 1786029596100 },
        },
      },
      {
        type: 'tool',
        callID: 'call_2',
        tool: 'Read',
        state: {
          status: 'error',
          input: { file_path: 'missing.md' },
          error: 'ENOENT: no such file',
          metadata: {},
          time: { start: 1786029596200, end: 1786029596300 },
        },
      },
      textPart('你好'),
      // step-finish：仅统计来源，不参与前端块
      { type: 'step-finish', reason: 'stop', cost: 0, tokens: { input: 9736, output: 2, reasoning: 19, cache: { read: 1920, write: 0 } } },
    ], { cost: 0, tokens: { input: 9736, output: 2, reasoning: 19, cache: { read: 1920, write: 0 } } })

    const data = toMessageData(sm)
    const parsed = JSON.parse(data.content) as {
      text: string
      thinking: string
      toolUses: Array<{ id: string; name: string; input: Record<string, unknown>; result?: string; isError?: boolean }>
      contentBlocks: Array<{ type: string; content?: string; toolUse?: { id: string; result?: string; isError?: boolean }; toolResult?: { toolUseId: string; content: string; isError?: boolean } }>
      durationMs: number
      inputTokens: number
      outputTokens: number
      costUSD: number
    }

    expect(parsed.text).toBe('你好')
    expect(parsed.thinking).toBe('The user is asking')
    // 工具调用：只保留终态（completed/error），pending/running 不进入历史
    expect(parsed.toolUses).toHaveLength(2)
    expect(parsed.toolUses[0]).toMatchObject({ id: 'call_1', name: 'Bash', result: 'file1.txt\nfile2.txt', isError: false })
    expect(parsed.toolUses[1]).toMatchObject({ id: 'call_2', name: 'Read', result: 'ENOENT: no such file', isError: true })
    // contentBlocks 时间线：thinking → tool_use → tool_result（紧跟工具卡片）→ text
    expect(parsed.contentBlocks.map((b) => b.type)).toEqual(['thinking', 'tool_use', 'tool_result', 'tool_use', 'tool_result', 'text'])
    expect(parsed.contentBlocks[0]).toMatchObject({ type: 'thinking', content: 'The user is asking' })
    expect(parsed.contentBlocks[1].toolUse?.id).toBe('call_1')
    expect(parsed.contentBlocks[2].toolResult).toMatchObject({ toolUseId: 'call_1', content: 'file1.txt\nfile2.txt', isError: false })
    expect(parsed.contentBlocks[5]).toMatchObject({ type: 'text', content: '你好' })
    // 统计尽力而为：durationMs = completed - created；tokens/cost 从 SDK 顶层字段
    expect(parsed.durationMs).toBe(1786029599033 - 1786029594660)
    expect(parsed.inputTokens).toBe(9736)
    expect(parsed.outputTokens).toBe(2)
    expect(parsed.costUSD).toBe(0)
    // token_usage 保持原 JSON 串（MessageData 契约字段）
    expect(data.token_usage).toBe(JSON.stringify({ input: 9736, output: 2, reasoning: 19, cache: { read: 1920, write: 0 } }))
  })

  it('assistant 消息：synthetic text part 被排除（serve 回显占位，非真实内容）', () => {
    const sm = makeMessage('assistant', [
      textPart('真实回答'),
      textPart('临时占位', { synthetic: true }),
      { type: 'reasoning', text: '思考中' },
    ])
    const data = toMessageData(sm)
    const parsed = JSON.parse(data.content) as { text: string; thinking: string; contentBlocks: Array<{ type: string }> }
    expect(parsed.text).toBe('真实回答')
    expect(parsed.thinking).toBe('思考中')
    // synthetic 占位不产生独立 text 块
    expect(parsed.contentBlocks.filter((b) => b.type === 'text')).toHaveLength(1)
  })

  it('assistant 消息：无工具/无思考 → 空数组占位（前端结构完整）', () => {
    const sm = makeMessage('assistant', [textPart('只有文本')])
    const data = toMessageData(sm)
    const parsed = JSON.parse(data.content) as { text: string; thinking: string; toolUses: unknown[]; contentBlocks: unknown[] }
    expect(parsed.text).toBe('只有文本')
    expect(parsed.thinking).toBe('')
    expect(parsed.toolUses).toEqual([])
    expect(parsed.contentBlocks).toEqual([{ type: 'text', content: '只有文本' }])
  })
})

// ── 附件 parts 构建（军师审查补测）──
import { buildSendParts, mimeFromExt } from './ipc'

describe('buildSendParts 附件 parts 构建', () => {
  it('text part 在前 + file part（mime/url file:///filename）', () => {
    const parts = buildSendParts('看这个文件', [
      { path: 'C:\\work\\a.md', name: 'a.md' },
      { path: 'C:\\work\\b.png', name: 'b.png' },
    ])
    expect(parts).toHaveLength(3)
    expect(parts[0]).toEqual({ type: 'text', text: '看这个文件' })
    expect(parts[1]).toMatchObject({ type: 'file', mime: 'text/markdown', filename: 'a.md' })
    expect((parts[1] as { url: string }).url).toContain('file:///')
    expect((parts[1] as { url: string }).url).toContain('a.md')
    expect(parts[2]).toMatchObject({ type: 'file', mime: 'image/png', filename: 'b.png' })
  })
  it('无附件仅 text part', () => {
    const parts = buildSendParts('hello', [])
    expect(parts).toEqual([{ type: 'text', text: 'hello' }])
  })
  it('mimeFromExt 兜底与补项', () => {
    expect(mimeFromExt('x.yaml')).toBe('text/yaml')
    expect(mimeFromExt('x.sh')).toBe('text/x-sh')
    expect(mimeFromExt('unknown.zzz')).toBe('application/octet-stream')
  })
})

// ── extractAssistantText（ai:polishMessage 润色回复提取：最后一条 assistant 的 text parts）──
describe('extractAssistantText', () => {
  it('取最后一条 assistant 消息的多 text part 拼接', () => {
    const msgs = [
      makeMessage('user', [textPart('原始消息')]),
      makeMessage('assistant', [textPart('优化后的'), textPart('消息内容')]),
    ]
    expect(extractAssistantText(msgs)).toBe('优化后的消息内容')
  })
  it('assistant 无文本（仅思考）时跳过取更早的', () => {
    const msgs = [
      makeMessage('assistant', [{ type: 'reasoning', text: '思考中' }]),
      makeMessage('user', [textPart('x')]),
    ]
    expect(extractAssistantText(msgs)).toBe('')
  })
  it('空列表返回空串', () => {
    expect(extractAssistantText([])).toBe('')
  })
})
