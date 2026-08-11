// 预置包管理：oc-plus 全家桶（agents/skills/plugins）随应用预置，首次启动自动初始化
// 阶段 8 实现：幂等拷贝预置到 XDG_CONFIG_HOME 隔离目录 + 字段级 merge 进 opencode.json（D10 预置即写入配置字段）
// 依赖约定：ensureConfig（写 provider/model/permission 受管字段）在 ensurePresetConfig 之后调用——
// 两者都按「读现有 → 写自身字段」merge，顺序无关但均须在 startServer 前完成（serve 启动时加载配置，阶段 0 实测）
import { promises as fsp } from 'node:fs'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getConfigPath, getJsoncPath, SMALL_MODEL, VISION_MODEL, ANTHROPIC_MODEL, resolveSmallModel } from './oc-config'
import { parseAndValidate } from './settings'

/** 预置清单：version 驱动幂等初始化，defaultAgent/instructions 决定 merge 进 opencode.json 的字段，mcp 为预置 MCP 清单 */
export interface PresetManifest {
  version: string
  defaultAgent: string
  instructions: string[]
  mcp?: Record<string, unknown>
}

/** 模型槽位：agent → 槽位映射（high=主模型 / low=轻量 / vision=多模态 / anthropic=Anthropic 兼容 / inherit=继承主模型） */
export type ModelSlot = 'high' | 'low' | 'vision' | 'anthropic' | 'inherit'

/** 契约清单条目：manifest 中单个 agent 的槽位声明 */
export interface AgentManifestEntry {
  file: string
  slot: ModelSlot
}

/** 契约清单（oc-plus sync-to-fractal.mjs 生成）：agent 槽位声明 + 来源信息 */
export interface AgentsManifest {
  version: string
  sourceCommit: string
  generatedAt: string
  agents: AgentManifestEntry[]
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
    instructions: Array.isArray(manifest.instructions) ? manifest.instructions : [],
    // mcp 段可选（旧预置包无此字段——解析到对象才保留，否则空对象）
    mcp: manifest.mcp && typeof manifest.mcp === 'object' && !Array.isArray(manifest.mcp) ? (manifest.mcp as Record<string, unknown>) : undefined,
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
  // B1 预置技能包开关：每次启动同步（不依赖 .preset-version——开关变化无版本升级也会生效）
  const skillsEnabled = await readSkillsEnabled(userDataDir)
  // 幂等检测：版本标记文件不存在（首次启动）或内容与当前版本不符（应用升级携带新预置）时初始化
  let marker = ''
  try {
    marker = (await fsp.readFile(join(target, '.preset-version'), 'utf-8')).trim()
  } catch {
    // 首次启动：无版本标记文件
  }
  if (marker === manifest.version) {
    await syncPresetSkills(userDataDir, presetRoot, skillsEnabled)
    return { initialized: false, version: manifest.version }
  }

  await copyDir(join(presetRoot, 'agents'), join(target, 'agents'), true)
  // 开关关闭时跳过 skills 拷贝（首次初始化即不交付预置技能）
  if (skillsEnabled) await copyDir(join(presetRoot, 'skills'), join(target, 'skills'))
  await copyDir(join(presetRoot, 'plugins'), join(target, 'plugins'))
  await fsp.writeFile(join(target, '.preset-version'), manifest.version, 'utf-8')
  // 兜底同步：开关开启但 skills 缺失（上次关闭时被删）→ 补拷；关闭 → 删除预置技能
  await syncPresetSkills(userDataDir, presetRoot, skillsEnabled)
  return { initialized: true, version: manifest.version }
}

/**
 * 预置技能包开关（B1：preset.skills.enabled）：读 settings.json（JSONC 解析，纯函数无内存副作用）。
 * 缺失/解析失败 → true（默认开启，与 DEFAULT_SETTINGS 一致；配置损坏不阻断预置初始化）。
 */
async function readSkillsEnabled(userDataDir: string): Promise<boolean> {
  try {
    const raw = await fsp.readFile(join(userDataDir, 'settings.json'), 'utf-8')
    const { config } = parseAndValidate(raw)
    return config['preset.skills.enabled'] !== false
  } catch {
    return true
  }
}

