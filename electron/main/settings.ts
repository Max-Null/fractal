// 应用配置体系：类 VSCode settings.json（JSONC 可注释）+ schema 校验 + 文件监听（方案 3.8）
// 配置分层：第 1 层内置默认值（本文件 DEFAULT_SETTINGS，只读）/ 第 2 层用户 settings.json / 第 3 层密钥（API Key 隔离，不进本文件）
// 生效机制：GUI 表单、JSONC 编辑器、agent 工具三条路径统一走文件 → fs.watch 监听 → 校验 → config-changed 广播（方案 3.8.3 流程图）
// 引擎联动：deepseek.model / agent.permissionMode / agent.effort 变更 → ensureConfig 增量同步 opencode.json（不重启 serve，下次会话生效）
import { promises as fsp, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser'
import Ajv from 'ajv'
import type { BrowserWindow } from 'electron'
import { ensureConfig } from './oc-config'
import settingsSchema from './settings.schema.json'

// ── 默认值表（方案 3.8.2 字段全集；与 settings.schema.json 的 default 保持一致）──
export const DEFAULT_SETTINGS: Record<string, unknown> = {
  'ui.theme': 'dark',
  'ui.language': 'zh',
  'ui.messageLayout': 'split',
  'ui.nickname': '',
  'ui.avatar': '',
  'deepseek.model': 'deepseek-v4-flash',
  'agent.permissionMode': 'default',
  'agent.effort': 'high',
  'agent.contextLimit': 0,
  'preset.skills.enabled': true,
  'preset.mcp.filesystem': true,
  'engine.opencodePath': '',
  'engine.logLevel': 'INFO',
  // 会话数据隔离：shared=共享系统 XDG_DATA_HOME（与其他工具同库）/ isolated=独立到 <userData>/data
  // （serve 数据目录跟随 XDG_DATA_HOME；startServer 注入 env 时读此值，见 server-manager.ts）
  'dataMode': 'shared',
  // 待办记录保留轮数：每个会话保留最近 N 轮完成快照（记录卡展示上限；1-100，前端高级设置可改）
  'todos.maxSnapshotsPerSession': 20,
}

/** 引擎相关 key：变更时同步 opencode.json（其余纯 UI 项不触碰引擎配置） */
const ENGINE_KEYS = ['deepseek.model', 'agent.permissionMode', 'agent.effort'] as const

// ── 内存状态（getConfig 直接返回；load/save/watch 时更新）──
let currentJsoncText = JSON.stringify(DEFAULT_SETTINGS, null, 2)
let currentConfig: Record<string, unknown> = { ...DEFAULT_SETTINGS }
let currentWarnings: string[] = []
/** 是否已从磁盘加载过（watchSettingsFile 启动加载或 loadSettings 显式调用）——settings:getConfig 首次调用判断 */
let configLoaded = false
/** 磁盘上的 settings.json 是否真实存在（首次启动不存在 → 默认值兜底；前端据此区分「默认态」与「显式配置」） */
let diskFileExists = false

/** 引擎字段快照：判断引擎相关项是否真的变化（避免 ui.theme 变更也写 opencode.json）
 * 传入 config 可能只含文件显式字段——缺失引擎字段按 DEFAULT 计（用户未写 = 默认值 = 无变化） */
function engineSnapshot(config: Record<string, unknown>): string {
  const full = { ...DEFAULT_SETTINGS, ...config }
  return ENGINE_KEYS.map((k) => `${k}=${JSON.stringify(full[k])}`).join('|')
}
let lastEngineSnapshot = engineSnapshot(currentConfig)

/** 变更监听器（watchSettings 注册；saveSettings 主动广播，fs.watch 回调也广播） */
type ConfigChangedPayload = { config: Record<string, unknown>; warnings: string[]; exists: boolean }
const configListeners: Array<(payload: ConfigChangedPayload) => void> = []

function emitConfigChanged(config: Record<string, unknown>, warnings: string[]): void {
  for (const fn of configListeners) {
    try {
      fn({ config, warnings, exists: diskFileExists })
    } catch (err) {
      // 单个监听器异常不阻断其余监听（防止前端回调炸掉主进程事件链）
      console.error('[settings] config-changed 监听器执行失败：', err)
    }
  }
}

// ── schema 校验（ajv 单例编译一次复用）──

let _validator: Ajv.ValidateFunction | null = null
function getValidator(): Ajv.ValidateFunction {
  if (!_validator) {
    // ajv v6 默认非严格（未知关键字 default 等直接忽略）；allErrors 收集全部字段错误（逐字段回退提示）
    const ajv = new Ajv({ allErrors: true })
    _validator = ajv.compile(settingsSchema as object)
  }
  return _validator
}

/** 从 ajv 错误 schemaPath（JSON pointer，如 "#/properties/ui.theme/enum"）提取字段名 */
function errorKey(schemaPath: string): string {
  const m = schemaPath.match(/^#\/properties\/([^/]+)/)
  return m ? m[1] : ''
}

/**
 * 解析 JSONC 文本 + schema 校验 → {config, warnings}。
 * 纯函数（无文件/状态依赖），供 loadSettings / saveSettings / 监听回调共用，单测直接覆盖。
 * 规则：未知 key 忽略（向前兼容）；语法错误/非法值回退默认并记录 warning（方案 3.8.2）。
 */
export function parseAndValidate(jsoncText: string): { config: Record<string, unknown>; warnings: string[] } {
  const warnings: string[] = []
  const errors: ParseError[] = []
  const parsed = parse(jsoncText, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length > 0) {
    // 语法错误（如少括号/逗号）→ 返回空配置（不覆盖现有表单值），warning 提示用户修复
    warnings.push(`settings.json 语法错误：${printParseErrorCode(errors[0].error)}（偏移 ${errors[0].offset}），配置未生效`)
    return { config: {}, warnings }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warnings.push('settings.json 顶层必须是 JSON 对象，配置未生效')
    return { config: {}, warnings }
  }

  const raw = parsed as Record<string, unknown>
  // 只含文件显式写入的已知字段——缺失字段不注入默认（避免 DEFAULT 覆盖表单值，如 theme=system）
  const config: Record<string, unknown> = {}
  // 仅校验已知字段（未知 key 直接忽略，additionalProperties: true 语义与 schema 一致）
  const known: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key in DEFAULT_SETTINGS) known[key] = value
  }
  const valid = getValidator()(known) as boolean
  if (!valid) {
    // 非法字段集合（同一字段可能多条错误）：回退默认 + warning
    // 注意：ajv v6 的 dataPath 是 JS 表达式格式（含点属性如 "['ui.theme']"），不可靠——用 schemaPath（JSON pointer）提取
    const badKeys = new Set<string>((getValidator().errors ?? []).map((e) => errorKey(e.schemaPath)).filter((k) => k in DEFAULT_SETTINGS))
    for (const key of badKeys) {
      warnings.push(`${key} 非法值 ${JSON.stringify(raw[key])}，已回退默认 ${JSON.stringify(DEFAULT_SETTINGS[key])}`)
    }
  }
  for (const [key, value] of Object.entries(known)) {
    // 合法字段写入；非法字段回退该字段默认值（warning 已记录）
    if (!warnings.some((w) => w.startsWith(key + ' 非法值'))) config[key] = value
    else config[key] = DEFAULT_SETTINGS[key]
  }
  return { config, warnings }
}

