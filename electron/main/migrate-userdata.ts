import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATE_MARK = '.migrated-from-oc-gui'

/**
 * userData 目录改名一次性迁移（2026-08-08 产品名对齐：oc-gui → fractal）：
 * 新路径（%APPDATA%\fractal）首次启动时，若旧路径（%APPDATA%\oc-gui）存在且新路径不存在 → 全量复制
 * （settings.json / ui-settings.json / provider-configs.json / config / logs / session-logs 等全部内容）→ 写迁移标记。
 * - 旧目录不删除（保守：迁移后用户确认可手动清理）
 * - 幂等：新目录已有迁移标记 / 新目录已存在 / 旧目录不存在 → 跳过
 * - e2e（临时 userData）自动跳过（新目录已存在或路径不同）
 * @param newDir 当前 userData（迁移目标）
 * @param oldDir 旧 userData（oc-gui，迁移来源）
 */
export function migrateUserDataIfNeeded(newDir: string, oldDir: string): { migrated: boolean; copied?: number } {
  if (!oldDir || !newDir || newDir === oldDir) return { migrated: false }
  // 已迁移过（标记文件存在）或新目录已被使用（存在内容）→ 跳过，避免覆盖新数据
  if (existsSync(join(newDir, MIGRATE_MARK))) return { migrated: false }
  if (!existsSync(oldDir) || existsSync(newDir)) return { migrated: false }
  try {
    mkdirSync(newDir, { recursive: true })
    cpSync(oldDir, newDir, { recursive: true })
    writeFileSync(join(newDir, MIGRATE_MARK), `migrated from ${oldDir}\n`, 'utf8')
    const copied = countFiles(newDir)
    console.log(`[migrate] userData 已从 ${oldDir} 迁移到 ${newDir}（${copied} 个文件），旧目录保留可手动清理`)
    return { migrated: true, copied }
  } catch (err) {
    // 迁移失败不阻断启动（用户可重新配置；旧数据仍在旧目录）
    console.error(`[migrate] userData 迁移失败：${err instanceof Error ? err.message : String(err)}`)
    return { migrated: false }
  }
}

/** 递归统计文件数（迁移报告用；失败返回 -1 不影响迁移结果） */
function countFiles(dir: string): number {
  try {
    let n = 0
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) n += countFiles(join(dir, entry.name))
      else n++
    }
    return n
  } catch {
    return -1
  }
}