/**
 * 预置技能目录同步（B1）：每次启动执行，不依赖 .preset-version 幂等标记。
 *  - 关闭：删除 target/skills 下「预置清单内的」技能子目录——按名精准删，用户自定义技能保留（skills 目录与用户共享）
 *  - 开启：补拷缺失的预置技能子目录（上次关闭时被删的恢复；已存在=跳过，不覆盖用户修改）
 */
async function syncPresetSkills(userDataDir: string, presetRoot: string, skillsEnabled: boolean): Promise<void> {
  const target = getPresetTarget(userDataDir)
  let presetSkillNames: string[] = []
  try {
    presetSkillNames = (await fsp.readdir(join(presetRoot, 'skills'))).filter((n) => n !== 'node_modules' && n !== '.git')
  } catch {
    return // 预置包无 skills 目录 → 无需同步
  }
  for (const name of presetSkillNames) {
    const dest = join(target, 'skills', name)
    if (!skillsEnabled) {
      await fsp.rm(dest, { recursive: true, force: true })
      continue
    }
    try {
      await fsp.access(dest)
    } catch {
      // 缺失 → 补拷（上次开关关闭时被删）
      await copyDir(join(presetRoot, 'skills', name), dest)
    }
  }
}

/**
 * 递归拷贝目录：覆盖语义（先删目标再拷，保证预置升级后与包内容一致）。
 * 排除 node_modules/.git——第三方依赖/仓库元数据不属于预置交付物。
 * preserveUserEdits=true（agents 用）：不删目录，逐文件 mtime 保护——目标比源新 = 用户/设置页改过 → 跳过覆盖。
 * 真相源原则（2026-08-09 oc-plus 查证）：.md 文件是 agent 模型配置的真相源，预置升级不得冲掉 GUI 已改的文件。
 */
async function copyDir(src: string, dest: string, preserveUserEdits = false): Promise<void> {
  // 非保护模式：先删目标保证与包内容一致（预置移除的文件也删除）；保护模式不删（用户文件可能比预置多）
  if (!preserveUserEdits) {
    await fsp.rm(dest, { recursive: true, force: true })
  }
  await fsp.mkdir(dest, { recursive: true })
  const entries = await fsp.readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const s = join(src, entry.name)
    const d = join(dest, entry.name)
    if (entry.isDirectory()) await copyDir(s, d, preserveUserEdits)
    else if (preserveUserEdits) {
      // 目标比源新 = 用户改过 → 跳过；目标缺失或比源旧 → 正常复制（预置更新生效）
      try {
        const [ss, ds] = await Promise.all([fsp.stat(s), fsp.stat(d)])
        if (ds.mtimeMs > ss.mtimeMs) continue
      } catch {
        /* 目标不存在 → 走复制 */
      }
      await copyFileKeepMtime(s, d)
    } else {
      await copyFileKeepMtime(s, d)
    }
  }
}

/**
 * 复制文件并恢复源 mtime——mtime 保护的比较前提：
 * copyFile 默认目标 mtime=拷贝时刻（必然晚于源创建时刻），不恢复的话二次初始化时
 * 「目标比源新」恒成立，预置升级永远全部跳过。恢复后：未改动文件 目标==源（可覆盖），
 * 用户改过 目标>源（保护跳过）——语义才成立。
 */
