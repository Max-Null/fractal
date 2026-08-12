// OC SDK 封装：与 opencode serve 引擎交互的类型定义与工具函数
// SDK 版本：@opencode-ai/sdk 1.18.13（与阶段 0 实测一致，v1 命名空间）
// 返回结构：@hey-api 生成，调用返回 { data, error, request, response }
// 统一约定：本文件所有方法成功返回 data，失败抛归一化 OcError（见 normalizeError）

import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk'
import type {
  Session,
  Message,
  Part,
  FileNode,
  FileContent,
  File as FileStatus,
  Config,
  TextPartInput,
  FilePartInput,
  ProviderListResponse,
} from '@opencode-ai/sdk'

// ══════════════════════════════════════════════════════════════════
// 类型定义（对外导出，供 server-manager / ipc 使用）
// ══════════════════════════════════════════════════════════════════

/**
 * 会话列表拉取上限（v2 /api/session 单次返回量）。
 * 2026-08-09 实测：serve 1.18.15 的 v1 GET /session 的 limit/start 参数全部无效、
 * 永远只返回最近 50 条——早期会话被挤出导致工作区列表空——v2 ?limit=1000 返回全量。
 * 响应含 cursor 字段，>1000 会话时翻页续拉留待（当前用户库 128 条）。
 */
export const SESSION_LIST_LIMIT = 1000

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

/** 会话消息（session.messages 返回的 {info, parts} 结构） */
export interface SessionMessage {
  info: Message
  parts: Part[]
}

/** @hey-api 统一返回结构（成功 data / 失败 error 二选一） */
export interface HeyApiResult<TData = unknown, TError = unknown> {
  data?: TData
  error?: TError
  request?: Request
  response?: Response
}

/** 会话创建参数（title 可选；cwd 传入时绑定工作区目录，serve query.directory） */
export interface CreateSessionOptions {
  title?: string
  parentID?: string
  cwd?: string
}

/** prompt 发送参数（model 可选，缺省用会话当前模型） */
export interface PromptOptions {
  model?: { providerID: string; modelID: string }
  system?: string
  agent?: string
  /** 思考强度 variant（模型 variant 名，如 low/high/max——spec 实测 prompt_async body 顶层字段） */
  variant?: string
}

/** 权限审批响应（SDK 1.18.13 枚举，always 即"记住"） */
export type PermissionResponse = 'once' | 'always' | 'reject'

// ══════════════════════════════════════════════════════════════════
// 错误归一化
// ══════════════════════════════════════════════════════════════════

/** 错误分类：认证失败 / 服务端错误 / 网络错误 / API 业务错误 / 未知 */
export type OcErrorKind = 'auth' | 'server' | 'network' | 'api' | 'unknown'

/** 归一化后的 SDK 调用错误（message 可直接展示给用户） */
export class OcError extends Error {
  readonly kind: OcErrorKind
  readonly status?: number
  readonly cause?: unknown

  constructor(kind: OcErrorKind, message: string, opts?: { status?: number; cause?: unknown }) {
    super(message)
    this.name = 'OcError'
    this.kind = kind
    this.status = opts?.status
    this.cause = opts?.cause
  }
}

/**
 * 从 @hey-api 返回中提取错误消息。
 * error 可能是 ApiError（{name, data:{message,...}}）、服务端 JSON（{name, data:{message}}）
 * 或纯文本——逐层兼容提取。
 */
function extractErrorMessage(error: unknown, status: number | undefined): string {
  if (typeof error === 'string') return error
  if (!error || typeof error !== 'object') return `请求失败（HTTP ${status ?? 'unknown'}）`
  const e = error as Record<string, unknown>
  // SDK 错误结构：{name:"APIError"|"UnknownError", data:{message}}
  const data = e.data as Record<string, unknown> | undefined
  if (data && typeof data.message === 'string') return data.message
  if (typeof e.message === 'string') return e.message
  if (typeof e.name === 'string') return `${e.name}（HTTP ${status ?? 'unknown'}）`
  return `请求失败（HTTP ${status ?? 'unknown'}）`
}

