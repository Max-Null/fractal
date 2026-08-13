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
  /** npm 插件声明（如 opencode-acp@latest）——OC 启动时 Bun 自动安装，merge 进 plugin 数组（2026-08-13 预装 ACP 会话压缩） */
  plugins?: string[]
  /** 顶层配置字段（如 compaction: {auto:false} 禁用内置自动压缩避免与 ACP 冲突）——仅未设置时写入 */
  compaction?: Record<string, unknown>
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
    // plugins 段可选：npm 插件声明数组（非字符串数组视为无效丢弃）
    plugins: Array.isArray(manifest.plugins) ? manifest.plugins.filter((p): p is string => typeof p === 'string') : undefined,
    // compaction 段可选：顶层配置对象
    compaction:
      manifest.compaction && typeof manifest.compaction === 'object' && !Array.isArray(manifest.compaction)
        ? (manifest.compaction as Record<string, unknown>)
        : undefined,
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
  // npm 插件声明（预置清单 plugins 段）：OC 启动时 Bun 自动安装（缓存 ~/.cache/opencode/node_modules/），
  // 与本地 file:// 插件同一数组去重追加（2026-08-13 预装 opencode-acp@latest 会话压缩）
  const npmPlugins = manifest.plugins ?? []
  if (pluginDecls.length > 0 || npmPlugins.length > 0) {
    const plugins = Array.isArray(cfg.plugin)
      ? (cfg.plugin as unknown[]).filter(
          // oc-gui 死路径清理（分形前身配置目录残留，目录已删，声明是死路径）
          (p) => !(typeof p === 'string' && p.includes('/oc-gui/'))
        )
      : []
    for (const decl of [...pluginDecls, ...npmPlugins]) {
      if (!plugins.includes(decl)) plugins.push(decl)
    }
    cfg.plugin = plugins
  }

  // compaction 段：仅未设置时写入（merge 不覆盖用户选择）——opencode-acp 预置要求禁用内置自动压缩避免冲突
  if (manifest.compaction && cfg.compaction == null) {
    cfg.compaction = manifest.compaction
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

  // guardian 语义向量依赖按需安装（fire-and-forget：不阻塞启动链；失败自动降级 BM25 不报错）
  void installVectorDeps(getPresetTarget(userDataDir)).catch(() => {})
}

/** 模型槽位：agent 文件 → 对应槽位（HIGH=主模型 / LOW=轻量 / VISION=多模态）；无 model 行的 agent 继承主模型（天然 HIGH）不处理 */
const MODEL_SLOT_RULES: Array<{ agents: string[]; slot: ModelSlot }> = [
  { agents: ['双星.md'], slot: 'high' },
  { agents: ['工匠.md', '参谋.md', '助理.md'], slot: 'low' },
  { agents: ['制图师.md'], slot: 'vision' },
  { agents: ['侦查兵.md'], slot: 'anthropic' }
]

// ── guardian 语义向量依赖按需安装（2026-08-12 定案：安装环境可联网则装，不可用降级 BM25）──

/** 失败标记文件：安装失败/无 npm 后写入，后续启动跳过（避免每次启动 npm 超时等待）；用户可删标记重试 */
const VECTOR_DEP_FAIL_FLAG = '.vector-install-failed'

/**
 * 按需安装 guardian 语义向量依赖（@huggingface/transformers → onnxruntime-node ~200MB）。
 * 设计（2026-08-12 用户拍板）：安装器不内置大依赖（安装包 138MB → 350MB+ 不可接受），
 * 首次启动联网时 npm 安装；无网络/npm 缺失/失败 → 写失败标记降级 BM25（guardian 主路径不受影响）。
 * 幂等：依赖已存在或失败标记存在 → 直接返回。fire-and-forget 调用（不阻塞启动链），spawn 超时 90s。
 */
export async function installVectorDeps(openCodeDir: string): Promise<void> {
  const depDir = join(openCodeDir, 'node_modules', '@huggingface', 'transformers')
  try {
    await fsp.access(depDir)
    // 依赖已存在（手动补装或上次成功）→ 幂等返回；若残留失败标记（曾失败后手动补装）→ 顺带清除，恢复下次自动检测
    await fsp.rm(join(openCodeDir, VECTOR_DEP_FAIL_FLAG), { force: true })
    return
  } catch {
    // 未安装 → 继续
  }
  if (existsSync(join(openCodeDir, VECTOR_DEP_FAIL_FLAG))) return // 之前失败过 → 跳过（防反复超时）

  try {
    const { spawn } = await import('node:child_process')
    await new Promise<void>((resolve, reject) => {
      const child = spawn('npm', ['install', '@huggingface/transformers', '--prefix', openCodeDir], {
        cwd: openCodeDir,
        shell: true, // Windows npm 是 npm.cmd，需 shell 解析
        windowsHide: true,
        stdio: 'ignore',
      })
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('npm install 超时（90s）'))
      }, 90_000)
      child.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(new Error(`npm install 退出码 ${code}`))
      })
    })
    // 安装成功 → 清除失败标记（之前失败过但本次成功）
    await fsp.rm(join(openCodeDir, VECTOR_DEP_FAIL_FLAG), { force: true })
    console.log('[preset] guardian 语义向量依赖安装成功（@huggingface/transformers）')
  } catch (err) {
    // 无网络/npm 缺失/安装失败 → 写失败标记（后续启动跳过），guardian 自动降级 BM25
    try {
      await fsp.writeFile(join(openCodeDir, VECTOR_DEP_FAIL_FLAG), String(err), 'utf-8')
    } catch {
      // 标记写入失败（目录只读等）→ 下次启动重试
    }
    console.log(`[preset] guardian 语义向量依赖安装失败（降级 BM25，可删 ${VECTOR_DEP_FAIL_FLAG} 重试）: ${String(err).slice(0, 120)}`)
  }
}

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
 * 子 agent 模型覆盖白名单（2026-08-13 设置页重构定案）：
 * 设置页「子 agent 模型」选择仅允许列表内模型——防止任意模型名写入 agents（OC 加载失败 / 资源误用）。
 * 与各 agent 槽位能力匹配：双星/工匠/助理/参谋/军师走 DeepSeek 主链路；侦查兵走 Anthropic 兼容链路；制图师固定视觉模型。
 */
