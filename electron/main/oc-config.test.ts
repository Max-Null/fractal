// oc-config 单元测试：merge 策略、权限规则生成、受管字段写入（不依赖 electron 运行时）
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getConfigPath, ensureConfig, buildPermissionRule, MANAGED_MODEL_LIMITS, resolveSmallModel, SMALL_MODEL } from './oc-config'

describe('getConfigPath', () => {
  it('返回 <userData>/config/opencode/opencode.json（对齐 XDG_CONFIG_HOME 隔离路径）', () => {
    expect(getConfigPath('C:\\oc-gui-data')).toBe('C:\\oc-gui-data\\config\\opencode\\opencode.json')
  })
})

describe('buildPermissionRule（权限模式 → OC 规则）', () => {
  it('default：敏感工具 ask，不含全放行通配', () => {
    const rule = buildPermissionRule('default')
    expect(rule['*']).toBeUndefined()
    for (const tool of ['read', 'edit', 'glob', 'grep', 'bash', 'task', 'lsp', 'external_directory', 'skill']) {
      expect(rule[tool]).toBe('ask')
    }
  })

  it('default + userDataDir：对象语法，仅 settings.json 文件 read/edit/write 例外 allow（阶段 6，不暴露 provider-configs.json）', () => {
    const rule = buildPermissionRule('default', 'C:\\oc-gui-data')
    const readRule = rule.read as Record<string, string>
    // catch-all ask 在前 + settings.json 文件路径 allow 在后（最后匹配生效）
    expect(readRule['*']).toBe('ask')
    expect(readRule['C:\\oc-gui-data\\settings.json']).toBe('allow')
    // 正反斜杠双规则保证 Windows 路径匹配命中
    expect(readRule['C:/oc-gui-data/settings.json']).toBe('allow')
    // 目录通配不 allow（API Key 明文在 provider-configs.json，同一目录——必须精确到文件）
    expect(readRule['C:\\oc-gui-data/*']).toBeUndefined()
    expect((rule.edit as Record<string, string>)['*']).toBe('ask')
    expect((rule.write as Record<string, string>)['C:\\oc-gui-data\\settings.json']).toBe('allow')
    expect((rule.external_directory as Record<string, string>)['*']).toBe('ask')
    // glob/grep 是目录扫描，单文件 allow 无意义——保持 ask
    expect(rule.glob).toBe('ask')
    expect(rule.grep).toBe('ask')
    // 无目录维度的工具保持字符串 ask
    expect(rule.bash).toBe('ask')
    expect(rule.skill).toBe('ask')
  })

  it('auto：全部 allow（userDataDir 不改变 auto 行为）', () => {
    expect(buildPermissionRule('auto')).toEqual({ '*': 'allow' })
    expect(buildPermissionRule('auto', 'C:\\data')).toEqual({ '*': 'allow' })
  })
})

