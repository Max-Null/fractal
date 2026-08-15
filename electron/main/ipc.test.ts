// ipc.ts 纯函数单元测试（不依赖 electron 运行时，node 环境）
// 覆盖军师审查 🔴3：路径校验、git status 解析、JSON 持久化往返
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { assertValidFsPath, parseGitStatus, readJsonFile, writeJsonFile, toMessageData, extractAssistantText, buildPolishPrompt, POLISH_PROMPT, readTailLines, registerIpcHandlers, resolveSessionModel, isSameWorkspace } from './ipc'
import type { SessionMessage } from './oc-sdk'

// electron mock：app:getInfo / logs:readServeLog 用例需要（node 环境无 electron 运行时）。
// registerIpcHandlers 用 ipcMain.handle mock 捕获注册的 handler，随后直接调用验证返回值。
const electronMock = vi.hoisted(() => ({
  app: {
    getName: vi.fn(() => '分形'),
    getVersion: vi.fn(() => '1.2.3'),
    // 带参签名：readServeLog 用例用 mockImplementation((name) => ...) 覆盖，返回独立 userData 目录
    getPath: vi.fn((_name: string) => ''),
  },
  handleCalls: [] as Array<{ channel: string; handler: (...a: unknown[]) => unknown }>,
  // pdf:htmlToPdf 通道 mock 群：对话框返回值 + 隐藏窗口实例捕获 + printToPDF 共享 mock
  // sharedPdfFn 用同一个引用注入每个 BrowserWindow 实例的 printToPDF——用例粒度 mockRejectedValueOnce 即可按用例控制失败
  dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() },
  sharedPdfFn: vi.fn(() => Promise.resolve(Buffer.from('pdf'))),
  browserWindowInstances: [] as Array<{
    loadFile: ReturnType<typeof vi.fn>
    webContents: { on: ReturnType<typeof vi.fn>; printToPDF: ReturnType<typeof vi.fn> }
    destroy: ReturnType<typeof vi.fn>
  }>,
  // notification:show mock：构造返回 { show } 实例，构造参数经 mock.calls 断言，show 经 mock.results 断言
  // 注意必须用普通 function（箭头函数不可作为构造函数，new 调用会抛 TypeError）
  Notification: vi.fn(function (this: unknown, opts: unknown) {
    return { show: vi.fn(), opts }
  }),
}))
vi.mock('electron', () => ({
  app: electronMock.app,
  dialog: electronMock.dialog,
  ipcMain: {
    handle: (channel: string, handler: (...a: unknown[]) => unknown) => {
      electronMock.handleCalls.push({ channel, handler })
    },
    on: vi.fn(),
  },
  shell: {},
  BrowserWindow: class {
    // 测试环境无聚焦窗口/无已开窗口 → handler 走无父窗口的对话框重载分支
    static getFocusedWindow = () => undefined
    static getAllWindows = () => []
    constructor() {
      const inst = {
        loadFile: vi.fn(() => Promise.resolve()),
        webContents: { on: vi.fn(), printToPDF: electronMock.sharedPdfFn },
        destroy: vi.fn(),
      }
      electronMock.browserWindowInstances.push(inst)
      return inst
    }
  },
  Notification: electronMock.Notification,
}))

// ipc.ts v1.1.0 起 app:getInfo 值导入引擎/预置版本查询——mock 注入固定值，避免真执行 opencode --version（~100ms）
vi.mock('./server-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./server-manager')>()
  return { ...actual, getEngineVersion: vi.fn(async () => '1.18.15'), resetEngineVersionCache: vi.fn() }
})
vi.mock('./preset', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./preset')>()
  return { ...actual, getPresetVersion: vi.fn(async () => '1.1.0') }
})

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

