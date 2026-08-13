// settings.ts 单元测试：默认值/JSONC 解析/schema 校验/非法值回退/读写/文件监听（不依赖 electron 运行时）
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DEFAULT_SETTINGS,
  getSettingsPath,
  parseAndValidate,
  loadSettings,
  saveSettings,
  getConfig,
  getSchema,
  getSettingsFileExists,
  watchSettingsFile,
} from './settings'
import { getConfigPath } from './oc-config'

describe('DEFAULT_SETTINGS（方案 3.8.2 字段全集）', () => {
  it('包含全部 19 个字段与默认值', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      'ui.theme': 'dark',
      'ui.language': 'zh',
      'ui.messageLayout': 'split',
      'ui.nickname': '',
      'ui.avatar': '',
      'ui.showThinking': true,
      'ui.avatarImage': '',
      'ui.notifications': {
        enabled: false,
        replyDone: true,
        engineError: false,
        permissionPending: false,
        subtaskDone: false,
      },
      'agentModelOverrides': {},
      'deepseek.model': 'deepseek-v4-flash',
      'agent.permissionMode': 'default',
      'agent.effort': 'high',
      'agent.contextLimit': 0,
      'preset.skills.enabled': true,
      'preset.mcp.filesystem': true,
      'engine.opencodePath': '',
      'engine.logLevel': 'INFO',
      'dataMode': 'isolated',
      'smallModel': '',
    })
  })

  it('getSchema 返回 schema（含 ui.theme 枚举）', () => {
    const schema = getSchema()
    const props = schema.properties as Record<string, { enum?: string[]; default?: unknown }>
    expect(props['ui.theme']).toBeDefined()
    expect(props['ui.theme'].enum).toEqual(['dark', 'light'])
    expect(props['ui.theme'].default).toBe('dark')
    expect(schema.additionalProperties).toBe(true)
  })

  it('getSchema 含 dataMode（enum shared/isolated，default isolated）', () => {
    const schema = getSchema()
    const props = schema.properties as Record<string, { enum?: string[]; default?: unknown }>
    expect(props['dataMode']).toBeDefined()
    expect(props['dataMode'].enum).toEqual(['shared', 'isolated'])
    expect(props['dataMode'].default).toBe('isolated')
  })

  it('getSchema 含 smallModel（enum 空/两个显式模型全名，default 空=跟随主模型）', () => {
    const schema = getSchema()
    const props = schema.properties as Record<string, { enum?: string[]; default?: unknown }>
    expect(props['smallModel']).toBeDefined()
    expect(props['smallModel'].enum).toEqual(['', 'deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-pro'])
    expect(props['smallModel'].default).toBe('')
  })

  it('getSchema 含 4 个新字段（思考开关/头像图/子agent覆盖/通知场景，default 与 DEFAULT_SETTINGS 一致）', () => {
    const schema = getSchema()
    const props = schema.properties as Record<
      string,
      { type?: string; default?: unknown; properties?: Record<string, unknown> }
    >
    expect(props['ui.showThinking']).toMatchObject({ type: 'boolean', default: true })
    expect(props['ui.avatarImage']).toMatchObject({ type: 'string', default: '' })
    expect(props['agentModelOverrides']).toMatchObject({ type: 'object', default: {} })
    expect(props['ui.notifications']).toMatchObject({
      type: 'object',
      default: { enabled: false, replyDone: true, engineError: false, permissionPending: false, subtaskDone: false },
    })
  })
})

