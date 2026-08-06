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
 */
export function buildPermissionRule(permissionMode: 'default' | 'auto'): Record<string, string> {
  if (permissionMode === 'auto') return { '*': 'allow' }
  const sensitiveTools = ['read', 'edit', 'glob', 'grep', 'bash', 'task', 'lsp', 'external_directory', 'skill']
  return Object.fromEntries(sensitiveTools.map((t) => [t, 'ask']))
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
  // 权限规则按模式生成（受管字段覆盖，用户自定义规则由设置面板二次调整）
  cfg.permission = buildPermissionRule(opts.permissionMode)

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

