import { describe, it, expect } from 'vitest'
import { calcCostCny, DEEPSEEK_PRICES } from './pricing'

describe('pricing 价格表（DeepSeek 2026-08 官方价：元/百万 tokens）', () => {
  it('flash：输入 1 元/M、输出 2 元/M', () => {
    expect(DEEPSEEK_PRICES['deepseek-v4-flash']).toEqual({ inputCnyPerM: 1, outputCnyPerM: 2, cacheReadCnyPerM: 0.02 })
  })

  it('pro：输入 3 元/M、输出 6 元/M', () => {
    expect(DEEPSEEK_PRICES['deepseek-v4-pro']).toEqual({ inputCnyPerM: 3, outputCnyPerM: 6, cacheReadCnyPerM: 0.025 })
  })
})

describe('calcCostCny（人民币成本计算）', () => {
  it('纯未命中输入 + 输出（无缓存）', () => {
    // pro：1000000×3/1e6 + 500000×6/1e6 = 3 + 3 = 6 元
    expect(calcCostCny('deepseek-v4-pro', { input: 1_000_000, output: 500_000 })).toBeCloseTo(6, 8)
  })

  it('缓存命中部分走缓存价（pro：命中 0.025 元/M）', () => {
    // serve 下发的 input 是 adjusted 口径（已减缓存）——10000 即为未命中输入，命中 8000 单独计价：
    // 10000×3/1e6 + 8000×0.025/1e6 = 0.03 + 0.0002 = 0.0302
    expect(calcCostCny('deepseek-v4-pro', { input: 10000, output: 0, cacheRead: 8000 })).toBeCloseTo(0.0302, 8)
  })

  it('flash 价格低于 pro（同用量 flash 更便宜）', () => {
    const usage = { input: 1_000_000, output: 1_000_000 }
    expect(calcCostCny('deepseek-v4-flash', usage)).toBeLessThan(calcCostCny('deepseek-v4-pro', usage))
  })

  it('未收录模型按 flash 兜底（保守计价，不因未知模型算天价）', () => {
    // 兜底价 = flash：输入 1 元/M、输出 2 元/M → 1+2 = 3 元
    expect(calcCostCny('deepseek-v5-new', { input: 1_000_000, output: 1_000_000 })).toBeCloseTo(3, 8)
  })

  it('cacheRead 异常大于 input 时不影响未命中计价（serve 下发的 input 已不含缓存）', () => {
    // input=10000（未命中）独立计价，cacheRead=20000 异常值按缓存价封顶（DeepSeek 价格表缓存价便宜）：
    // 10000×3/1e6 + 20000×0.025/1e6 = 0.03 + 0.0005 = 0.0305
    expect(calcCostCny('deepseek-v4-pro', { input: 10000, output: 0, cacheRead: 20000 })).toBeCloseTo(0.0305, 8)
  })

  it('负数 tokens 钳到 0（不产生负成本）', () => {
    expect(calcCostCny('deepseek-v4-flash', { input: -5, output: -5 })).toBe(0)
  })
})
