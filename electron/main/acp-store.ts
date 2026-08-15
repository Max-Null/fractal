// ACP 插件状态读取（上下文面板真实数据源，2026-08-15）
// 数据来源：opencode-acp 插件每会话落盘 JSON —— <OC 数据目录>/storage/plugin/acp/ses_{sessionId}.json
// 契约（实测 2026-08-15）：顶层 { prune: { messages: { byMessageId, blocksById, activeBlockIds } }, stats: { totalPruneTokens }, modelContextLimit, lastCompaction }
//   byMessageId: { [msg_id]: { tokenCount, allBlockIds, activeBlockIds } }
//   blocksById:  { [blockId]: { blockId, topic, compressedTokens, summaryTokens, tier, active, startId, endId, createdAt, summary, ... } }
// 渲染进程无 fs 权限（沙箱）→ 主进程只读固定目录，不接收用户任意路径
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// ── 类型（与 acp-bridge.ts 前端契约对齐；分类字段为展示子集）──

export interface AcpBlock {
  blockId: number
  topic: string
  compressedTokens: number
  summaryTokens: number
  tier: number
  active: boolean
  startId: string
  endId: string
  createdAt: string
  /** 摘要预览（截断，列表展示用） */
  summaryPreview: string
}

export interface AcpCategoryStat {
  role: 'user' | 'assistant' | 'tool' | 'system'
  tokens: number
  messages: number
}

export interface AcpSessionState {
  /** ACP JSON 是否存在且可解析（false → 前端走估算兜底） */
  detected: boolean
  blocks: AcpBlock[]
  totalPruneTokens: number
  modelContextLimit: number
  /** 分类汇总（user/assistant/tool 真实，system 由前端估算补充） */
  categories: AcpCategoryStat[]
  error?: string
}

/** ACP 落盘目录（OC 数据目录约定，与 serve 一致） */
export function getAcpStorageDir(): string {
  return join(homedir(), '.local', 'share', 'opencode', 'storage', 'plugin', 'acp')
}

/** 单个压缩块字段透传 + summary 截断 */
function toAcpBlock(raw: Record<string, unknown>): AcpBlock {
  return {
    blockId: Number(raw.blockId ?? 0),
    topic: typeof raw.topic === 'string' ? raw.topic : '',
    compressedTokens: Number(raw.compressedTokens ?? 0),
    summaryTokens: Number(raw.summaryTokens ?? 0),
    tier: Number(raw.tier ?? 1),
    active: raw.active !== false, // 缺省视为活跃（老版本字段缺失容错）
    startId: typeof raw.startId === 'string' ? raw.startId : '',
    endId: typeof raw.endId === 'string' ? raw.endId : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    summaryPreview:
      typeof raw.summary === 'string' && raw.summary.length > 120
        ? raw.summary.slice(0, 120) + '…'
        : typeof raw.summary === 'string'
          ? raw.summary
          : '',
  }
}

/**
 * 读取指定会话的 ACP 状态。
 * @param sessionId serve 会话 id（已由调用方校验非空；IPC 层再做格式校验防路径注入）
 * @param messages message:list 拉取的消息记录（含 id/role），用于把 ACP 消息级 token 归入 user/assistant
 * @returns detected=false 表示无 ACP 数据（前端回退估算）；解析失败同样返回 detected=false + error
 */
export async function getAcpSessionState(
  sessionId: string,
  messages: Array<{ id: string; role: string }>,
): Promise<AcpSessionState> {
  const filePath = join(getAcpStorageDir(), `ses_${sessionId}.json`)
  let raw: string
  try {
    raw = await fsp.readFile(filePath, 'utf8')
  } catch {
    // 文件不存在（新会话未触发 ACP）——正常兜底，不视为错误
    return emptyState()
  }

  let data: Record<string, unknown>
  try {
    data = JSON.parse(raw) as Record<string, unknown>
  } catch (e) {
    // JSON 损坏（插件版本升级写一半）——兜底 + 透传错误供前端提示
    return { ...emptyState(), error: `ACP 状态解析失败：${(e as Error).message}` }
  }

  const prune = (data.prune ?? {}) as Record<string, unknown>
  const messagesState = (prune.messages ?? {}) as Record<string, unknown>
  const byMessageId = (messagesState.byMessageId ?? {}) as Record<string, { tokenCount?: number }>
  const blocksById = (messagesState.blocksById ?? {}) as Record<string, Record<string, unknown>>
  const stats = (data.stats ?? {}) as Record<string, unknown>

  // 压缩块列表：blocksById 值数组，按 createdAt 倒序（最新在前）
  // 空串 createdAt（老版本缺字段）归一化为最早，避免与有效日期比较时排最前
  const blocks = Object.values(blocksById)
    .map((b) => toAcpBlock(b))
    .sort((a, b) => {
      const at = a.createdAt || '0000-00-00T00:00:00.000Z'
      const bt = b.createdAt || '0000-00-00T00:00:00.000Z'
      return at < bt ? 1 : -1
    })

  // 分类汇总：ACP 消息级 token → message:list role 关联
  // user/assistant 直接映射；role 匹配不上（内部/系统消息）归入 system——
  // ACP byMessageId 含 serve 内部消息，message:list 可能不返回全部，缺失 role 的消息计入 system 兜底（避免 token 丢失但标注估算）
  const roleByMsgId = new Map<string, string>()
  for (const m of messages) {
    roleByMsgId.set(m.id, m.role)
  }
  const categories: AcpCategoryStat[] = [
    { role: 'user', tokens: 0, messages: 0 },
    { role: 'assistant', tokens: 0, messages: 0 },
    { role: 'tool', tokens: 0, messages: 0 },
    { role: 'system', tokens: 0, messages: 0 },
  ]
  for (const [msgId, info] of Object.entries(byMessageId)) {
    const tokens = Number(info.tokenCount ?? 0)
    if (tokens <= 0) continue
    const role = roleByMsgId.get(msgId)
    // tool 消息：ACP 没有 role 字段，assistant 消息内的 tool part 无法在消息级拆分——
    // 设计决策：本把「role 缺失」的消息计入 system 兜底，assistant 直接当 assistant（tool 折算见前端文档风险）
    // 注：此处简单映射，避免过度工程——真实 tool 拆分依赖消息 parts 结构（文档已标注简化）
    const bucket =
      role === 'user' ? categories[0] : role === 'assistant' ? categories[1] : categories[3]
    bucket.tokens += tokens
    bucket.messages += 1
  }
  // 移除零值分类行（前端只展示有数据的）
  const nonEmpty = categories.filter((c) => c.tokens > 0)

  return {
    detected: true,
    blocks,
    totalPruneTokens: Number(stats.totalPruneTokens ?? 0),
    modelContextLimit: Number(data.modelContextLimit ?? 0),
    categories: nonEmpty,
  }
}

function emptyState(): AcpSessionState {
  return {
    detected: false,
    blocks: [],
    totalPruneTokens: 0,
    modelContextLimit: 0,
    categories: [],
  }
}
