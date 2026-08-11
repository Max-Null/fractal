// panel.ts 纯函数单元测试（不依赖 electron 运行时，node 环境）
// 覆盖：记忆解析（元数据行/无 status/无标题）、记忆操作（confirm/remove/越界拦截）、
//       计划解析（当前步骤行/未知）、计划列表（两目录合并）、状态读取（不存在容错）
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  parseMemoryEntry,
  confirmMemory,
  removeMemory,
  readMemory,
  assertInsideDir,
  parsePlanEntry,
  listMemories,
  listPlans,
  readPlan,
  getStatusState,
  globalMemoriesDir,
  projectMemoriesDir,
  isolatedPlansDir,
  projectPlansDir,
  statusStateFile,
} from './panel'

// ── 全局记忆目录测试注入：globalMemoriesDir 读真实全局（homedir()），
//    测试把 USERPROFILE 指向临时目录使 homedir() 返回 tmp，隔离真实用户记忆 ──
const realUserProfile = process.env.USERPROFILE
function setHomeForTest(home: string) {
  process.env.USERPROFILE = home
}
function restoreHome() {
  if (realUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = realUserProfile
}

// ── 记忆解析 ──

describe('parseMemoryEntry（记忆文件解析）', () => {
  it('解析元数据行：status/description + 标题 + preview', () => {
    const content = [
      '<!-- type: knowledge --><!-- status: pending --><!-- description: 一句话摘要 -->',
      '',
      '## 记忆标题',
      '',
      '正文第一句是长描述，用来验证 preview 截断到 80 字的效果是否正常生效，多余部分应被截掉',
    ].join('\n')
    const e = parseMemoryEntry('C:\\mem\\a.md', content)
    expect(e.title).toBe('记忆标题')
    expect(e.status).toBe('pending')
    expect(e.desc).toBe('一句话摘要')
    expect(e.preview).toBe('正文第一句是长描述，用来验证 preview 截断到 80 字的效果是否正常生效，多余部分应被截掉'.slice(0, 80))
    expect(e.preview.length).toBeLessThanOrEqual(80)
  })

  it('status 为 auto → 已生效', () => {
    const e = parseMemoryEntry('a.md', '<!-- type: knowledge -->\n<!-- status: auto -->\n# 标题\n正文')
    expect(e.status).toBe('auto')
  })

  it('无 status 元数据 → suggest（观察中）', () => {
    const e = parseMemoryEntry('a.md', '# 标题\n正文内容')
    expect(e.status).toBe('suggest')
  })

  it('无标题 → 用文件名兜底；preview 去除元数据行与标题行', () => {
    const e = parseMemoryEntry('C:\\mem\\my-file.md', '<!-- type: knowledge -->\n仅正文，无标题')
    expect(e.title).toBe('my-file')
    expect(e.preview).toBe('仅正文，无标题')
    expect(e.preview).not.toContain('<!--')
  })
})

// ── 记忆操作（临时目录）──

describe('记忆操作（confirm/remove/越界拦截）', () => {
  let userDataDir: string
  let cwd: string

  beforeEach(async () => {
    userDataDir = await fsp.mkdtemp(join(tmpdir(), 'panel-mem-'))
    cwd = await fsp.mkdtemp(join(tmpdir(), 'panel-cwd-'))
    setHomeForTest(userDataDir)
  })

  afterEach(async () => {
    restoreHome()
    await fsp.rm(userDataDir, { recursive: true, force: true })
    await fsp.rm(cwd, { recursive: true, force: true })
  })

  it('confirmMemory：pending → auto 写回', async () => {
    const dir = globalMemoriesDir()
    await fsp.mkdir(dir, { recursive: true })
    const file = join(dir, 'a.md')
    await fsp.writeFile(file, '<!-- type: knowledge --><!-- status: pending -->\n# A\n正文', 'utf-8')
    const r = await confirmMemory('', file)
    expect(r.ok).toBe(true)
    const after = await fsp.readFile(file, 'utf-8')
    expect(after).toContain('<!-- status: auto -->')
    expect(after).not.toContain('pending')
  })

  it('confirmMemory：无 pending 不写（内容不变）', async () => {
    const dir = globalMemoriesDir()
    await fsp.mkdir(dir, { recursive: true })
    const file = join(dir, 'auto.md')
    await fsp.writeFile(file, '<!-- status: auto -->\n# A', 'utf-8')
    const r = await confirmMemory('', file)
    expect(r.ok).toBe(false)
    expect(await fsp.readFile(file, 'utf-8')).toBe('<!-- status: auto -->\n# A')
  })

  it('removeMemory：删除文件', async () => {
    const dir = globalMemoriesDir()
    await fsp.mkdir(dir, { recursive: true })
    const file = join(dir, 'del.md')
    await fsp.writeFile(file, '# A', 'utf-8')
    const r = await removeMemory('', file)
    expect(r.ok).toBe(true)
    await expect(fsp.access(file)).rejects.toThrow()
  })

  it('confirm/remove：越界路径（记忆目录外）被拦截', async () => {
    const outside = join(userDataDir, 'secret.md')
    await fsp.writeFile(outside, 'x', 'utf-8')
    await expect(confirmMemory('', outside)).rejects.toThrow('记忆文件不在记忆目录内')
    await expect(removeMemory('', outside)).rejects.toThrow('记忆文件不在记忆目录内')
    // 文件未被误删
    expect(await fsp.readFile(outside, 'utf-8')).toBe('x')
  })

  it('readMemory：返回元数据 + 全文（详情弹窗数据源）', async () => {
    const dir = globalMemoriesDir()
    await fsp.mkdir(dir, { recursive: true })
    const file = join(dir, 'detail.md')
    await fsp.writeFile(
      file,
      '<!-- type: knowledge --><!-- status: pending --><!-- description: 一句话摘要 -->\n# 标题\n正文第一行\n正文第二行',
      'utf-8'
    )
    const r = await readMemory('', file)
    expect(r.title).toBe('标题')
    expect(r.status).toBe('pending')
    expect(r.desc).toBe('一句话摘要')
    expect(r.content).toContain('正文第一行')
    expect(r.content).toContain('<!-- status: pending -->') // 全文保留元数据（渲染层自行剥注释）
  })

  it('readMemory：越界路径被拦截', async () => {
    const outside = join(userDataDir, 'secret.md')
    await fsp.writeFile(outside, 'x', 'utf-8')
    await expect(readMemory('', outside)).rejects.toThrow('记忆文件不在记忆目录内')
  })

  it('项目记忆：file 位于项目记忆目录内可操作', async () => {
    const dir = projectMemoriesDir(cwd)
    await fsp.mkdir(dir, { recursive: true })
    const file = join(dir, 'p.md')
    await fsp.writeFile(file, '<!-- status: pending -->\n# P', 'utf-8')
    const r = await confirmMemory(cwd, file)
    expect(r.ok).toBe(true)
    expect(await fsp.readFile(file, 'utf-8')).toContain('<!-- status: auto -->')
  })

  it('assertInsideDir：.. 段逃逸与目录外路径被拒绝', () => {
    const dir = 'C:\\mem\\blocks'
    expect(() => assertInsideDir(dir, 'C:\\mem\\blocks\\a.md')).not.toThrow()
    expect(() => assertInsideDir(dir, 'C:\\mem\\blocks\\sub\\b.md')).not.toThrow()
    expect(() => assertInsideDir(dir, 'C:\\mem\\other\\c.md')).toThrow('越界')
    expect(() => assertInsideDir(dir, 'C:\\mem\\blocks\\..\\..\\evil.md')).toThrow('越界')
    expect(() => assertInsideDir(dir, '')).toThrow('不能为空')
  })
})

// ── 记忆列表（临时目录）──

describe('listMemories（全局 + 项目）', () => {
  let userDataDir: string
  let cwd: string

  beforeEach(async () => {
    userDataDir = await fsp.mkdtemp(join(tmpdir(), 'panel-list-'))
    cwd = await fsp.mkdtemp(join(tmpdir(), 'panel-list-cwd-'))
    setHomeForTest(userDataDir)
  })

  afterEach(async () => {
    restoreHome()
    await fsp.rm(userDataDir, { recursive: true, force: true })
    await fsp.rm(cwd, { recursive: true, force: true })
  })

  it('目录不存在 → 全局/项目都返回空（不抛错）', async () => {
    const r = await listMemories(cwd)
    expect(r.global).toEqual([])
    expect(r.project).toEqual([])
  })

  it('项目 cwd 为空 → project 空数组', async () => {
    const r = await listMemories('')
    expect(r.project).toEqual([])
  })

  it('解析全局 + 项目记忆文件', async () => {
    await fsp.mkdir(globalMemoriesDir(), { recursive: true })
    await fsp.writeFile(join(globalMemoriesDir(), 'g.md'), '<!-- status: pending --><!-- description: 全局描述 -->\n# 全局记忆\n正文', 'utf-8')
    await fsp.mkdir(projectMemoriesDir(cwd), { recursive: true })
    await fsp.writeFile(join(projectMemoriesDir(cwd), 'p.md'), '<!-- status: auto -->\n# 项目记忆\n正文', 'utf-8')

    const r = await listMemories(cwd)
    expect(r.global).toHaveLength(1)
    expect(r.global[0]).toMatchObject({ title: '全局记忆', status: 'pending', desc: '全局描述' })
    expect(r.project).toHaveLength(1)
    expect(r.project[0]).toMatchObject({ title: '项目记忆', status: 'auto' })
  })
})

// ── 计划解析 ──

describe('parsePlanEntry（计划文件解析）', () => {
  it('解析「当前步骤：x/y | 状态：执行中」行', () => {
    const content = ['# 测试计划', '', '## 当前步骤：3/5 | 状态：执行中', '', '正文'].join('\n')
    const p = parsePlanEntry('2026-08-07-0300-测试计划.md', content)
    expect(p.title).toBe('测试计划')
    expect(p.currentStep).toBe(3)
    expect(p.totalSteps).toBe(5)
    expect(p.status).toBe('执行中')
  })

  it('兼容全角冒号/竖线 + 已完成', () => {
    const p = parsePlanEntry('x.md', '# 完成计划\n## 当前步骤：5／5｜状态：已完成')
    expect(p.currentStep).toBe(5)
    expect(p.totalSteps).toBe(5)
    expect(p.status).toBe('已完成')
  })

  it('无进度行 → 未知 + 0/0；无标题用文件名', () => {
    const p = parsePlanEntry('2026-07-26-0135-旧计划.md', '# 旧计划\n**状态**：已完成')
    expect(p.status).toBe('未知')
    expect(p.currentStep).toBe(0)
    expect(p.totalSteps).toBe(0)
  })
})

// ── 计划列表（隔离 + 项目级合并 + active）──
// 注意：listPlans 第三参 systemDir 为测试注入（隔离真实 ~/.config/opencode/plans），第二参为项目工作区

describe('listPlans（隔离 + 项目级 + .active.json）', () => {
  let userDataDir: string
  let sysPlansDir: string
  let cwd: string

  beforeEach(async () => {
    userDataDir = await fsp.mkdtemp(join(tmpdir(), 'panel-plans-'))
    sysPlansDir = await fsp.mkdtemp(join(tmpdir(), 'panel-plans-sys-'))
    cwd = await fsp.mkdtemp(join(tmpdir(), 'panel-plans-cwd-'))
  })

  afterEach(async () => {
    await fsp.rm(userDataDir, { recursive: true, force: true })
    await fsp.rm(sysPlansDir, { recursive: true, force: true })
    await fsp.rm(cwd, { recursive: true, force: true })
  })

  it('两目录都不存在 → 空列表 + active null（不抛错）', async () => {
    const r = await listPlans(userDataDir, '', sysPlansDir)
    expect(r.plans).toEqual([])
    expect(r.active).toBeNull()
  })

  it('合并隔离 + 项目级两目录 + lastCompletedStep 回填 + active 第一项 + updatedAt', async () => {
    const iso = isolatedPlansDir(userDataDir)
    await fsp.mkdir(iso, { recursive: true })
    await fsp.mkdir(projectPlansDir(cwd), { recursive: true })
    const isoFile = join(iso, '2026-08-07-0300-隔离计划.md')
    const projFile = join(projectPlansDir(cwd), '2026-08-12-0045-项目计划.md')
    await fsp.writeFile(isoFile, '# 隔离计划\n## 当前步骤：2/4 | 状态：执行中', 'utf-8')
    await fsp.writeFile(projFile, '# 项目计划\n## 当前步骤：1/3 | 状态：执行中', 'utf-8')
    // 显式固定 mtime（连续写入的 mtime 精度可能相同导致排序不稳定）——项目计划更新
    const tBase = Date.UTC(2026, 7, 12, 10, 0, 0)
    await fsp.utimes(isoFile, new Date(tBase), new Date(tBase))
    await fsp.utimes(projFile, new Date(tBase + 60_000), new Date(tBase + 60_000))
    // .active.json 在隔离目录（隔离优先），回填 lastCompletedStep
    await fsp.writeFile(join(iso, '.active.json'), JSON.stringify({ activePlans: [{ file: '2026-08-07-0300-隔离计划.md', title: '隔离计划', progress: '2/4', lastCompletedStep: '步骤二完成' }] }), 'utf-8')

    const r = await listPlans(userDataDir, cwd, sysPlansDir)
    expect(r.plans).toHaveLength(2)
    // mtime 倒序（项目计划 mtime 更新 → 最前）
    expect(r.plans[0]).toMatchObject({ title: '项目计划', currentStep: 1, totalSteps: 3, status: '执行中' })
    expect(r.plans[1]).toMatchObject({ title: '隔离计划', currentStep: 2, totalSteps: 4, status: '执行中', lastCompletedStep: '步骤二完成' })
    expect(r.plans[0].updatedAt).toBeGreaterThan(r.plans[1].updatedAt)
    expect(r.active).toEqual({ title: '隔离计划', progress: '2/4', lastCompletedStep: '步骤二完成' })
  })

  it('系统全局目录（注入）仅测试语义：显式注入才读', async () => {
    await fsp.writeFile(join(sysPlansDir, '2026-07-26-0135-跨项目计划.md'), '# 跨项目计划', 'utf-8')
    const injected = await listPlans(userDataDir, cwd, sysPlansDir)
    expect(injected.plans).toHaveLength(1)
  })

  it('生产不传 systemDir → 不读系统全局（跨项目隔离）', async () => {
    await fsp.writeFile(join(sysPlansDir, '2026-07-26-0135-跨项目计划.md'), '# 跨项目计划', 'utf-8')
    const r = await listPlans(userDataDir, cwd)
    expect(r.plans).toHaveLength(0)
  })

  it('active.json 在项目级目录（隔离无）→ 读项目级的', async () => {
    await fsp.mkdir(projectPlansDir(cwd), { recursive: true })
    await fsp.writeFile(join(projectPlansDir(cwd), '.active.json'), JSON.stringify({ activePlans: [{ file: 'x.md', title: '项目活跃', progress: '5/5', lastCompletedStep: '全绿' }] }), 'utf-8')
    const r = await listPlans(userDataDir, cwd)
    expect(r.active).toEqual({ title: '项目活跃', progress: '5/5', lastCompletedStep: '全绿' })
  })

  it('readPlan：返回元数据 + 全文（详情弹窗数据源）', async () => {
    await fsp.mkdir(projectPlansDir(cwd), { recursive: true })
    const file = join(projectPlansDir(cwd), '2026-08-12-0100-详情计划.md')
    await fsp.writeFile(file, '# 详情计划\n## 当前步骤：2/5 | 状态：执行中\n正文行一\n正文行二', 'utf-8')
    const r = await readPlan(userDataDir, cwd, file)
    expect(r.title).toBe('详情计划')
    expect(r.currentStep).toBe(2)
    expect(r.status).toBe('执行中')
    expect(r.content).toContain('正文行二')
  })

  it('readPlan：越界路径被拦截', async () => {
    const outside = join(userDataDir, 'secret.md')
    await fsp.writeFile(outside, 'x', 'utf-8')
    await expect(readPlan(userDataDir, cwd, outside)).rejects.toThrow('计划文件不在计划目录内')
  })
})

// ── 状态读取 ──

describe('getStatusState（Guardian 状态文件）', () => {
  let userDataDir: string

  beforeEach(async () => {
    userDataDir = await fsp.mkdtemp(join(tmpdir(), 'panel-status-'))
  })

  afterEach(async () => {
    await fsp.rm(userDataDir, { recursive: true, force: true })
  })

  it('文件不存在 → { exists: false, state: null }（不抛错）', async () => {
    const r = await getStatusState(userDataDir)
    expect(r).toEqual({ exists: false, state: null })
  })

  it('文件存在 → 解析 JSON 返回', async () => {
    await fsp.mkdir(join(userDataDir, 'config', 'opencode'), { recursive: true })
    await fsp.writeFile(statusStateFile(userDataDir), JSON.stringify({ engine: { running: true }, assertions: { count: 3 } }), 'utf-8')
    const r = await getStatusState(userDataDir)
    expect(r.exists).toBe(true)
    expect(r.state).toEqual({ engine: { running: true }, assertions: { count: 3 } })
  })

  it('JSON 损坏 → 容错返回空态', async () => {
    await fsp.mkdir(join(userDataDir, 'config', 'opencode'), { recursive: true })
    await fsp.writeFile(statusStateFile(userDataDir), '{ broken', 'utf-8')
    const r = await getStatusState(userDataDir)
    expect(r).toEqual({ exists: false, state: null })
  })
})

// ── 军师审查补测：目录自身拒绝 / 越界路径 / 附件 parts 映射 ──
import { mimeFromExt } from './ipc'

describe('军师审查补测（assertInsideDir / mimeFromExt）', () => {
  it('目录自身不允许操作（防误删整个记忆目录）', () => {
    const dir = 'C:/mem/blocks'
    expect(() => assertInsideDir(dir, dir)).toThrow()
    expect(() => assertInsideDir(dir, 'C:/mem/blocks')).toThrow()
  })
  it('目录内文件通过，目录外拒绝', () => {
    expect(() => assertInsideDir('C:/mem/blocks', 'C:/mem/blocks/a.md')).not.toThrow()
    expect(() => assertInsideDir('C:/mem/blocks', 'C:/mem/other/a.md')).toThrow()
    expect(() => assertInsideDir('C:/mem/blocks', 'C:/mem/blocks/../other.md')).toThrow()
  })
  it('mimeFromExt 扩展名推断（含新补项与兜底）', () => {
    expect(mimeFromExt('a.md')).toBe('text/markdown')
    expect(mimeFromExt('a.yaml')).toBe('text/yaml')
    expect(mimeFromExt('a.yml')).toBe('text/yaml')
    expect(mimeFromExt('a.xml')).toBe('application/xml')
    expect(mimeFromExt('a.sh')).toBe('text/x-sh')
    expect(mimeFromExt('a.sql')).toBe('text/x-sql')
    expect(mimeFromExt('a.toml')).toBe('application/toml')
    expect(mimeFromExt('a.env')).toBe('text/plain')
    expect(mimeFromExt('a.PNG')).toBe('image/png')
    expect(mimeFromExt('noext')).toBe('application/octet-stream')
  })
})

// ── 军师审查补测：目录自身拒绝 / 越界路径 / mime 兜底 ──
describe('军师审查补测（assertInsideDir 边界 / mimeFromExt）', () => {
  it('目录自身不允许操作（防误删整个记忆目录）', () => {
    const dir = 'C:/mem/blocks'
    expect(() => assertInsideDir(dir, dir)).toThrow()
    expect(() => assertInsideDir(dir, 'C:/mem/blocks')).toThrow()
  })
  it('目录内文件通过，目录外拒绝', () => {
    expect(() => assertInsideDir('C:/mem/blocks', 'C:/mem/blocks/a.md')).not.toThrow()
    expect(() => assertInsideDir('C:/mem/blocks', 'C:/mem/other/a.md')).toThrow()
    expect(() => assertInsideDir('C:/mem/blocks', 'C:/mem/blocks/../other.md')).toThrow()
  })
})