// ── 路径 ──

/** settings.json 路径：<userDataDir>/settings.json（Windows %APPDATA%/oc-gui/settings.json） */
export function getSettingsPath(userDataDir: string): string {
  return join(userDataDir, 'settings.json')
}

// ── 读写 ──

/**
 * 从磁盘加载 settings.json（JSONC 解析 + 校验），同步内存态。
 * 文件不存在/不可读 → 默认值（监听失败场景兜底，方案 3.8.3）。
 */
export async function loadSettings(userDataDir: string): Promise<{ config: Record<string, unknown>; warnings: string[]; jsoncText: string }> {
  try {
    const raw = await fsp.readFile(getSettingsPath(userDataDir), 'utf-8')
    const { config, warnings } = parseAndValidate(raw)
    currentJsoncText = raw
    currentConfig = config
    currentWarnings = warnings
    configLoaded = true
    diskFileExists = true
    // 同步引擎快照：加载后引擎字段即「当前生效值」，后续 saveSettings 以此为准判断是否触发联动
    lastEngineSnapshot = engineSnapshot(config)
    return { config, warnings, jsoncText: raw }
  } catch (err) {
    // 文件不存在（首次启动）或读取失败 → 默认值；读取失败记录上下文便于排查
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[settings] 读取 ${getSettingsPath(userDataDir)} 失败，使用默认配置：`, err)
    }
    currentJsoncText = JSON.stringify(DEFAULT_SETTINGS, null, 2)
    currentConfig = { ...DEFAULT_SETTINGS }
    currentWarnings = []
    // 文件不存在（首次启动）→ 默认态：前端不应把默认值当显式配置（主题持久化依赖此区分）
    diskFileExists = false
    // 重置引擎快照：默认配置即「当前生效值」（防止上一个文件残留的快照导致误触发联动）
    lastEngineSnapshot = engineSnapshot(currentConfig)
    return { config: currentConfig, warnings: [], jsoncText: currentJsoncText }
  }
}

/** 获取内存态配置（同步；未加载过则返回默认值）——settings:getConfig 通道与前端编辑器共用 */
export function getConfig(): { config: Record<string, unknown>; warnings: string[]; jsoncText: string } {
  return { config: currentConfig, warnings: currentWarnings, jsoncText: currentJsoncText }
}

/** 是否已从磁盘加载过配置（getConfig 首次调用前用于决定是否先 loadSettings） */
export function isSettingsLoaded(): boolean {
  return configLoaded
}

/** settings.json 文件是否真实存在于磁盘（前端区分默认态与显式配置，主题持久化的前提） */
export function getSettingsFileExists(): boolean {
  return diskFileExists
}

/** settings.schema.json 内容——settings:getSchema 通道（编辑器提示用） */
export function getSchema(): Record<string, unknown> {
  return settingsSchema as unknown as Record<string, unknown>
}

/**
 * 保存 settings.json：写盘 + 解析校验 + 引擎联动 + 广播。
 * 写盘本身会触发 fs.watch 回调（300ms 防抖后二次广播）——广播幂等，前端 store 合并无副作用；
 * 主动广播保证监听未启动/防抖窗口内保存也能立即生效（JSONC 编辑器保存场景）。
 */
export async function saveSettings(userDataDir: string, jsoncText: string): Promise<{ ok: boolean; warnings: string[] }> {
  const { config, warnings } = parseAndValidate(jsoncText)
  await fsp.mkdir(userDataDir, { recursive: true })
  await fsp.writeFile(getSettingsPath(userDataDir), jsoncText, 'utf-8')
  currentJsoncText = jsoncText
  currentConfig = config
  currentWarnings = warnings
  diskFileExists = true
  emitConfigChanged(config, warnings)
  await syncEngineConfig(userDataDir, config)
  return { ok: true, warnings }
}

/**
 * 引擎联动：settings.json 引擎相关项 → ensureConfig 增量同步 opencode.json（复用 oc-config.ts 的 merge 逻辑）。
 * 不重启 serve——模型/权限变更影响新会话，已在运行会话不受干扰（方案 3.8.3）。
 */
async function syncEngineConfig(userDataDir: string, config: Record<string, unknown>): Promise<void> {
  // 引擎字段未变化 → 跳过（ui.theme 等纯 UI 项不应触发 opencode.json 写盘）
  const snapshot = engineSnapshot(config)
  if (snapshot === lastEngineSnapshot) return
  lastEngineSnapshot = snapshot
  // settings.json 不含密钥（第 3 层隔离）——从 provider-configs.json 读当前 key；无 key 也写受管字段（model/双星 agent 定义）
  let apiKey = ''
  try {
    const raw = await fsp.readFile(join(userDataDir, 'provider-configs.json'), 'utf-8')
    const saved = JSON.parse(raw) as Record<string, { apiKey?: string }>
    apiKey = (saved?.deepseek?.apiKey ?? '').trim()
  } catch {
    // provider-configs.json 不存在（首次启动/未保存过 key）→ 空 key，仅同步 model/agent 定义
  }
  await ensureConfig(userDataDir, { apiKey, permissionMode: toOcPermissionMode(config['agent.permissionMode']) })
}

/**
 * settings.json 四值权限模式 → oc-config 两值。
 * default/acceptEdits/plan 归为 default（敏感工具 ask 的安全集）：acceptEdits 的「编辑自动接受」
 * 由 OC 工具级规则承载（阶段 8 细化），plan 的只读约束由双星 agent 定义承载；auto 全放行。
 */
function toOcPermissionMode(mode: unknown): 'default' | 'auto' {
  return mode === 'auto' ? 'auto' : 'default'
}

// ── 文件监听 ──

/**
 * 监听 settings.json 变更：解析+校验 → 广播 config-changed → 引擎联动。
 * 目录级监听（而非文件级）：首次启动 settings.json 可能不存在，文件级 fs.watch 会 ENOENT 失败，
 * 监听 userDataDir 目录可捕获「agent 首次创建 settings.json」的场景（方案 3.8.4 闭环前提）。
 * 防抖 300ms：JSONC 编辑器保存是整文件写（一次保存可能触发多次 fs.watch 回调）；
 * 监听失败 → 保持默认值（loadSettings 已初始化内存态），等待下次 saveSettings 写盘后恢复。
 */
export function watchSettingsFile(userDataDir: string, onChanged: (payload: ConfigChangedPayload) => void): () => void {
  configListeners.push(onChanged)
  // 初始化内存态：启动即加载磁盘当前值（否则 getConfig 首次返回默认值，直到文件首次变更）
  // loadSettings 内部 catch 兜底（文件不存在 → 默认值），不会抛
  void loadSettings(userDataDir)
  let timer: ReturnType<typeof setTimeout> | null = null
  let watcher: FSWatcher | null = null
  try {
    watcher = watch(userDataDir, { encoding: 'utf-8' }, (_eventType, filename) => {
      // 目录级监听会收到目录内所有文件事件——只处理 settings.json（provider-configs.json 等其他文件不触发 reload）
      // filename 为 null（部分平台事件不带文件名）时保守触发，交给防抖合并
      if (filename !== null && filename !== 'settings.json') return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        void (async () => {
          const { config, warnings } = await loadSettings(userDataDir)
          emitConfigChanged(config, warnings)
          await syncEngineConfig(userDataDir, config)
        })()
      }, 300)
    })
  } catch (err) {
    // 目录不可监听（罕见）→ 默认值兜底（方案 3.8.3「监听失败 → 用默认值」）；其他错误记录上下文
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[settings] 监听 ${userDataDir} 失败：`, err)
    }
  }
  return () => {
    if (timer) clearTimeout(timer)
    watcher?.close()
    const idx = configListeners.indexOf(onChanged)
    if (idx >= 0) configListeners.splice(idx, 1)
  }
}

/** 主窗口版监听：变更 → webContents.send('config-changed', {config, warnings})；窗口关闭自动解绑 */
export function watchSettings(win: BrowserWindow, userDataDir: string): () => void {
  return watchSettingsFile(userDataDir, (payload) => {
    if (!win.isDestroyed()) win.webContents.send('config-changed', payload)
  })
}
