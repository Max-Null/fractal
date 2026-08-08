// oc-sdk 单元测试：用 stage0 实测的 /provider 响应验证 deepseek 模型提取逻辑
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { listDeepseekModels, normalizeError, OcError, type Provider, type HeyApiResult } from './oc-sdk'

// 定位 fixtures 路径：测试文件在 electron/main/ 下，fixtures 在 electron/tests/fixtures/
// 用 process.cwd()（vitest run 在项目根执行）而非 import.meta.url——vitest 4 下后者可能是非 file scheme
const fixturePath = resolve(process.cwd(), 'electron/tests/fixtures/providers.json')
const providerResponse = JSON.parse(readFileSync(fixturePath, 'utf-8')) as { all: Provider[] }

describe('listDeepseekModels', () => {
  it('从实测 /provider 响应提取 deepseek 模型', () => {
    const models = listDeepseekModels(providerResponse.all)
    // 实测结构中 deepseek provider 的模型 id 为 deepseek-v4-flash / deepseek-v4-pro
    expect(models).toContain('deepseek/deepseek-v4-flash')
    expect(models).toContain('deepseek/deepseek-v4-pro')
  })

  it('排除非 deepseek 模型', () => {
    const models = listDeepseekModels(providerResponse.all)
    // 实测响应中存在大量非 deepseek 模型（如 databricks 的 gemini/claude），不应被提取
    expect(models.some((id) => !id.toLowerCase().includes('deepseek'))).toBe(false)
    expect(models).not.toContain('databricks/databricks-gemini-3-pro')
  })
})

// ── 错误归一化（纯函数测试，不建真实连接）──

function resultWith(response: Partial<Response>, error?: unknown): HeyApiResult<unknown> {
  return { error, response: response as Response }
}

describe('normalizeError', () => {
  it('data 存在 → 返回 data（成功路径）', () => {
    const data = { id: 'ses_1' }
    expect(normalizeError({ data })).toBe(data)
  })

  it('HTTP 401 → 抛 OcError kind=auth', () => {
    const result = resultWith({ status: 401 }, { name: 'Unauthorized', message: 'unauthorized' })
    try {
      normalizeError(result)
      throw new Error('应当抛错')
    } catch (e) {
      expect(e).toBeInstanceOf(OcError)
      expect((e as OcError).kind).toBe('auth')
    }
  })

  it('HTTP 500 → 抛 OcError kind=server', () => {
    const result = resultWith({ status: 500 }, { name: 'UnknownError', data: { message: 'Unexpected server error.' } })
    try {
      normalizeError(result)
      throw new Error('应当抛错')
    } catch (e) {
      expect(e).toBeInstanceOf(OcError)
      const err = e as OcError
      expect(err.kind).toBe('server')
      // SDK 错误结构 {name, data:{message}} → message 从 data.message 提取
      expect(err.message).toBe('Unexpected server error.')
    }
  })

  it('TypeError（fetch 网络层）→ 抛 OcError kind=network', () => {
    const result = { error: new TypeError('fetch failed: ECONNREFUSED'), response: undefined } as HeyApiResult<unknown>
    try {
      normalizeError(result)
      throw new Error('应当抛错')
    } catch (e) {
      expect(e).toBeInstanceOf(OcError)
      expect((e as OcError).kind).toBe('network')
      expect((e as OcError).message).toContain('无法连接')
    }
  })

  it('HTTP 400 ApiError → 抛 OcError kind=api', () => {
    const result = resultWith(
      { status: 400 },
      { name: 'APIError', data: { message: 'Model not found: deepseek-v4-flash.', statusCode: 400 } }
    )
    try {
      normalizeError(result)
      throw new Error('应当抛错')
    } catch (e) {
      expect(e).toBeInstanceOf(OcError)
      const err = e as OcError
      expect(err.kind).toBe('api')
      expect(err.status).toBe(400)
      expect(err.message).toBe('Model not found: deepseek-v4-flash.')
    }
  })

  it('纯文本 error → message 用文本本身', () => {
    const result = resultWith({ status: 503 }, 'Service Unavailable')
    try {
      normalizeError(result)
      throw new Error('应当抛错')
    } catch (e) {
      expect((e as OcError).kind).toBe('server')
      expect((e as OcError).message).toBe('Service Unavailable')
    }
  })

  it('无状态码且无 response → kind=unknown', () => {
    const result = { error: { some: 'unknown shape' }, response: undefined } as HeyApiResult<unknown>
    try {
      normalizeError(result)
      throw new Error('应当抛错')
    } catch (e) {
      expect(e).toBeInstanceOf(OcError)
      expect((e as OcError).kind).toBe('unknown')
    }
  })
})

// ── session.create 工作区绑定（query.directory 透传）──

// mock SDK 客户端：vi.hoisted 暴露底层 spy（createOcClient 会包一层包装函数，不能直接断言返回值）
const sdkMocks = vi.hoisted(() => ({
  sessionCreate: vi.fn().mockResolvedValue({ data: { id: 'ses_mock' } }),
  sessionMessages: vi.fn().mockResolvedValue({ data: [] }),
  sessionPromptAsync: vi.fn().mockResolvedValue({ data: {} }),
}))
vi.mock('@opencode-ai/sdk', () => ({
  createOpencodeClient: () => ({
    session: {
      create: sdkMocks.sessionCreate,
      list: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      rename: vi.fn(),
      fork: vi.fn(),
      abort: vi.fn(),
      prompt: vi.fn(),
      promptAsync: sdkMocks.sessionPromptAsync,
      messages: sdkMocks.sessionMessages,
    },
    permission: { respond: vi.fn() },
    file: { list: vi.fn(), read: vi.fn(), status: vi.fn() },
    config: { get: vi.fn(), update: vi.fn() },
    provider: { list: vi.fn() },
  }),
}))

