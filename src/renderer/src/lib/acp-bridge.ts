// acp-bridge.ts：渲染层 ACP 数据桥——上下文面板展示 ACP 真实上下文构成（压缩块/分类/统计）与解压操作
// 与主进程 acp-store.ts 类型对齐（分类字段为展示子集：渲染层不展示 messages 计数，此处省略）
// invoke 经 preload 白名单（acp:getState / acp:decompress）

/** 压缩块概要（渲染层展示用；summary 截断预览） */
export interface AcpBlockSummary {
  blockId: number;
  topic: string;
  compressedTokens: number;
  summaryTokens: number;
  tier: number;
  active: boolean;
  startId: string;
  endId: string;
  createdAt: string;
  summaryPreview: string;
}

/** 分类统计行（role 关联 serve message:list；缺失 role 归 system 兜底） */
export interface AcpCategoryStat {
  role: string;
  tokens: number;
}

/** ACP 会话状态（getAcpSessionState 返回；detected=false 时为空态兜底） */
export interface AcpSessionState {
  detected: boolean;
  blocks: AcpBlockSummary[];
  categories: AcpCategoryStat[];
  totalPruneTokens?: number;
  modelContextLimit?: number;
  error?: string;
}

/** IPC invoke 统一入口：经 preload 暴露的 window.electronBridge */
async function invoke<T>(channel: string, args?: Record<string, unknown>): Promise<T> {
  return window.electronBridge.invoke(channel, args) as Promise<T>
}

/** 读取 ACP 会话状态（压缩块 + 分类 + 统计；文件缺失/损坏返回 detected=false） */
export async function getAcpSessionState(sessionId: string): Promise<AcpSessionState> {
  return invoke<AcpSessionState>("acp:getState", { sessionId })
}

/** 驱动模型执行 decompress bN（serve 无 REST 端点，走 promptAsync 指令）；返回 ok */
export async function decompressAcpBlock(sessionId: string, blockId: number): Promise<{ ok: boolean }> {
  return invoke<{ ok: boolean }>("acp:decompress", { sessionId, blockId })
}
