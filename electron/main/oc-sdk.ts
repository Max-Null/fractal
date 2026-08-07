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

/** OC serve 客户端聚合（供 server-manager 阶段 4 使用） */
export interface OcClient {
  session: OcSessionClient
  permission: OcPermissionClient
  file: OcFileClient
  config: OcConfigClient
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
        await client.session.create({ query: opts?.cwd ? { directory: opts.cwd } : undefined, body: { title: opts?.title, parentID: opts?.parentID } }),
      ),
      list: async (directory?: string) =>
    // serve 原生支持 GET /session?directory= 按工作区过滤（spec 实测）；未传目录返回全部
    normalizeError<Session[]>(await client.session.list({ query: directory ? { directory } : undefined })),
      get: async (id) => normalizeError<Session>(await client.session.get({ path: { id } })),
      delete: async (id) => normalizeError<boolean>(await client.session.delete({ path: { id } })),
      rename: async (id, title) => normalizeError<Session>(await client.session.update({ path: { id }, body: { title } })),
      fork: async (id, messageID) => normalizeError<Session>(await client.session.fork({ path: { id }, body: messageID ? { messageID } : {} })),
      abort: async (id) => normalizeError<boolean>(await client.session.abort({ path: { id } })),
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
        return normalizeError<SessionMessage>(await client.session.prompt({ path: { id }, body }))
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
        await client.session.promptAsync({ path: { id }, body })
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
        await client.session.promptAsync({ path: { id }, body })
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
        return normalizeError<SessionMessage[]>(await client.session.messages({ path: { id }, query }))
      },
    },
    permission: {
      // SDK 1.18.13 顶层方法 postSessionIdPermissionsPermissionId，body 仅 {response}
      // （阶段 0 实测 5.5 曾用裸 fetch {response:"allow", remember:false}——SDK 类型无 remember，
      //  always 即"记住该工具/模式"，无需额外字段）
      respond: async (sessionID, permissionID, response) =>
        normalizeError(await client.postSessionIdPermissionsPermissionId({ path: { id: sessionID, permissionID }, body: { response } })),
    },
    file: {
      list: async (path) => normalizeError<FileNode[]>(await client.file.list({ query: { path } })),
      read: async (path) => normalizeError<FileContent>(await client.file.read({ query: { path } })),
      status: async () => normalizeError<FileStatus[]>(await client.file.status()),
    },
    config: {
      get: async () => normalizeError<Config>(await client.config.get()),
      update: async (config) => normalizeError<Config>(await client.config.update({ body: config })),
      providers: async () => normalizeError<ProviderListResponse>(await client.provider.list()),
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
