// 预置包管理：oc-plus 全家桶（agents/skills/plugins）随应用预置，首次启动自动初始化
// 阶段 8 实现：幂等拷贝预置到 XDG_CONFIG_HOME 隔离目录 + 字段级 merge 进 opencode.json（D10 预置即写入配置字段）
// 依赖约定：ensureConfig（写 provider/model/permission 受管字段）在 ensurePresetConfig 之后调用——
// 两者都按「读现有 → 写自身字段」merge，顺序无关但均须在 startServer 前完成（serve 启动时加载配置，阶段 0 实测）
import { promises as fsp } from 'node:fs'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getConfigPath, getJsoncPath, SMALL_MODEL, VISION_MODEL, resolveSmallModel } from './oc-config'

/** 预置清单：version 驱动幂等初始化，defaultAgent/instructions 决定 merge 进 opencode.json 的字段 */
export interface PresetManifest {
  version: string
  defaultAgent: string
  instructions: string[]
}

/**
 * 预置包根目录（双路径解析）：
 * - 打包后：electron-builder extraResources → process.resourcesPath/preset/（Electron 主进程存在该属性）
 * - dev/vitest：源码目录 electron/resources/preset
 * 注意：process.resourcesPath 在 dev 下也永远存在（指向 electron dist 的 resources）——用 preset.json 存在性判断，
 * 不能只看 resourcesPath 属性（否则 dev 模式会拿到不存在的 <dist>/resources/preset 导致初始化失败）
 */
export function getDefaultPresetRoot(): string {
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath
  if (resourcesPath && existsSync(join(resourcesPath, 'preset', 'preset.json'))) {
    return join(resourcesPath, 'preset')
  }
  return join(__dirname, '..', '..', 'electron', 'resources', 'preset')
}

/** 目标配置目录：<userDataDir>/config/opencode/（XDG_CONFIG_HOME 隔离目录，D17 定案） */
export function getPresetTarget(userDataDir: string): string {
  return join(userDataDir, 'config', 'opencode')
}

/** 预置指令文件名：内容由 preset.json.instructions 文案运行时生成（OC 的 instructions 字段只认文件路径/URL，不认直接文本） */
export const PRESET_INSTRUCTION_FILE = '分形预置指令.md'

/**
 * 解析预置清单 preset.json。
 * 缺文件/损坏/缺关键字段时抛错——预置资源缺失属于打包缺陷，必须让启动链路暴露而不是静默降级。
 */
export async function readPresetManifest(presetRoot: string): Promise<PresetManifest> {
  const raw = await fsp.readFile(join(presetRoot, 'preset.json'), 'utf-8')
  const manifest = JSON.parse(raw) as Partial<PresetManifest>
  if (!manifest?.version || !manifest?.defaultAgent) {
    throw new Error(
      `预置清单非法：preset.json 缺少 version/defaultAgent（${join(presetRoot, 'preset.json')}）`
    )
  }
  return {
    version: manifest.version,
    defaultAgent: manifest.defaultAgent,
    instructions: Array.isArray(manifest.instructions) ? manifest.instructions : []
  }
}

/**
 * 幂等初始化：拷贝 agents/skills/plugins 到目标配置目录 + 写 .preset-version。
 * 检测 <target>/.preset-version 内容与 preset.json.version 一致 → 已初始化跳过；不一致（首次/版本旧）→ 覆盖拷贝重新初始化。
 * 返回 { initialized, version }，initialized=false 表示本次跳过。
 */
export async function initPreset(
  userDataDir: string,
  presetRoot = getDefaultPresetRoot()
): Promise<{ initialized: boolean; version: string }> {
  const manifest = await readPresetManifest(presetRoot)
  const target = getPresetTarget(userDataDir)
  // 幂等检测：版本标记文件不存在（首次启动）或内容与当前版本不符（应用升级携带新预置）时初始化
  let marker = ''
  try {
    marker = (await fsp.readFile(join(target, '.preset-version'), 'utf-8')).trim()
  } catch {
    // 首次启动：无版本标记文件
  }
  if (marker === manifest.version) {
    return { initialized: false, version: manifest.version }
  }

  await copyDir(join(presetRoot, 'agents'), join(target, 'agents'))
  await copyDir(join(presetRoot, 'skills'), join(target, 'skills'))
  await copyDir(join(presetRoot, 'plugins'), join(target, 'plugins'))
  await fsp.writeFile(join(target, '.preset-version'), manifest.version, 'utf-8')
  return { initialized: true, version: manifest.version }
}