/** 构造 serve text part（可指定 synthetic——serve 回显占位标记；time——part 耗时区间） */
function textPart(text: string, opts: { synthetic?: boolean; type?: string; time?: { start: number; end?: number } } = {}): Record<string, unknown> {
  return { type: opts.type ?? 'text', text, ...(opts.synthetic ? { synthetic: true } : {}), ...(opts.time ? { time: opts.time } : {}) }
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

  it('user 消息：synthetic text part 被排除（serve 附件注入的 Read 调用占位不污染原文）', () => {
    const sm = makeMessage('user', [
      textPart('查看这个文件'),
      textPart('Called the Read tool with the following input: {"filePath":"D:\\Project\\doc-edit\\附件.docx"}', { synthetic: true }),
      {
        type: 'file',
        filename: '附件.集团信息化平台建设及运维服务（第一期）项目采购需求.docx',
        url: 'file:///D:/Project/doc-edit/附件.docx',
        source: { type: 'file', path: 'D:\\Project\\doc-edit\\附件.docx' },
      },
    ])
    const data = toMessageData(sm)
    const parsed = JSON.parse(data.content) as { text: string; attachments: Array<{ name: string; path: string }> }
    // 用户原文完整保留，Read 调用占位不混入
    expect(parsed.text).toBe('查看这个文件')
    expect(parsed.attachments).toEqual([
      { name: '附件.集团信息化平台建设及运维服务（第一期）项目采购需求.docx', path: 'D:\\Project\\doc-edit\\附件.docx' },
    ])
  })

  it('assistant 消息：reasoning→thinking、text→content、tool→toolUses、contentBlocks 时间线重建', () => {
    const sm = makeMessage('assistant', [
      textPart('The user is asking', { type: 'reasoning', time: { start: 1786029595000, end: 1786029596000 } }), // 真实报文中 reasoning part 无 text 空起步，此处用样例简化
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
      // step-finish：仅统计来源，不参与前端块（cost 字段已弃用——本地价格表按 tokens 计算）
      { type: 'step-finish', reason: 'stop', cost: 0, tokens: { input: 9736, output: 2, reasoning: 19, cache: { read: 1920, write: 0 } } },
    ], { cost: 0, modelID: 'deepseek-v4-pro', tokens: { input: 9736, output: 2, reasoning: 19, cache: { read: 1920, write: 0 } } })

    const data = toMessageData(sm)
    const parsed = JSON.parse(data.content) as {
      text: string
      thinking: string
      toolUses: Array<{ id: string; name: string; input: Record<string, unknown>; result?: string; isError?: boolean }>
      contentBlocks: Array<{ type: string; content?: string; toolUse?: { id: string; result?: string; isError?: boolean }; toolResult?: { toolUseId: string; content: string; isError?: boolean } }>
      durationMs: number
      inputTokens: number
      outputTokens: number
      costCNY: number
      costUSD?: number
    }

    expect(parsed.text).toBe('你好')
    expect(parsed.thinking).toBe('The user is asking')
    // 工具调用：只保留终态（completed/error），pending/running 不进入历史
    expect(parsed.toolUses).toHaveLength(2)
    expect(parsed.toolUses[0]).toMatchObject({ id: 'call_1', name: 'Bash', result: 'file1.txt\nfile2.txt', isError: false })
    expect(parsed.toolUses[1]).toMatchObject({ id: 'call_2', name: 'Read', result: 'ENOENT: no such file', isError: true })
    // 2026-08-10 耗时透传：ToolState.time → startedAt / executionDurationMs（历史恢复不依赖客户端计时）
    expect(parsed.toolUses[0]).toMatchObject({ startedAt: 1786029596000, executionDurationMs: 100 })
    expect(parsed.toolUses[1]).toMatchObject({ startedAt: 1786029596200, executionDurationMs: 100 })
    // contentBlocks 时间线：thinking → tool_use → tool_result（紧跟工具卡片）→ text
    expect(parsed.contentBlocks.map((b) => b.type)).toEqual(['thinking', 'tool_use', 'tool_result', 'tool_use', 'tool_result', 'text'])
    expect(parsed.contentBlocks[0]).toMatchObject({ type: 'thinking', content: 'The user is asking', durationMs: 1000 })
    expect(parsed.contentBlocks[1].toolUse?.id).toBe('call_1')
    expect(parsed.contentBlocks[1].toolUse).toMatchObject({ startedAt: 1786029596000, executionDurationMs: 100 })
    expect(parsed.contentBlocks[2].toolResult).toMatchObject({ toolUseId: 'call_1', content: 'file1.txt\nfile2.txt', isError: false })
    expect(parsed.contentBlocks[5]).toMatchObject({ type: 'text', content: '你好' })
    // 统计尽力而为：durationMs = completed - created；tokens 从 SDK 顶层字段；
    // 人民币成本本地计算（pro 价，2026-08-13 修正口径）：serve 下发 input 已不含缓存命中，
    // 直接按未命中计价：未命中 9736/1e6×3 + 命中 1920/1e6×0.025 + 输出 2/1e6×6
    expect(parsed.durationMs).toBe(1786029599033 - 1786029594660)
    expect(parsed.inputTokens).toBe(9736)
    expect(parsed.outputTokens).toBe(2)
    expect(parsed.costCNY).toBeCloseTo((9736 / 1e6) * 3 + (1920 / 1e6) * 0.025 + (2 / 1e6) * 6, 8)
    expect(parsed.costUSD).toBeUndefined()
    // token_usage 保持原 JSON 串（MessageData 契约字段）
    expect(data.token_usage).toBe(JSON.stringify({ input: 9736, output: 2, reasoning: 19, cache: { read: 1920, write: 0 } }))
  })

  it('assistant 消息：task 工具 state.metadata.sessionId 合并进 input.metadata（历史 subtask 节点归属键）', () => {
    const sm = makeMessage('assistant', [
      {
        type: 'tool',
        callID: 'call_task',
        tool: 'task',
        state: {
          status: 'completed',
          input: { description: '查天气', prompt: '请搜索…', subagent_type: '侦查兵' },
          output: '<task id="ses_sub_9" state="completed">\n<task_result>结果</task_result>',
          metadata: { parentSessionId: 'ses_main', sessionId: 'ses_sub_9' },
          time: { start: 1786029597000, end: 1786029598000 },
        },
      },
    ])
    const data = toMessageData(sm)
    const parsed = JSON.parse(data.content) as {
      toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>
      contentBlocks: Array<{ type: string; toolUse?: { id: string; input: Record<string, unknown> } }>
    }
    // toolUses 与 contentBlocks 双通道都合并 metadata.sessionId（前端 extractTaskId 依赖）
    expect(parsed.toolUses[0].input).toMatchObject({
      description: '查天气',
      metadata: { sessionId: 'ses_sub_9' },
    })
    expect(parsed.contentBlocks[0].toolUse?.input).toMatchObject({ metadata: { sessionId: 'ses_sub_9' } })
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

  it('assistant 消息：contentBlocks 按 parts 原序构建（thinking/text 交错不再聚合）', () => {
    // serve 真实输出序：思考 → 文本 → 工具 → 思考 → 文本（多 step 交错）
    const sm = makeMessage('assistant', [
      { type: 'reasoning', text: '第一步思考' },
      textPart('第一步回答'),
      {
        type: 'tool',
        callID: 'call_1',
        tool: 'Bash',
        state: { status: 'completed', input: { command: 'ls' }, output: 'file1.txt' },
      },
      { type: 'reasoning', text: '第二步思考' },
      textPart('第二步回答'),
    ])
    const data = toMessageData(sm)
    const parsed = JSON.parse(data.content) as { contentBlocks: Array<{ type: string; content?: string }> }
    // 原序：thinking / text / tool_use / tool_result / thinking / text（不再聚合到首尾）
    expect(parsed.contentBlocks.map((b) => b.type)).toEqual([
      'thinking', 'text', 'tool_use', 'tool_result', 'thinking', 'text',
    ])
    expect(parsed.contentBlocks[0].content).toBe('第一步思考')
    expect(parsed.contentBlocks[1].content).toBe('第一步回答')
    expect(parsed.contentBlocks[4].content).toBe('第二步思考')
    expect(parsed.contentBlocks[5].content).toBe('第二步回答')
  })

  it('assistant 消息：相邻 text part 各自成块（合并交给 buildTurnNodes 回合级）', () => {
    const sm = makeMessage('assistant', [
      textPart('第一段'),
      textPart('第二段'),
    ])
    const data = toMessageData(sm)
    const parsed = JSON.parse(data.content) as { contentBlocks: Array<{ type: string; content?: string }> }
    expect(parsed.contentBlocks).toEqual([
      { type: 'text', content: '第一段' },
      { type: 'text', content: '第二段' },
    ])
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

// ── buildPolishPrompt（润色指令组装：无引用纯文本 / 带选区片段 / 带附件文件 / 文件读取失败跳过）──
describe('buildPolishPrompt', () => {
  it('无引用 = 基础指令 + 消息', async () => {
    const p = await buildPolishPrompt('你好')
    expect(p).toBe(POLISH_PROMPT + '你好')
  })
  it('带选区片段：内容入 prompt 且标注不要引用到输出', async () => {
    const p = await buildPolishPrompt('优化这段', [{ label: '选区片段', content: 'const a = 1' }])
    expect(p).toContain('【选区片段】\nconst a = 1')
    expect(p).toContain('仅作背景理解，不要引用到输出中')
    expect(p).toContain('要优化的消息：优化这段')
  })
  it('带附件文件：主进程读文件内容入 prompt（50KB 截断）', async () => {
    const dir = await fsp.mkdtemp(join(tmpdir(), 'polish-ref-'))
    const file = join(dir, 'ref.txt')
    await fsp.writeFile(file, '文件内容ABC', 'utf-8')
    const p = await buildPolishPrompt('优化', [{ label: 'ref.txt', path: file }])
    expect(p).toContain('【ref.txt】\n文件内容ABC')
    await fsp.rm(dir, { recursive: true, force: true })
  })
  it('文件读取失败（不存在）→ 跳过该引用，退化为基础指令', async () => {
    const p = await buildPolishPrompt('你好', [{ label: 'gone.txt', path: 'Z:\\不存在\\gone.txt' }])
    expect(p).toBe(POLISH_PROMPT + '你好')
  })
})

// ── readTailLines（serve.log 尾部读取，方案 D8：大文件尾部 N 行，UTF-8 整行边界）──
describe('readTailLines（serve.log 尾部读取）', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fsp.mkdtemp(join(tmpdir(), 'serve-tail-'))
  })

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true })
  })

  it('多行文件：读取尾部 N 行（最后 maxLines 行）', async () => {
    const file = join(dir, 'serve.log')
    const lines = Array.from({ length: 20 }, (_, i) => `line-${i}`)
    await fsp.writeFile(file, lines.join('\n') + '\n', 'utf-8')
    const tail = await readTailLines(file, 5)
    expect(tail).toEqual(['line-15', 'line-16', 'line-17', 'line-18', 'line-19'])
  })

  it('行数不足 maxLines → 全量返回', async () => {
    const file = join(dir, 'serve.log')
    await fsp.writeFile(file, 'a\nb\nc', 'utf-8')
    expect(await readTailLines(file, 10)).toEqual(['a', 'b', 'c'])
  })

  it('空文件 → []', async () => {
    const file = join(dir, 'serve.log')
    await fsp.writeFile(file, '', 'utf-8')
    expect(await readTailLines(file, 5)).toEqual([])
  })

  it('文件不存在 → []（serve 从未启动）', async () => {
    expect(await readTailLines(join(dir, 'missing.log'), 5)).toEqual([])
  })

  it('UTF-8 多字节行不被切坏（尾部读取从整行边界开始）', async () => {
    const file = join(dir, 'serve.log')
    await fsp.writeFile(file, '启动服务\n模型加载成功\n监听端口 58143\n', 'utf-8')
    const tail = await readTailLines(file, 2)
    expect(tail).toEqual(['模型加载成功', '监听端口 58143'])
  })

  it('文件无尾换行也正常返回', async () => {
    const file = join(dir, 'serve.log')
    await fsp.writeFile(file, 'one\ntwo', 'utf-8')
    expect(await readTailLines(file, 5)).toEqual(['one', 'two'])
  })

  it('单行超长（无换行）→ 整行返回不截断', async () => {
    const file = join(dir, 'serve.log')
    await fsp.writeFile(file, 'x'.repeat(200_000), 'utf-8')
    const tail = await readTailLines(file, 5)
    expect(tail).toHaveLength(1)
    expect(tail[0]).toHaveLength(200_000)
  })
})

