// provider 单元测试：模型映射表 + listDeepseekModels 过滤逻辑（mock client，不建真实连接）
import { describe, it, expect } from 'vitest'
import { DEEPSEEK_MODELS, DEFAULT_MODEL, listDeepseekModels } from './provider'
import type { OcClient, Provider } from './oc-sdk'

describe('DEEPSEEK_MODELS 映射表', () => {
  it('flash/pro 高低搭配（D16 模型固定，无 [1M] 后缀——阶段 0 实测 S3）', () => {
    expect(Object.keys(DEEPSEEK_MODELS).sort()).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
    expect(DEEPSEEK_MODELS['deepseek-v4-flash'].label).toContain('flash')
    expect(DEEPSEEK_MODELS['deepseek-v4-pro'].label).toContain('pro')
  })

  it('默认模型为 pro（深度）', () => {
    expect(DEFAULT_MODEL.id).toBe('deepseek-v4-pro')
  })
})

describe('listDeepseekModels（mock client）', () => {
  function mockClient(providers: Provider[]): OcClient {
    return {
      session: {} as OcClient['session'],
      permission: {} as OcClient['permission'],
      file: {} as OcClient['file'],
      raw: {} as OcClient['raw'],
      config: {
        get: async () => ({}),
        update: async (c) => c,
        providers: async () => ({ all: providers }) as never,
      },
    }
  }

  it('从 /provider 响应提取 deepseek 受管模型并映射 label', async () => {
    const providers: Provider[] = [
      {
        id: 'deepseek',
        name: 'DeepSeek',
        models: {
          'deepseek-v4-flash': { id: 'deepseek-v4-flash', providerID: 'deepseek' },
          'deepseek-v4-pro': { id: 'deepseek-v4-pro', providerID: 'deepseek' },
          'deepseek-chat': { id: 'deepseek-chat', providerID: 'deepseek' },
        },
      },
      { id: 'databricks', name: 'Databricks', models: { 'databricks-gemini-3-pro': { id: 'databricks-gemini-3-pro', providerID: 'databricks' } } },
    ]
    const items = await listDeepseekModels(mockClient(providers))
    expect(items.map((i) => i.id).sort()).toEqual(['deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-pro'])
    expect(items.find((i) => i.id === 'deepseek/deepseek-v4-pro')?.label).toBe('pro（深度）')
    // deepseek-chat 未受管（不在映射表）不返回；非 deepseek provider 不返回
    expect(items.some((i) => i.id.includes('deepseek-chat'))).toBe(false)
    expect(items.some((i) => i.id.includes('databricks'))).toBe(false)
  })

  it('provider 无 deepseek 模型时返回空数组', async () => {
    const items = await listDeepseekModels(mockClient([{ id: 'anthropic', name: 'Anthropic', models: {} }]))
    expect(items).toEqual([])
  })
})
