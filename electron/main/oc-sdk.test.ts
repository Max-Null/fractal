// oc-sdk 单元测试：用 stage0 实测的 /provider 响应验证 deepseek 模型提取逻辑
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { listDeepseekModels, type Provider } from './oc-sdk'

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