/**
 * 归一化 @hey-api 返回：data 存在则返回 data；error 存在则抛归一化 OcError。
 * 错误分类依据（优先级从高到低）：
 * 1. HTTP 401 → auth（Basic 认证失败，多为 serve 未启动或凭据错）
 * 2. HTTP >= 500 → server（serve 内部错误）
 * 3. error 为 TypeError（fetch 网络层）→ network（serve 未启动/连接中断）
 * 4. error.name === 'APIError' → api（业务错误，带 statusCode）
 * 5. 其余 → unknown
 */
export function normalizeError<T>(result: HeyApiResult<T>): T {
  if (result.data !== undefined) return result.data

  const status = result.response?.status
  const error = result.error

  // 网络层异常：fetch 失败抛 TypeError（如 ECONNREFUSED / 超时）
  if (error instanceof TypeError) {
    throw new OcError('network', `无法连接 OC serve：${error.message}`, { cause: error })
  }
  // AbortError（DOMException）：withTimeout 超时中止的 fetch——serve 无响应，归类 network
  if (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError') {
    throw new OcError('network', 'OC serve 请求超时（可能正在重启）', { cause: error })
  }
  // HTTP 状态码优先分类
  if (status === 401) {
    throw new OcError('auth', extractErrorMessage(error, status), { status, cause: error })
  }
  if (status !== undefined && status >= 500) {
    throw new OcError('server', extractErrorMessage(error, status), { status, cause: error })
  }
  // ApiError（业务错误，如 400 模型不存在 / 404 会话不存在）
  const isApiError = error !== null && typeof error === 'object' && (error as Record<string, unknown>).name === 'APIError'
  if (isApiError || (status !== undefined && status >= 400)) {
    throw new OcError('api', extractErrorMessage(error, status), { status, cause: error })
  }
  throw new OcError('unknown', extractErrorMessage(error, status), { status, cause: error })
}

// ══════════════════════════════════════════════════════════════════
// 请求超时
// ══════════════════════════════════════════════════════════════════

/** 普通 SDK 请求超时（毫秒）。serve 重启/被杀时底层 fetch 无超时（server-manager.ts 注释），
 *  请求会永久挂起导致前端永远卡 loading——统一注入 AbortSignal 兜底 */
const SDK_REQUEST_TIMEOUT_MS = 15_000

/** 同步 prompt（等待模型完整回复）超时——模型生成可达数分钟，不能套普通超时 */
const SDK_PROMPT_TIMEOUT_MS = 300_000

/**
 * 带超时的 SDK 调用：serve 无响应时 abort 底层 fetch，抛归一化 OcError（network 类）。
 * 仅用于普通 HTTP 请求；SSE 长连接（events.ts 订阅）不经此包装。
 * timeoutMs 可注入（测试用短超时），默认 SDK_REQUEST_TIMEOUT_MS。
 * 导出供单测直接验证超时行为。
 * 实现：Promise.race 主动 reject 兜底——不依赖 run 内部监听 abort 事件（若 run 的 promise
 * 永不 settle，abort 信号本身无法让 await 返回，必须由 race 的 timeoutPromise 结束）。
 * 双路径说明：超时后 controller.abort() 若让 run 先 reject（如 fetch 抛 AbortError），
 * 该 rejection 由 race 内部已挂的 handler 静默接住（不会 unhandledRejection），
 * 最终用户只看到 timeoutPromise 抛的 OcError——两路径不冲突。
 */
export async function withTimeout<T>(label: string, run: (signal: AbortSignal) => Promise<T>, timeoutMs = SDK_REQUEST_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  // 超时即 abort 底层 fetch（若已建立连接则真正取消）+ 主动 reject（防 run 永不 settle 时整体挂起）
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error(`${label} 超时`))
      reject(new OcError('network', `${label} 超时：OC serve 无响应（可能正在重启）`))
    }, timeoutMs)
  })
  try {
    return await Promise.race([Promise.resolve().then(() => run(controller.signal)), timeoutPromise])
  } finally {
    clearTimeout(timer)
  }
}

