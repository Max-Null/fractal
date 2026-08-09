// preset 单元测试：幂等初始化、预置字段 merge（不覆盖用户配置）、排除 node_modules/.git
// 不依赖 electron 运行时——preset.ts 仅用 node:fs/path + oc-config 的纯路径函数
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getConfigPath, getJsoncPath, ensureConfig } from './oc-config'
import {
  getDefaultPresetRoot,
  getPresetTarget,
  readPresetManifest,
  initPreset,
  ensurePresetConfig,
  getPresetVersion,
  applyModelAliases,
  PRESET_INSTRUCTION_FILE
} from './preset'

/** 构造临时预置包 fixture：含 agents/skills/plugins 真实文件 + node_modules/.git 陷阱目录 */
async function makeFixturePreset(version = '1.0.0'): Promise<string> {
  const presetRoot = await fsp.mkdtemp(join(tmpdir(), 'preset-fixture-'))
  await fsp.mkdir(join(presetRoot, 'agents'), { recursive: true })
  await fsp.mkdir(join(presetRoot, 'skills', 's1'), { recursive: true })
  await fsp.mkdir(join(presetRoot, 'plugins', 'lib'), { recursive: true })
  // 陷阱：不应被拷贝进预置交付的第三方依赖/仓库元数据
  await fsp.mkdir(join(presetRoot, 'plugins', 'node_modules', 'pkg'), { recursive: true })
  await fsp.mkdir(join(presetRoot, 'plugins', '.git'), { recursive: true })
  await fsp.writeFile(join(presetRoot, 'agents', '双星.md'), '# 双星 agent 定义', 'utf-8')
  await fsp.writeFile(join(presetRoot, 'skills', 's1', 'SKILL.md'), '# skill 定义', 'utf-8')
  await fsp.writeFile(join(presetRoot, 'plugins', 'fractal-guardian.js'), 'export {}', 'utf-8')
  await fsp.writeFile(join(presetRoot, 'plugins', 'agents-priority.ts'), 'export {}', 'utf-8')
  await fsp.writeFile(join(presetRoot, 'plugins', 'lib', 'engine.ts'), 'export {}', 'utf-8')
  await fsp.writeFile(
    join(presetRoot, 'plugins', 'node_modules', 'pkg', 'index.js'),
    'TRAP',
    'utf-8'
  )
  await fsp.writeFile(join(presetRoot, 'plugins', '.git', 'config'), 'TRAP', 'utf-8')
  await fsp.writeFile(
    join(presetRoot, 'preset.json'),
    JSON.stringify(
      { version, defaultAgent: '双星', instructions: ['预置指令一', '预置指令二'] },
      null,
      2
    ),
    'utf-8'
  )
  return presetRoot
}

describe('readPresetManifest / getPresetTarget（预置清单解析与目标路径）', () => {
  it('读取真实预置包 preset.json：version/defaultAgent/instructions 齐全', async () => {
    const manifest = await readPresetManifest(getDefaultPresetRoot())
    expect(manifest.version).toBeTruthy()
    expect(manifest.defaultAgent).toBe('双星')
    expect(Array.isArray(manifest.instructions)).toBe(true)
    expect(manifest.instructions.length).toBeGreaterThan(0)
  })

  it('getPresetTarget 对齐 XDG_CONFIG_HOME 隔离路径', () => {
    expect(getPresetTarget('C:\\oc-gui-data')).toBe('C:\\oc-gui-data\\config\\opencode')
  })
})