// ── logs:readServeLog / app:getInfo（诊断面板引擎日志页数据源，方案 D8 / 4.5）──
describe('logs:readServeLog / app:getInfo handler', () => {
  let userDataDir: string

  beforeEach(async () => {
    electronMock.handleCalls.length = 0
    // 每个用例独立 userData 目录（readServeLog 读 userData/logs/serve.log，防跨用例文件串扰）
    userDataDir = await fsp.mkdtemp(join(tmpdir(), 'ipc-serve-'))
    electronMock.app.getPath.mockReset()
    electronMock.app.getPath.mockImplementation((name: string) => (name === 'userData' ? userDataDir : ''))
  })

  afterEach(async () => {
    await fsp.rm(userDataDir, { recursive: true, force: true })
  })

  it('readServeLog：读取 userData/logs/serve.log 尾部（文件存在）', async () => {
    const serveDir = join(userDataDir, 'logs')
    await fsp.mkdir(serveDir, { recursive: true })
    const logFile = join(serveDir, 'serve.log')
    await fsp.writeFile(logFile, 'one\ntwo\nthree\n', 'utf-8')
    registerIpcHandlers()
    const h = electronMock.handleCalls.find((x) => x.channel === 'logs:readServeLog')
    expect(h).toBeDefined()
    const r = (await h!.handler({}, { lines: 2 })) as string[]
    expect(r).toEqual(['two', 'three'])
  })

  it('readServeLog：lines 非法（非 1-5000 正整数）→ 抛错', async () => {
    registerIpcHandlers()
    const h = electronMock.handleCalls.find((x) => x.channel === 'logs:readServeLog')
    expect(h).toBeDefined()
    await expect(h!.handler({}, { lines: 0 })).rejects.toThrow('lines 必须是 1-5000')
    await expect(h!.handler({}, { lines: 99999 })).rejects.toThrow('lines 必须是 1-5000')
  })

  it('readServeLog：文件不存在 → 返回空数组（serve 未启动空态）', async () => {
    registerIpcHandlers()
    const h = electronMock.handleCalls.find((x) => x.channel === 'logs:readServeLog')
    expect(h).toBeDefined()
    const r = (await h!.handler({}, { lines: 500 })) as string[]
    expect(r).toEqual([])
  })

  it('app:getInfo：返回分形/OC 引擎/预置包三版本（设置页「关于」+ 诊断打包头）', async () => {
    registerIpcHandlers()
    const h = electronMock.handleCalls.find((x) => x.channel === 'app:getInfo')
    expect(h).toBeDefined()
    const r = (await h!.handler({})) as {
      name: string
      version: string
      engineVersion: string
      presetVersion: string
    }
    expect(r).toEqual({ name: '分形', version: '1.2.3', engineVersion: '1.18.15', presetVersion: '1.1.0' })
  })

  it('loadSessionLogs：返回单元素 [debugJson]（stderr 槽位已移除，旧 stderr.json 不再读取）', async () => {
    const sdir = join(userDataDir, 'session-logs', 'ses_x')
    await fsp.mkdir(sdir, { recursive: true })
    await fsp.writeFile(join(sdir, 'debug.json'), '["📨 a"]', 'utf-8')
    await fsp.writeFile(join(sdir, 'stderr.json'), '["旧数据"]', 'utf-8')
    registerIpcHandlers()
    const h = electronMock.handleCalls.find((x) => x.channel === 'logs:loadSessionLogs')
    expect(h).toBeDefined()
    const r = (await h!.handler({}, { sessionId: 'ses_x' })) as [string | null]
    // 协议变更双元素 → 单元素（方案 D4）；旧 stderr.json 残留不返回
    expect(r).toHaveLength(1)
    expect(r[0]).toContain('📨 a')
  })

  it('engine:refresh：未注入 serverManager → { ok:false, error }（不抛，数据模式切换需回滚链）', async () => {
    registerIpcHandlers()
    const h = electronMock.handleCalls.find((x) => x.channel === 'engine:refresh')
    expect(h).toBeDefined()
    const r = (await h!.handler({})) as { ok: boolean; error?: string }
    expect(r.ok).toBe(false)
    expect(r.error).toContain('引擎未初始化')
  })

  it('engine:refresh：stopServer + startServer 成功 → { ok:true }', async () => {
    const stopServer = vi.fn(async () => {})
    const startServer = vi.fn(async () => ({ baseURL: 'http://127.0.0.1:1', username: 'u', password: 'p', port: 1 }))
    registerIpcHandlers({ stopServer, startServer } as never)
    const h = electronMock.handleCalls.find((x) => x.channel === 'engine:refresh')
    expect(h).toBeDefined()
    const r = (await h!.handler({})) as { ok: boolean; error?: string }
    expect(r).toEqual({ ok: true })
    expect(stopServer).toHaveBeenCalled()
    expect(startServer).toHaveBeenCalled()
  })

  it('engine:refresh：startServer 抛错 → { ok:false, error }（不抛给渲染层）', async () => {
    const stopServer = vi.fn(async () => {})
    const startServer = vi.fn(async () => { throw new Error('serve 连续 3 次启动失败') })
    registerIpcHandlers({ stopServer, startServer } as never)
    const h = electronMock.handleCalls.find((x) => x.channel === 'engine:refresh')
    expect(h).toBeDefined()
    const r = (await h!.handler({})) as { ok: boolean; error?: string }
    expect(r.ok).toBe(false)
    expect(r.error).toContain('serve 连续 3 次启动失败')
  })

  it('engine:getStatus：未注入 serverManager → 降级返回 { running:false }', async () => {
    registerIpcHandlers()
    const h = electronMock.handleCalls.find((x) => x.channel === 'engine:getStatus')
    expect(h).toBeDefined()
    const r = (await h!.handler({})) as { running: boolean }
    expect(r).toEqual({ running: false })
  })

  it('engine:getStatus：注入 serverManager → 透传 getServerInfo', async () => {
    const getServerInfo = vi.fn(() => ({ running: true, baseURL: 'http://127.0.0.1:58143' }))
    registerIpcHandlers({ getServerInfo } as never)
    const h = electronMock.handleCalls.find((x) => x.channel === 'engine:getStatus')
    expect(h).toBeDefined()
    const r = (await h!.handler({})) as { running: boolean }
    expect(r).toEqual({ running: true, baseURL: 'http://127.0.0.1:58143' })
  })
})

