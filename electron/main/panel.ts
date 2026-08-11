// 右侧面板数据源（阶段 6 遗留 P1-P3 拍板：GUI 文件监听实时刷新）
// 数据来源与路径约定：
//  - 记忆：全局 ~/.config/opencode/memories/blocks（真实全局——serve 会话的 AGENTS.md 实际加载真实全局，
//           agent 记忆写入约定即此目录，隔离目录从未产生记忆）+ 项目 <cwd>/.opencode/memories/blocks
//  - 计划：隔离 <userDataDir>/config/opencode/plans + 系统 ~/.config/opencode/plans（%USERPROFILE%）
//  - 状态：<userDataDir>/config/opencode/.fractal-state.json（Guardian 插件未来写入，可能不存在 → 容错）
import { promises as fsp, watch as fsWatch, type FSWatcher } from 'node:fs'
import { join, basename, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import type { BrowserWindow } from 'electron'

// ── 类型（与 electron-bridge 前端契约一致）──

export interface MemoryEntry {
  file: string
  title: string
  status: 'pending' | 'auto' | 'suggest'
  desc: string
  preview: string
}

export interface PlanEntry {
  file: string
  title: string
  currentStep: number
  totalSteps: number
  status: '执行中' | '已完成' | '未知'
  lastCompletedStep: string
  /** 文件最后修改时间（mtimeMs，面板按此倒序显示） */
  updatedAt: number
}

export interface PanelActivePlan {
  title: string
  progress: string
  lastCompletedStep: string
}

export type PanelKind = 'memory' | 'plans' | 'status'

// ── 路径（与 server-manager XDG_CONFIG_HOME 隔离目录一致：<userDataDir>/config）──

/** 隔离 opencode 配置目录（serve 的 XDG_CONFIG_HOME 指向 <userDataDir>/config） */
export function isolatedOpenCodeDir(userDataDir: string): string {
  return join(userDataDir, 'config', 'opencode')
}

/** 全局记忆目录（真实全局：serve 会话的 AGENTS.md 加载真实全局，记忆写入约定即此——隔离目录无写入方） */
export function globalMemoriesDir(): string {
  return join(homedir(), '.config', 'opencode', 'memories', 'blocks')
}

/** 项目记忆目录（跟随渲染进程工作区） */
export function projectMemoriesDir(cwd: string): string {
  return join(cwd, '.opencode', 'memories', 'blocks')
}

/** 隔离计划目录（分形自身数据目录的计划面板写入方） */
export function isolatedPlansDir(userDataDir: string): string {
  return join(isolatedOpenCodeDir(userDataDir), 'plans')
}

/** 项目计划目录（2026-08-12 约定：临时计划写入当前工作区 .opencode/plans，与项目记忆目录对称） */
export function projectPlansDir(cwd: string): string {
  return join(cwd, '.opencode', 'plans')
}

/** 系统计划目录（跨项目共享旧约定，2026-08-12 起不再作为面板数据源；保留导出供迁移/测试） */
export function systemPlansDir(): string {
  return join(homedir(), '.config', 'opencode', 'plans')
}

/** Guardian 状态文件（约定路径，未来由分形插件写入） */
export function statusStateFile(userDataDir: string): string {
  return join(isolatedOpenCodeDir(userDataDir), '.fractal-state.json')
}

/** 渲染进程工作区路径：ui-settings.json 是前端持久化工作区的唯一主进程可见通道（无则返回空串） */
export async function readProjectCwd(userDataDir: string): Promise<string> {
  try {
    const raw = await fsp.readFile(join(userDataDir, 'ui-settings.json'), 'utf-8')
    const ui = JSON.parse(raw) as { cwd?: unknown }
    return typeof ui.cwd === 'string' && ui.cwd ? ui.cwd : ''
  } catch {
    // ui-settings.json 不存在（首次启动未保存过工作区）→ 空串
    return ''
  }
}

// ── 记忆解析 ──

/**
 * 解析记忆文件（md 元数据行约定，见 AGENTS.md 元知识记录）：
 * - status 元数据 `<!-- status: pending|auto -->`；缺失 → 'suggest'（观察中）
 * - description 元数据 `<!-- description: ... -->`
 * - title = 首个 # 标题（无则文件名）；preview = 正文（去元数据/标题行后）前 80 字
 */
export function parseMemoryEntry(file: string, content: string): MemoryEntry {
  const statusMeta = content.match(/<!--\s*status:\s*(pending|auto)\s*-->/)
  const descMeta = content.match(/<!--\s*description:\s*([\s\S]*?)-->/)
  const titleMatch = content.match(/^#{1,6}\s+(.+)$/m)
  // 正文：去掉全部元数据注释与首个标题行（元数据行不进入 preview）
  const body = content.replace(/<!--[\s\S]*?-->/g, '').replace(/^#{1,6}\s+.+$/m, '').trim()
  return {
    file,
    title: titleMatch?.[1]?.trim() || basename(file, '.md'),
    status: statusMeta?.[1] === 'pending' ? 'pending' : statusMeta?.[1] === 'auto' ? 'auto' : 'suggest',
    desc: descMeta?.[1]?.trim() ?? '',
    preview: body.slice(0, 80),
  }
}

/** 读目录下全部 .md 记忆文件（目录不存在 → 空列表；单文件读取失败跳过） */
async function readMemoryDir(dir: string): Promise<MemoryEntry[]> {
  let files: string[]
  try {
    files = await fsp.readdir(dir)
  } catch {
    // 目录不存在（首次启动/无记忆）→ 空列表
    return []
  }
  const entries: MemoryEntry[] = []
  for (const f of files) {
    if (!f.endsWith('.md')) continue
    try {
      const content = await fsp.readFile(join(dir, f), 'utf-8')
      entries.push(parseMemoryEntry(join(dir, f), content))
    } catch {
      // 单个文件读取失败（竞态删除/编码异常）→ 跳过不阻断整体
    }
  }
  return entries.sort((a, b) => a.title.localeCompare(b.title))
}

export async function listMemories(projectCwd: string): Promise<{ global: MemoryEntry[]; project: MemoryEntry[] }> {
  const global = await readMemoryDir(globalMemoriesDir())
  // 无工作区（ui-settings.json 未记录）→ 项目记忆返回空，前端空态提示
  const project = projectCwd ? await readMemoryDir(projectMemoriesDir(projectCwd)) : []
  return { global, project }
}

// ── 记忆操作（路径安全：file 必须位于记忆目录内，防越界删除/改写）──

/** 校验 file 解析后位于 dir 内（resolve 归一化 .. 后再做前缀检查，配合绝对路径双保险） */
export function assertInsideDir(dir: string, file: unknown): asserts file is string {
  if (typeof file !== 'string' || !file.trim()) {
    throw new Error('记忆文件路径不能为空')
  }
  const resolvedDir = resolve(dir)
  const resolvedFile = resolve(file)
  // 目录自身不允许操作（防误删整个记忆目录）；目录外（含 .. 逃逸）拒绝
  if (resolvedFile === resolvedDir) {
    throw new Error(`不允许操作目录自身：${file}`)
  }
  if (!resolvedFile.startsWith(resolvedDir + sep)) {
    throw new Error(`记忆文件越界：${file}`)
  }
}

/** 读取单条记忆全文（越界校验 + 元数据解析复用），详情弹窗数据源 */
export async function readMemory(projectCwd: string, file: unknown): Promise<MemoryEntry & { content: string }> {
  // resolveMemoryDir 仅做越界校验（file 必须位于记忆目录内）
  resolveMemoryDir(projectCwd, file)
  const content = await fsp.readFile(file as string, 'utf-8')
  return { ...parseMemoryEntry(file as string, content), content }
}

/** file 归属的记忆目录（全局或项目，二选一；都不归属抛错） */
function resolveMemoryDir(projectCwd: string, file: unknown): string {
  const dirs = [globalMemoriesDir(), ...(projectCwd ? [projectMemoriesDir(projectCwd)] : [])]
  for (const d of dirs) {
    try {
      assertInsideDir(d, file)
      return d
    } catch {
      // 不在该目录 → 试下一个
    }
  }
  throw new Error('记忆文件不在记忆目录内')
}

/** 确认记忆：把 `<!-- status: pending -->` 替换为 `<!-- status: auto -->`（无 pending 则不写） */
export async function confirmMemory(projectCwd: string, file: unknown): Promise<{ ok: boolean }> {
  // resolveMemoryDir 仅做越界校验（file 必须位于记忆目录内）
  resolveMemoryDir(projectCwd, file)
  const target = file as string
  try {
    const content = await fsp.readFile(target, 'utf-8')
    if (!/<!--\s*status:\s*pending\s*-->/.test(content)) return { ok: false }
    await fsp.writeFile(target, content.replace(/<!--\s*status:\s*pending\s*-->/g, '<!-- status: auto -->'), 'utf-8')
    return { ok: true }
  } catch (err) {
    throw new Error(`确认记忆失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 删除记忆文件（force 容错：文件已不存在不抛错） */
export async function removeMemory(projectCwd: string, file: unknown): Promise<{ ok: boolean }> {
  void resolveMemoryDir(projectCwd, file)
  await fsp.rm(file as string, { force: true })
  return { ok: true }
}

// ── 计划解析 ──

/**
 * 解析计划文件：
 * - title = 首个 # 标题（无则文件名）
 * - 进度行正则：`当前步骤：x/y | 状态：执行中|已完成`（兼容全角/半角冒号与竖线）
 * - status 无进度行 → '未知'；currentStep/totalSteps 无进度行 → 0/0
 */
export function parsePlanEntry(file: string, content: string): PlanEntry {
  const titleMatch = content.match(/^#{1,6}\s+(.+)$/m)
  const progressMatch = content.match(/当前步骤[:：]\s*(\d+)\s*[/／]\s*(\d+)(?:\s*[|｜]\s*状态[:：]\s*(执行中|已完成))?/)
  const currentStep = progressMatch ? Number(progressMatch[1]) : 0
  const totalSteps = progressMatch ? Number(progressMatch[2]) : 0
  const status: PlanEntry['status'] = progressMatch?.[3] === '执行中' ? '执行中' : progressMatch?.[3] === '已完成' ? '已完成' : '未知'
  return {
    file,
    title: titleMatch?.[1]?.trim() || basename(file, '.md'),
    currentStep,
    totalSteps,
    status,
    // lastCompletedStep 由 .active.json 填充（md 内无此字段）
    lastCompletedStep: '',
    // updatedAt 由 listPlans/readPlan 按文件 mtime 覆盖（解析层占位 0）
    updatedAt: 0,
  }
}

/** 读 .active.json（隔离优先，没有读项目级；systemDir 仅测试注入），返回 activePlans 数组或 null */
async function readActivePlansJson(userDataDir: string, projectCwd: string, systemDir?: string): Promise<Array<{ file: string; title: string; progress: string; lastCompletedStep: string }> | null> {
  const dirs = [isolatedPlansDir(userDataDir), projectCwd ? projectPlansDir(projectCwd) : '']
  // 生产不读系统全局（2026-08-12 约定迁移）；systemDir 仅测试注入（隔离真实 ~/.config/opencode/plans）
  if (systemDir) dirs.push(systemDir)
  for (const dir of dirs) {
    if (!dir) continue
    try {
      const raw = await fsp.readFile(join(dir, '.active.json'), 'utf-8')
      const data = JSON.parse(raw) as { activePlans?: Array<{ file?: string; title?: string; progress?: string; lastCompletedStep?: string }> }
      if (Array.isArray(data?.activePlans)) {
        return data.activePlans.map((p) => ({
          file: p.file ?? '',
          title: p.title ?? '',
          progress: p.progress ?? '',
          lastCompletedStep: p.lastCompletedStep ?? '',
        }))
      }
    } catch {
      // 该目录无 active.json → 试下一个
    }
  }
  return null
}

/**
 * 计划列表（隔离 + 项目级两目录合并，按最后更新时间倒序；lastCompletedStep 从 .active.json 按文件名回填）。
 * systemDir 仅测试注入（隔离真实 ~/.config/opencode/plans），生产不传。
 * 2026-08-12 约定变更：系统全局目录不再作为面板数据源（计划写入已迁移到当前工作区 .opencode/plans）。
 */
export async function listPlans(userDataDir: string, projectCwd: string, systemDir?: string): Promise<{ plans: PlanEntry[]; active: PanelActivePlan | null }> {
  const activeList = await readActivePlansJson(userDataDir, projectCwd, systemDir)
  const activeByFile = new Map((activeList ?? []).map((p) => [p.file, p]))

  const plans: PlanEntry[] = []
  const seen = new Set<string>()
  const dirs = [isolatedPlansDir(userDataDir), projectCwd ? projectPlansDir(projectCwd) : '']
  // 生产不读系统全局（2026-08-12 约定迁移）；systemDir 仅测试注入（隔离真实 ~/.config/opencode/plans）
  if (systemDir) dirs.push(systemDir)
  for (const dir of dirs) {
    if (!dir) continue
    let files: string[]
    try {
      files = await fsp.readdir(dir)
    } catch {
      // 目录不存在（首次启动）→ 跳过该目录
      continue
    }
    for (const f of files) {
      if (!f.endsWith('.md')) continue
      const key = `${dir}${sep}${f}`
      if (seen.has(key)) continue
      seen.add(key)
      try {
        const filePath = join(dir, f)
        const content = await fsp.readFile(filePath, 'utf-8')
        const stat = await fsp.stat(filePath)
        const entry = parsePlanEntry(filePath, content)
        const activeMeta = activeByFile.get(f)
        if (activeMeta?.lastCompletedStep) entry.lastCompletedStep = activeMeta.lastCompletedStep
        plans.push({ ...entry, updatedAt: stat.mtimeMs })
      } catch {
        // 单个文件读取失败（竞态删除）→ 跳过
      }
    }
  }
  // 按最后更新时间倒序（最新修改在前）——2026-08-12 用户需求（原按文件名时间前缀，编辑/改名后不准）
  plans.sort((a, b) => b.updatedAt - a.updatedAt)
  const active = activeList && activeList.length > 0 ? { title: activeList[0].title, progress: activeList[0].progress, lastCompletedStep: activeList[0].lastCompletedStep } : null
  return { plans, active }
}

// ── 状态读取（Guardian .fractal-state.json，可能不存在）──

export async function getStatusState(userDataDir: string): Promise<{ exists: boolean; state: unknown }> {
  try {
    const raw = await fsp.readFile(statusStateFile(userDataDir), 'utf-8')
    return { exists: true, state: JSON.parse(raw) as unknown }
  } catch {
    // 文件不存在（Guardian 未写入）或 JSON 损坏 → 容错返回空态，不抛错
    return { exists: false, state: null }
  }
}

/** 读取单条计划全文（越界校验：隔离 + 项目级二选一），详情弹窗数据源 */
export async function readPlan(userDataDir: string, projectCwd: string, file: unknown): Promise<PlanEntry & { content: string }> {
  resolvePlanDir(userDataDir, projectCwd, file)
  const target = file as string
  const content = await fsp.readFile(target, 'utf-8')
  const stat = await fsp.stat(target)
  return { ...parsePlanEntry(target, content), content, updatedAt: stat.mtimeMs }
}

/** file 归属的计划目录（隔离或项目级，二选一；都不归属抛错） */
function resolvePlanDir(userDataDir: string, projectCwd: string, file: unknown): string {
  const dirs = [isolatedPlansDir(userDataDir), ...(projectCwd ? [projectPlansDir(projectCwd)] : [])]
  for (const d of dirs) {
    try {
      assertInsideDir(d, file)
      return d
    } catch {
      // 不在该目录 → 试下一个
    }
  }
  throw new Error('计划文件不在计划目录内')
}

// ══════════════════════════════════════════════════════════════════
// 面板文件监听（P1-P3 拍板：GUI 文件监听实时刷新）
// ══════════════════════════════════════════════════════════════════

/**
 * 监听面板数据源目录变更 → 防抖 300ms → webContents.send('engine:panel-update', {kind})。
 * 覆盖：记忆（隔离+项目）、计划（隔离+系统）、状态文件所在目录（按文件名过滤只响应 .fractal-state.json）。
 * 目录不存在 → 先 mkdir recursive 再 watch；watch/mkdir 失败记录后跳过（容错，不阻断应用启动）。
 * 返回停止函数（窗口关闭时调用）。
 */
export function startPanelWatchers(win: BrowserWindow, userDataDir: string): { dispose: () => void; refreshProject: (cwd: string | null) => void } {
  const watchers: FSWatcher[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let pendingKind: PanelKind = 'memory'
  let projectWatched: string | null = null // 当前监听的项目记忆目录（工作区跟随）

  function notify(kind: PanelKind) {
    // 防抖：整目录写入可能一次触发多次 fs.watch 回调（如保存时临时文件+改名），合并为一次广播
    pendingKind = kind
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      if (!win.isDestroyed()) win.webContents.send('engine:panel-update', { kind: pendingKind })
    }, 300)
  }

  /** 目录监听：先 mkdir recursive 确保存在，watch 失败记录后跳过 */
  function watchDir(dir: string, kind: PanelKind, filter?: (filename: string | null) => boolean) {
    void fsp
      .mkdir(dir, { recursive: true })
      .then(() => {
        const w = fsWatch(dir, { encoding: 'utf-8' }, (_eventType, filename) => {
          if (filter && !filter(filename)) return
          notify(kind)
        })
        watchers.push(w)
      })
      .catch((err) => {
        // mkdir 失败（如项目 cwd 已被删除）→ 不 watch，容错
        console.error(`[panel] 监听 ${dir} 失败：`, err)
      })
  }

  watchDir(globalMemoriesDir(), 'memory')
  watchDir(isolatedPlansDir(userDataDir), 'plans')
  // 系统全局 plans 不再是面板数据源（2026-08-12 约定迁移到项目级）→ 不监听，避免 oc-plus 等跨项目计划触发面板刷新
  // 状态文件：watch 其所在目录；仅 .fractal-state.json（或文件名缺失的保守事件）触发 status。
  // 记忆/计划子目录在 config/opencode 下的目录条目变更被过滤，不会误映射为 status
  watchDir(isolatedOpenCodeDir(userDataDir), 'status', (filename) => filename === null || filename === '.fractal-state.json')

  // 项目目录 watcher 单独管理：工作区切换时重建（跟随 ui-settings.json 的 cwd 变更）
  // 2026-08-12 起同时监听项目记忆 + 项目计划（写入约定均迁移到当前工作区 .opencode/ 下）
  const projectWatchers: FSWatcher[] = []
  function projectWatchDir(dir: string, kind: PanelKind) {
    void fsp
      .mkdir(dir, { recursive: true })
      .then(() => {
        const w = fsWatch(dir, { encoding: 'utf-8' }, () => notify(kind))
        projectWatchers.push(w)
      })
      .catch(() => {})
  }
  function refreshProject(cwd: string | null) {
    const newDir = cwd ? projectMemoriesDir(cwd) : null
    if (newDir === projectWatched) return
    for (const w of projectWatchers) w.close()
    projectWatchers.length = 0
    projectWatched = newDir
    // newDir 非空即 cwd 非空（上方三目同源）——此处再判一次让 TS 窄化，避免断言
    if (newDir && cwd) {
      projectWatchDir(newDir, 'memory')
      projectWatchDir(projectPlansDir(cwd), 'plans')
    }
  }
  void readProjectCwd(userDataDir).then((cwd) => {
    if (cwd) {
      projectWatched = projectMemoriesDir(cwd)
      projectWatchDir(projectWatched, 'memory')
      projectWatchDir(projectPlansDir(cwd), 'plans')
    }
  })

  const dispose = () => {
    if (timer) clearTimeout(timer)
    for (const w of watchers) w.close()
    watchers.length = 0
    for (const w of projectWatchers) w.close()
    projectWatchers.length = 0
    projectWatched = null
  }
  return { dispose, refreshProject }
}

// 活动 watcher 句柄（index.ts 启动时设置；ipc 面板 handler 用它跟随工作区切换）
let activePanelWatchers: { dispose: () => void; refreshProject: (cwd: string | null) => void } | null = null
export function setPanelWatchers(w: { dispose: () => void; refreshProject: (cwd: string | null) => void } | null): void {
  activePanelWatchers = w
}
export function getPanelWatchers(): { dispose: () => void; refreshProject: (cwd: string | null) => void } | null {
  return activePanelWatchers
}
