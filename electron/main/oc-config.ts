// OC 配置读写：对齐 opencode 的配置文件结构（类 VSCode settings.json）
// 阶段 4 实现：读取/写入分形独立配置目录（D17 定案）下的 opencode.json，
// 支撑 agent 自检自改配置。merge 策略：受管字段（provider.deepseek / model / permission）覆盖写，
// 用户其他字段（agent/plugins/ui 等）原样保留。
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'

/** 受管 provider 配置（provider.deepseek 整体覆盖） */
export interface EnsureConfigOptions {
  /** DeepSeek API Key（serve 自动读配置 provider.deepseek.options.apiKey，无需 env——阶段 0 实测） */
  apiKey: string
  /** 权限模式：default → 敏感工具 ask；auto → 全部 allow */
  permissionMode: 'default' | 'auto'
}

/** DeepSeek 模型上下文限制（对应 opencode.json provider.deepseek.models，规格 D16 模型固定） */
export const MANAGED_MODEL_LIMITS: Record<string, { context: number; output: number }> = {
  'deepseek-v4-flash': { context: 1000000, output: 131072 },
  'deepseek-v4-pro': { context: 1000000, output: 131072 },
}

/**
 * 默认小模型（轻量任务专用：标题生成/会话摘要/输入消息润色）。
 * OC 语义：small_model 未配置 → Provider.getSmallModel 解析失败 → ensureTitle 静默失败（oc 已知 #14807，标题永远「新会话」）。
 * 默认值兜底——设置页「轻量模型」下拉显式选择后经 resolveSmallModel 覆盖（LOW 槽位统一）。
 */
export const SMALL_MODEL = 'deepseek/deepseek-v4-flash'

/**
 * 解析轻量任务模型（LOW 槽位）：读设置页写入 settings.json 的 smallModel 字段。
 * - settings.json 不存在 / JSON.parse 失败 → SMALL_MODEL 常量（标题生成等轻量任务不能断，兜底）
 * - smallModel 字段缺失 → SMALL_MODEL 常量（无用户意图，用默认小模型）
 * - smallModel = '' → 返回 ''（用户显式选「跟随主模型」，ensureConfig 据此不写 small_model 字段）
 * - smallModel = 显式模型全名（deepseek/deepseek-v4-flash | pro）→ 该值
 * 不 import settings 模块：settings.ts 依赖 oc-config（ensureConfig 联动），反向 import 会循环依赖；
 * 分形自己写的 settings.json 是纯 JSON（非 JSONC），直接 fsp.readFile + JSON.parse 即可。
 */
export async function resolveSmallModel(userDataDir: string): Promise<string> {
  let raw: string
  try {
    raw = await fsp.readFile(join(userDataDir, 'settings.json'), 'utf-8')
  } catch {
    // 文件不存在 → 从未配置过 → 默认小模型
    return SMALL_MODEL
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const value = parsed?.smallModel
    // 字段缺失 → 默认小模型；显式字符串（含 '' 跟随主模型）原样返回——'' 由 ensureConfig 判定不写
    return typeof value === 'string' ? value : SMALL_MODEL
  } catch {
    // 文件损坏 → 默认小模型（解析失败不阻断配置写入）
    return SMALL_MODEL
  }
}

/**
 * 多模态模型（VISION 槽位）：制图师等图像能力 agent 专用
 * models.dev 内置 provider（id=moonshotai-cn），无 key 时 provider 定义仍写（models 定义使 serve 可识别），
 * 用户填 key 后 options.apiKey 非空即通——key 空只缺鉴权，provider 不缺失（2026-08-09 多模态接入）
 */
export const VISION_MODEL = 'moonshotai-cn/kimi-k3'

/**
 * Anthropic 兼容端点模型（ANTHROPIC 槽位）：侦查兵专用
 * ds-anthropic provider 复用 deepseek 账户（同一 apiKey），自带 web_search 工具（2026-08-09 同步 oc-plus）
 */
export const ANTHROPIC_MODEL = 'ds-anthropic/deepseek-v4-flash'

/**
 * 多模态 provider 的受管 models 定义（对应 opencode.json provider['moonshotai-cn'].models）：
 * kimi-k3 为 models.dev 内置模型，仅显式 reasoningEffort=low（对齐用户全局配置参考，无 key 也写）
 */