describe('parseAndValidate（JSONC 解析 + schema 校验）', () => {
  it('空对象 → 空配置（缺失字段不注入默认，消费方用默认兜底），无 warning', () => {
    const { config, warnings } = parseAndValidate('{}')
    expect(config).toEqual({})
    expect(warnings).toEqual([])
  })

  it('合法 JSONC（带注释）→ 值正确覆盖，无 warning', () => {
    const text = `
      {
        // 界面主题
        "ui.theme": "light",
        "ui.language": "en",
        "deepseek.model": "deepseek-v4-pro",
        "agent.permissionMode": "auto",
        "agent.effort": "medium"
      }`
    const { config, warnings } = parseAndValidate(text)
    expect(warnings).toEqual([])
    expect(config['ui.theme']).toBe('light')
    expect(config['ui.language']).toBe('en')
    expect(config['deepseek.model']).toBe('deepseek-v4-pro')
    expect(config['agent.permissionMode']).toBe('auto')
    expect(config['agent.effort']).toBe('medium')
    // 未指定的字段不注入（消费方用 DEFAULT 兜底，不覆盖表单值）
    expect(config['preset.skills.enabled']).toBeUndefined()
  })

  it('非法枚举 → 回退默认 + warning（ui.theme: "red"）', () => {
    const { config, warnings } = parseAndValidate('{ "ui.theme": "red" }')
    expect(config['ui.theme']).toBe('dark')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('ui.theme')
    expect(warnings[0]).toContain('red')
    expect(warnings[0]).toContain('dark')
  })

  it('dataMode 合法值保留（isolated/shared）', () => {
    const { config, warnings } = parseAndValidate('{ "dataMode": "isolated" }')
    expect(config['dataMode']).toBe('isolated')
    expect(warnings).toEqual([])
    const r2 = parseAndValidate('{ "dataMode": "shared" }')
    expect(r2.config['dataMode']).toBe('shared')
    expect(r2.warnings).toEqual([])
  })

  it('dataMode 非法值 → 回退默认 isolated + warning', () => {
    const { config, warnings } = parseAndValidate('{ "dataMode": "public" }')
    expect(config['dataMode']).toBe('isolated')
    expect(warnings.some((w) => w.includes('dataMode'))).toBe(true)
  })

  it('类型错误 → 回退默认 + warning（agent.contextLimit: "abc"）', () => {
    const { config, warnings } = parseAndValidate('{ "agent.contextLimit": "abc" }')
    expect(config['agent.contextLimit']).toBe(0)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('agent.contextLimit')
  })

  it('未知 key 忽略（向前兼容，不产生 warning）', () => {
    const { config, warnings } = parseAndValidate('{ "ui.theme": "light", "future.key": "whatever" }')
    expect(config['ui.theme']).toBe('light')
    expect(config['future.key']).toBeUndefined()
    expect(warnings).toEqual([])
  })

  it('语法错误 → 空配置（不覆盖现有表单值）+ 语法 warning', () => {
    const { config, warnings } = parseAndValidate('{ "ui.theme": "light", ')
    expect(config).toEqual({})
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('语法错误')
  })

  it('顶层非对象 → 空配置 + warning', () => {
    const { config, warnings } = parseAndValidate('[1, 2, 3]')
    expect(config).toEqual({})
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('顶层必须是 JSON 对象')
  })

  it('部分非法部分合法：非法回退，合法保留', () => {
    const text = '{ "ui.theme": "light", "agent.effort": "turbo", "agent.contextLimit": 128000 }'
    const { config, warnings } = parseAndValidate(text)
    expect(config['ui.theme']).toBe('light')
    expect(config['agent.contextLimit']).toBe(128000)
    // effort "turbo" 不在枚举 → 回退默认 high
    expect(config['agent.effort']).toBe('high')
    expect(warnings.some((w) => w.includes('agent.effort'))).toBe(true)
  })

  it('parseAndValidate 保留 4 个新字段（思考开关/头像图/子agent覆盖/通知场景）', () => {
    const text = JSON.stringify({
      'ui.showThinking': false,
      'ui.avatarImage': 'avatar.webp',
      'agentModelOverrides': { '双星': 'deepseek/deepseek-v4-pro' },
      'ui.notifications': { enabled: true, replyDone: false, engineError: true, permissionPending: false, subtaskDone: true },
    })
    const { config, warnings } = parseAndValidate(text)
    expect(warnings).toEqual([])
    expect(config['ui.showThinking']).toBe(false)
    expect(config['ui.avatarImage']).toBe('avatar.webp')
    expect(config['agentModelOverrides']).toEqual({ '双星': 'deepseek/deepseek-v4-pro' })
    expect(config['ui.notifications']).toEqual({
      enabled: true,
      replyDone: false,
      engineError: true,
      permissionPending: false,
      subtaskDone: true,
    })
  })

  it('agentModelOverrides 非对象值 → 回退默认 {} + warning（子agent覆盖只接受对象）', () => {
    const { config, warnings } = parseAndValidate('{ "agentModelOverrides": "not-an-object" }')
    expect(config['agentModelOverrides']).toEqual({})
    expect(warnings.some((w) => w.includes('agentModelOverrides'))).toBe(true)
  })

  it('ui.notifications 嵌套字段类型错误 → 整字段回退默认 + warning', () => {
    const { config, warnings } = parseAndValidate('{ "ui.notifications": { "enabled": "yes" } }')
    expect(config['ui.notifications']).toEqual({
      enabled: false,
      replyDone: true,
      engineError: false,
      permissionPending: false,
      subtaskDone: false,
    })
    expect(warnings.some((w) => w.includes('ui.notifications'))).toBe(true)
  })
})