async function copyFileKeepMtime(src: string, dest: string): Promise<void> {
  await fsp.copyFile(src, dest)
  const st = await fsp.stat(src)
  await fsp.utimes(dest, st.mtime, st.mtime)
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
 * merge 预置字段进 opencode.json：default_agent / plugin 声明 / mcp 清单 / instructions 指令文件路径。
 * 不覆盖用户已有配置——default_agent/mcp 只补缺，plugin/instructions 数组项去重追加；
 * 另清理分形前身 oc-gui 的配置目录残留死路径（见 plugin 段注释）。
 * globalConfigPath 可选注入（测试用）：默认探测用户全局配置（~/.config/opencode/opencode.json[.jsonc]）。
 */
export async function ensurePresetConfig(
  userDataDir: string,
  presetRoot = getDefaultPresetRoot(),
  globalConfigPath?: string
): Promise<void> {
  const manifest = await readPresetManifest(presetRoot)
  const target = getPresetTarget(userDataDir)
  const filePath = getConfigPath(userDataDir)
  let cfg: Record<string, unknown> = {}
  try {
    const raw = await fsp.readFile(filePath, 'utf-8')
    // 剥 BOM：外部编辑器/PowerShell 可能写入 BOM（Set-Content -Encoding UTF8），JSON.parse 遇 BOM 直接抛错
    // ——一旦抛错配置被当损坏重置，用户自定义字段（如 opencode-acp 插件声明）会静默丢失
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as unknown
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
  // 插件文件不存在（用户手动删除预置插件）则不声明，避免 serve 加载失效路径。
  // 同时清理历史迁移残留：分形前身 oc-gui 的配置目录条目（目录已删，声明是死路径）——
  // merge 语义是「补缺」，死路径既不补缺也不该保留，否则 serve 面板出现幽灵插件
  const pluginDecls = await buildPluginDecls(target)
  if (pluginDecls.length > 0) {
    const plugins = Array.isArray(cfg.plugin)
      ? (cfg.plugin as unknown[]).filter(
          // oc-gui 死路径清理 + guardian 临时停用（日志风暴阻塞 serve 事件循环，待 oc-plus 修复后恢复）
          (p) => !(typeof p === 'string' && (p.includes('/oc-gui/') || p.includes('fractal-guardian')))
        )
      : []
    for (const decl of pluginDecls) {
      if (!plugins.includes(decl)) plugins.push(decl)
    }
    cfg.plugin = plugins
  }

  // mcp 段：仅当目标配置无 mcp 时写入（merge 不覆盖用户选择）——
  // 预置内置清单（preset.json.mcp，无凭据公开端点）为底，用户全局 MCP 迁移补缺（同名覆盖、本机配置是真相）。
  // 面向小白：无全局配置时预置 3 个公开 MCP 保证生态面板非空且开箱可用
  if (!cfg.mcp || Object.keys(cfg.mcp as Record<string, unknown>).length === 0) {
    const builtin = manifest.mcp ?? {}
    const global = await readGlobalMcp(globalConfigPath)
    cfg.mcp = { ...builtin, ...global }
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
const MODEL_SLOT_RULES: Array<{ agents: string[]; slot: ModelSlot }> = [
  { agents: ['双星.md'], slot: 'high' },
  { agents: ['工匠.md', '参谋.md', '助理.md'], slot: 'low' },
  { agents: ['制图师.md'], slot: 'vision' },
  { agents: ['侦查兵.md'], slot: 'anthropic' }
]

/**
 * 读契约清单 agents-manifest.json（oc-plus sync-to-fractal.mjs 生成）。
 * 契约驱动原则（2026-08-09 定案）：agent 槽位由 oc-plus 侧声明，fractal 只消费——
 * oc-plus 新增/调整 agent 后同步 manifest，fractal 自动适配，无需改硬编码。
 * 缺失/损坏 → 返回 null（调用方回退 MODEL_SLOT_RULES 硬编码，兼容旧预置包）。
 */
export async function readAgentsManifest(presetRoot: string): Promise<AgentsManifest | null> {
  try {
    const raw = await fsp.readFile(join(presetRoot, 'agents-manifest.json'), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<AgentsManifest>
    if (
      parsed &&
      Array.isArray(parsed.agents) &&
      parsed.agents.every((a) => a && typeof a.file === 'string' && typeof a.slot === 'string')
    ) {
      return {
        version: typeof parsed.version === 'string' ? parsed.version : '',
        sourceCommit: typeof parsed.sourceCommit === 'string' ? parsed.sourceCommit : '',
        generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : '',
        agents: parsed.agents,
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * 按槽位规则替换预置 agents 的 model 字段——模型槽位统一由分形配置管理（2026-08-09 定案）：
 * 预置包内的 agent 来自 oc-plus 部署产物（model 写死），设置页改模型后不跟随；这里每次启动幂等覆盖为目标值。
 * 槽位来源：优先 agents-manifest.json 契约清单（oc-plus 声明），缺失回退 MODEL_SLOT_RULES 硬编码（兼容旧包）。
 * 值解析：high 取 cfg.model（设置页选择经 ensureConfig 写入）；low 取 resolveSmallModel（设置页「轻量模型」选择，
 * 空=跟随主模型 → SMALL_MODEL 兜底）；vision 取 oc-config 常量；anthropic 取 oc-config 常量；inherit 跳过（不写 model 行）。
 * 内容一致时不写盘（避免无谓刷盘）；agents 目录缺失/文件损坏 → 跳过不抛错（预置损坏不阻断启动）。
 */
export async function applyModelAliases(
  userDataDir: string,
  highModel?: unknown,
  presetRoot = getDefaultPresetRoot()
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
  const slotValues: Record<ModelSlot, string> = {
    high,
    low,
    vision: VISION_MODEL,
    anthropic: ANTHROPIC_MODEL,
    inherit: '', // inherit 槽位不写 model 行（继承主模型），值占位不用
  }
  // 契约清单优先（oc-plus 声明槽位），缺失回退硬编码规则
  const manifest = await readAgentsManifest(presetRoot)
  const rules: Array<{ file: string; slot: ModelSlot }> = manifest
    ? manifest.agents.map((a) => ({ file: a.file, slot: a.slot }))
    : MODEL_SLOT_RULES.flatMap((r) => r.agents.map((name) => ({ file: name, slot: r.slot })))
  try {
    await fsp.access(agentsDir)
  } catch {
    return
  }
  for (const rule of rules) {
    // inherit 槽位 = 无 model 行继承主模型，跳过不写盘
    if (rule.slot === 'inherit') continue
    const file = join(agentsDir, rule.file)
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

/** 预置插件声明：仅声明实际存在的插件文件（防用户删除后 serve 加载失效路径报错）。
 *  注意：fractal-guardian 已临时停用（2026-08-11 日志风暴阻塞 serve 事件循环导致 GUI 卡死，oc-plus 修复后恢复）。 */
async function buildPluginDecls(target: string): Promise<string[]> {
  const pluginsDir = join(target, 'plugins')
  const files = ['agents-priority.ts']
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

/**
 * 读用户全局 opencode 配置的 mcp 段（「当前 OC 安装的 MCP」迁移来源）。
 * 候选路径依次探测（openCode 加载顺序：.json 优先于 .jsonc？——实际 .jsonc 优先，但两个都读保证兼容）：
 *   ~/.config/opencode/opencode.json / ~/.config/opencode/opencode.jsonc
 * 缺失/解析失败 → 空对象（小白用户无全局配置，静默跳过不报错）。
 * globalConfigPath 由测试注入假全局配置，绕过真实用户目录。
 */
async function readGlobalMcp(globalConfigPath?: string): Promise<Record<string, unknown>> {
  const candidates = globalConfigPath
    ? [globalConfigPath]
    : [
        join(homedir(), '.config', 'opencode', 'opencode.json'),
        join(homedir(), '.config', 'opencode', 'opencode.jsonc'),
      ]
  for (const p of candidates) {
    try {
      const raw = await fsp.readFile(p, 'utf-8')
      // 剥 BOM：与 ensurePresetConfig 一致（外部编辑器/PowerShell 可能写入 BOM，JSON.parse 遇 BOM 抛错
      // → MCP 迁移静默丢失，2026-08-12 审查发现）
      const cfg = JSON.parse(raw.replace(/^\uFEFF/, '')) as { mcp?: unknown }
      if (cfg?.mcp && typeof cfg.mcp === 'object' && !Array.isArray(cfg.mcp)) {
        return cfg.mcp as Record<string, unknown>
      }
    } catch {
      // 单文件缺失/损坏 → 尝试下一个候选
    }
  }
  return {}
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