describe('ensureConfig（merge 不覆盖用户字段）', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fsp.mkdtemp(join(tmpdir(), 'oc-config-test-'))
  })

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true })
  })

  it('首次写入：受管字段完整（apiKey/baseURL/models/model/small_model/permission 含 userData 例外）', async () => {
    await ensureConfig(dir, { apiKey: 'sk-test', permissionMode: 'default' })
    const cfg = JSON.parse(await fsp.readFile(getConfigPath(dir), 'utf-8')) as Record<string, unknown>
    const ds = (cfg.provider as Record<string, unknown>).deepseek as Record<string, unknown>
    const options = ds.options as { apiKey: string; baseURL: string }
    expect(options.apiKey).toBe('sk-test')
    expect(options.baseURL).toBe('https://api.deepseek.com/v1')
    expect(ds.models).toEqual(MANAGED_MODEL_LIMITS)
    expect(cfg.model).toBe('deepseek/deepseek-v4-pro')
    // small_model：标题生成等轻量任务专用（未配置 → OC ensureTitle 静默失败 → 标题永远「新会话」#14807）
    expect(cfg.small_model).toBe('deepseek/deepseek-v4-flash')
    // ensureConfig 注入 userDataDir（=dir）→ permission 为对象语法 + settings.json 目录例外
    expect(cfg.permission).toEqual(buildPermissionRule('default', dir))
    // 阶段 8：agent 定义由预置包 agents/*.md 提供，ensureConfig 不再写内联占位（同名会被 OC 双层 merge 污染）
    expect(cfg.agent).toBeUndefined()
    const readRule = (cfg.permission as Record<string, unknown>).read as Record<string, string>
    expect(readRule['*']).toBe('ask')
    expect(Object.values(readRule)).toContain('allow')
  })

  it('保留用户其他字段（agent/ui 等不被 merge 覆盖）', async () => {
    const file = getConfigPath(dir)
    await fsp.mkdir(join(dir, 'config', 'opencode'), { recursive: true })
    await fsp.writeFile(
      file,
      JSON.stringify({ agent: { 双星: { description: '用户自定义' } }, ui: { theme: 'dark' } }),
      'utf-8'
    )
    await ensureConfig(dir, { apiKey: 'sk-test', permissionMode: 'auto' })
    const cfg = JSON.parse(await fsp.readFile(file, 'utf-8')) as Record<string, unknown>
    expect(cfg.agent).toEqual({ 双星: { description: '用户自定义' } })
    expect(cfg.ui).toEqual({ theme: 'dark' })
    expect(cfg.permission).toEqual({ '*': 'allow' })
  })

  it('受管字段覆盖旧值（apiKey 更新）', async () => {
    const file = getConfigPath(dir)
    await fsp.mkdir(join(dir, 'config', 'opencode'), { recursive: true })
    await fsp.writeFile(file, JSON.stringify({ provider: { ds: { options: { apiKey: 'old-key' } } } }), 'utf-8')
    await ensureConfig(dir, { apiKey: 'new-key', permissionMode: 'default' })
    const cfg = JSON.parse(await fsp.readFile(file, 'utf-8')) as Record<string, unknown>
    const ds = (cfg.provider as Record<string, unknown>).deepseek as { options: { apiKey: string } }
    expect(ds.options.apiKey).toBe('new-key')
  })

  it('损坏 JSON 不崩溃：从空配置重建受管字段', async () => {
    const file = getConfigPath(dir)
    await fsp.mkdir(join(dir, 'config', 'opencode'), { recursive: true })
    await fsp.writeFile(file, '{ not valid', 'utf-8')
    await ensureConfig(dir, { apiKey: 'sk-test', permissionMode: 'default' })
    const cfg = JSON.parse(await fsp.readFile(file, 'utf-8')) as Record<string, unknown>
    expect(cfg.model).toBe('deepseek/deepseek-v4-pro')
  })

  it('small_model 跟随设置页显式选择（settings.json smallModel=pro → 写入 opencode.json）', async () => {
    // 模拟设置页已保存：settings.json 显式选 deepseek-v4-pro
    await fsp.writeFile(join(dir, 'settings.json'), JSON.stringify({ smallModel: 'deepseek/deepseek-v4-pro' }), 'utf-8')
    await ensureConfig(dir, { apiKey: 'sk-test', permissionMode: 'default' })
    const cfg = JSON.parse(await fsp.readFile(getConfigPath(dir), 'utf-8')) as Record<string, unknown>
    expect(cfg.small_model).toBe('deepseek/deepseek-v4-pro')
  })

  it('small_model 跟随主模型（settings.json smallModel="" → 不写字段，OC 用主模型兜底）', async () => {
    // 用户选「跟随主模型」：smallModel 显式空 → ensureConfig 不写 small_model 字段（避免上次显式选择残留）
    await fsp.writeFile(join(dir, 'settings.json'), JSON.stringify({ smallModel: '' }), 'utf-8')
    await ensureConfig(dir, { apiKey: 'sk-test', permissionMode: 'default' })
    const cfg = JSON.parse(await fsp.readFile(getConfigPath(dir), 'utf-8')) as Record<string, unknown>
    expect(cfg.small_model).toBeUndefined()
  })

  it('small_model 从显式值切回跟随主模型：删除旧字段（不残留上次选择）', async () => {
    const file = getConfigPath(dir)
    await fsp.mkdir(join(dir, 'config', 'opencode'), { recursive: true })
    // 旧配置：small_model 已写 flash（之前显式选择过）
    await fsp.writeFile(file, JSON.stringify({ small_model: 'deepseek/deepseek-v4-flash' }), 'utf-8')
    await fsp.writeFile(join(dir, 'settings.json'), JSON.stringify({ smallModel: '' }), 'utf-8')
    await ensureConfig(dir, { apiKey: 'sk-test', permissionMode: 'default' })
    const cfg = JSON.parse(await fsp.readFile(file, 'utf-8')) as Record<string, unknown>
    expect(cfg.small_model).toBeUndefined()
  })

  it('moonshotai-cn：provider 定义恒写（key 空时 models 也写——provider 可被 serve 识别，填 key 即通）', async () => {
    // 老文件只有 deepseek 条目（或 provider-configs.json 不存在）→ moonshotai-cn 用空 key
    await ensureConfig(dir, { apiKey: 'sk-test', permissionMode: 'default' })
    const cfg = JSON.parse(await fsp.readFile(getConfigPath(dir), 'utf-8')) as Record<string, unknown>
    const kimi = (cfg.provider as Record<string, unknown>)['moonshotai-cn'] as { models: unknown; options: { apiKey: string } }
    expect(kimi.models).toEqual({ 'kimi-k3': { options: { reasoningEffort: 'low' } } })
    expect(kimi.options.apiKey).toBe('')
    // ds-anthropic：侦查兵专用 provider（Anthropic 端点 + deepseek 同 key + 同 models）
    const anthropic = (cfg.provider as Record<string, unknown>)['ds-anthropic'] as { npm?: string; options: { apiKey: string; baseURL: string } }
    expect(anthropic.npm).toBe('@ai-sdk/anthropic')
    expect(anthropic.options.apiKey).toBe('sk-test')
    expect(anthropic.options.baseURL).toBe('https://api.deepseek.com/anthropic')
    // deepseek ����Ӱ�죨˫ provider ���棩
    const ds = (cfg.provider as Record<string, unknown>).deepseek as { options: { apiKey: string } }
    expect(ds.options.apiKey).toBe('sk-test')
  })

  it('moonshotai-cn：provider-configs.json 已有 key → 写入 options.apiKey（key 变化联动链路）', async () => {
    // 模拟设置页已保存 kimi key（saveProviderConfig 落盘 provider-configs.json）
    await fsp.writeFile(
      join(dir, 'provider-configs.json'),
      JSON.stringify({ deepseek: { apiKey: 'sk-ds', baseUrl: '', model: '' }, 'moonshotai-cn': { apiKey: 'sk-kimi' } }),
      'utf-8'
    )
    await ensureConfig(dir, { apiKey: 'sk-ds', permissionMode: 'default' })
    const cfg = JSON.parse(await fsp.readFile(getConfigPath(dir), 'utf-8')) as Record<string, unknown>
    const kimi = (cfg.provider as Record<string, unknown>)['moonshotai-cn'] as { options: { apiKey: string } }
    expect(kimi.options.apiKey).toBe('sk-kimi')
  })

  it('moonshotai-cn：老文件只有 deepseek 条目 → moonshotai-cn 仍写 models 定义（向后兼容，key 空）', async () => {
    // 老结构 provider-configs.json（只有 deepseek）→ 读取容错，moonshotai-cn 空 key 但 models 定义在
    await fsp.writeFile(
      join(dir, 'provider-configs.json'),
      JSON.stringify({ deepseek: { apiKey: 'sk-ds', baseUrl: '', model: '' } }),
      'utf-8'
    )
    await ensureConfig(dir, { apiKey: 'sk-ds', permissionMode: 'default' })
    const cfg = JSON.parse(await fsp.readFile(getConfigPath(dir), 'utf-8')) as Record<string, unknown>
    const kimi = (cfg.provider as Record<string, unknown>)['moonshotai-cn'] as { models: unknown; options: { apiKey: string } }
    expect(kimi.models).toEqual({ 'kimi-k3': { options: { reasoningEffort: 'low' } } })
    expect(kimi.options.apiKey).toBe('')
  })
})

