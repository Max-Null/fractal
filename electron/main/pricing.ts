// DeepSeek 价格表与成本计算（人民币 ¥ 计费）
// 价格来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/（2026-08 实测，单位：元/百万 tokens）
// 设计决策：DeepSeek 按人民币计费且区分缓存命中/未命中，serve 引擎返回的 cost 是美元口径且
// events.ts 曾读错字段层级（info.tokens.cost 不存在）——本地按价格表计算最准确、可测试。

/** 单模型价格（元/百万 tokens） */
export interface ModelPrice {
  /** 输入（缓存未命中）单价：元/百万 tokens */
  inputCnyPerM: number
  /** 输出单价：元/百万 tokens */
  outputCnyPerM: number
  /** 缓存命中输入单价：元/百万 tokens（DeepSeek 缓存命中约 30 倍便宜，2026-08 价格页） */
  cacheReadCnyPerM: number
}

/** 支持计费的模型价格表（key 为 serve model.id；新增模型未收录时按默认价兜底） */
export const DEEPSEEK_PRICES: Record<string, ModelPrice> = {
  'deepseek-v4-flash': { inputCnyPerM: 1, outputCnyPerM: 2, cacheReadCnyPerM: 0.02 },
  'deepseek-v4-pro': { inputCnyPerM: 3, outputCnyPerM: 6, cacheReadCnyPerM: 0.025 },
}

/** 未收录模型的兜底价（按 flash——最保守，避免新模型按未知价算成天价） */
const FALLBACK_PRICE: ModelPrice = DEEPSEEK_PRICES['deepseek-v4-flash']

/**
 * 成本计算入参（tokens 口径与 serve 一致：input 为 adjusted 口径——opencode 的
 * Session.getUsage 已减去 cacheRead/cacheWrite，故 input 不含缓存命中部分，cacheRead 单独列出）。
 */
export interface TokenUsage {
  input: number
  output: number
  cacheRead?: number
}

/**
 * 计算一次请求的人民币成本（元）。
 * 公式：未命中输入 × 输入价 + 命中输入 × 缓存价 + 输出 × 输出价，全部按每百万 tokens 折算。
 * 注意：serve 下发的 tokens.input 是 adjusted（不含缓存），直接作为未命中输入，
 * 不再减 cacheRead（2026-08-13 修正——此前按「input 含缓存」口径再减一次导致成本低估）。
 * cacheRead 缺省按 0（serve 早期版本无 cache 字段时兜底）。
 */
export function calcCostCny(modelId: string, usage: TokenUsage): number {
  const price = DEEPSEEK_PRICES[modelId] ?? FALLBACK_PRICE
  const cacheRead = Math.max(0, usage.cacheRead ?? 0)
  const uncachedInput = Math.max(0, usage.input)
  return (
    (uncachedInput / 1e6) * price.inputCnyPerM +
    (cacheRead / 1e6) * price.cacheReadCnyPerM +
    (Math.max(0, usage.output) / 1e6) * price.outputCnyPerM
  )
}