/**
 * 递归拷贝目录：覆盖语义（先删目标再拷，保证预置升级后与包内容一致）。
 * 排除 node_modules/.git——第三方依赖/仓库元数据不属于预置交付物。
 */
async function copyDir(src: string, dest: string): Promise<void> {
  await fsp.rm(dest, { recursive: true, force: true })
  await fsp.mkdir(dest, { recursive: true })
  const entries = await fsp.readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const s = join(src, entry.name)
    const d = join(dest, entry.name)
    if (entry.isDirectory()) await copyDir(s, d)
    else await fsp.copyFile(s, d)
  }
}

/**
 * 读取预置包版本（设置页「关于」三行版本之一；路径解析复用 getDefaultPresetRoot 双路径）。
 * 读不到/损坏 → 返回 '—'（展示兜底，不抛错——版本信息缺失不应影响设置页渲染）。
 */
export async function getPresetVersion(presetRoot = getDefaultPresetRoot()): Promise<string> {
  try {
    const raw = await fsp.readFile(join(presetRoot, 'preset.json'), 'utf-8')
    const manifest = JSON.parse(raw) as Partial<PresetManifest>
    return typeof manifest?.version === 'string' && manifest.version ? manifest.version : '—'
  } catch {
    return '—'
  }
}

/**
 * merge 预置字段进 opencode.json：default_agent / plugin 声明 / instructions 指令文件路径。
 * 不覆盖用户已有配置——三个字段都只补缺：已有值保留，数组项去重追加。
 */
export async function ensurePresetConfig(
  userDataDir: string,
  presetRoot = getDefaultPresetRoot()
): Promise<void> {
  const manifest = await readPresetManifest(presetRoot)
  const target = getPresetTarget(userDataDir)
  const filePath = getConfigPath(userDataDir)
  let cfg: Record<string, unknown> = {}
  try {
    const raw = await fsp.readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      cfg = parsed as Record<string, unknown>
    }
  } catch {
    // 文件不存在或损坏 → 从空配置开始（预置字段首写场景）
    cfg = {}
  }

  // default_agent：仅未设置时写入（merge 不覆盖用户选择）
  if (!cfg.default_agent) {
    cfg.default_agent = manifest.defaultAgent
  }

  // plugin 声明：file:// 绝对路径（对齐用户全局 opencode.json 格式，OC resolvePluginSpec 会规范化加载）；
  // 插件文件不存在（用户手动删除预置插件）则不声明，避免 serve 加载失效路径
  const pluginDecls = await buildPluginDecls(target)
  if (pluginDecls.length > 0) {
    const plugins = Array.isArray(cfg.plugin) ? (cfg.plugin as unknown[]) : []
    for (const decl of pluginDecls) {
      if (!plugins.includes(decl)) plugins.push(decl)
    }
    cfg.plugin = plugins
  }

  // instructions：OC 只把数组元素当文件路径/glob/URL 加载（2026-08-07 源码查证，直接文本会被当 glob 解析后失败）——
  // 预置文案写入指令文件（不存在才写，用户改过则不覆盖），再把文件绝对路径补进 instructions 数组
  if (manifest.instructions.length > 0) {
    const instructionFile = join(target, 'instructions', PRESET_INSTRUCTION_FILE)
    await writePresetInstructionFile(instructionFile, manifest.instructions)
    const instructions = Array.isArray(cfg.instructions) ? (cfg.instructions as unknown[]) : []
    if (!instructions.includes(instructionFile)) instructions.push(instructionFile)
    cfg.instructions = instructions
  }

  await fsp.mkdir(target, { recursive: true })
  const content = JSON.stringify(cfg, null, 2)
  await fsp.writeFile(filePath, content, 'utf-8')
  // 双写 jsonc：serve 候选加载 opencode.jsonc 优先于 opencode.json（首启默认文件），只写 json 会被忽略（2026-08-06 实测）
  await fsp.writeFile(getJsoncPath(userDataDir), content, 'utf-8')

  // 模型槽位替换：HIGH 跟随主模型（cfg.model 由 ensureConfig 联动设置页选择）、LOW 跟随设置页轻量模型、VISION 用 oc-config 常量
  await applyModelAliases(userDataDir, cfg.model)
}