// ══════════════════════════════════════════════════════════════════
// 认证与客户端工厂
// ══════════════════════════════════════════════════════════════════

/** 构造 Basic 认证头（serve v1.15+ 默认要求，凭据由 OPENCODE_SERVER_USERNAME/PASSWORD 注入） */
export function basicAuthHeader(username: string, password: string): string {
  return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64')
}

/** OC serve 连接配置 */
export interface OcClientOptions {
  baseURL: string
  username: string
  password: string
}

/** 会话操作客户端 */
export interface OcSessionClient {
  /** 创建会话，返回新会话（title 可选） */
  create(options?: CreateSessionOptions): Promise<Session>
  /** 列出会话；directory 传入时按工作区过滤（serve ?directory=） */
  list(directory?: string): Promise<Session[]>
  /** 获取单个会话详情 */
  get(id: string): Promise<Session>
  /** 删除会话（含数据），返回是否成功 */
  delete(id: string): Promise<boolean>
  /** 重命名会话（PATCH title） */
  rename(id: string, title: string): Promise<Session>
  /** 从指定消息分叉会话（messageID 可选，缺省从当前末尾） */
  fork(id: string, messageID?: string): Promise<Session>
  /** 中断正在运行的会话，返回是否成功 */
  abort(id: string): Promise<boolean>
  /** 同步发送消息，等待模型完成返回 {info, parts} */
  prompt(id: string, text: string, options?: PromptOptions): Promise<SessionMessage>
  /** 异步发送消息：立即返回（204），结果通过 SSE 事件流接收 */
  promptAsync(id: string, text: string, options?: PromptOptions): Promise<void>
  /** 异步发送带附件消息：parts 数组（text + file 混排），立即返回（204），结果通过 SSE 事件流接收（P6 附件链路） */
  promptPartsAsync(id: string, parts: Array<TextPartInput | FilePartInput>, options?: PromptOptions): Promise<void>
  /** 拉取会话消息列表（limit=最近 N 条；before=消息 ID 游标，返回该消息之前的更早消息——长会话分页加载用） */
  messages(id: string, options?: { limit?: number; before?: string }): Promise<SessionMessage[]>
}

/** 权限审批客户端 */
export interface OcPermissionClient {
  /** 响应权限请求（once=本次允许 / always=记住 / reject=拒绝） */
  respond(sessionID: string, permissionID: string, response: PermissionResponse): Promise<unknown>
}

/** 文件操作客户端（SDK v1 仅有 list/read/status，无 write） */
export interface OcFileClient {
  /** 列出目录/文件（path 为 serve 工作区内路径） */
  list(path: string): Promise<FileNode[]>
  /** 读取文件内容（text/binary） */
  read(path: string): Promise<FileContent>
  /** 获取工作区文件变更状态 */
  status(): Promise<FileStatus[]>
}

/** 配置客户端 */
export interface OcConfigClient {
  /** 获取当前 opencode.json 配置 */
  get(): Promise<Config>
  /** 整体更新配置（合并语义由 serve 决定） */
  update(config: Config): Promise<Config>
  /** 列出全部 provider（/provider 端点，顶层 {all, default, connected}，与阶段 0 实测一致） */
  providers(): Promise<ProviderListResponse>
}

// ── 生态面板数据（原「技能」tab）：serve 原生清单端点（v1.18.5 api-spec 实测）──

export interface CapabilityAgent {
  name: string
  description: string
  mode: string
  native: boolean
}
export interface CapabilitySkill {
  name: string
  description: string
  location: string
}
export interface CapabilityPlugin {
  name: string
  source: string
}
export interface CapabilityMcp {
  name: string
  /** serve 运行时状态：connected / disabled / failed / needsAuth / needsClientRegistration */
  status: string
  type: 'local' | 'remote' | ''
  /** remote → url；local → command 前两项拼接 */
  target: string
}
export interface CapabilityBundle {
  agents: CapabilityAgent[]
  skills: CapabilitySkill[]
  plugins: CapabilityPlugin[]
  mcp: CapabilityMcp[]
}