describe('initPreset（幂等初始化）', () => {
  let presetRoot: string
  let userData: string

  beforeEach(async () => {
    presetRoot = await makeFixturePreset()
    userData = await fsp.mkdtemp(join(tmpdir(), 'preset-userdata-'))
  })

  afterEach(async () => {
    await fsp.rm(presetRoot, { recursive: true, force: true })
    await fsp.rm(userData, { recursive: true, force: true })
  })

  it('首次初始化：agents/skills/plugins 拷贝到位 + .preset-version 写入', async () => {
    const result = await initPreset(userData, presetRoot)
    expect(result.initialized).toBe(true)
    expect(result.version).toBe('1.0.0')

    const target = getPresetTarget(userData)
    // agents/skills/plugins 内容到位（含 plugins/lib 子目录）
    expect(await fsp.readFile(join(target, 'agents', '双星.md'), 'utf-8')).toBe('# 双星 agent 定义')
    expect(await fsp.readFile(join(target, 'skills', 's1', 'SKILL.md'), 'utf-8')).toBe(
      '# skill 定义'
    )
    expect(await fsp.readFile(join(target, 'plugins', 'fractal-guardian.js'), 'utf-8')).toBe(
      'export {}'
    )
    expect(await fsp.readFile(join(target, 'plugins', 'lib', 'engine.ts'), 'utf-8')).toBe(
      'export {}'
    )
    // 版本标记写入
    expect((await fsp.readFile(join(target, '.preset-version'), 'utf-8')).trim()).toBe('1.0.0')
  })

  it('排除 node_modules/.git（第三方依赖与仓库元数据不进预置交付）', async () => {
    await initPreset(userData, presetRoot)
    const pluginsDir = join(getPresetTarget(userData), 'plugins')
    await expect(fsp.access(join(pluginsDir, 'node_modules'))).rejects.toThrow()
    await expect(fsp.access(join(pluginsDir, '.git'))).rejects.toThrow()
  })

  it('幂等：二次调用跳过（initialized=false，不重复拷贝）', async () => {
    await initPreset(userData, presetRoot)
    const second = await initPreset(userData, presetRoot)
    expect(second.initialized).toBe(false)
    expect(second.version).toBe('1.0.0')
  })

  it('版本旧：preset.json 版本变化 → 重新初始化（覆盖预置内容）', async () => {
    await initPreset(userData, presetRoot)
    // 模拟应用升级：新预置包 version=1.0.1 + agent 内容更新
    await fsp.rm(presetRoot, { recursive: true, force: true })
    presetRoot = await makeFixturePreset('1.0.1')
    await fsp.writeFile(join(presetRoot, 'agents', '双星.md'), '# 双星 agent 定义 v2', 'utf-8')

    const upgraded = await initPreset(userData, presetRoot)
    expect(upgraded.initialized).toBe(true)
    expect(upgraded.version).toBe('1.0.1')
    expect(await fsp.readFile(join(getPresetTarget(userData), 'agents', '双星.md'), 'utf-8')).toBe(
      '# 双星 agent 定义 v2'
    )
    expect(
      (await fsp.readFile(join(getPresetTarget(userData), '.preset-version'), 'utf-8')).trim()
    ).toBe('1.0.1')
  })

  it('mtime 保护：升级时用户改过的 agents 文件不被预置覆盖（真相源原则）', async () => {
    await initPreset(userData, presetRoot)
    // 用户/设置页改过 target 的 双星.md（内容 + mtime 都更新——目标比源新）
    const targetAgent = join(getPresetTarget(userData), 'agents', '双星.md')
    await fsp.writeFile(targetAgent, '# 用户改过的双星', 'utf-8')

    // 模拟应用升级：仅 bump preset.json 版本（agents 源文件未变动——真实升级时未变文件 mtime 保持）
    const pj = join(presetRoot, 'preset.json')
    const pjData = JSON.parse(await fsp.readFile(pj, 'utf-8')) as { version: string }
    pjData.version = '1.0.1'
    await fsp.writeFile(pj, JSON.stringify(pjData), 'utf-8')

    const upgraded = await initPreset(userData, presetRoot)
    expect(upgraded.initialized).toBe(true)
    // 用户改过的文件保留（目标比源新 → mtime 保护跳过）
    expect(await fsp.readFile(targetAgent, 'utf-8')).toBe('# 用户改过的双星')
  })

  it('mtime 保护：预置文件比目标新 → 正常覆盖（预置更新生效）', async () => {
    await initPreset(userData, presetRoot)
    const targetAgent = join(getPresetTarget(userData), 'agents', '双星.md')
    // 预置更新 双星.md（源 mtime 变新）；拷贝恢复 mtime 后目标==旧源，故源新必覆盖
    await new Promise((r) => setTimeout(r, 10))
    await fsp.writeFile(join(presetRoot, 'agents', '双星.md'), '# 双星 agent 定义 v2', 'utf-8')
    const pj = join(presetRoot, 'preset.json')
    const pjData = JSON.parse(await fsp.readFile(pj, 'utf-8')) as { version: string }
    pjData.version = '1.0.1'
    await fsp.writeFile(pj, JSON.stringify(pjData), 'utf-8')

    const upgraded = await initPreset(userData, presetRoot)
    expect(upgraded.initialized).toBe(true)
    expect(await fsp.readFile(targetAgent, 'utf-8')).toBe('# 双星 agent 定义 v2')
  })
})