export const KIMI_MODEL_LIMITS: Record<string, { options: { reasoningEffort: string } }> = {
  'kimi-k3': { options: { reasoningEffort: 'low' } },
}

/**
 * 分形受管配置路径：<userDataDir>/config/opencode/opencode.json
 * XDG_CONFIG_HOME 注入为 <userDataDir>/config 后，serve 全局配置路径即此文件（阶段 0 D17 实测定案）。
 */
export function getConfigPath(userDataDir: string): string {
  return join(userDataDir, 'config', 'opencode', 'opencode.json')
}

/**
 * serve 实际加载的全局配置文件：opencode.jsonc（serve 首启自动创建，候选加载优先于 opencode.json——2026-08-06 实测）。
 * ensureConfig 双写两个文件名，保证 serve 无论如何加载的都是分形受管配置。
 */
export function getJsoncPath(userDataDir: string): string {
  return join(userDataDir, 'config', 'opencode', 'opencode.jsonc')
}

/**
 * 按权限模式生成顶层 permission 规则（OC 权限模型 v1.18.x，v1.12 修正：工具级 allow/ask/deny）。
 * default：敏感工具 ask（read/edit/glob/grep/bash/task/lsp/external_directory/skill），
 * 贴合 OC 默认哲学（关键项询问，非一刀切全部询问）；auto：全放行。
 * userDataDir（阶段 6 配置体系）：agent 改 settings.json 的前提——read/edit/write/glob/grep/external_directory
 * 对 userData 目录放行。对象语法（{"*": "ask", "<path>/*": "allow"}）表达「目录例外」；
 * 通配符最后匹配生效，catch-all "*" 必须放前面（v1.18.x 配置 schema 文档）。
 */
export function buildPermissionRule(permissionMode: 'default' | 'auto', userDataDir?: string): Record<string, unknown> {
  if (permissionMode === 'auto') return { '*': 'allow' }
  const sensitiveTools = ['read', 'edit', 'glob', 'grep', 'bash', 'task', 'lsp', 'external_directory', 'skill']
  if (!userDataDir) {
    return Object.fromEntries(sensitiveTools.map((t) => [t, 'ask']))
  }
  // 精确到 settings.json 文件而非整个 userData 目录——目录通配会暴露 provider-configs.json（API Key 明文）
  // Windows 路径分隔符不确定（\ 或 /），两条规则都加，保证 OC 内部路径匹配命中
  const settingsJsonPath = join(userDataDir, 'settings.json')
  const allowPatterns = [settingsJsonPath, settingsJsonPath.replace(/\\/g, '/')]
  // 对象语法：catch-all ask 在前，settings.json 文件 allow 在后（最后匹配生效）
  const withFileAllow = (): Record<string, string> => ({ '*': 'ask', ...Object.fromEntries(allowPatterns.map((p) => [p, 'allow'])) })
  const rule: Record<string, unknown> = {
    read: withFileAllow(),
    edit: withFileAllow(),
    write: withFileAllow(),
    // glob/grep 是目录扫描，单文件 allow 无意义——保持 ask（agent grep settings.json 需审批）
    glob: 'ask',
    grep: 'ask',
    // bash/task/lsp/skill 保持字符串 ask（无目录维度，对象语法无意义）
    bash: 'ask',
    task: 'ask',
    lsp: 'ask',
    skill: 'ask',
    // external_directory 默认 ask——对 settings.json 文件放行后 agent 才能自由读写（方案 3.8.4 权限预置）
    external_directory: withFileAllow(),
  }
  return rule
}

/**
 * 读分形受管 provider 配置（provider-configs.json）：返回全部条目（deepseek / moonshotai-cn）。
 * 不存在/损坏 → 空对象（首次启动）；老文件只有 deepseek 条目时 moonshotai-cn 返回 undefined（容错）。
 * ensureConfig 双 provider 写入依赖此文件（GUI 保存 API Key 的落盘点），deepseek 的 key 仍以 opts.apiKey 为准
 * （向后兼容：调用方显式传入的 key 覆盖文件值，见 ipc saveProviderConfig 注释）。
 */
async function readProviderConfigs(userDataDir: string): Promise<Record<string, { apiKey?: string }>> {
  try {
    const raw = await fsp.readFile(join(userDataDir, 'provider-configs.json'), 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, { apiKey?: string }>
    }
  } catch {
    // 文件不存在（首次启动/未保存过设置）→ 空条目
  }
  return {}
}