describe('loadSettings / saveSettings / getConfig（文件读写）', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fsp.mkdtemp(join(tmpdir(), 'settings-test-'))
    // 重置内存态为默认（跨用例隔离：saveSettings 引擎快照/内存态不残留）
    await loadSettings(dir)
  })

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true })
  })

  it('loadSettings：文件不存在 → 默认值', async () => {
    const r = await loadSettings(dir)
    expect(r.config).toEqual(DEFAULT_SETTINGS)
    expect(r.warnings).toEqual([])
    expect(getSettingsPath(dir)).toBe(join(dir, 'settings.json'))
  })

  it('getSettingsFileExists：无文件 false → saveSettings 后 true → 删除文件后 loadSettings 回 false（默认态区分）', async () => {
    await loadSettings(dir)
    expect(getSettingsFileExists()).toBe(false)  // 首次启动：默认态（前端不覆盖表单主题的前提）
    await saveSettings(dir, '{ "ui.theme": "light" }')
    expect(getSettingsFileExists()).toBe(true)   // 写盘后：显式配置态
    await fsp.rm(getSettingsPath(dir))
    await loadSettings(dir)
    expect(getSettingsFileExists()).toBe(false)  // 文件被删 → 回默认态
  })

  it('saveSettings：写盘 + 更新内存态 + getConfig 读回', async () => {
    const text = '{ "ui.theme": "light", "deepseek.model": "deepseek-v4-pro" }'
    const r = await saveSettings(dir, text)
    expect(r).toEqual({ ok: true, warnings: [] })
    const onDisk = await fsp.readFile(getSettingsPath(dir), 'utf-8')
    expect(onDisk).toBe(text)
    const cfg = getConfig()
    expect(cfg.config['ui.theme']).toBe('light')
    expect(cfg.jsoncText).toBe(text)
  })

  it('saveSettings：非法值写盘但返回 warning（不回写默认到文件——保留用户原文）', async () => {
    const text = '{ "ui.theme": "red" }'
    const r = await saveSettings(dir, text)
    expect(r.ok).toBe(true)
    expect(r.warnings).toHaveLength(1)
    // 文件保留用户原文（JSONC 编辑器所见即所得），校验结果只在内存态/警告中体现
    const onDisk = await fsp.readFile(getSettingsPath(dir), 'utf-8')
    expect(onDisk).toBe(text)
    expect(getConfig().config['ui.theme']).toBe('dark')
  })

  it('loadSettings：读回已保存的 JSONC（注释保留）', async () => {
    const text = '{\n  // 注释\n  "ui.theme": "light"\n}'
    await saveSettings(dir, text)
    const r = await loadSettings(dir)
    expect(r.config['ui.theme']).toBe('light')
    expect(r.jsoncText).toContain('// 注释')
  })

  it('saveSettings 引擎联动：引擎字段变化 → 同步 opencode.json（含 userData 权限例外）', async () => {
    await saveSettings(dir, '{ "deepseek.model": "deepseek-v4-pro" }')
    const oc = JSON.parse(await fsp.readFile(getConfigPath(dir), 'utf-8')) as { permission: Record<string, unknown> }
    expect(oc.permission).toBeDefined()
    // settings.json 目录（userData = dir）在 read 规则中有 allow 例外（方案 3.8.4 权限预置）
    const readRule = oc.permission.read as Record<string, string>
    expect(readRule['*']).toBe('ask')
    expect(Object.values(readRule)).toContain('allow')
  })

  it('saveSettings 引擎联动：引擎字段未变化 → 不写 opencode.json', async () => {
    await saveSettings(dir, '{ "ui.theme": "light" }')
    // ui.theme 是纯 UI 项，引擎快照未变 → ensureConfig 不执行 → opencode.json 不存在
    await expect(fsp.access(getConfigPath(dir))).rejects.toThrow()
  })

  it('saveSettings 引擎联动：smallModel 显式值 → 同步 opencode.json 的 small_model', async () => {
    // 设置页轻量模型选 pro：smallModel 引擎快照变化 → ensureConfig → resolveSmallModel 读新值写入
    await saveSettings(dir, '{ "smallModel": "deepseek/deepseek-v4-pro" }')
    const oc = JSON.parse(await fsp.readFile(getConfigPath(dir), 'utf-8')) as { small_model?: string }
    expect(oc.small_model).toBe('deepseek/deepseek-v4-pro')
  })

  it('saveSettings 引擎联动：smallModel 从显式值切回空 → opencode.json 删除 small_model（跟随主模型）', async () => {
    // 先保存显式 pro（触发联动写入），再切回跟随主模型（空）
    await saveSettings(dir, '{ "smallModel": "deepseek/deepseek-v4-pro" }')
    await saveSettings(dir, '{ "smallModel": "" }')
    const oc = JSON.parse(await fsp.readFile(getConfigPath(dir), 'utf-8')) as { small_model?: string }
    expect(oc.small_model).toBeUndefined()
  })

  it('saveSettings 引擎联动：agentModelOverrides 变化 → 触发引擎同步（opencode.json 被写）', async () => {
    // 设置页「子 agent 模型覆盖」变更 → 引擎快照（ENGINE_KEYS）变化 → ensureConfig 重跑
    // （applyModelAliases 的联动由 ipc 层触发，见 2026-08-13 设置页重构方案——settings/preset 互相 import 会循环）
    await saveSettings(dir, '{ "agentModelOverrides": { "双星": "deepseek/deepseek-v4-pro" } }')
    const oc = JSON.parse(await fsp.readFile(getConfigPath(dir), 'utf-8')) as { permission: Record<string, unknown> }
    expect(oc.permission).toBeDefined()
  })
})