describe('ensurePresetConfig（预置字段 merge，不覆盖用户配置）', () => {
  let presetRoot: string
  let userData: string

  beforeEach(async () => {
    presetRoot = await makeFixturePreset()
    userData = await fsp.mkdtemp(join(tmpdir(), 'preset-cfg-'))
  })

  afterEach(async () => {
    await fsp.rm(presetRoot, { recursive: true, force: true })
    await fsp.rm(userData, { recursive: true, force: true })
  })

  it('首次 merge：default_agent / plugin 声明 / instructions 指令文件路径写入', async () => {
    // 前置：initPreset 先拷贝 plugins（plugin 声明只在实际文件存在时写入）
    await initPreset(userData, presetRoot)
    await ensurePresetConfig(userData, presetRoot)

    const cfg = JSON.parse(await fsp.readFile(getConfigPath(userData), 'utf-8')) as Record<
      string,
      unknown
    >
    expect(cfg.default_agent).toBe('双星')
    // plugin 声明格式对齐用户全局 opencode.json：file:// 绝对路径
    const plugins = cfg.plugin as string[]
    expect(plugins).toContain(
      `file:///${join(getPresetTarget(userData), 'plugins', 'fractal-guardian.js').replace(/\\/g, '/')}`
    )
    expect(plugins).toContain(
      `file:///${join(getPresetTarget(userData), 'plugins', 'agents-priority.ts').replace(/\\/g, '/')}`
    )
    // instructions 指向生成的指令文件（OC 只加载文件路径，不认直接文本）
    const instructions = cfg.instructions as string[]
    const instructionFile = join(getPresetTarget(userData), 'instructions', PRESET_INSTRUCTION_FILE)
    expect(instructions).toContain(instructionFile)
    expect(await fsp.readFile(instructionFile, 'utf-8')).toContain('预置指令一')
    // 双写 jsonc（serve 候选加载 opencode.jsonc 优先）
    expect(await fsp.readFile(getJsoncPath(userData), 'utf-8')).toContain('"default_agent": "双星"')
  })

  it('不覆盖用户已有配置：default_agent 保留用户值，plugin/instructions 数组仅追加不重复', async () => {
    await initPreset(userData, presetRoot)
    // 用户已有 opencode.json：自定义 default_agent/plugin/instructions
    const existingPlugin = 'superpowers'
    const existingInstruction = 'C:/my-rules.md'
    const cfgPath = getConfigPath(userData)
    await fsp.mkdir(join(cfgPath, '..'), { recursive: true })
    await fsp.writeFile(
      cfgPath,
      JSON.stringify(
        { default_agent: 'build', plugin: [existingPlugin], instructions: [existingInstruction] },
        null,
        2
      ),
      'utf-8'
    )

    await ensurePresetConfig(userData, presetRoot)

    const cfg = JSON.parse(await fsp.readFile(cfgPath, 'utf-8')) as Record<string, unknown>
    expect(cfg.default_agent).toBe('build') // 用户选择优先，不覆盖
    const plugins = cfg.plugin as string[]
    expect(plugins).toContain(existingPlugin) // 用户插件保留
    expect(plugins.length).toBe(3) // superpowers + 2 个预置插件
    const instructions = cfg.instructions as string[]
    expect(instructions).toContain(existingInstruction) // 用户指令保留
    expect(instructions.length).toBe(2) // 用户指令 + 预置指令文件
  })

  it('二次调用幂等：plugin/instructions 不重复追加', async () => {
    await initPreset(userData, presetRoot)
    await ensurePresetConfig(userData, presetRoot)
    await ensurePresetConfig(userData, presetRoot)

    const cfg = JSON.parse(await fsp.readFile(getConfigPath(userData), 'utf-8')) as Record<
      string,
      unknown
    >
    expect(cfg.default_agent).toBe('双星')
    expect((cfg.plugin as string[]).filter((p) => p.includes('fractal-guardian.js')).length).toBe(1)
    expect(
      (cfg.instructions as string[]).filter((i) => i.includes(PRESET_INSTRUCTION_FILE)).length
    ).toBe(1)
  })

  it('插件文件被用户删除时不写入对应 plugin 声明', async () => {
    await initPreset(userData, presetRoot)
    await fsp.rm(join(getPresetTarget(userData), 'plugins', 'agents-priority.ts'))
    await ensurePresetConfig(userData, presetRoot)

    const cfg = JSON.parse(await fsp.readFile(getConfigPath(userData), 'utf-8')) as Record<
      string,
      unknown
    >
    const plugins = cfg.plugin as string[]
    expect(plugins.some((p) => p.includes('fractal-guardian.js'))).toBe(true)
    expect(plugins.some((p) => p.includes('agents-priority'))).toBe(false)
  })

  it('指令文件已存在（用户自定义过）不覆盖', async () => {
    await initPreset(userData, presetRoot)
    // 先跑一次生成指令文件，再模拟用户自定义内容
    await ensurePresetConfig(userData, presetRoot)
    const instructionFile = join(getPresetTarget(userData), 'instructions', PRESET_INSTRUCTION_FILE)
    await fsp.writeFile(instructionFile, '用户自定义指令内容', 'utf-8')

    await ensurePresetConfig(userData, presetRoot)
    expect(await fsp.readFile(instructionFile, 'utf-8')).toBe('用户自定义指令内容')
  })
})

