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

  // 受管字段：provider.deepseek 整体覆盖（DeepSeek 为 OC 内置 provider，仅注入 apiKey/baseURL/models）
  // provider id 用 serve 实测值 "deepseek"（阶段 0 fixtures/providers.json：all[].id=deepseek）
  const provider = (cfg.provider as Record<string, unknown> | undefined) ?? {}
  provider.deepseek = {
    options: { apiKey: opts.apiKey, baseURL: 'https://api.deepseek.com/v1' },
    models: MANAGED_MODEL_LIMITS,
  }
  cfg.provider = provider
  // 默认模型：pro（深度）——会话级参数由 ipc.ts 覆盖，此处为 serve 全局默认
  cfg.model = 'deepseek/deepseek-v4-pro'
  // 权限规则按模式生成（受管字段覆盖，用户自定义规则由设置面板二次调整）；
  // userDataDir 注入 settings.json 目录例外（阶段 6：agent 可自检自改配置的前提，方案 3.8.4）
  cfg.permission = buildPermissionRule(opts.permissionMode, userDataDir) as Record<string, unknown>

  // 预置「双星」agent：D15 预置包的最小占位定义（阶段 8 用完整 oc-plus 定义替换）。
  // 必要性：serve 找不到 agent 时 promptAsync 会 400，而分形默认 currentAgent=双星（用户首次发消息即触发）。
  // merge 保留用户已有 agent 定义，仅补缺。
  const agents = (cfg.agent as Record<string, unknown> | undefined) ?? {}
  if (!agents['双星']) {
    agents['双星'] = {
      description: '分形默认主 agent：研究→综合→实现→验证四阶段协作',
      mode: 'primary',
      prompt:
        '你是分形（Fractal）的主 agent「双星」。遵循四阶段工作法：阶段 1 研究（探索代码、并行调研）、阶段 2 综合（制定规格并持久化）、阶段 3 实现（按规格编码自测）、阶段 4 验证（亲自审查 diff、跑全量测试）。动手前先输出「###思考结论」与用户对齐。',
    }
  }
  cfg.agent = agents

  await fsp.mkdir(join(userDataDir, 'config', 'opencode'), { recursive: true })
  const content = JSON.stringify(cfg, null, 2)
  await fsp.writeFile(filePath, content, 'utf-8')
  // 双写 jsonc：serve 候选加载 opencode.jsonc 优先于 opencode.json（首启默认文件），只写 json 会被忽略（2026-08-06 实测）
  await fsp.writeFile(getJsoncPath(userDataDir), content, 'utf-8')
}

