import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateUserDataIfNeeded } from './migrate-userdata'

describe('migrateUserDataIfNeeded（userData 改名一次性迁移）', () => {
  let root: string
  let oldDir: string
  let newDir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'migrate-test-'))
    oldDir = join(root, 'oc-gui')
    newDir = join(root, 'fractal')
    // 构造旧目录内容：settings.json + ui-settings.json + config/opencode/ + logs/
    mkdirSync(join(oldDir, 'config', 'opencode'), { recursive: true })
    mkdirSync(join(oldDir, 'logs'), { recursive: true })
    writeFileSync(join(oldDir, 'settings.json'), '{"dataMode":"shared"}', 'utf8')
    writeFileSync(join(oldDir, 'config', 'opencode', 'opencode.json'), '{"model":"deepseek/deepseek-v4-pro"}', 'utf8')
    writeFileSync(join(oldDir, 'logs', 'serve.log'), '[19:00:00] hello\n', 'utf8')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('旧目录存在且新目录不存在 → 全量复制 + 写迁移标记', () => {
    const r = migrateUserDataIfNeeded(newDir, oldDir)
    expect(r.migrated).toBe(true)
    expect(existsSync(join(newDir, 'settings.json'))).toBe(true)
    expect(readFileSync(join(newDir, 'settings.json'), 'utf8')).toContain('"dataMode":"shared"')
    expect(existsSync(join(newDir, 'config', 'opencode', 'opencode.json'))).toBe(true)
    expect(existsSync(join(newDir, 'logs', 'serve.log'))).toBe(true)
    expect(existsSync(join(newDir, '.migrated-from-oc-gui'))).toBe(true)
    // 旧目录保留（保守不删）
    expect(existsSync(join(oldDir, 'settings.json'))).toBe(true)
  })

  it('新目录已存在 → 跳过（不覆盖新数据）', () => {
    mkdirSync(newDir, { recursive: true })
    writeFileSync(join(newDir, 'fresh.json'), '{}', 'utf8')
    const r = migrateUserDataIfNeeded(newDir, oldDir)
    expect(r.migrated).toBe(false)
    expect(existsSync(join(newDir, 'fresh.json'))).toBe(true)
    expect(existsSync(join(newDir, 'settings.json'))).toBe(false)
  })

  it('已迁移过（标记存在）→ 幂等跳过', () => {
    migrateUserDataIfNeeded(newDir, oldDir)
    // 迁移后旧目录再更新，二次调用不应再次复制
    writeFileSync(join(oldDir, 'new.txt'), 'x', 'utf8')
    const r = migrateUserDataIfNeeded(newDir, oldDir)
    expect(r.migrated).toBe(false)
    expect(existsSync(join(newDir, 'new.txt'))).toBe(false)
  })

  it('旧目录不存在 → 跳过', () => {
    const r = migrateUserDataIfNeeded(newDir, join(root, 'nonexistent'))
    expect(r.migrated).toBe(false)
    expect(existsSync(newDir)).toBe(false)
  })

  it('路径相同 → 跳过（防自迁移）', () => {
    const r = migrateUserDataIfNeeded(oldDir, oldDir)
    expect(r.migrated).toBe(false)
  })
})