describe('真实预置包端到端（交付物完整性：initPreset + ensurePresetConfig 完整串联）', () => {
  let userData: string

  beforeEach(async () => {
    userData = await fsp.mkdtemp(join(tmpdir(), 'preset-e2e-'))
  })

  afterEach(async () => {
    await fsp.rm(userData, { recursive: true, force: true })
  })

  it('首次初始化完整流程：7 agents / 15 skills / 2 plugins+lib 拷贝 + opencode.json 字段 merge', async () => {
    // presetRoot 用真实交付物（electron/resources/preset，getDefaultPresetRoot 解析）
    const presetRoot = getDefaultPresetRoot()
    const manifest = await readPresetManifest(presetRoot)

    const init = await initPreset(userData, presetRoot)
    expect(init.initialized).toBe(true)

    const target = getPresetTarget(userData)
    // agents：7 个 oc-plus agent md（双星/工匠/参谋/军师/助理 + v1.1.0 新增 侦查兵/制图师）
    const agents = await fsp.readdir(join(target, 'agents'))
    expect(agents.length).toBe(7)
    expect(agents).toContain('双星.md')
    expect(agents).toContain('侦查兵.md')
    expect(agents).toContain('制图师.md')
    // skills：15 个 mxy-*/omo-* 目录（mxy 9 + omo 6）
    const skills = await fsp.readdir(join(target, 'skills'))
    expect(skills.length).toBe(15)
    expect(skills.filter((s) => s.startsWith('mxy-')).length).toBe(9)
    expect(skills.filter((s) => s.startsWith('omo-')).length).toBe(6)
    // plugins：2 个插件文件 + lib/ 子目录保留
    expect(await fsp.access(join(target, 'plugins', 'fractal-guardian.js'))).toBeUndefined()
    expect(await fsp.access(join(target, 'plugins', 'agents-priority.ts'))).toBeUndefined()
    const pluginLib = await fsp.readdir(join(target, 'plugins', 'lib'))
    expect(pluginLib.length).toBeGreaterThan(0)

    // merge 字段：default_agent / 2 个 plugin 声明 / instructions 指令文件路径
    await ensurePresetConfig(userData, presetRoot)
    const cfg = JSON.parse(await fsp.readFile(getConfigPath(userData), 'utf-8')) as Record<
      string,
      unknown
    >
    expect(cfg.default_agent).toBe(manifest.defaultAgent)
    const plugins = cfg.plugin as string[]
    expect(plugins.filter((p) => p.includes('fractal-guardian.js')).length).toBe(1)
    expect(plugins.filter((p) => p.includes('agents-priority.ts')).length).toBe(1)
    const instructions = cfg.instructions as string[]
    expect(instructions.filter((i) => i.includes(PRESET_INSTRUCTION_FILE)).length).toBe(1)
    // 指令文件已生成且含预置文案
    const instructionFile = join(target, 'instructions', PRESET_INSTRUCTION_FILE)
    expect(await fsp.access(instructionFile)).toBeUndefined()
    const instructionContent = await fsp.readFile(instructionFile, 'utf-8')
    expect(instructionContent).toContain('分形')
    expect(instructionContent).toContain(manifest.instructions[0])
  })

  it('二次启动幂等：initPreset 跳过 + ensurePresetConfig 字段不重复', async () => {
    const presetRoot = getDefaultPresetRoot()
    await initPreset(userData, presetRoot)
    await ensurePresetConfig(userData, presetRoot)

    const secondInit = await initPreset(userData, presetRoot)
    expect(secondInit.initialized).toBe(false)
    await ensurePresetConfig(userData, presetRoot)

    const cfg = JSON.parse(await fsp.readFile(getConfigPath(userData), 'utf-8')) as Record<
      string,
      unknown
    >
    expect((cfg.plugin as string[]).filter((p) => p.includes('fractal-guardian.js')).length).toBe(1)
    expect((cfg.instructions as string[]).length).toBe(1)
  })

  it('交叉串联：initPreset → ensurePresetConfig → ensureConfig 字段无冲突（军师 #4）', async () => {
    // 军师审查建议：锚定「预置字段（default_agent/plugin/instructions）与受管字段（model）可共存」
    const presetRoot = getDefaultPresetRoot()
    await initPreset(userData, presetRoot)
    await ensurePresetConfig(userData, presetRoot)
    await ensureConfig(userData, { apiKey: 'sk-test', permissionMode: 'default' })

    const cfg = JSON.parse(await fsp.readFile(getConfigPath(userData), 'utf-8')) as Record<
      string,
      unknown
    >
    expect(cfg.default_agent).toBe('双星')
    expect(cfg.model).toBe('deepseek/deepseek-v4-pro')
    expect((cfg.plugin as string[]).filter((p) => p.includes('fractal-guardian.js')).length).toBe(1)
    expect((cfg.instructions as string[]).filter((i) => i.includes(PRESET_INSTRUCTION_FILE)).length).toBe(1)
  })
})