/** 生态清单客户端：单次聚合拉取（各端点独立容错，失败返回空数组） */
export interface OcCapabilitiesClient {
  list(): Promise<CapabilityBundle>
}

/** OC serve 客户端聚合（供 server-manager 阶段 4 使用） */
export interface OcClient {
  session: OcSessionClient
  permission: OcPermissionClient
  file: OcFileClient
  config: OcConfigClient
  /** 生态清单（agent/skill/plugin/mcp——serve 原生端点聚合） */
  capabilities: OcCapabilitiesClient
  /** 底层 SDK client（events.ts 订阅 SSE 用） */
  raw: OpencodeClient
}

/**
 * 创建 OC serve 客户端工厂。
 * 统一注入 Basic 认证头（阶段 0 实测 serve v1.15+ 必需）。
 */
export function createOcClient(options: OcClientOptions): OcClient {
  const client = createOpencodeClient({
    baseUrl: options.baseURL,
    headers: { Authorization: basicAuthHeader(options.username, options.password) },
  })

  return {
    session: {
      create: async (opts) => normalizeError<Session>(
        // 目录走 query.directory（SDK 实测结构：body 只有 parentID/title）——绑定工作区后会话在 ?directory= 过滤下可见
        await withTimeout('创建会话', (signal) =>
          client.session.create({ query: opts?.cwd ? { directory: opts.cwd } : undefined, body: { title: opts?.title, parentID: opts?.parentID }, signal }),
        ),
      ),
      list: async (directory?: string) => {
        // v2 全量列表（2026-08-09 实测）：serve 1.18.15 的 v1 GET /session 的 limit/start 参数全部无效，
        // 永远只返回最近 50 条——早期会话（如 oc-plus 的主会话）被挤出，工作区列表过滤后为空。
        // v2 GET /api/session?limit=1000 返回全量（响应 {data, cursor}；>1000 会话时 cursor 翻页留待）。
        // directory 参数保留签名兼容但忽略——目录过滤由前端内存完成（session store normalizeDir）
        void directory
        const authHeader = basicAuthHeader(options.username, options.password)
        const res = await withTimeout('会话列表', (signal) =>
          fetch(`${options.baseURL}/api/session?limit=${SESSION_LIST_LIMIT}`, { headers: { Authorization: authHeader }, signal }),
        )
        if (!res.ok) throw new Error(`session list 失败: HTTP ${res.status}`)
        const body = (await res.json()) as { data?: Array<Record<string, unknown>> }
        // v2 会话目录在 location.directory（v1 在顶层 directory）——映射回 v1 形状供前端 normalizeDir 过滤
        return (body.data ?? []).map((s) => ({
          ...s,
          directory: (s.location as { directory?: string } | undefined)?.directory ?? undefined,
        })) as unknown as Session[]
      },
      get: async (id) => normalizeError<Session>(await withTimeout('获取会话', (signal) => client.session.get({ path: { id }, signal }))),
      delete: async (id) => normalizeError<boolean>(await withTimeout('删除会话', (signal) => client.session.delete({ path: { id }, signal }))),
      rename: async (id, title) => normalizeError<Session>(await withTimeout('重命名会话', (signal) => client.session.update({ path: { id }, body: { title }, signal }))),
      fork: async (id, messageID) => normalizeError<Session>(await withTimeout('复制会话', (signal) => client.session.fork({ path: { id }, body: messageID ? { messageID } : {}, signal }))),
      abort: async (id) => normalizeError<boolean>(await withTimeout('中止会话', (signal) => client.session.abort({ path: { id }, signal }))),
      // prompt 同步等待模型完成（返回完整消息），promptAsync 仅提交（结果走 SSE）
      prompt: async (id, text, opts) => {
        const body: { parts: TextPartInput[]; model?: PromptOptions['model']; system?: string; agent?: string; variant?: string } = {
          parts: [{ type: 'text', text }],
        }
        if (opts?.model) body.model = opts.model
        if (opts?.system) body.system = opts.system
        if (opts?.agent) body.agent = opts.agent
        // variant 不在 SDK types.gen 的 body 类型（spec 实测 prompt_async/prompt 顶层支持）——
        // body 是变量非字面量，多出属性不触发 excess property check，运行时原样透传
        if (opts?.variant) body.variant = opts.variant
        try {
          return await normalizeError<SessionMessage>(
            // 同步等模型完整回复，用长超时（模型生成可达数分钟）
            await withTimeout('等待模型回复', (signal) => client.session.prompt({ path: { id }, body, signal }), SDK_PROMPT_TIMEOUT_MS),
          )
        } catch (err) {
          // 同步 prompt 超时：withTimeout abort 只断开了本地 HTTP 连接，serve 端模型仍在生成——
          // 若不清理，后续 SSE 事件（message.completed 等）会继续到达造成状态错乱。
          // 主动 abort 当前会话让 serve 端取消本回合；abort 本身也可能失败（serve 已重启），静默忽略
          if (err instanceof OcError && err.kind === 'network' && err.message.includes('超时')) {
            try {
              await client.session.abort({ path: { id } })
            } catch {
              // serve 可能已死，abort 失败可接受——网络层错误已向上抛出
            }
          }
          throw err
        }
      },
      promptAsync: async (id, text, opts) => {
        const body: { parts: TextPartInput[]; model?: PromptOptions['model']; system?: string; agent?: string; variant?: string } = {
          parts: [{ type: 'text', text }],
        }
        if (opts?.model) body.model = opts.model
        if (opts?.system) body.system = opts.system
        if (opts?.agent) body.agent = opts.agent
        // variant 同 prompt：spec 实测字段，SDK 类型未生成——变量透传绕过类型检查（注释见 prompt）
        if (opts?.variant) body.variant = opts.variant
        // promptAsync 成功返回 204 void（data 为空对象），无需 data 校验
        await withTimeout('发送消息', (signal) => client.session.promptAsync({ path: { id }, body, signal }))
      },
      promptPartsAsync: async (id, parts, opts) => {
        const body: { parts: Array<TextPartInput | FilePartInput>; model?: PromptOptions['model']; system?: string; agent?: string; variant?: string } = {
          parts,
        }
        if (opts?.model) body.model = opts.model
        if (opts?.system) body.system = opts.system
        if (opts?.agent) body.agent = opts.agent
        // variant 同 prompt：spec 实测字段，SDK 类型未生成——变量透传绕过类型检查（注释见 prompt）
        if (opts?.variant) body.variant = opts.variant
        await withTimeout('发送消息', (signal) => client.session.promptAsync({ path: { id }, body, signal }))
      },
      messages: async (id, options) => {
        // before 不在 SDK types.gen 的 SessionMessagesData.query（仅 directory/limit），
        // 但 serve spec 实测支持（分页游标）——用 as never 类型断言绕过类型检查（@hey-api 运行时透传 query）
        const query = options
          ? ({
              ...(options.limit !== undefined ? { limit: options.limit } : {}),
              ...(options.before !== undefined ? { before: options.before } : {}),
            } as never)
          : undefined
        return normalizeError<SessionMessage[]>(await withTimeout('拉取消息', (signal) => client.session.messages({ path: { id }, query, signal })))
      },
    },
    permission: {
      // SDK 1.18.13 顶层方法 postSessionIdPermissionsPermissionId，body 仅 {response}
      // （阶段 0 实测 5.5 曾用裸 fetch {response:"allow", remember:false}——SDK 类型无 remember，
      //  always 即"记住该工具/模式"，无需额外字段）
      respond: async (sessionID, permissionID, response) =>
        normalizeError(
          await withTimeout('权限响应', (signal) =>
            client.postSessionIdPermissionsPermissionId({ path: { id: sessionID, permissionID }, body: { response }, signal }),
          ),
        ),
    },
    file: {
      list: async (path) => normalizeError<FileNode[]>(await withTimeout('文件列表', (signal) => client.file.list({ query: { path }, signal }))),
      read: async (path) => normalizeError<FileContent>(await withTimeout('读取文件', (signal) => client.file.read({ query: { path }, signal }))),
      status: async () => normalizeError<FileStatus[]>(await withTimeout('文件状态', (signal) => client.file.status({ signal }))),
    },
    config: {
      get: async () => normalizeError<Config>(await withTimeout('读取配置', (signal) => client.config.get({ signal }))),
      update: async (config) => normalizeError<Config>(await withTimeout('更新配置', (signal) => client.config.update({ body: config, signal }))),
      providers: async () => normalizeError<ProviderListResponse>(await withTimeout('模型列表', (signal) => client.provider.list({ signal }))),
    },
    capabilities: {
      // 生态清单：/agent + /skill + /mcp + /config 并行拉取，各端点独立容错（任一失败返回空数组，
      // 不让面板因单个端点异常整体不可用——2026-08-11 用户要求 serve 数据源）
      list: async (): Promise<CapabilityBundle> => {
        const authHeader = basicAuthHeader(options.username, options.password)
        const get = async <T>(path: string): Promise<T | undefined> => {
          try {
            const res = await withTimeout(`拉取 ${path}`, (signal) => fetch(`${options.baseURL}${path}`, { headers: { Authorization: authHeader }, signal }))
            if (!res.ok) return undefined
            return (await res.json()) as T
          } catch {
            return undefined
          }
        }
        const [agentsRaw, skillsRaw, mcpRaw, configRaw] = await Promise.all([
          get<Array<Record<string, unknown>>>('/agent'),
          get<Array<Record<string, unknown>>>('/skill'),
          get<Record<string, Record<string, unknown>>>('/mcp'),
          get<Record<string, unknown>>('/config'),
        ])
        const configMcp = configRaw?.mcp as Record<string, Record<string, unknown>> | undefined
        const configPlugins = configRaw?.plugin as Array<string | [string, unknown]> | undefined
        return {
          agents: (agentsRaw ?? []).map((a) => ({
            name: typeof a.name === 'string' ? a.name : '',
            description: typeof a.description === 'string' ? a.description : '',
            mode: typeof a.mode === 'string' ? a.mode : '',
            native: a.native === true,
          })),
          skills: (skillsRaw ?? []).map((s) => ({
            name: typeof s.name === 'string' ? s.name : '',
            description: typeof s.description === 'string' ? s.description : '',
            location: typeof s.location === 'string' ? s.location : '',
          })),
          // 插件数组元素：string（文件路径）或 [name, opts]——名字取路径 basename 去扩展名；
          // npm 包声明（无 file://，如 opencode-acp@latest）去 @版本后缀，面板显示干净包名
          plugins: (configPlugins ?? []).map((entry): CapabilityPlugin => {
            const source = typeof entry === 'string' ? entry : entry[0]
            const cleaned = source.replace(/^file:\/\//, '').replace(/\\/g, '/')
            const base = cleaned.split('/').pop() ?? cleaned
            return { name: base.replace(/\.(ts|js|mjs|cjs)$/i, '').replace(/@(latest|stable|next|beta|dev|\d[\w.-]*)$/, ''), source }
          }),
          // MCP：状态来自 /mcp（运行时真相），type/target 补充自 /config.mcp（local=command / remote=url）
          mcp: Object.entries(mcpRaw ?? {}).map(([name, st]) => {
            const conf = (configMcp?.[name] ?? {}) as { type?: string; command?: unknown; url?: string }
            return {
              name,
              status: typeof st.status === 'string' ? st.status : 'unknown',
              type: conf.type === 'local' || conf.type === 'remote' ? conf.type : '',
              // command 畸形（非数组）时放弃拼接——单条目畸形不能拖垮整组（外层有整组容错，但组内应自愈）
              target: conf.type === 'remote' ? String(conf.url ?? '') : Array.isArray(conf.command) ? (conf.command as string[]).slice(0, 2).join(' ') : '',
            }
          }),
        }
      },
    },
    raw: client,
  }
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
