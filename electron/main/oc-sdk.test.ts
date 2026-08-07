// oc-sdk 单元测试：用 stage0 实测的 /provider 响应验证 deepseek 模型提取逻辑
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
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
      promptAsync: vi.fn(),
      messages: vi.fn(),
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
