// server-manager B1 测试：engine.opencodePath 自定义路径 + engine.logLevel 日志级别参数
// 纯函数直测（resolveOpencodeBin / buildServeArgs 已导出）——不 mock spawn、不真启动：
// vitest 对 node: 内置模块的 vi.mock 不生效（实测 node.exe 被真实执行，Cannot find module 'serve'），
// 且 spawn 参数无法经 ESM namespace 断言（Cannot spy on export "spawn"）
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveOpencodeBin, buildServeArgs } from './server-manager'
import { loadSettings } from './settings'

describe('B1 resolveOpencodeBin（engine.opencodePath 自定义路径）', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fsp.mkdtemp(join(tmpdir(), 'oc-b1-'))
  })

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it('自定义路径存在（非空且可访问）→ 最高优先返回', async () => {
    await fsp.writeFile(join(dir, 'settings.json'), JSON.stringify({ 'engine.opencodePath': process.execPath }), 'utf-8')
    await loadSettings(dir)
    await expect(resolveOpencodeBin()).resolves.toBe(process.execPath)
  })

  it('自定义路径无效（不存在）→ 回落内置 sidecar / 系统解析，不抛错', async () => {
    const bad = join(dir, 'no-such-opencode.exe')
    await fsp.writeFile(join(dir, 'settings.json'), JSON.stringify({ 'engine.opencodePath': bad }), 'utf-8')
    await loadSettings(dir)
    const bin = await resolveOpencodeBin()
    expect(bin).not.toBe(bad)
    // 回落路径是真实存在的可执行（sidecar 或系统安装），非自定义坏路径
    expect(typeof bin).toBe('string')
    expect(bin.length).toBeGreaterThan(0)
  })

  it('无配置（settings.json 缺失）→ 默认 sidecar 解析路径', async () => {
    await loadSettings(dir) // 无 settings.json → DEFAULT 配置（opencodePath=''）
    const bin = await resolveOpencodeBin()
    expect(typeof bin).toBe('string')
    expect(bin.length).toBeGreaterThan(0)
  })
})

describe('B1 buildServeArgs（engine.logLevel 日志级别参数）', () => {
  it('白名单内（DEBUG/INFO/WARN/ERROR）→ 追加 --log-level <level>', () => {
    expect(buildServeArgs('DEBUG')).toEqual(['serve', '--port', '0', '--hostname', '127.0.0.1', '--print-logs', '--log-level', 'DEBUG'])
    expect(buildServeArgs('INFO')).toContain('--log-level')
    expect(buildServeArgs('WARN')).toContain('--log-level')
    expect(buildServeArgs('ERROR')).toContain('--log-level')
  })

  it('白名单外 / 缺失 → 不加参（serve 默认级别）', () => {
    expect(buildServeArgs('VERBOSE')).not.toContain('--log-level')
    expect(buildServeArgs(undefined)).not.toContain('--log-level')
    expect(buildServeArgs('')).not.toContain('--log-level')
    expect(buildServeArgs(123)).not.toContain('--log-level')
  })
})
