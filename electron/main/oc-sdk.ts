// OC SDK 封装：与 opencode 引擎交互的类型定义与工具函数
// 类型对齐 stage0 实测的 /provider 响应结构（顶层 { all, default, connected }）

/** /provider 响应中的单个模型定义（字段对齐实测报文，仅取本阶段所需） */
export interface ModelInfo {
  id: string
  providerID: string
  name?: string
}

/** /provider 响应中的 provider 定义，models 为模型 id -> ModelInfo 映射 */
export interface Provider {
  id: string
  name?: string
  source?: string
  models: Record<string, ModelInfo>
}

/**
 * 从 /provider 响应中提取所有 deepseek 模型 id。
 * 过滤条件：模型 id 含 "deepseek"（覆盖 deepseek-v4-flash/pro/chat 等），
 * 返回 `${providerId}/${modelId}` 格式，便于 renderer 直接选中模型。
 */
export function listDeepseekModels(providers: Provider[]): string[] {
  return providers.flatMap((provider) =>
    Object.values(provider.models)
      .filter((model) => model.id.toLowerCase().includes('deepseek'))
      .map((model) => `${provider.id}/${model.id}`)
  )
}

/**
 * 向 serve 发送会话消息（send_message 通道）。
 * 阶段 4 实现：组装 ACP 报文并经 server-manager 转发。
 */
export async function sendMessage(_sessionId: string, _content: string): Promise<string> {
  throw new Error('sendMessage 未实现：阶段 4')
}

/**
 * 停止当前会话（stop_session 通道）。
 * 阶段 4 实现。
 */
export async function stopSession(_sessionId: string): Promise<void> {
  throw new Error('stopSession 未实现：阶段 4')
}
