// provider 管理：DeepSeek 模型映射表 + 经 serve 拉取模型列表（阶段 4 实现）
// 策略：产品只针对 DeepSeek（D13 单一 Provider），映射表维护 GUI 展示名 ↔ 模型 ID（设计方案 3.1.3）

import type { OcClient } from './oc-sdk'

/** DeepSeek 模型定义（D16 模型固定：flash/pro 高低搭配，无 [1M] 后缀——阶段 0 实测 S3） */
export interface DeepseekModelDef {
  id: string
  label: string
  limit: { context: number; output: number }
}

/** 模型映射表（provider.ts 职责：GUI 展示名 ↔ 模型 ID） */
export const DEEPSEEK_MODELS: Record<string, DeepseekModelDef> = {
  'deepseek-v4-flash': { id: 'deepseek-v4-flash', label: 'flash（快速）', limit: { context: 1000000, output: 131072 } },
  'deepseek-v4-pro': { id: 'deepseek-v4-pro', label: 'pro（深度）', limit: { context: 1000000, output: 131072 } },
}

/** 会话级默认模型（ipc.ts chat:sendMessage 使用；serve 全局默认由 oc-config.ts 写 config.model） */
export const DEFAULT_MODEL: DeepseekModelDef = DEEPSEEK_MODELS['deepseek-v4-pro']

/** 模型选择器列表项 */
export interface DeepseekModelListItem {
  id: string
  /** 完整 id（provider/模型），直接可选中 */
  providerModelId: string
  label: string
}

/**
 * 经 serve 拉取 deepseek provider 的模型列表，映射为 GUI 列表项。
 * 过滤：provider.id 含 deepseek + 模型 id 命中 DEEPSEEK_MODELS 映射表（避免 deepseek-chat/reasoner 等未受管模型混入）。
 */
export async function listDeepseekModels(client: OcClient): Promise<DeepseekModelListItem[]> {
  const resp = await client.config.providers()
  // ProviderListResponse 顶层 {all, default, connected}（阶段 0 实测 /provider 结构）；
  // SDK 生成的 Model 类型与 oc-sdk Provider 结构不同（无 providerID），这里用窄类型自行提取
  const all = (resp as { all?: unknown }).all as Array<{ id: string; models?: Record<string, { id: string }> }> | undefined
  const result: DeepseekModelListItem[] = []
  for (const p of all ?? []) {
    if (!String(p.id).toLowerCase().includes('deepseek')) continue
    for (const m of Object.values(p.models ?? {})) {
      const def = DEEPSEEK_MODELS[m.id]
      if (def) {
        result.push({ id: `${p.id}/${m.id}`, providerModelId: `${p.id}/${m.id}`, label: def.label })
      }
    }
  }
  return result
}