describe('resolveSmallModel（LOW 槽位：读设置页 settings.json smallModel 字段）', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fsp.mkdtemp(join(tmpdir(), 'oc-smallmodel-'))
  })

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true })
  })

  it('缺省：settings.json 无 smallModel 字段 → SMALL_MODEL 常量', async () => {
    await fsp.writeFile(join(dir, 'settings.json'), JSON.stringify({ dataMode: 'isolated' }), 'utf-8')
    expect(await resolveSmallModel(dir)).toBe(SMALL_MODEL)
  })

  it('显式值：settings.json smallModel=pro → 返回 pro 全名', async () => {
    await fsp.writeFile(join(dir, 'settings.json'), JSON.stringify({ smallModel: 'deepseek/deepseek-v4-pro' }), 'utf-8')
    expect(await resolveSmallModel(dir)).toBe('deepseek/deepseek-v4-pro')
  })

  it('显式空：settings.json smallModel=""（跟随主模型）→ 返回空字符串（ensureConfig 据此不写字段）', async () => {
    await fsp.writeFile(join(dir, 'settings.json'), JSON.stringify({ smallModel: '' }), 'utf-8')
    expect(await resolveSmallModel(dir)).toBe('')
  })

  it('损坏容错：settings.json 非法 JSON → SMALL_MODEL 常量（解析失败不抛错）', async () => {
    await fsp.writeFile(join(dir, 'settings.json'), '{ not valid', 'utf-8')
    expect(await resolveSmallModel(dir)).toBe(SMALL_MODEL)
  })

  it('文件不存在 → SMALL_MODEL 常量（从未配置过，标题生成等轻量任务不能断）', async () => {
    expect(await resolveSmallModel(dir)).toBe(SMALL_MODEL)
  })

  it('字段非字符串（损坏值）→ SMALL_MODEL 常量', async () => {
    await fsp.writeFile(join(dir, 'settings.json'), JSON.stringify({ smallModel: 42 }), 'utf-8')
    expect(await resolveSmallModel(dir)).toBe(SMALL_MODEL)
  })
})


