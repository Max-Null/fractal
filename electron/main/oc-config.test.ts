// oc-config 单元测试：merge 策略、权限规则生成、受管字段写入（不依赖 electron 运行时）
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getConfigPath, ensureConfig, buildPermissionRule, MANAGED_MODEL_LIMITS } from './oc-config'

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

  it('auto：全部 allow', () => {
    expect(buildPermissionRule('auto')).toEqual({ '*': 'allow' })
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

  it('首次写入：受管字段完整（apiKey/baseURL/models/model/permission）', async () => {
    await ensureConfig(dir, { apiKey: 'sk-test', permissionMode: 'default' })
    const cfg = JSON.parse(await fsp.readFile(getConfigPath(dir), 'utf-8')) as Record<string, unknown>
    const ds = (cfg.provider as Record<string, unknown>).deepseek as Record<string, unknown>
    const options = ds.options as { apiKey: string; baseURL: string }
    expect(options.apiKey).toBe('sk-test')
    expect(options.baseURL).toBe('https://api.deepseek.com/v1')
    expect(ds.models).toEqual(MANAGED_MODEL_LIMITS)
    expect(cfg.model).toBe('deepseek/deepseek-v4-pro')
    expect(cfg.permission).toEqual(buildPermissionRule('default'))
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
})