// ── capabilities:list（生态清单：serve 四端点聚合，未注入 serverManager 降级空 bundle）──
describe('capabilities:list handler', () => {
  // 与 saveProviderConfig 相同：清空累积的 handler，保证 find 命中本用例注册的最新 handler
  beforeEach(() => {
    electronMock.handleCalls.length = 0
  })

  it('未注入 serverManager → 返回空 bundle 不抛', async () => {
    registerIpcHandlers()
    const h = electronMock.handleCalls.find((x) => x.channel === 'capabilities:list')
    expect(h).toBeDefined()
    const r = (await h!.handler({})) as { agents: unknown[] }
    expect(r).toEqual({ agents: [], skills: [], plugins: [], mcp: [] })
  })

  it('注入 serverManager → 透传 capabilities.list 结果', async () => {
    const list = vi.fn(async () => ({
      agents: [{ name: '双星', description: '主力助手', mode: 'primary', native: false }],
      skills: [], plugins: [], mcp: [],
    }))
    registerIpcHandlers({
      getClient: () => ({ capabilities: { list } }),
      ready: async () => {},
    } as never)
    const h = electronMock.handleCalls.find((x) => x.channel === 'capabilities:list')
    expect(h).toBeDefined()
    const r = (await h!.handler({})) as { agents: { name: string }[] }
    expect(r.agents[0].name).toBe('双星')
    expect(list).toHaveBeenCalledOnce()
  })

  it('capabilities.list 抛错 → 降级空 bundle（面板不崩）', async () => {
    registerIpcHandlers({
      getClient: () => ({ capabilities: { list: vi.fn(async () => { throw new Error('boom') }) } }),
      ready: async () => {},
    } as never)
    const h = electronMock.handleCalls.find((x) => x.channel === 'capabilities:list')
    expect(h).toBeDefined()
    await expect(h!.handler({})).resolves.toEqual({ agents: [], skills: [], plugins: [], mcp: [] })
  })
})