/**
 * 确保分形独立配置目录下的 opencode.json 存在并含受管字段。
 * merge 不覆盖用户其他字段：读已有文件（无则 {}）→ 写受管字段 → 格式化 2 空格写回。
 */
export async function ensureConfig(userDataDir: string, opts: EnsureConfigOptions): Promise<void> {
  const filePath = getConfigPath(userDataDir)
  let cfg: Record<string, unknown> = {}
  try {
    const raw = await fsp.readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      cfg = parsed as Record<string, unknown>
    }
  } catch {
    // 文件不存在或损坏 → 从空配置开始（首次启动场景，原配置不可恢复则重建受管字段）
    cfg = {}
  }

  // 受管字段：provider 整体覆盖（DeepSeek 为 OC 内置 provider，仅注入 apiKey/baseURL/models；
  // moonshotai-cn 为 models.dev 内置多模态 provider，key 空也写 models 定义——provider 可被识别，填 key 即通）
  const savedProviders = await readProviderConfigs(userDataDir)
  const provider = (cfg.provider as Record<string, unknown> | undefined) ?? {}
  // provider id 用 serve 实测值 "deepseek"（阶段 0 fixtures/providers.json：all[].id=deepseek）
  provider.deepseek = {
    options: { apiKey: opts.apiKey, baseURL: 'https://api.deepseek.com/v1' },
    models: MANAGED_MODEL_LIMITS,
  }
  // moonshotai-cn：key 从 provider-configs.json 读（saveProviderConfig 落盘点）；models 定义恒写
  // 对齐用户全局配置参考：{ "moonshotai-cn": { "models": { "kimi-k3": { "options": { "reasoningEffort": "low" } } } } }
  provider['moonshotai-cn'] = {
    models: KIMI_MODEL_LIMITS,
    options: { apiKey: savedProviders['moonshotai-cn']?.apiKey ?? '' },
  }
  // ds-anthropic：侦查兵专用（Anthropic 兼容端点自带 web_search 工具，2026-08-09 同步 oc-plus）
  // baseURL 指向 Anthropic 兼容端点；key 复用 deepseek（同一账户）；models 同 deepseek 定义（flash/pro）
  provider['ds-anthropic'] = {
    options: { apiKey: opts.apiKey, baseURL: 'https://api.deepseek.com/anthropic' },
    models: MANAGED_MODEL_LIMITS,
  }
  cfg.provider = provider
  // 默认模型：pro（深度）——会话级参数由 ipc.ts 覆盖，此处为 serve 全局默认
  cfg.model = 'deepseek/deepseek-v4-pro'
  // small_model：轻量任务模型（标题生成等）——跟随设置页「轻量模型」下拉选择（LOW 槽位统一）。
  // 空值 = 用户选「跟随主模型」：不写 small_model 字段，OC 用主模型兜底（同时删除旧值防上次显式选择残留）
  const smallModel = await resolveSmallModel(userDataDir)
  if (smallModel) {
    cfg.small_model = smallModel
  } else {
    delete cfg.small_model
  }
  // 权限规则按模式生成（受管字段覆盖，用户自定义规则由设置面板二次调整）；
  // userDataDir 注入 settings.json 目录例外（阶段 6：agent 可自检自改配置的前提，方案 3.8.4）
  cfg.permission = buildPermissionRule(opts.permissionMode, userDataDir) as Record<string, unknown>

  // 预置 agent 由 preset 包 agents/*.md 提供（阶段 8），ensureConfig 不再写内联占位——
  // 原因：config.agent.双星 与 agents/双星.md 同名会被 OC 双层配置 merge，占位定义会污染完整 md 定义（行为不确定）。
  // default_agent 由 ensurePresetConfig 写入，serve 找不到 agent 的 400 问题由预置 md 本身解决。

  await fsp.mkdir(join(userDataDir, 'config', 'opencode'), { recursive: true })
  const content = JSON.stringify(cfg, null, 2)
  await fsp.writeFile(filePath, content, 'utf-8')
  // 双写 jsonc：serve 候选加载 opencode.jsonc 优先于 opencode.json（首启默认文件），只写 json 会被忽略（2026-08-06 实测）
  await fsp.writeFile(getJsoncPath(userDataDir), content, 'utf-8')
}

