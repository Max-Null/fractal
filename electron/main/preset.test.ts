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
  readAgentsManifest,
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
      {
        version,
        defaultAgent: '双星',
        instructions: ['预置指令一', '预置指令二'],
        // 预置内置 MCP：对齐真实交付物（无凭据公开端点）
        mcp: {
          websearch: { type: 'remote', enabled: true, url: 'https://mcp.exa.ai/mcp?tools=web_search_exa' },
          gh_grep: { type: 'remote', enabled: true, url: 'https://mcp.grep.app' },
          context7: { type: 'remote', enabled: true, url: 'https://mcp.context7.com/mcp' },
        },
      },
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
    // guardian 临时停用（2026-08-11 日志风暴阻塞 serve 事件循环，oc-plus 修复后恢复）——声明不应出现
    expect(plugins.some((p) => p.includes('fractal-guardian'))).toBe(false)
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
    expect(plugins.length).toBe(2) // superpowers + 1 个预置插件（guardian 临时停用）
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
    expect((cfg.plugin as string[]).filter((p) => p.includes('fractal-guardian.js')).length).toBe(0)
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
    const plugins = (cfg.plugin as string[] | undefined) ?? []
    expect(plugins.some((p) => p.includes('fractal-guardian.js'))).toBe(false)
    expect(plugins.some((p) => p.includes('agents-priority'))).toBe(false)
  })

  it('清理分形前身 oc-gui 的配置目录残留插件声明（幽灵插件）', async () => {
    await initPreset(userData, presetRoot)
    // 模拟历史迁移残留：plugin 段含 oc-gui 目录死路径（目录已删）+ 用户自定义插件
    const ghost =
      'file:///C:/Users/x/AppData/Roaming/oc-gui/config/opencode/plugins/fractal-guardian.js'
    const custom = 'superpowers'
    await fsp.writeFile(getConfigPath(userData), JSON.stringify({ plugin: [ghost, custom] }), 'utf-8')

    await ensurePresetConfig(userData, presetRoot)

    const cfg = JSON.parse(await fsp.readFile(getConfigPath(userData), 'utf-8')) as Record<
      string,
      unknown
    >
    const plugins = cfg.plugin as string[]
    expect(plugins.some((p) => p.includes('/oc-gui/'))).toBe(false) // 幽灵条目清理
    expect(plugins).toContain(custom) // 用户自定义保留
    expect(plugins.filter((p) => p.includes('fractal-guardian.js')).length).toBe(0) // guardian 临时停用不追加
  })

  it('mcp 段：无配置时写入 预置内置 + 用户全局迁移（同名全局优先）', async () => {
    await initPreset(userData, presetRoot)
    // 假全局配置：context7 自定义 url（同名覆盖预置）+ github（私有凭据 MCP，本机迁移）
    const globalCfg = join(userData, 'global-opencode.json')
    await fsp.writeFile(
      globalCfg,
      JSON.stringify({
        mcp: {
          context7: { type: 'remote', enabled: true, url: 'https://custom.context7/mcp' },
          github: { type: 'remote', url: 'https://api.githubcopilot.com/mcp/', enabled: true },
        },
      }),
      'utf-8'
    )

    await ensurePresetConfig(userData, presetRoot, globalCfg)

    const cfg = JSON.parse(await fsp.readFile(getConfigPath(userData), 'utf-8')) as Record<
      string,
      unknown
    >
    const mcp = cfg.mcp as Record<string, { url?: string }>
    expect(mcp.websearch.url).toContain('exa.ai') // 预置内置保留
    expect(mcp.gh_grep).toBeTruthy()
    expect(mcp.github).toBeTruthy() // 全局私有 MCP 迁移
    expect(mcp.context7.url).toBe('https://custom.context7/mcp') // 同名全局优先
  })

  it('mcp 段：无全局配置 → 仅预置内置；已有 mcp → 不覆盖', async () => {
    await initPreset(userData, presetRoot)
    // 无全局配置（注入不存在的路径，避免读到真实用户目录）
    await ensurePresetConfig(userData, presetRoot, join(userData, 'no-global.json'))

    let cfg = JSON.parse(await fsp.readFile(getConfigPath(userData), 'utf-8')) as Record<
      string,
      unknown
    >
    const builtin = cfg.mcp as Record<string, unknown>
    expect(Object.keys(builtin).length).toBeGreaterThanOrEqual(3) // 预置内置 websearch/gh_grep/context7

    // 用户已有 mcp → merge 不覆盖
    await fsp.writeFile(
      getConfigPath(userData),
      JSON.stringify({ mcp: { mine: { type: 'remote', url: 'https://mine' } } }),
      'utf-8'
    )
    await ensurePresetConfig(userData, presetRoot, join(userData, 'no-global.json'))
    cfg = JSON.parse(await fsp.readFile(getConfigPath(userData), 'utf-8')) as Record<string, unknown>
    expect((cfg.mcp as Record<string, unknown>).mine).toBeTruthy()
    expect((cfg.mcp as Record<string, unknown>).context7).toBeUndefined() // 已有 mcp 不再写预置
  })

  it('BOM 防御：带 BOM 的配置（外部编辑器写入）不被当损坏重置，用户字段保留', async () => {
    await initPreset(userData, presetRoot)
    // 模拟 PowerShell Set-Content -Encoding UTF8 写入：BOM 开头 + 自定义插件声明
    const custom = 'opencode-acp@latest'
    await fsp.writeFile(getConfigPath(userData), `\uFEFF${JSON.stringify({ plugin: [custom] })}`, 'utf-8')

    await ensurePresetConfig(userData, presetRoot)

    const cfg = JSON.parse(await fsp.readFile(getConfigPath(userData), 'utf-8')) as Record<
      string,
      unknown
    >
    const plugins = cfg.plugin as string[]
    expect(plugins).toContain(custom) // BOM 未导致配置重置，自定义插件保留
    expect(plugins.filter((p) => p.includes('fractal-guardian.js')).length).toBe(0) // guardian 临时停用不追加
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
    expect(plugins.filter((p) => p.includes('fractal-guardian.js')).length).toBe(0) // guardian 临时停用
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
    expect((cfg.plugin as string[]).filter((p) => p.includes('fractal-guardian.js')).length).toBe(0)
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
    expect((cfg.plugin as string[]).filter((p) => p.includes('fractal-guardian.js')).length).toBe(0)
    expect((cfg.instructions as string[]).filter((i) => i.includes(PRESET_INSTRUCTION_FILE)).length).toBe(1)
  })
})