// ── settings:saveProviderConfig / settings:loadProviderConfigs（多 provider 扩展：deepseek + moonshotai-cn）──
describe('saveProviderConfig（多 provider 持久化）', () => {
  let userDataDir: string

  beforeEach(async () => {
    electronMock.handleCalls.length = 0
    userDataDir = await fsp.mkdtemp(join(tmpdir(), 'ipc-provider-'))
    electronMock.app.getPath.mockReset()
    electronMock.app.getPath.mockImplementation((name: string) => (name === 'userData' ? userDataDir : ''))
  })

  afterEach(async () => {
    await fsp.rm(userDataDir, { recursive: true, force: true })
  })

  async function getProviderCfg(): Promise<Record<string, unknown>> {
    return JSON.parse(await fsp.readFile(join(userDataDir, 'provider-configs.json'), 'utf-8'))
  }

  it('保存 deepseek：三段式（apiKey/baseUrl/model）写入，不影响 moonshotai-cn 条目', async () => {
    registerIpcHandlers()
    const h = electronMock.handleCalls.find((x) => x.channel === 'settings:saveProviderConfig')
    expect(h).toBeDefined()
    await h!.handler({}, { providerId: 'deepseek', apiKey: 'sk-ds', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-pro', restart: false })
    const cfg = await getProviderCfg() as { deepseek: { apiKey: string; baseUrl: string; model: string } }
    expect(cfg.deepseek).toEqual({ apiKey: 'sk-ds', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-pro' })
    // 老结构无 moonshotai-cn → 不出现该条目（首次保存 deepseek 不自动建空条目，读时容错）
    expect('moonshotai-cn' in cfg).toBe(false)
  })

  it('保存 moonshotai-cn：只写 apiKey（无 baseUrl/model），deepseek 条目保留', async () => {
    // 前置：已有 deepseek 配置（老结构向后兼容场景）
    await fsp.writeFile(join(userDataDir, 'provider-configs.json'), JSON.stringify({ deepseek: { apiKey: 'sk-ds', baseUrl: '', model: '' } }), 'utf-8')
    registerIpcHandlers()
    const h = electronMock.handleCalls.find((x) => x.channel === 'settings:saveProviderConfig')
    expect(h).toBeDefined()
    await h!.handler({}, { providerId: 'moonshotai-cn', apiKey: 'sk-kimi', baseUrl: '', model: '', restart: false })
    const cfg = await getProviderCfg() as { deepseek: { apiKey: string }; 'moonshotai-cn': { apiKey: string } }
    expect(cfg['moonshotai-cn']).toEqual({ apiKey: 'sk-kimi' })
    // deepseek 条目不被覆盖（多 provider 共存的关键）
    expect(cfg.deepseek.apiKey).toBe('sk-ds')
  })

  it('moonshotai-cn 保存触发 ensureConfig：opencode.json 的 moonshotai-cn provider 写入 models + key', async () => {
    await fsp.writeFile(join(userDataDir, 'provider-configs.json'), JSON.stringify({ deepseek: { apiKey: 'sk-ds', baseUrl: '', model: '' } }), 'utf-8')
    registerIpcHandlers()
    const h = electronMock.handleCalls.find((x) => x.channel === 'settings:saveProviderConfig')
    expect(h).toBeDefined()
    await h!.handler({}, { providerId: 'moonshotai-cn', apiKey: 'sk-kimi', baseUrl: '', model: '', restart: false })
    const cfg = JSON.parse(require('node:fs').readFileSync(join(userDataDir, 'config', 'opencode', 'opencode.json'), 'utf-8')) as {
      provider: Record<string, { options?: { apiKey?: string }; models?: unknown }>
    }
    const kimi = cfg.provider['moonshotai-cn']
    expect(kimi.models).toEqual({ 'kimi-k3': { options: { reasoningEffort: 'low' } } })
    expect(kimi.options?.apiKey).toBe('sk-kimi')
    // deepseek 槽位不受 kimi key 污染（saveProviderConfig 从旧 cfg 读 deepseek key 透传）
    expect(cfg.provider.deepseek.options?.apiKey).toBe('sk-ds')
  })

  it('key 变化 + restart=true → 重启 serve（基准 = getServedApiKey，非 provider-configs.json 旧值）', async () => {
    // 前置：provider-configs.json 已含新 key（模拟 store watch 防抖提前落盘，restart=false 那次保存）
    await fsp.writeFile(join(userDataDir, 'provider-configs.json'), JSON.stringify({ deepseek: { apiKey: 'sk-new', baseUrl: '', model: '' } }), 'utf-8')
    const stopServer = vi.fn(async () => {})
    const ready = vi.fn(async () => ({ baseURL: 'http://127.0.0.1:1', username: 'u', password: 'p', port: 1 }))
    const getServerInfo = vi.fn(() => ({ running: true }))
    // serve 实际加载的 key 仍是失效旧值——这是重启判断的正确基准
    const getServedApiKey = vi.fn(() => 'sk-old')
    registerIpcHandlers({ stopServer, ready, getServerInfo, getServedApiKey } as never)
    const h = electronMock.handleCalls.find((x) => x.channel === 'settings:saveProviderConfig')
    expect(h).toBeDefined()
    await h!.handler({}, { providerId: 'deepseek', apiKey: 'sk-new', baseUrl: '', model: '', restart: true })
    expect(stopServer).toHaveBeenCalled()
    expect(ready).toHaveBeenCalled()
  })

  it('key 未变化 + restart=true → 不重启 serve（避免无谓杀掉健康 serve）', async () => {
    await fsp.writeFile(join(userDataDir, 'provider-configs.json'), JSON.stringify({ deepseek: { apiKey: 'sk-same', baseUrl: '', model: '' } }), 'utf-8')
    const stopServer = vi.fn(async () => {})
    const ready = vi.fn(async () => ({}))
    const getServerInfo = vi.fn(() => ({ running: true }))
    const getServedApiKey = vi.fn(() => 'sk-same')
    registerIpcHandlers({ stopServer, ready, getServerInfo, getServedApiKey } as never)
    const h = electronMock.handleCalls.find((x) => x.channel === 'settings:saveProviderConfig')
    expect(h).toBeDefined()
    await h!.handler({}, { providerId: 'deepseek', apiKey: 'sk-same', baseUrl: '', model: '', restart: true })
    expect(stopServer).not.toHaveBeenCalled()
    expect(ready).not.toHaveBeenCalled()
  })

  it('loadProviderConfigs：返回全部条目（含 moonshotai-cn 仅 apiKey）', async () => {
    await fsp.writeFile(join(userDataDir, 'provider-configs.json'), JSON.stringify({ deepseek: { apiKey: 'sk-ds', baseUrl: '', model: '' }, 'moonshotai-cn': { apiKey: 'sk-kimi' } }), 'utf-8')
    registerIpcHandlers()
    const h = electronMock.handleCalls.find((x) => x.channel === 'settings:loadProviderConfigs')
    expect(h).toBeDefined()
    const r = (await h!.handler({})) as Record<string, { apiKey: string; baseUrl?: string; model?: string }>
    expect(r.deepseek.apiKey).toBe('sk-ds')
    expect(r['moonshotai-cn']).toEqual({ apiKey: 'sk-kimi' })
  })
})

describe('deepseek:getBalance（计费迭代：DeepSeek 余额查询）', () => {
  let userDataDir: string

  beforeEach(async () => {
    electronMock.handleCalls.length = 0
    userDataDir = await fsp.mkdtemp(join(tmpdir(), 'ipc-balance-'))
    electronMock.app.getPath.mockReset()
    electronMock.app.getPath.mockImplementation((name: string) => (name === 'userData' ? userDataDir : ''))
  })

  afterEach(async () => {
    await fsp.rm(userDataDir, { recursive: true, force: true })
  })

  it('未配置 API Key → 返回 ok:false 提示（不发起网络请求）', async () => {
    // userData 目录无 provider-configs.json → 空 key
    registerIpcHandlers()
    const h = electronMock.handleCalls.find((x) => x.channel === 'deepseek:getBalance')
    expect(h).toBeDefined()
    const r = (await h!.handler({})) as { ok: boolean; message?: string }
    expect(r.ok).toBe(false)
    expect(r.message).toContain('API Key')
  })

  it('已配置 API Key → 调 DeepSeek /user/balance 并归一化返回', async () => {
    await fsp.writeFile(join(userDataDir, 'provider-configs.json'), JSON.stringify({ deepseek: { apiKey: 'sk-test', baseUrl: '', model: '' } }), 'utf-8')
    // 注入 fetch mock：DeepSeek 返回真实结构（余额字符串 "110.00"）
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch
    try {
      registerIpcHandlers()
      const h = electronMock.handleCalls.find((x) => x.channel === 'deepseek:getBalance')
      expect(h).toBeDefined()
      const r = (await h!.handler({})) as { ok: boolean; isAvailable: boolean; balanceInfos: Array<{ currency: string; totalBalance: string }> }
      expect(r.ok).toBe(true)
      expect(r.isAvailable).toBe(true)
      expect(r.balanceInfos).toEqual([{ currency: 'CNY', totalBalance: '110.00' }])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('HTTP 401（key 失效）→ ok:false + 认证失败提示', async () => {
    await fsp.writeFile(join(userDataDir, 'provider-configs.json'), JSON.stringify({ deepseek: { apiKey: 'sk-bad', baseUrl: '', model: '' } }), 'utf-8')
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response('unauthorized', { status: 401 })) as typeof fetch
    try {
      registerIpcHandlers()
      const h = electronMock.handleCalls.find((x) => x.channel === 'deepseek:getBalance')
      expect(h).toBeDefined()
      const r = (await h!.handler({})) as { ok: boolean; message?: string }
      expect(r.ok).toBe(false)
      expect(r.message).toContain('401')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('kimi:getBalance（计费迭代：Kimi 多模态余额查询，与 DeepSeek 对称）', () => {
  let userDataDir: string

  beforeEach(async () => {
    electronMock.handleCalls.length = 0
    userDataDir = await fsp.mkdtemp(join(tmpdir(), 'ipc-kimi-balance-'))
    electronMock.app.getPath.mockReset()
    electronMock.app.getPath.mockImplementation((name: string) => (name === 'userData' ? userDataDir : ''))
  })

  afterEach(async () => {
    await fsp.rm(userDataDir, { recursive: true, force: true })
  })

  it('未配置 API Key → 返回 ok:false 提示（不发起网络请求）', async () => {
    // userData 目录无 provider-configs.json → 空 key
    registerIpcHandlers()
    const h = electronMock.handleCalls.find((x) => x.channel === 'kimi:getBalance')
    expect(h).toBeDefined()
    const r = (await h!.handler({})) as { ok: boolean; message?: string }
    expect(r.ok).toBe(false)
    expect(r.message).toContain('API Key')
  })

  it('已配置 API Key → 调 moonshot /users/me/balance 并归一化返回', async () => {
    await fsp.writeFile(join(userDataDir, 'provider-configs.json'), JSON.stringify({ 'moonshotai-cn': { apiKey: 'sk-kimi-test' } }), 'utf-8')
    // 注入 fetch mock：Kimi 返回真实结构（available_balance 数值 49.58）
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: 0, data: { available_balance: 49.58, voucher_balance: 46.58, cash_balance: 3.0 }, scode: '0x0', status: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch
    try {
      registerIpcHandlers()
      const h = electronMock.handleCalls.find((x) => x.channel === 'kimi:getBalance')
      expect(h).toBeDefined()
      const r = (await h!.handler({})) as { ok: boolean; isAvailable: boolean; balanceInfos: Array<{ currency: string; totalBalance: string }> }
      expect(r.ok).toBe(true)
      expect(r.isAvailable).toBe(true)
      expect(r.balanceInfos).toEqual([{ currency: 'CNY', totalBalance: '49.58' }])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('可用余额 ≤0（code:0 但 available_balance 为 0）→ ok:true 但 isAvailable:false', async () => {
    await fsp.writeFile(join(userDataDir, 'provider-configs.json'), JSON.stringify({ 'moonshotai-cn': { apiKey: 'sk-kimi-empty' } }), 'utf-8')
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: 0, data: { available_balance: 0, voucher_balance: 0, cash_balance: 0 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch
    try {
      registerIpcHandlers()
      const h = electronMock.handleCalls.find((x) => x.channel === 'kimi:getBalance')
      expect(h).toBeDefined()
      const r = (await h!.handler({})) as { ok: boolean; isAvailable: boolean; balanceInfos: Array<{ currency: string; totalBalance: string }> }
      expect(r.ok).toBe(true)
      expect(r.isAvailable).toBe(false)
      expect(r.balanceInfos).toEqual([{ currency: 'CNY', totalBalance: '0' }])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('HTTP 401（key 失效）→ ok:false + 认证失败提示', async () => {
    await fsp.writeFile(join(userDataDir, 'provider-configs.json'), JSON.stringify({ 'moonshotai-cn': { apiKey: 'sk-kimi-bad' } }), 'utf-8')
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response('unauthorized', { status: 401 })) as typeof fetch
    try {
      registerIpcHandlers()
      const h = electronMock.handleCalls.find((x) => x.channel === 'kimi:getBalance')
      expect(h).toBeDefined()
      const r = (await h!.handler({})) as { ok: boolean; message?: string }
      expect(r.ok).toBe(false)
      expect(r.message).toContain('401')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

// ── engine:testConnection（2026-08-13：真实验证 key 有效性，不再「假通过」）──
describe('engine:testConnection（真实校验 API Key）', () => {
  let userDataDir: string

  beforeEach(async () => {
    electronMock.handleCalls.length = 0
    userDataDir = await fsp.mkdtemp(join(tmpdir(), 'ipc-testconn-'))
    electronMock.app.getPath.mockReset()
    electronMock.app.getPath.mockImplementation((name: string) => (name === 'userData' ? userDataDir : ''))
  })

  afterEach(async () => {
    await fsp.rm(userDataDir, { recursive: true, force: true })
  })

  it('空 key → ok:false 提示（不发起请求）', async () => {
    registerIpcHandlers()
    const h = electronMock.handleCalls.find((x) => x.channel === 'engine:testConnection')
    expect(h).toBeDefined()
    const r = (await h!.handler({}, { apiKey: '' })) as { ok: boolean; message?: string }
    expect(r.ok).toBe(false)
    expect(r.message).toContain('API Key')
  })

  it('key 有效 → 调 DeepSeek /models 200 + serve 可达 → ok:true', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-chat' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch
    try {
      registerIpcHandlers({
        getClient: () => ({ config: { providers: vi.fn(async () => ({})) } }),
        ready: async () => {},
      } as never)
      const h = electronMock.handleCalls.find((x) => x.channel === 'engine:testConnection')
      expect(h).toBeDefined()
      const r = (await h!.handler({}, { apiKey: 'sk-valid' })) as { ok: boolean; message?: string }
      expect(r.ok).toBe(true)
      expect(r.message).toContain('有效')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('key 无效（401）→ ok:false + 认证失败提示（修复「假通过」核心用例）', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response('unauthorized', { status: 401 })) as typeof fetch
    try {
      registerIpcHandlers({
        getClient: () => ({ config: { providers: vi.fn(async () => ({})) } }),
        ready: async () => {},
      } as never)
      const h = electronMock.handleCalls.find((x) => x.channel === 'engine:testConnection')
      expect(h).toBeDefined()
      const r = (await h!.handler({}, { apiKey: 'sk-bad' })) as { ok: boolean; message?: string }
      expect(r.ok).toBe(false)
      expect(r.message).toContain('401')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('key 有效但 serve 不可达 → ok:false（服务端错误透传）', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ object: 'list', data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch
    try {
      registerIpcHandlers({
        getClient: () => ({ config: { providers: vi.fn(async () => { throw new Error('serve down') }) } }),
        ready: async () => {},
      } as never)
      const h = electronMock.handleCalls.find((x) => x.channel === 'engine:testConnection')
      expect(h).toBeDefined()
      const r = (await h!.handler({}, { apiKey: 'sk-valid' })) as { ok: boolean; message?: string }
      expect(r.ok).toBe(false)
      expect(r.message).toContain('serve down')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

// ── engine:testKimiConnection（2026-08-13：与 DeepSeek 对称，moonshotai-cn 校验走 api.moonshot.cn，纯 fetch 不依赖 serve）──
describe('engine:testKimiConnection（真实校验 Kimi API Key）', () => {
  it('空 key → ok:false 提示（不发起请求）', async () => {
    registerIpcHandlers()
    const h = electronMock.handleCalls.find((x) => x.channel === 'engine:testKimiConnection')
    expect(h).toBeDefined()
    const r = (await h!.handler({}, { apiKey: '  ' })) as { ok: boolean; message?: string }
    expect(r.ok).toBe(false)
    expect(r.message).toContain('API Key')
  })

  it('key 有效（GET /v1/models 2xx）→ ok:true', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ object: 'list', data: [{ id: 'kimi-k3' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch
    try {
      registerIpcHandlers()
      const h = electronMock.handleCalls.find((x) => x.channel === 'engine:testKimiConnection')
      expect(h).toBeDefined()
      const r = (await h!.handler({}, { apiKey: 'sk-valid' })) as { ok: boolean; message?: string }
      expect(r.ok).toBe(true)
      expect(r.message).toContain('有效')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('key 无效（401）→ ok:false + 认证失败提示', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response('unauthorized', { status: 401 })) as typeof fetch
    try {
      registerIpcHandlers()
      const h = electronMock.handleCalls.find((x) => x.channel === 'engine:testKimiConnection')
      expect(h).toBeDefined()
      const r = (await h!.handler({}, { apiKey: 'sk-bad' })) as { ok: boolean; message?: string }
      expect(r.ok).toBe(false)
      expect(r.message).toContain('401')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('question:reply / question:reject（多实例路由：带 directory query）', () => {
  let userDataDir: string
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    electronMock.handleCalls.length = 0
    userDataDir = await fsp.mkdtemp(join(tmpdir(), 'ipc-question-'))
    electronMock.app.getPath.mockReset()
    electronMock.app.getPath.mockImplementation((name: string) => (name === 'userData' ? userDataDir : ''))
    fetchMock = vi.fn(async () => new Response('true', { status: 200 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(async () => {
    globalThis.fetch = fetchMock.mockClear() as unknown as typeof fetch
    await fsp.rm(userDataDir, { recursive: true, force: true })
  })

  it('reply 携带当前工作区 directory（serve 多实例路由到正确实例）', async () => {
    // ui-settings.json 写当前工作区 → readProjectCwd 读取 → fetch URL 带 ?directory=
    await fsp.writeFile(join(userDataDir, 'ui-settings.json'), JSON.stringify({ cwd: 'H:\\MaxNull\\WorkStation\\test' }), 'utf-8')
    registerIpcHandlers({
      ready: async () => {},
      getClient: () => ({}),
      getServerInfo: () => ({ baseURL: 'http://127.0.0.1:4000', username: 'u', password: 'p' }),
    } as never)
    const h = electronMock.handleCalls.find((x) => x.channel === 'question:reply')
    expect(h).toBeDefined()
    const r = (await h!.handler({}, { sessionId: 'ses-1', requestId: 'que-1', answers: [['A']] })) as { ok: boolean }
    expect(r.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('/question/que-1/reply')
    expect(url).toContain('directory=')
    expect(url).toContain(encodeURIComponent('H:\\MaxNull\\WorkStation\\test'))
  })

  it('reject 携带当前工作区 directory', async () => {
    await fsp.writeFile(join(userDataDir, 'ui-settings.json'), JSON.stringify({ cwd: 'H:\\MaxNull\\WorkStation\\test' }), 'utf-8')
    registerIpcHandlers({
      ready: async () => {},
      getClient: () => ({}),
      getServerInfo: () => ({ baseURL: 'http://127.0.0.1:4000', username: 'u', password: 'p' }),
    } as never)
    const h = electronMock.handleCalls.find((x) => x.channel === 'question:reject')
    expect(h).toBeDefined()
    const r = (await h!.handler({}, { sessionId: 'ses-1', requestId: 'que-1' })) as { ok: boolean }
    expect(r.ok).toBe(true)
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('/question/que-1/reject')
    expect(url).toContain('directory=')
  })

  it('无 ui-settings.json（cwd 为空）→ URL 不带 directory（默认实例路由兜底）', async () => {
    registerIpcHandlers({
      ready: async () => {},
      getClient: () => ({}),
      getServerInfo: () => ({ baseURL: 'http://127.0.0.1:4000', username: 'u', password: 'p' }),
    } as never)
    const h = electronMock.handleCalls.find((x) => x.channel === 'question:reply')
    expect(h).toBeDefined()
    const r = (await h!.handler({}, { sessionId: 'ses-1', requestId: 'que-1', answers: [['A']] })) as { ok: boolean }
    expect(r.ok).toBe(true)
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).not.toContain('directory')
  })
})

describe('resolveSessionModel（serve 会话模型提取）', () => {
  it('对象形态 {id, providerID, variant} → 取 id', () => {
    expect(resolveSessionModel({ id: 'deepseek-v4-pro', providerID: 'deepseek', variant: 'default' })).toBe('deepseek-v4-pro')
  })

  it('字符串形态 → 原样', () => {
    expect(resolveSessionModel('deepseek-v4-flash')).toBe('deepseek-v4-flash')
  })

  it('缺失/异常 → 空字符串（前端兜底显示 "--"）', () => {
    expect(resolveSessionModel(undefined)).toBe('')
    expect(resolveSessionModel(null)).toBe('')
    expect(resolveSessionModel(42)).toBe('')
  })
})


describe('isSameWorkspace（多窗口事件路由目录归一）', () => {
  it('分隔符/尾斜杠/大小写差异归一后相等', () => {
    expect(isSameWorkspace('H:/work/A', 'H:\\work\\A')).toBe(true)
    expect(isSameWorkspace('H:/work/A/', 'H:/work/A')).toBe(true)
    expect(isSameWorkspace('H:/Work/A', 'h:/work/a')).toBe(true)
    expect(isSameWorkspace('H:/work/A//', 'H:/work/A')).toBe(true)
  })

  it('不同目录不相等', () => {
    expect(isSameWorkspace('H:/work/A', 'H:/work/B')).toBe(false)
    expect(isSameWorkspace('H:/work/A', 'D:/work/A')).toBe(false)
  })

  it('空串（窗口工作区未知）处理：仅与空串相等', () => {
    expect(isSameWorkspace('', 'H:/work/A')).toBe(false)
    expect(isSameWorkspace('', '')).toBe(true)
  })
})

// ── pdf:htmlToPdf（HTML 转 PDF：保存对话框 → 隐藏窗口 loadFile → printToPDF(A4) → 写盘）──
// 导出路径落在 tmpdir 临时目录——handler 内 writeFile 真实写盘，避免污染系统路径
describe('pdf:htmlToPdf（HTML 转 PDF）', () => {
  const getHandler = () => {
    const call = electronMock.handleCalls.find((c) => c.channel === 'pdf:htmlToPdf')
    if (!call) throw new Error('pdf:htmlToPdf handler 未注册')
    return call.handler
  }

  let outDir: string

  beforeEach(async () => {
    electronMock.handleCalls.length = 0
    electronMock.dialog.showSaveDialog.mockReset()
    electronMock.sharedPdfFn.mockClear()
    electronMock.browserWindowInstances.length = 0
    outDir = await fsp.mkdtemp(join(tmpdir(), 'ipc-pdf-'))
    registerIpcHandlers()
  })

  afterEach(async () => {
    await fsp.rm(outDir, { recursive: true, force: true })
  })

  it('成功：loadFile + printToPDF 后返回 {ok:true, path}，finally 销毁隐藏窗口', async () => {
    const outPdf = join(outDir, 'out.pdf')
    electronMock.dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: outPdf })
    const r = (await getHandler()(null, { path: 'C:/x/report.html' })) as { ok: boolean; path?: string }
    expect(r).toEqual({ ok: true, path: outPdf })
    const inst = electronMock.browserWindowInstances[0]
    expect(inst.loadFile).toHaveBeenCalledWith('C:/x/report.html')
    expect(inst.webContents.printToPDF).toHaveBeenCalledWith({ printBackground: true, pageSize: 'A4' })
    expect(inst.destroy).toHaveBeenCalled()
  })

  it('用户取消保存对话框 → {ok:false}（无 error，且不创建隐藏窗口）', async () => {
    electronMock.dialog.showSaveDialog.mockResolvedValue({ canceled: true })
    const r = (await getHandler()(null, { path: 'C:/x/report.html' })) as { ok: boolean; error?: string }
    expect(r).toEqual({ ok: false })
    expect(electronMock.browserWindowInstances.length).toBe(0)
  })

  it('printToPDF 失败 → {ok:false, error} 非空（隐藏窗口仍销毁）', async () => {
    const outPdf = join(outDir, 'out.pdf')
    electronMock.dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: outPdf })
    electronMock.sharedPdfFn.mockRejectedValueOnce(new Error('boom'))
    const r = (await getHandler()(null, { path: 'C:/x/report.html' })) as { ok: boolean; error?: string }
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
    expect(electronMock.browserWindowInstances[0].destroy).toHaveBeenCalled()
  })
})

describe('settings:saveSettings handler（保存设置联动 applyModelAliases）', () => {
  let userDataDir: string

  beforeEach(async () => {
    electronMock.handleCalls.length = 0
    // 每个用例独立 userData 目录（saveSettings 写 settings.json + ensureConfig 写 opencode.json，防跨用例串扰）
    userDataDir = await fsp.mkdtemp(join(tmpdir(), 'ipc-settings-'))
    electronMock.app.getPath.mockReset()
    electronMock.app.getPath.mockImplementation((name: string) => (name === 'userData' ? userDataDir : ''))
  })

  afterEach(async () => {
    await fsp.rm(userDataDir, { recursive: true, force: true })
  })

  it('保存设置 → 联动 applyModelAliases（覆盖表变化 → agents model 行更新）', async () => {
    // 前置：agents 目录 + 双星.md（high 槽位，部署产物 model 写死）
    const agentsDir = join(userDataDir, 'config', 'opencode', 'agents')
    await fsp.mkdir(agentsDir, { recursive: true })
    await fsp.writeFile(join(agentsDir, '双星.md'), '---\nmode: primary\nmodel: "ds/deepseek-v4-pro"\n---\n', 'utf-8')
    registerIpcHandlers()
    const h = electronMock.handleCalls.find((x) => x.channel === 'settings:saveSettings')
    expect(h).toBeDefined()
    const r = (await h!.handler({}, {
      jsoncText: JSON.stringify({ agentModelOverrides: { '双星': 'deepseek/deepseek-v4-flash' } }),
    })) as { ok: boolean; warnings: string[] }
    expect(r.ok).toBe(true)
    // applyModelAliases 联动生效：双星.md 的 model 行更新为覆盖值（不再停留在部署产物旧值）
    const md = await fsp.readFile(join(agentsDir, '双星.md'), 'utf-8')
    expect(md).toContain('model: "deepseek/deepseek-v4-flash"')
  })
})

describe('avatar IPC（图片头像 pick/clear/getPath）', () => {
  let userDataDir: string

  beforeEach(async () => {
    electronMock.handleCalls.length = 0
    // 每个用例独立 userData 目录（avatar 图片真实落盘，防跨用例串扰）
    userDataDir = await fsp.mkdtemp(join(tmpdir(), 'ipc-avatar-'))
    electronMock.app.getPath.mockReset()
    electronMock.app.getPath.mockImplementation((name: string) => (name === 'userData' ? userDataDir : ''))
    electronMock.dialog.showOpenDialog.mockReset()
  })

  afterEach(async () => {
    await fsp.rm(userDataDir, { recursive: true, force: true })
  })

  const getHandler = (channel: string) => {
    const call = electronMock.handleCalls.find((c) => c.channel === channel)
    if (!call) throw new Error(`${channel} handler 未注册`)
    return call.handler
  }

  it('pick：选择 png → 复制到 <userData>/avatar/avatar.png，返回 {ok, filename}', async () => {
    const src = join(userDataDir, 'pick.png')
    await fsp.writeFile(src, 'fake-png-bytes')
    electronMock.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [src] })
    registerIpcHandlers()
    const r = (await getHandler('avatar:pick')()) as { ok: boolean; filename?: string }
    expect(r).toEqual({ ok: true, filename: 'avatar.png' })
    expect(await fsp.readFile(join(userDataDir, 'avatar', 'avatar.png'), 'utf-8')).toBe('fake-png-bytes')
  })

  it('pick：用户取消 → {ok:false} 且不建目录不复制', async () => {
    electronMock.dialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    registerIpcHandlers()
    const r = (await getHandler('avatar:pick')()) as { ok: boolean }
    expect(r).toEqual({ ok: false })
    await expect(fsp.access(join(userDataDir, 'avatar'))).rejects.toThrow()
  })

  it('pick：扩展名白名单外（.gif）→ {ok:false} 且不复制', async () => {
    const src = join(userDataDir, 'anim.gif')
    await fsp.writeFile(src, 'gif')
    electronMock.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [src] })
    registerIpcHandlers()
    const r = (await getHandler('avatar:pick')()) as { ok: boolean }
    expect(r).toEqual({ ok: false })
    await expect(fsp.access(join(userDataDir, 'avatar'))).rejects.toThrow()
  })

  it('pick：大写扩展名（.PNG）→ 归一化为小写 avatar.png', async () => {
    const src = join(userDataDir, 'up.PNG')
    await fsp.writeFile(src, 'png')
    electronMock.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [src] })
    registerIpcHandlers()
    const r = (await getHandler('avatar:pick')()) as { ok: boolean; filename?: string }
    expect(r).toEqual({ ok: true, filename: 'avatar.png' })
    expect(await fsp.readFile(join(userDataDir, 'avatar', 'avatar.png'), 'utf-8')).toBe('png')
  })

  it('pick：重复选择 → 统一文件名覆盖旧图（avatar 目录仅一个文件）', async () => {
    const src1 = join(userDataDir, 'a.png')
    const src2 = join(userDataDir, 'b.png')
    await fsp.writeFile(src1, 'first')
    await fsp.writeFile(src2, 'second')
    electronMock.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [src1] })
    electronMock.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [src2] })
    registerIpcHandlers()
    await getHandler('avatar:pick')()
    await getHandler('avatar:pick')()
    expect(await fsp.readdir(join(userDataDir, 'avatar'))).toEqual(['avatar.png'])
    expect(await fsp.readFile(join(userDataDir, 'avatar', 'avatar.png'), 'utf-8')).toBe('second')
  })

  it('clear：删除 avatar 目录 → {ok:true}', async () => {
    await fsp.mkdir(join(userDataDir, 'avatar'), { recursive: true })
    await fsp.writeFile(join(userDataDir, 'avatar', 'avatar.png'), 'x')
    registerIpcHandlers()
    const r = (await getHandler('avatar:clear')()) as { ok: boolean }
    expect(r).toEqual({ ok: true })
    await expect(fsp.access(join(userDataDir, 'avatar'))).rejects.toThrow()
  })

  it('getPath：返回 <userData>/avatar', async () => {
    registerIpcHandlers()
    const r = (await getHandler('avatar:getPath')()) as string
    expect(r).toBe(join(userDataDir, 'avatar'))
  })
})

describe('notification:show（系统通知 IPC）', () => {
  beforeEach(() => {
    electronMock.handleCalls.length = 0
    electronMock.Notification.mockClear()
  })

  const getHandler = () => {
    const call = electronMock.handleCalls.find((c) => c.channel === 'notification:show')
    if (!call) throw new Error('notification:show handler 未注册')
    return call.handler
  }

  it('调用 → new Notification({title, body}) 且 show() 被调', async () => {
    registerIpcHandlers()
    const r = (await getHandler()({}, { title: '任务完成', body: '生成 3 个文件' })) as undefined
    expect(r).toBeUndefined()
    expect(electronMock.Notification).toHaveBeenCalledTimes(1)
    expect(electronMock.Notification.mock.calls[0][0]).toEqual({ title: '任务完成', body: '生成 3 个文件' })
    const inst = electronMock.Notification.mock.results[0].value as { show: ReturnType<typeof vi.fn> }
    expect(inst.show).toHaveBeenCalled()
  })

  it('Notification 构造抛错 → 静默吞掉不抛出（通知失败不阻断主流程）', async () => {
    electronMock.Notification.mockImplementationOnce(function () {
      throw new Error('notification backend unavailable')
    })
    registerIpcHandlers()
    // handler 同步返回 undefined（非 Promise），直接断言调用不抛
    expect(() => getHandler()({}, { title: 't', body: 'b' })).not.toThrow()
  })
})

describe('fs:fileFingerprint（文件指纹：预览面板自动刷新判断）', () => {
  const getHandler = () => {
    const call = electronMock.handleCalls.find((c) => c.channel === 'fs:fileFingerprint')
    if (!call) throw new Error('fs:fileFingerprint handler 未注册')
    return call.handler
  }

  it('withHash=false：仅 stat 返回 size + mtimeMs，md5=null（快路径不读盘）', async () => {
    const dir = join(tmpdir(), `fractal-fp-${Date.now()}`)
    const file = join(dir, 'a.txt')
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(file, 'hello', 'utf-8')
    try {
      registerIpcHandlers()
      const r = (await getHandler()({}, { path: file, withHash: false })) as {
        size: number; mtimeMs: number; md5: string | null
      }
      expect(r.size).toBe(5)
      expect(typeof r.mtimeMs).toBe('number')
      expect(r.md5).toBeNull()
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  it('withHash=true：内容变化 → md5 变化（同一路径两次指纹不同）', async () => {
    const dir = join(tmpdir(), `fractal-fp-${Date.now()}`)
    const file = join(dir, 'a.txt')
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(file, 'v1', 'utf-8')
    try {
      registerIpcHandlers()
      const h = getHandler()
      const r1 = (await h({}, { path: file, withHash: true })) as { md5: string | null }
      await fsp.writeFile(file, 'v2', 'utf-8')
      const r2 = (await h({}, { path: file, withHash: true })) as { md5: string | null }
      expect(r1.md5).toBeTruthy()
      expect(r2.md5).toBeTruthy()
      expect(r1.md5).not.toBe(r2.md5)
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  it('非法路径 → assertValidFsPath 拒绝', async () => {
    registerIpcHandlers()
    await expect(getHandler()({}, { path: '../escape' })).rejects.toThrow('路径')
  })

  it('文件不存在 → 抛错（stat 失败）', async () => {
    registerIpcHandlers()
    await expect(getHandler()({}, { path: join(tmpdir(), `fractal-fp-none-${Date.now()}.txt`) })).rejects.toThrow()
  })
})