const AGENT_MODEL_WHITELIST: Record<string, string[]> = {
  双星: ['deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-pro'],
  工匠: ['deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-pro'],
  助理: ['deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-pro'],
  参谋: ['deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-pro'],
  军师: ['deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-pro'],
  侦查兵: ['ds-anthropic/deepseek-v4-flash', 'ds-anthropic/deepseek-v4-pro'],
  制图师: ['moonshotai-cn/kimi-k3'],
}

/**
 * 读设置页「子 agent 模型覆盖」表：<userDataDir>/settings.json 的 agentModelOverrides 字段。
 * 容错：BOM 去除（Windows 编辑器可能带）；非对象 / 解析失败 → {}（读取失败不阻断启动，回退槽位默认）。
 */
export async function readAgentModelOverrides(userDataDir: string): Promise<Record<string, string>> {
  try {
    const raw = await fsp.readFile(join(userDataDir, 'settings.json'), 'utf-8')
    // BOM 会导致 JSON.parse 抛错（UTF-8 BOM 字节在文本前），剥离后再解析
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const table = (parsed as Record<string, unknown>).agentModelOverrides
      if (table && typeof table === 'object' && !Array.isArray(table)) {
        const result: Record<string, string> = {}
        for (const [name, model] of Object.entries(table as Record<string, unknown>)) {
          // 只保留字符串值（设置页只会写入 string；防御脏数据）
          if (typeof model === 'string' && model) result[name] = model
        }
        return result
      }
    }
    return {}
  } catch {
    return {}
  }
}

/**
 * 按槽位规则替换预置 agents 的 model 字段——模型槽位统一由分形配置管理（2026-08-09 定案）：
 * 预置包内的 agent 来自 oc-plus 部署产物（model 写死），设置页改模型后不跟随；这里每次启动幂等覆盖为目标值。
 * 槽位来源：优先 agents-manifest.json 契约清单（oc-plus 声明），缺失回退 MODEL_SLOT_RULES 硬编码（兼容旧包）。
 * 值解析：high 取 cfg.model（设置页选择经 ensureConfig 写入）；low 取 resolveSmallModel（设置页「轻量模型」选择，
 * 空=跟随主模型 → SMALL_MODEL 兜底）；vision 取 oc-config 常量；anthropic 取 oc-config 常量；inherit 跳过（不写 model 行）。
 * 覆盖表：settings.json 的 agentModelOverrides（agent 名 → 模型全名）优先于槽位默认，但仅限 AGENT_MODEL_WHITELIST——
 * 白名单外忽略回退槽位；inherit 槽位被覆盖时在 mode: 行后插入 model 行（原本无 model 行）。
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
  // 覆盖表一次读入（settings.json 读取失败 → {}，全走槽位逻辑）
  const overrides = await readAgentModelOverrides(userDataDir)
  for (const rule of rules) {
    // agent 名 = rule.file 去 .md 后缀（与设置页配置 key 对齐）
    const agentName = rule.file.replace(/\.md$/, '')
    const override = overrides[agentName]
    // 覆盖命中白名单才生效；白名单外 → 回退槽位逻辑
    const overrideOk =
      typeof override === 'string' && !!override && AGENT_MODEL_WHITELIST[agentName]?.includes(override) === true
    // inherit 槽位且无有效覆盖 → 无 model 行继承主模型，跳过不写盘
    if (!overrideOk && rule.slot === 'inherit') continue
    const file = join(agentsDir, rule.file)
    let raw: string
    try {
      raw = await fsp.readFile(file, 'utf-8')
    } catch {
      // agent 文件不存在（用户删除预置 agent）→ 跳过
      continue
    }
    const value = overrideOk ? override : slotValues[rule.slot]
    // 已有 model 行 → 整行替换（agents md 的 model 行顶格无缩进）；
    // 无 model 行（inherit 被覆盖）→ 以 mode: 行为锚点在其后插入一行，保持 frontmatter 字段顺序
    const next = /^model:.*$/m.test(raw)
      ? raw.replace(/^model:.*$/m, `model: "${value}"`)
      : raw.replace(/^(mode:.*)$/m, `$1\nmodel: "${value}"`)
    // 值不变时跳过写盘（幂等：重复启动/重复触发不刷盘）
    if (next !== raw) await fsp.writeFile(file, next, 'utf-8')
  }
}

/** 预置插件声明：仅声明实际存在的插件文件（防用户删除后 serve 加载失效路径报错）。
 *  fractal-guardian 已于 2026-08-12 恢复（oc-plus 修复日志风暴：rotateLog O(1) 归档 + raw-events 按类型去重）。 */
async function buildPluginDecls(target: string): Promise<string[]> {
  const pluginsDir = join(target, 'plugins')
  const files = ['agents-priority.ts', 'fractal-guardian.js']
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