// ── getPresetVersion（设置页「关于」预置包版本；双路径解析复用 getDefaultPresetRoot）──
describe('getPresetVersion', () => {
  it('源码路径：读取真实交付物 preset.json 的 version（v1.1.0，升级后新增 侦查兵/制图师 agent）', async () => {
    // 动态断言：getPresetVersion 必须与真实交付物 preset.json 的 version 一致（bump 版本时不用改测试）
    const presetRoot = getDefaultPresetRoot()
    const realVersion = JSON.parse(await fsp.readFile(join(presetRoot, 'preset.json'), 'utf-8')).version
    expect(await getPresetVersion()).toBe(realVersion)
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

  it('LOW 槽位跟随设置页轻量模型选择（settings.json smallModel=pro → 工匠/助理 替换成 pro）', async () => {
    // 模拟设置页已选 pro：settings.json smallModel=pro（resolveSmallModel 读此值）
    await fsp.writeFile(join(userData, 'settings.json'), JSON.stringify({ smallModel: 'deepseek/deepseek-v4-pro' }), 'utf-8')
    // 补建 LOW 槽位 agent（beforeEach fixture 仅建 工匠.md 代表 LOW 槽位；参谋为 inherit 槽位不属 LOW）
    await fsp.writeFile(join(getPresetTarget(userData), 'agents', '助理.md'), 'model: "ds/deepseek-v4-pro"\n', 'utf-8')
    await applyModelAliases(userData, 'deepseek/deepseek-v4-flash')
    const agentsDir = join(getPresetTarget(userData), 'agents')
    const gong = await fsp.readFile(join(agentsDir, '工匠.md'), 'utf-8')
    expect(gong).toContain('model: "deepseek/deepseek-v4-pro"')
    // 助理同为 LOW 槽位，一并替换
    const zhuli = await fsp.readFile(join(agentsDir, '助理.md'), 'utf-8')
    expect(zhuli).toContain('model: "deepseek/deepseek-v4-pro"')
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

// 契约清单（agents-manifest.json）驱动：oc-plus sync-to-fractal.mjs 生成，fractal 只消费
// manifest 缺失 → 回退 MODEL_SLOT_RULES 硬编码（旧预置包兼容）
describe('readAgentsManifest + 契约驱动槽位替换', () => {
  let presetRoot: string
  let userData: string

  beforeEach(async () => {
    presetRoot = await fsp.mkdtemp(join(tmpdir(), 'preset-manifest-'))
    userData = await fsp.mkdtemp(join(tmpdir(), 'preset-manifest-user-'))
    // 目标 agents 目录：含契约声明的全部 agent（侦查兵 anthropic 槽位）
    const agentsDir = join(getPresetTarget(userData), 'agents')
    await fsp.mkdir(agentsDir, { recursive: true })
    await fsp.writeFile(join(agentsDir, '双星.md'), 'model: "ds/deepseek-v4-pro"\n', 'utf-8')
    await fsp.writeFile(join(agentsDir, '工匠.md'), 'model: "ds/deepseek-v4-pro"\n', 'utf-8')
    await fsp.writeFile(join(agentsDir, '制图师.md'), 'model: "ds/deepseek-v4-pro"\n', 'utf-8')
    await fsp.writeFile(join(agentsDir, '侦查兵.md'), 'model: "ds/deepseek-v4-pro"\n', 'utf-8')
    // inherit 槽位 agent：无 model 行（应保持不被写入）
    await fsp.writeFile(join(agentsDir, '军师.md'), 'description: 战略远见\n', 'utf-8')
    await fsp.writeFile(join(agentsDir, '参谋.md'), 'description: 战术纠偏\n', 'utf-8')
  })

  afterEach(async () => {
    await fsp.rm(presetRoot, { recursive: true, force: true })
    await fsp.rm(userData, { recursive: true, force: true })
  })

  async function writeManifest(agents: Array<{ file: string; slot: string }>) {
    await fsp.writeFile(
      join(presetRoot, 'agents-manifest.json'),
      JSON.stringify({ version: '1.2.0', sourceCommit: 'abc123', generatedAt: '2026-08-09', agents }, null, 2),
      'utf-8'
    )
  }

  it('读取合法 manifest：返回全部槽位声明', async () => {
    await writeManifest([
      { file: '双星.md', slot: 'high' },
      { file: '侦查兵.md', slot: 'anthropic' },
      { file: '军师.md', slot: 'inherit' }
    ])
    const manifest = await readAgentsManifest(presetRoot)
    expect(manifest?.agents.length).toBe(3)
    expect(manifest?.agents[1]).toEqual({ file: '侦查兵.md', slot: 'anthropic' })
  })

  it('manifest 缺失/损坏 → null（回退硬编码）', async () => {
    expect(await readAgentsManifest(presetRoot)).toBeNull()
    // 损坏 JSON：写入非法内容后仍返回 null
    await fsp.writeFile(join(presetRoot, 'agents-manifest.json'), '{broken', 'utf-8')
    expect(await readAgentsManifest(presetRoot)).toBeNull()
  })

  it('契约驱动：anthropic 槽位替换为 ds-anthropic 模型、inherit 槽位不写 model 行', async () => {
    await writeManifest([
      { file: '双星.md', slot: 'high' },
      { file: '侦查兵.md', slot: 'anthropic' },
      { file: '军师.md', slot: 'inherit' },
      { file: '参谋.md', slot: 'inherit' }
    ])
    await applyModelAliases(userData, 'deepseek/deepseek-v4-flash', presetRoot)
    const agentsDir = join(getPresetTarget(userData), 'agents')
    const scout = await fsp.readFile(join(agentsDir, '侦查兵.md'), 'utf-8')
    expect(scout).toContain('model: "ds-anthropic/deepseek-v4-flash"')
    const teacher = await fsp.readFile(join(agentsDir, '军师.md'), 'utf-8')
    expect(teacher).not.toContain('model:')
    const canmou = await fsp.readFile(join(agentsDir, '参谋.md'), 'utf-8')
    expect(canmou).not.toContain('model:')
    // 契约声明外的 agent（工匠/制图师 未在 manifest 中）→ 不处理
    const gong = await fsp.readFile(join(agentsDir, '工匠.md'), 'utf-8')
    expect(gong).toContain('model: "ds/deepseek-v4-pro"')
  })

  it('契约优先于硬编码：manifest 将工匠声明为 vision 槽位 → 按契约替换', async () => {
    await writeManifest([
      { file: '双星.md', slot: 'high' },
      { file: '工匠.md', slot: 'vision' }
    ])
    await applyModelAliases(userData, 'deepseek/deepseek-v4-flash', presetRoot)
    const agentsDir = join(getPresetTarget(userData), 'agents')
    const gong = await fsp.readFile(join(agentsDir, '工匠.md'), 'utf-8')
    expect(gong).toContain('model: "moonshotai-cn/kimi-k3"')
  })

  it('契约覆盖完整槽位集合：high/low/vision/anthropic 全部替换', async () => {
    await writeManifest([
      { file: '双星.md', slot: 'high' },
      { file: '工匠.md', slot: 'low' },
      { file: '制图师.md', slot: 'vision' },
      { file: '侦查兵.md', slot: 'anthropic' }
    ])
    await applyModelAliases(userData, 'deepseek/deepseek-v4-pro', presetRoot)
    const agentsDir = join(getPresetTarget(userData), 'agents')
    const shuang = await fsp.readFile(join(agentsDir, '双星.md'), 'utf-8')
    expect(shuang).toContain('model: "deepseek/deepseek-v4-pro"')
    const gong = await fsp.readFile(join(agentsDir, '工匠.md'), 'utf-8')
    expect(gong).toContain('model: "deepseek/deepseek-v4-flash"')
    const zhi = await fsp.readFile(join(agentsDir, '制图师.md'), 'utf-8')
    expect(zhi).toContain('model: "moonshotai-cn/kimi-k3"')
    const scout = await fsp.readFile(join(agentsDir, '侦查兵.md'), 'utf-8')
    expect(scout).toContain('model: "ds-anthropic/deepseek-v4-flash"')
  })
})

describe('initPreset（B1 预置技能包开关 preset.skills.enabled）', () => {
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

  /** 目标 skills 目录存在性断言辅助 */
  async function skillExists(name: string): Promise<boolean> {
    try {
      await fsp.access(join(getPresetTarget(userData), 'skills', name))
      return true
    } catch {
      return false
    }
  }

  it('开关关闭（settings.json 显式 false）：已安装的预置技能被删、用户自定义技能保留', async () => {
    // 预置技能先正常初始化（默认开启）
    await initPreset(userData, presetRoot)
    // 用户自定义技能（混在共享 skills 目录）
    await fsp.mkdir(join(getPresetTarget(userData), 'skills', 'custom-skill'), { recursive: true })
    await fsp.writeFile(join(getPresetTarget(userData), 'skills', 'custom-skill', 'SKILL.md'), '# 用户自定义', 'utf-8')
    // 关闭开关（JSONC 合法）
    await fsp.writeFile(join(userData, 'settings.json'), JSON.stringify({ 'preset.skills.enabled': false }), 'utf-8')
    // 幂等命中 → syncPresetSkills 按预置清单精准删
    const result = await initPreset(userData, presetRoot)
    expect(result.initialized).toBe(false)
    expect(await skillExists('s1')).toBe(false)
    expect(await skillExists('custom-skill')).toBe(true)
  })

  it('开关重新开启：缺失的预置技能补拷、用户自定义技能不受影响', async () => {
    await initPreset(userData, presetRoot)
    await fsp.mkdir(join(getPresetTarget(userData), 'skills', 'custom-skill'), { recursive: true })
    // 关闭 → 删除预置技能
    await fsp.writeFile(join(userData, 'settings.json'), JSON.stringify({ 'preset.skills.enabled': false }), 'utf-8')
    await initPreset(userData, presetRoot)
    expect(await skillExists('s1')).toBe(false)
    // 开启 → 补拷缺失的预置技能
    await fsp.writeFile(join(userData, 'settings.json'), JSON.stringify({ 'preset.skills.enabled': true }), 'utf-8')
    await initPreset(userData, presetRoot)
    expect(await skillExists('s1')).toBe(true)
    expect(await skillExists('custom-skill')).toBe(true)
    // 补拷内容完整（SKILL.md 在）
    const restored = await fsp.readFile(join(getPresetTarget(userData), 'skills', 's1', 'SKILL.md'), 'utf-8')
    expect(restored).toContain('skill')
  })

  it('开关关闭时首次初始化：skills 目录不交付（agents/plugins 仍正常）', async () => {
    await fsp.writeFile(join(userData, 'settings.json'), JSON.stringify({ 'preset.skills.enabled': false }), 'utf-8')
    const result = await initPreset(userData, presetRoot)
    expect(result.initialized).toBe(true)
    expect(await skillExists('s1')).toBe(false)
    // agents/plugins 不受开关影响
    expect(await fsp.access(join(getPresetTarget(userData), 'agents', '双星.md')).then(() => true).catch(() => false)).toBe(true)
    expect(await fsp.access(join(getPresetTarget(userData), 'plugins', 'fractal-guardian.js')).then(() => true).catch(() => false)).toBe(true)
  })
})