// ── getPresetVersion（设置页「关于」预置包版本；双路径解析复用 getDefaultPresetRoot）──
describe('getPresetVersion', () => {
  it('源码路径：读取真实交付物 preset.json 的 version（v1.1.0，升级后新增 侦查兵/制图师 agent）', async () => {
    expect(await getPresetVersion()).toBe('1.1.0')
  })

  it('preset.json 缺失 → 返回 占位符 —（不抛错）', async () => {
    const emptyRoot = await fsp.mkdtemp(join(tmpdir(), 'preset-empty-'))
    try {
      expect(await getPresetVersion(emptyRoot)).toBe('—')
    } finally {
      await fsp.rm(emptyRoot, { recursive: true, force: true })
    }
  })

  it('preset.json version 非字符串/空 → 返回 占位符 —', async () => {
    const brokenRoot = await fsp.mkdtemp(join(tmpdir(), 'preset-broken-'))
    try {
      await fsp.writeFile(join(brokenRoot, 'preset.json'), JSON.stringify({ version: 42 }), 'utf-8')
      expect(await getPresetVersion(brokenRoot)).toBe('—')
    } finally {
      await fsp.rm(brokenRoot, { recursive: true, force: true })
    }
  })
})

// 模型槽位统一（HIGH/LOW/VISION 按槽位规则替换，2026-08-09 定案）：预置 agents 来自 oc-plus 部署产物（model 写死），
// applyModelAliases 每次启动幂等覆盖为目标值——HIGH 跟随主模型选择、LOW=SMALL_MODEL、VISION=VISION_MODEL
describe('applyModelAliases', () => {
  let userData: string

  beforeEach(async () => {
    userData = await fsp.mkdtemp(join(tmpdir(), 'preset-aliases-'))
    const agentsDir = join(getPresetTarget(userData), 'agents')
    await fsp.mkdir(agentsDir, { recursive: true })
    // 预置 agent 部署产物形态：model 写死（全部写 pro——验证 LOW/VISION 也能覆盖非目标值）
    await fsp.writeFile(join(agentsDir, '双星.md'), 'model: "ds/deepseek-v4-pro"\n', 'utf-8')
    await fsp.writeFile(join(agentsDir, '工匠.md'), 'model: "ds/deepseek-v4-pro"\n', 'utf-8')
    await fsp.writeFile(join(agentsDir, '制图师.md'), 'model: "ds/deepseek-v4-pro"\n', 'utf-8')
    // 无 model 行：继承主模型（天然 HIGH），替换必须跳过
    await fsp.writeFile(join(agentsDir, '军师.md'), 'description: 战略远见\n', 'utf-8')
  })

  afterEach(async () => {
    await fsp.rm(userData, { recursive: true, force: true })
  })

  it('按槽位替换：HIGH 用主模型参数值、LOW=SMALL_MODEL、VISION=VISION_MODEL', async () => {
    await applyModelAliases(userData, 'deepseek/deepseek-v4-flash')
    const agentsDir = join(getPresetTarget(userData), 'agents')
    const shuang = await fsp.readFile(join(agentsDir, '双星.md'), 'utf-8')
    expect(shuang).toContain('model: "deepseek/deepseek-v4-flash"')
    const gong = await fsp.readFile(join(agentsDir, '工匠.md'), 'utf-8')
    expect(gong).toContain('model: "deepseek/deepseek-v4-flash"')
    const zhi = await fsp.readFile(join(agentsDir, '制图师.md'), 'utf-8')
    expect(zhi).toContain('model: "moonshotai-cn/kimi-k3"')
  })

  it('LOW 槽位跟随设置页轻量模型选择（settings.json smallModel=pro → 工匠/参谋/助理 替换成 pro）', async () => {
    // 模拟设置页已选 pro：settings.json smallModel=pro（resolveSmallModel 读此值）
    await fsp.writeFile(join(userData, 'settings.json'), JSON.stringify({ smallModel: 'deepseek/deepseek-v4-pro' }), 'utf-8')
    // 补建 LOW 同槽位 agent（beforeEach fixture 仅建 工匠.md 代表 LOW 槽位）
    await fsp.writeFile(join(getPresetTarget(userData), 'agents', '参谋.md'), 'model: "ds/deepseek-v4-pro"\n', 'utf-8')
    await applyModelAliases(userData, 'deepseek/deepseek-v4-flash')
    const agentsDir = join(getPresetTarget(userData), 'agents')
    const gong = await fsp.readFile(join(agentsDir, '工匠.md'), 'utf-8')
    expect(gong).toContain('model: "deepseek/deepseek-v4-pro"')
    // 参谋同为 LOW 槽位，一并替换
    const canmou = await fsp.readFile(join(agentsDir, '参谋.md'), 'utf-8')
    expect(canmou).toContain('model: "deepseek/deepseek-v4-pro"')
    // HIGH 槽位不受影响（仍用主模型参数值）
    const shuang = await fsp.readFile(join(agentsDir, '双星.md'), 'utf-8')
    expect(shuang).toContain('model: "deepseek/deepseek-v4-flash"')
  })

  it('LOW 槽位跟随主模型（settings.json smallModel="" → 用 SMALL_MODEL 默认兜底）', async () => {
    // 用户选「跟随主模型」：smallModel 显式空 → LOW 槽位回退 SMALL_MODEL（flash）
    await fsp.writeFile(join(userData, 'settings.json'), JSON.stringify({ smallModel: '' }), 'utf-8')
    await applyModelAliases(userData, 'deepseek/deepseek-v4-pro')
    const agentsDir = join(getPresetTarget(userData), 'agents')
    const gong = await fsp.readFile(join(agentsDir, '工匠.md'), 'utf-8')
    expect(gong).toContain('model: "deepseek/deepseek-v4-flash"')
  })

  it('HIGH 参数缺省时读目标 opencode.json 的 model 字段（设置页选择经 ensureConfig 写入）', async () => {
    // 模拟 ensureConfig 已写入：cfg.model = flash
    await fsp.writeFile(
      getConfigPath(userData),
      JSON.stringify({ model: 'deepseek/deepseek-v4-flash', default_agent: '双星' }, null, 2),
      'utf-8'
    )
    await applyModelAliases(userData)
    const agentsDir = join(getPresetTarget(userData), 'agents')
    const shuang = await fsp.readFile(join(agentsDir, '双星.md'), 'utf-8')
    expect(shuang).toContain('model: "deepseek/deepseek-v4-flash"')
  })

  it('HIGH 缺省且配置文件缺失 → 默认 pro（不抛错）', async () => {
    await applyModelAliases(userData)
    const agentsDir = join(getPresetTarget(userData), 'agents')
    const shuang = await fsp.readFile(join(agentsDir, '双星.md'), 'utf-8')
    expect(shuang).toContain('model: "deepseek/deepseek-v4-pro"')
  })

  it('无 model 行的 agent（军师）不被修改', async () => {
    await applyModelAliases(userData, 'deepseek/deepseek-v4-flash')
    const agentsDir = join(getPresetTarget(userData), 'agents')
    const teacher = await fsp.readFile(join(agentsDir, '军师.md'), 'utf-8')
    expect(teacher).not.toContain('model:')
    expect(teacher).toContain('description')
  })

  it('agents 目录不存在 → 跳过不抛错（预置损坏不阻断启动）', async () => {
    const empty = await fsp.mkdtemp(join(tmpdir(), 'preset-noagents-'))
    try {
      await expect(applyModelAliases(empty, 'deepseek/deepseek-v4-flash')).resolves.toBeUndefined()
    } finally {
      await fsp.rm(empty, { recursive: true, force: true })
    }
  })

  it('值一致时幂等：不重复写盘（mtime 不变）', async () => {
    const agentsDir = join(getPresetTarget(userData), 'agents')
    // 第一次：HIGH 变化触发替换
    await applyModelAliases(userData, 'deepseek/deepseek-v4-flash')
    const file = join(agentsDir, '双星.md')
    const mtime1 = (await fsp.stat(file)).mtimeMs
    await new Promise((r) => setTimeout(r, 20))
    // 第二次：值已一致 → 不写盘
    await applyModelAliases(userData, 'deepseek/deepseek-v4-flash')
    const mtime2 = (await fsp.stat(file)).mtimeMs
    expect(mtime2).toBe(mtime1)
  })
})