describe('watchSettingsFile（文件监听 → config-changed）', () => {
  let dir: string
  let stop: (() => void) | null = null

  beforeEach(async () => {
    dir = await fsp.mkdtemp(join(tmpdir(), 'settings-watch-'))
    await loadSettings(dir)
  })

  afterEach(async () => {
    stop?.()
    stop = null
    await fsp.rm(dir, { recursive: true, force: true })
  })

  it('文件变更 → 防抖后回调收到新配置', async () => {
    const received: Array<{ config: Record<string, unknown>; warnings: string[] }> = []
    stop = watchSettingsFile(dir, (payload) => received.push(payload))
    // 先建文件（监听启动时文件不存在 → 默认值兜底，不崩溃）
    await fsp.writeFile(getSettingsPath(dir), '{ "ui.theme": "dark" }', 'utf-8')
    await new Promise((r) => setTimeout(r, 120)) // 让 watcher 看到首版
    await fsp.writeFile(getSettingsPath(dir), '{ "ui.theme": "light" }', 'utf-8')
    // 防抖 300ms + 异步加载余量
    await new Promise((r) => setTimeout(r, 600))
    expect(received.length).toBeGreaterThan(0)
    const last = received[received.length - 1]
    expect(last.config['ui.theme']).toBe('light')
    expect(last.warnings).toEqual([])
  })

  it('非法值写入 → 回调收到回退 + warning', async () => {
    const received: Array<{ config: Record<string, unknown>; warnings: string[] }> = []
    stop = watchSettingsFile(dir, (payload) => received.push(payload))
    await fsp.writeFile(getSettingsPath(dir), '{ "ui.theme": "dark" }', 'utf-8')
    await new Promise((r) => setTimeout(r, 120))
    await fsp.writeFile(getSettingsPath(dir), '{ "ui.theme": "red" }', 'utf-8')
    await new Promise((r) => setTimeout(r, 600))
    expect(received.length).toBeGreaterThan(0)
    const last = received[received.length - 1]
    expect(last.config['ui.theme']).toBe('dark')
    expect(last.warnings.some((w) => w.includes('ui.theme'))).toBe(true)
  })

  it('stop 后不再收到回调', async () => {
    const received: Array<{ config: Record<string, unknown> }> = []
    stop = watchSettingsFile(dir, (payload) => received.push(payload))
    // 先等监听生效并收到一次回调（文件创建 → 防抖 300ms → reload）
    await fsp.writeFile(getSettingsPath(dir), '{ "ui.theme": "dark" }', 'utf-8')
    await new Promise((r) => setTimeout(r, 600))
    expect(received.length).toBeGreaterThan(0)
    const countBefore = received.length
    stop()
    stop = null
    // stop 后再写一次，不应新增（watcher 已 close + listener 已移除）
    await fsp.writeFile(getSettingsPath(dir), '{ "ui.theme": "light" }', 'utf-8')
    await new Promise((r) => setTimeout(r, 600))
    expect(received.length).toBe(countBefore)
  })
})