import { vi } from 'vitest'
import { createOcClient } from './oc-sdk'

describe('session.create 工作区绑定', () => {
  it('传入 cwd 时透传 query.directory（会话跟随工作区）', async () => {
    const client = createOcClient({ baseURL: 'http://127.0.0.1:1', username: 'u', password: 'p' })
    sdkMocks.sessionCreate.mockClear()
    await client.session.create({ title: 'T', cwd: 'H:\\work\\proj' })
    expect(sdkMocks.sessionCreate).toHaveBeenCalledWith({
      query: { directory: 'H:\\work\\proj' },
      body: { title: 'T', parentID: undefined },
    })
  })

  it('不传 cwd 时不带 query（serve 默认目录）', async () => {
    const client = createOcClient({ baseURL: 'http://127.0.0.1:1', username: 'u', password: 'p' })
    sdkMocks.sessionCreate.mockClear()
    await client.session.create({ title: 'T' })
    expect(sdkMocks.sessionCreate).toHaveBeenCalledWith({ query: undefined, body: { title: 'T', parentID: undefined } })
  })
})

// ── session.messages 分页（limit/before 透传）──

describe('session.messages 分页', () => {
  it('传 limit + before → query 透传（before 为 serve spec 实测字段，SDK types.gen 缺失用 as never 绕过）', async () => {
    const client = createOcClient({ baseURL: 'http://127.0.0.1:1', username: 'u', password: 'p' })
    sdkMocks.sessionMessages.mockClear()
    await client.session.messages('ses_1', { limit: 50, before: 'msg_100' })
    expect(sdkMocks.sessionMessages).toHaveBeenCalledWith({
      path: { id: 'ses_1' },
      query: { limit: 50, before: 'msg_100' },
    })
  })

  it('仅传 limit（首屏最近 N 条）→ query 不含 before', async () => {
    const client = createOcClient({ baseURL: 'http://127.0.0.1:1', username: 'u', password: 'p' })
    sdkMocks.sessionMessages.mockClear()
    await client.session.messages('ses_1', { limit: 50 })
    expect(sdkMocks.sessionMessages).toHaveBeenCalledWith({
      path: { id: 'ses_1' },
      query: { limit: 50 },
    })
  })

  it('不传 options → query undefined（全量拉取，旧调用兼容）', async () => {
    const client = createOcClient({ baseURL: 'http://127.0.0.1:1', username: 'u', password: 'p' })
    sdkMocks.sessionMessages.mockClear()
    await client.session.messages('ses_1')
    expect(sdkMocks.sessionMessages).toHaveBeenCalledWith({
      path: { id: 'ses_1' },
      query: undefined,
    })
  })
})

// ── promptAsync variant 透传（思考强度真实接入引擎）──

describe('session.promptAsync variant', () => {
  it('传 variant → body 含 variant（spec 实测 prompt_async body 顶层字段，SDK 类型未生成但运行时透传）', async () => {
    const client = createOcClient({ baseURL: 'http://127.0.0.1:1', username: 'u', password: 'p' })
    sdkMocks.sessionPromptAsync.mockClear()
    await client.session.promptAsync('ses_1', '你好', { model: { providerID: 'deepseek', modelID: 'deepseek-v4-flash' }, variant: 'high' })
    expect(sdkMocks.sessionPromptAsync).toHaveBeenCalledWith({
      path: { id: 'ses_1' },
      body: {
        parts: [{ type: 'text', text: '你好' }],
        model: { providerID: 'deepseek', modelID: 'deepseek-v4-flash' },
        variant: 'high',
      },
    })
  })

  it('不传 variant → body 不含 variant（缺省走 serve 默认）', async () => {
    const client = createOcClient({ baseURL: 'http://127.0.0.1:1', username: 'u', password: 'p' })
    sdkMocks.sessionPromptAsync.mockClear()
    await client.session.promptAsync('ses_1', 'hi')
    const body = sdkMocks.sessionPromptAsync.mock.calls[0][0].body as Record<string, unknown>
    expect(body).not.toHaveProperty('variant')
  })
})

// ── session.list v2 全量拉取（2026-08-09 实测：v1 /session 的 limit 失效、永远只返回最近 50 条）──

describe('session.list v2', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('拉 v2 /api/session?limit=1000 并映射 location.directory → directory（前端 normalizeDir 过滤依赖）', async () => {
    const client = createOcClient({ baseURL: 'http://127.0.0.1:1', username: 'u', password: 'p' })
    const body = {
      data: [
        { id: 'ses_a', parentID: null, title: 'A', location: { directory: 'H:/Work/proj' } },
        { id: 'ses_b', parentID: 'ses_x', title: 'B', location: {} },
      ],
      cursor: null,
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })))
    const list = await client.session.list()
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:1/api/session?limit=1000',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: expect.stringContaining('Basic ') }) }),
    )
    expect(list).toHaveLength(2)
    expect((list[0] as unknown as { directory?: string }).directory).toBe('H:/Work/proj')
    expect((list[1] as unknown as { directory?: string }).directory).toBeUndefined()
  })

  it('HTTP 非 2xx → 抛错（serve 异常透传）', async () => {
    const client = createOcClient({ baseURL: 'http://127.0.0.1:1', username: 'u', password: 'p' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
    await expect(client.session.list()).rejects.toThrow(/HTTP 500/)
  })
})