/** 模型槽位：agent 文件 → 对应槽位（HIGH=主模型 / LOW=轻量 / VISION=多模态）；无 model 行的 agent 继承主模型（天然 HIGH）不处理 */
const MODEL_SLOT_RULES: Array<{ agents: string[]; slot: 'high' | 'low' | 'vision' }> = [
  { agents: ['双星.md'], slot: 'high' },
  { agents: ['工匠.md', '参谋.md', '助理.md'], slot: 'low' },
  { agents: ['制图师.md'], slot: 'vision' }
]

/**
 * 按槽位规则替换预置 agents 的 model 字段——模型槽位统一由分形配置管理（2026-08-09 定案）：
 * 预置包内的 agent 来自 oc-plus 部署产物（model 写死），设置页改模型后不跟随；这里每次启动幂等覆盖为目标值。
 * 值解析：high 取 cfg.model（设置页选择经 ensureConfig 写入）；low 取 resolveSmallModel（设置页「轻量模型」选择，
 * 空=跟随主模型 → SMALL_MODEL 兜底）；vision 取 oc-config 常量。
 * 内容一致时不写盘（避免无谓刷盘）；agents 目录缺失/文件损坏 → 跳过不抛错（预置损坏不阻断启动）。
 */
export async function applyModelAliases(
  userDataDir: string,
  highModel?: unknown
): Promise<void> {
  const agentsDir = join(getPresetTarget(userDataDir), 'agents')
  // HIGH 值解析：显式参数优先；缺省时读目标 opencode.json 的 model 字段（ensureConfig 联动设置页选择后写入）——
  // 统一走 cfg.model 的完整 provider/model 格式，避免调用方传短名（deepseek-v4-flash）污染 agents
  let high = typeof highModel === 'string' && highModel ? highModel : ''
  if (!high) {
    try {
      const cfg = JSON.parse(await fsp.readFile(getConfigPath(userDataDir), 'utf-8')) as {
        model?: unknown
      }
      if (typeof cfg?.model === 'string' && cfg.model) high = cfg.model
    } catch {
      // 配置缺失（首次启动 ensureConfig 之前）→ 落到默认值
    }
  }
  if (!high) high = 'deepseek/deepseek-v4-pro'
  // LOW 槽位：设置页「轻量模型」选择优先，空=跟随主模型 → SMALL_MODEL 默认兜底
  // （agent 的 model 行不能为空串——OC 解析空 model 会报错；ensureConfig 场景才允许空=不写 small_model）
  const low = (await resolveSmallModel(userDataDir)) || SMALL_MODEL
  const slotValues: Record<'high' | 'low' | 'vision', string> = {
    high,
    low,
    vision: VISION_MODEL
  }
  try {
    await fsp.access(agentsDir)
  } catch {
    return
  }
  for (const rule of MODEL_SLOT_RULES) {
    for (const name of rule.agents) {
      const file = join(agentsDir, name)
      let raw: string
      try {
        raw = await fsp.readFile(file, 'utf-8')
      } catch {
        // agent 文件不存在（用户删除预置 agent）→ 跳过
        continue
      }
      const value = slotValues[rule.slot]
      // 整行替换 model 字段（agents md 的 model 行顶格无缩进）；值不变时跳过写盘
      const next = raw.replace(/^model:.*$/m, `model: "${value}"`)
      if (next !== raw) await fsp.writeFile(file, next, 'utf-8')
    }
  }
}

/** 预置插件声明：仅声明实际存在的插件文件（防用户删除后 serve 加载失效路径报错） */
async function buildPluginDecls(target: string): Promise<string[]> {
  const pluginsDir = join(target, 'plugins')
  const files = ['fractal-guardian.js', 'agents-priority.ts']
  const decls: string[] = []
  for (const f of files) {
    const abs = join(pluginsDir, f)
    try {
      await fsp.access(abs)
    } catch {
      continue
    }
    // file:// URL 用 pathToFileURL 规范化（自动处理盘符/空格/特殊字符编码）
    decls.push(pathToFileURL(abs).href)
  }
  return decls
}

/** 写预置指令文件：仅首次创建；已存在不覆盖（用户可能自定义过文案），内容一致时不刷盘 */
async function writePresetInstructionFile(file: string, instructionLines: string[]): Promise<void> {
  const content = instructionLines.join('\n\n') + '\n'
  let exists = true
  try {
    await fsp.access(file)
  } catch {
    exists = false
  }
  if (!exists) {
    await fsp.mkdir(dirname(file), { recursive: true })
    await fsp.writeFile(file, content, 'utf-8')
  }
}
