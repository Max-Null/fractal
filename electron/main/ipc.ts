// IPC 通道注册：renderer 桥（electronBridge）的本地能力实现
// 通道前缀约定：fs: / git: / settings: / logs: / dialog:
// 引擎通道（chat: / session: / message: / permission:）阶段 4 接入 serve
import { app, dialog, ipcMain, shell, BrowserWindow } from 'electron'
import { promises as fsp } from 'node:fs'
import { join, dirname, basename, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { type ServerManager, getEngineVersion } from './server-manager'
import { getPresetVersion } from './preset'
import { type OcClient, type SessionMessage, basicAuthHeader } from './oc-sdk'
import { listMemories, confirmMemory, removeMemory, listPlans, getStatusState, readProjectCwd, getPanelWatchers } from './panel'
import type { Session } from '@opencode-ai/sdk'
import type { FilePartInput } from '@opencode-ai/sdk'
import { subscribeEvents } from './events'
import { DEFAULT_MODEL } from './provider'
import { ensureConfig } from './oc-config'
import { getConfig as getSettingsConfig, loadSettings, saveSettings, getSchema as getSettingsSchema, isSettingsLoaded, getSettingsFileExists } from './settings'

// ── 工具函数 ──

/**
 * 校验渲染进程传入的文件路径（防御性：渲染进程加载自本地文件，攻击面极小，
 * 但路径错误/越界会写错文件甚至删除错误目录——统一拦截）
 * 规则：必须是非空绝对路径，且不含 .. 段（配合绝对路径双保险）
 */
export function assertValidFsPath(p: unknown): asserts p is string {
  if (typeof p !== 'string' || p.trim() === '') {
    throw new Error('路径不能为空')
  }
  if (!isAbsolute(p)) {
    throw new Error(`路径必须是绝对路径: ${p}`)
  }
  if (p.split(/[\\/]/).includes('..')) {
    throw new Error(`路径不能包含 .. 段: ${p}`)
  }
}

/** 校验文件名（rename 目标）：拒绝路径分隔符与 ..，防止拼接逃逸 */
function assertValidFileName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || name.trim() === '' || /[\\/]/.test(name) || name === '..') {
    throw new Error(`非法文件名: ${String(name)}`)
  }
}

/** 在 repoPath 下执行 git CLI，返回 stdout；失败抛错带 stderr 上下文 */
function execGit(repoPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd: repoPath, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr.trim() || err.message))
        } else {
          resolve(stdout)
        }
      }
    )
  })
}

/** userData 下的 JSON 文件读写（设置/配置持久化用） */
export async function readJsonFile(filePath: string, fallback: unknown): Promise<unknown> {
  try {
    const raw = await fsp.readFile(filePath, 'utf-8')
    return JSON.parse(raw)
  } catch {
    // 文件不存在或损坏 → 返回兜底值（首次启动场景）
    return fallback
  }
}

/** 附件文件名 → MIME（FilePart 小表）；未知扩展回退 application/octet-stream */
export function mimeFromExt(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const table: Record<string, string> = {
    md: 'text/markdown',
    json: 'application/json',
    txt: 'text/plain',
    js: 'text/javascript',
    ts: 'text/typescript',
    tsx: 'text/typescript',
    vue: 'text/x-vue',
    py: 'text/x-python',
    java: 'text/x-java',
    go: 'text/x-go',
    rs: 'text/x-rust',
    c: 'text/x-c',
    h: 'text/x-c',
    cpp: 'text/x-c++',
    hpp: 'text/x-c++',
    html: 'text/html',
    css: 'text/css',
    scss: 'text/x-scss',
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
zip: 'application/zip',
yml: 'text/yaml',
yaml: 'text/yaml',
xml: 'application/xml',
sh: 'text/x-sh',
sql: 'text/x-sql',
toml: 'application/toml',
env: 'text/plain',
  }
  return table[ext] ?? 'application/octet-stream'
}

export async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await fsp.mkdir(dirname(filePath), { recursive: true })
  await fsp.writeFile(filePath, JSON.stringify(data), 'utf-8')
}

/**
 * 读取文件尾部 N 行（大文件尾部读取，避免 10MB serve.log 全量加载）。
 * 实现：fs.open + 从文件尾向前按块扫 0x0A 定位行边界；0x0A 是 ASCII 单字节，
 * 不会出现在多字节 UTF-8 序列内部——按换行符切分天然在字符边界上，不会切出 �。
 * 文件不存在/为空 → 返回 []（serve 从未启动的正常空态）。
 */

/**
 * 从 Buffer 尾部定位「最后 maxLines 行」的起始字节：
 * 跳过文件末尾空行后，从最后一个非空行向前数 maxLines 个换行（行分隔），第 maxLines 个换行之后即起点。
 * 返回 -1 = 无法确定（缓冲区开头可能仍处于某行中间——单行超长时尾部块内数不够换行，需继续读取更早内容）；
 * 返回 >=0 = 已确定起点（含 0：整个缓冲区都是目标行）。
 */
function findTailStart(buf: Buffer, maxLines: number): number {
  let i = buf.length - 1
  while (i >= 0 && buf[i] === 0x0a) i-- // 跳过文件末尾的空行（末尾 \n 是空行的结束，不算行）
  if (i < 0) return 0 // 全空行/空文件 → 起点 0
  let need = maxLines
  for (; i >= 0; i--) {
    if (buf[i] === 0x0a) {
      need--
      if (need === 0) return i + 1
    }
  }
  return -1
}

export async function readTailLines(filePath: string, maxLines: number): Promise<string[]> {
  const CHUNK = 64 * 1024
  let fh: fsp.FileHandle | null = null
  try {
    fh = await fsp.open(filePath, 'r')
  } catch (err) {
    // 文件不存在（serve 从未启动）→ 正常空态；其他错误（权限/占用）→ 记日志防误判为空态
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[ipc] serve.log 打开失败：${err instanceof Error ? err.message : String(err)}`)
    }
    return []
  }
  try {
    const st = await fh.stat()
    if (st.size === 0) return []
    let pos = st.size
    let tail = Buffer.alloc(0)
    // 从尾向前按块读，累积到能确定「最后 maxLines 行」起点即够（多出的头部截掉）
    while (pos > 0) {
      const readSize = Math.min(CHUNK, pos)
      pos -= readSize
      const buf = Buffer.alloc(readSize)
      await fh.read(buf, 0, readSize, pos)
      tail = Buffer.concat([buf, tail])
      const start = findTailStart(tail, maxLines)
      // pos===0 = 已读完全部（单行超长无换行时 findTailStart 恒 -1，此时整个 tail 即目标行）
      if (start >= 0 || pos === 0) {
        if (start >= 0) tail = tail.subarray(start)
        break
      }
      // 防御：文件极大且每行极短/单行超长（尾块内始终数不够）→ 限制内存占用，取已读部分
      if (tail.length > 10 * 1024 * 1024) break
    }
    // 已收集尾部字节串（起始于完整行边界）→ 按行切分，去掉尾部空串（文件以换行结尾）
    const parts = tail.toString('utf8').split('\n')
    if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
    return parts.slice(-maxLines)
  } finally {
    if (fh) await fh.close()
  }
}

/** 解析 git status --porcelain 输出为结构化 GitStatus */
export function parseGitStatus(stdout: string): {
  branch: string
  staged: Array<{ path: string; status: 'staged' }>
  modified: Array<{ path: string; status: 'modified' }>
  untracked: Array<{ path: string; status: 'untracked' }>
} {
  const lines = stdout.split('\n').filter(Boolean)
  let branch = ''
  const staged: Array<{ path: string; status: 'staged' }> = []
  const modified: Array<{ path: string; status: 'modified' }> = []
  const untracked: Array<{ path: string; status: 'untracked' }> = []

  for (const line of lines) {
    // 首行分支信息：## main...origin/main
    if (line.startsWith('## ')) {
      branch = line.slice(3).split('...')[0].trim()
      continue
    }
    // porcelain v1 格式：XY PATH（XY 两个状态字符 + 空格 + 路径）
    const xy = line.slice(0, 2)
    let p = line.slice(3).trim()
    // 重命名/复制输出为 "old -> new"，取新路径
    if (p.includes(' -> ')) p = p.split(' -> ')[1]
    if (xy === '??') {
      untracked.push({ path: p, status: 'untracked' })
    } else {
      const idx = xy[0]
      const wt = xy[1]
      // 索引区有变更 → staged
      if (idx !== ' ' && idx !== '?') {
        staged.push({ path: p, status: 'staged' })
      }
      // 工作区有变更 → modified（索引区状态为空的场景，避免同一文件重复进两列表）
      if (wt !== ' ' && wt !== '?') {
        modified.push({ path: p, status: 'modified' })
      }
    }
  }
  return { branch, staged, modified, untracked }
}

/**
 * 构建 promptAsync 的 parts：text part 在前 + file part（mime 按扩展名推断、url 用 file:// URL——serve 约定，实测返回格式 file:///C:/…）
 */
export function buildSendParts(
  message: string,
  attachments: Array<{ path: string; name: string }>,
): Array<{ type: 'text'; text: string } | FilePartInput> {
  return [
    { type: 'text', text: message },
    ...attachments.map((a) => ({
      type: 'file' as const,
      mime: mimeFromExt(a.name),
      url: pathToFileURL(a.path).href,
      filename: a.name,
    })),
  ]
}

/**
 * 注册全部主进程 IPC handler。
 * 职责：实现 renderer 桥（electronBridge.invoke）的本地能力通道 + 引擎通道（阶段 4）。
 * serverManager：serve 进程管理器（index.ts 注入；测试可省略，引擎通道此时抛「引擎未初始化」）。
 */
export function registerIpcHandlers(serverManager?: ServerManager): void {
  // ── 文件系统 ──

  ipcMain.handle('fs:listDir', async (_e, args: { path: string }) => {
    assertValidFsPath(args.path)
    const entries = await fsp.readdir(args.path, { withFileTypes: true })
    const result: Array<{ name: string; path: string; is_dir: boolean; size: number }> = []
    for (const entry of entries) {
      try {
        const stat = await fsp.stat(join(args.path, entry.name))
        result.push({
          name: entry.name,
          path: join(args.path, entry.name),
          is_dir: entry.isDirectory(),
          size: stat.size
        })
      } catch {
        // 单个条目 stat 失败（如权限/软链损坏）→ 跳过，不影响整体列表
        result.push({
          name: entry.name,
          path: join(args.path, entry.name),
          is_dir: entry.isDirectory(),
          size: 0
        })
      }
    }
    return result
  })

  ipcMain.handle('fs:readFileContent', (_e, args: { path: string }) => {
    assertValidFsPath(args.path)
    return fsp.readFile(args.path, 'utf-8')
  })

  ipcMain.handle('fs:writeFile', (_e, args: { path: string; content: string }) => {
    assertValidFsPath(args.path)
    return fsp.writeFile(args.path, args.content, 'utf-8')
  })

  ipcMain.handle('fs:saveFileContent', (_e, args: { path: string; content: string }) => {
    assertValidFsPath(args.path)
    return fsp.writeFile(args.path, args.content, 'utf-8')
  })

  ipcMain.handle('fs:deleteFile', (_e, args: { path: string }) => {
    assertValidFsPath(args.path)
    return fsp.rm(args.path, { recursive: true, force: true })
  })

  ipcMain.handle('fs:renameFile', async (_e, args: { path: string; newName: string }) => {
    assertValidFsPath(args.path)
    assertValidFileName(args.newName)
    const newPath = join(dirname(args.path), args.newName)
    await fsp.rename(args.path, newPath)
    return newPath
  })

  ipcMain.handle('fs:moveFile', async (_e, args: { path: string; destDir: string }) => {
    assertValidFsPath(args.path)
    assertValidFsPath(args.destDir)
    const newPath = join(args.destDir, basename(args.path))
    await fsp.rename(args.path, newPath)
    return newPath
  })

  ipcMain.handle('fs:copyFile', async (_e, args: { path: string; destDir: string }) => {
    assertValidFsPath(args.path)
    assertValidFsPath(args.destDir)
    const newPath = join(args.destDir, basename(args.path))
    await fsp.copyFile(args.path, newPath)
    return newPath
  })

  ipcMain.handle('fs:createDir', (_e, args: { path: string }) => {
    assertValidFsPath(args.path)
    return fsp.mkdir(args.path, { recursive: true })
  })

  ipcMain.handle('fs:readFileBase64', async (_e, args: { path: string }) => {
    assertValidFsPath(args.path)
    const buf = await fsp.readFile(args.path)
    return buf.toString('base64')
  })

  ipcMain.handle('fs:getWorkspaceRoot', () => {
    // 阶段 2：默认用户主目录（可浏览）；阶段 4 由 serve 工作区决定
    return app.getPath('home')
  })

  ipcMain.handle('fs:revealInExplorer', (_e, args: { path: string }) => {
    assertValidFsPath(args.path)
    shell.showItemInFolder(args.path)
  })

  // ── Git（git CLI 执行）──

  ipcMain.handle('git:status', async (_e, args: { repoPath: string }) => {
    assertValidFsPath(args.repoPath)
    const stdout = await execGit(args.repoPath, ['status', '--porcelain=v1', '-b'])
    return parseGitStatus(stdout)
  })

  ipcMain.handle('git:diff', async (_e, args: { repoPath: string; file: string; staged: boolean }) => {
    assertValidFsPath(args.repoPath)
    // file 是仓库内相对路径（如 src/foo.ts），只做非空与 .. 前缀拦截
    if (typeof args.file !== 'string' || args.file.trim() === '' || args.file.startsWith('..')) {
      throw new Error(`非法 git 文件参数: ${String(args.file)}`)
    }
    const diffArgs = args.staged ? ['diff', '--cached', '--', args.file] : ['diff', '--', args.file]
    return execGit(args.repoPath, diffArgs)
  })

  ipcMain.handle('git:stage', async (_e, args: { repoPath: string; files: string[] }) => {
    assertValidFsPath(args.repoPath)
    await execGit(args.repoPath, ['add', '--', ...args.files])
  })

  ipcMain.handle('git:unstage', async (_e, args: { repoPath: string; files: string[] }) => {
    assertValidFsPath(args.repoPath)
    await execGit(args.repoPath, ['restore', '--staged', '--', ...args.files])
  })

  ipcMain.handle('git:commit', async (_e, args: { repoPath: string; message: string; amend: boolean }) => {
    assertValidFsPath(args.repoPath)
    const commitArgs = args.amend ? ['commit', '--amend', '-m', args.message] : ['commit', '-m', args.message]
    return execGit(args.repoPath, commitArgs)
  })

  ipcMain.handle('git:push', async (_e, args: { repoPath: string }) => {
    assertValidFsPath(args.repoPath)
    await execGit(args.repoPath, ['push'])
  })

  // ── 设置/配置持久化（userData JSON 文件）──

  ipcMain.handle('settings:saveUiSettings', (_e, args: { json: string }) => {
    return writeJsonFile(join(app.getPath('userData'), 'ui-settings.json'), JSON.parse(args.json))
  })

  ipcMain.handle('settings:loadUiSettings', async () => {
    try {
      return await fsp.readFile(join(app.getPath('userData'), 'ui-settings.json'), 'utf-8')
    } catch {
      // 首次启动无记录 → 返回 "{}"，前端走默认值
      return '{}'
    }
  })

  ipcMain.handle(
    'settings:saveProviderConfig',
    async (_e, args: { providerId: string; apiKey: string; baseUrl: string; model: string }) => {
      const file = join(app.getPath('userData'), 'provider-configs.json')
      const cfg = (await readJsonFile(file, {})) as Record<string, unknown>
      const next = { ...cfg, [args.providerId]: { apiKey: args.apiKey, baseUrl: args.baseUrl, model: args.model } }
      await writeJsonFile(file, next)
      // 引擎配置联动（阶段 5）：保存 API Key 的同时写 serve 隔离配置 opencode.json（单一入口，避免前端竞态）。
      // apiKey 为空视为用户未配置，跳过联动（否则会把已生效的 key 覆盖为空）。
      // permissionMode 用 default 兜底（安全默认：敏感工具 ask）；前端模式切换的精确联动后续阶段细化。
      if (args.apiKey && args.apiKey.trim()) {
        await ensureConfig(app.getPath('userData'), { apiKey: args.apiKey.trim(), permissionMode: 'default' })
        // serve 启动时加载配置（阶段 0 实测）——key 变更后重启 serve 使新配置生效。
        // 仅对已运行实例重启：首次启动场景（健康检查中）前端会自动保存设置，此时重启会打断 serve 启动（2026-08-06 实测）
        if (serverManager?.getServerInfo().running) {
          await serverManager.stopServer()
          await serverManager.ready()
        }
      }
    }
  )

  ipcMain.handle('engine:getStatus', () => serverManager?.getServerInfo() ?? { running: false })

  ipcMain.handle('settings:loadProviderConfigs', async () => {
    const cfg = await readJsonFile(join(app.getPath('userData'), 'provider-configs.json'), {})
    return cfg as Record<string, { apiKey: string; baseUrl: string; model: string }>
  })

  // ── settings.json 配置体系（阶段 6，方案 3.8）：类 VSCode settings.json + agent 可自检自改 ──
  // 与 provider-configs.json 分离：API Key 走 saveProviderConfig 通道（第 3 层密钥隔离，不进 settings.json）

  ipcMain.handle('settings:getConfig', async () => {
    // 首次调用（内存态尚未从磁盘加载）→ 主动读盘；之后直接返回内存态（watch/save 持续更新）
    // exists：settings.json 是否真实存在于磁盘（默认态与显式配置的区分，前端主题持久化依赖）
    if (!isSettingsLoaded()) {
      const r = await loadSettings(app.getPath('userData'))
      return { ...r, exists: getSettingsFileExists() }
    }
    const r = getSettingsConfig()
    return { ...r, exists: getSettingsFileExists() }
  })

  ipcMain.handle('settings:saveSettings', async (_e, args: { jsoncText: string }) => {
    if (typeof args?.jsoncText !== 'string') {
      throw new Error(`settings:saveSettings jsoncText 参数非法: ${String(args?.jsoncText)}`)
    }
    // saveSettings 内部：写盘 + 校验 + 引擎联动（ensureConfig 增量同步 opencode.json）+ 广播 config-changed
    return saveSettings(app.getPath('userData'), args.jsoncText)
  })

  ipcMain.handle('settings:getSchema', async () => {
    // settings.schema.json 内容——SettingsJsonEditor 编辑器提示用
    return getSettingsSchema()
  })

  // ── 会话日志持久化（userData/session-logs/{sessionId}/）+ serve 引擎日志（userData/logs/serve.log）──

  ipcMain.handle('logs:saveSessionDebugLog', (_e, args: { sessionId: string; linesJson: string }) => {
    const file = join(app.getPath('userData'), 'session-logs', args.sessionId, 'debug.json')
    return fsp.mkdir(dirname(file), { recursive: true }).then(() => fsp.writeFile(file, args.linesJson, 'utf-8'))
  })

  // 读取 serve 引擎日志尾部（诊断面板引擎日志页，D8）：lines 正整数 1-5000，缺省 500
  ipcMain.handle('logs:readServeLog', async (_e, args: { lines?: number }) => {
    const maxLines = args?.lines ?? 500
    if (!Number.isInteger(maxLines) || maxLines < 1 || maxLines > 5000) {
      throw new Error(`logs:readServeLog lines 必须是 1-5000 的正整数: ${String(args?.lines)}`)
    }
    try {
      // readTailLines 大文件尾部读取；文件不存在（serve 未启动）内部已返回 []
      return await readTailLines(join(app.getPath('userData'), 'logs', 'serve.log'), maxLines)
    } catch (err) {
      // 读取失败（文件被占用/权限）→ 返回空数组 + 主进程记录，前端显示空态可重试
      console.error(`[ipc] 读取 serve.log 失败：${err instanceof Error ? err.message : String(err)}`)
      return []
    }
  })

  ipcMain.handle('logs:loadSessionLogs', async (_e, args: { sessionId: string }) => {
    const dir = join(app.getPath('userData'), 'session-logs', args.sessionId)
    const debugFile = join(dir, 'debug.json')
    // stderr.json 槽位已移除（OC 无 --verbose 输出，CC 遗留机制废除——方案 D4），返回结构单元素 [debugJson]
    const debug = await fsp.readFile(debugFile, 'utf-8').catch(() => null)
    return [debug] as [string | null]
  })

  // 应用信息（诊断面板「复制诊断信息」打包头 + 设置页「关于」三行版本：分形/OC 引擎/预置包）
  ipcMain.handle('app:getInfo', async () => {
    const [engineVersion, presetVersion] = await Promise.all([getEngineVersion(), getPresetVersion()])
    return { name: app.getName(), version: app.getVersion(), engineVersion, presetVersion }
  })

  // ── 文件对话框（替代 @tauri-apps/plugin-dialog）──

  ipcMain.handle(
    'dialog:openDialog',
    async (
      _e,
      args: { options: { directory?: boolean; multiple?: boolean; title?: string; defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> } }
    ) => {
      const opts = args.options ?? {}
      // 父窗口保底：焦点不在 app 时 getFocusedWindow 为 null，无父对话框不置前（用户感觉「没效果」）——用主窗口兜底
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? undefined
      // 模态对话框前置保障：窗口若被遮挡/最小化则先恢复聚焦，否则对话框可能弹到不可见位置
      if (win) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      }
      // 调用日志（诊断用，后续可移除）：记录对话框请求与结果
      try {
        const { appendFileSync } = require('node:fs') as typeof import('node:fs')
        appendFileSync(join(app.getPath('userData'), 'dialog.log'), `${new Date().toISOString()} openDialog directory=${!!opts.directory}\n`)
      } catch { /* 日志失败忽略 */ }
      const properties: Array<'openFile' | 'openDirectory' | 'multiSelections'> = []
      // 目录模式与文件模式互斥，directory 优先
      if (opts.directory) {
        properties.push('openDirectory')
      } else {
        properties.push('openFile')
      }
      if (opts.multiple) properties.push('multiSelections')
      // 无聚焦窗口时走无父窗口重载（避免 win! 崩溃：应用启动瞬间/全部最小化场景）
      const result = win
        ? await dialog.showOpenDialog(win, {
            title: opts.title,
            defaultPath: opts.defaultPath,
            properties,
            filters: opts.filters as Electron.FileFilter[] | undefined
          })
        : await dialog.showOpenDialog({
            title: opts.title,
            defaultPath: opts.defaultPath,
            properties,
            filters: opts.filters as Electron.FileFilter[] | undefined
          })
      if (result.canceled || result.filePaths.length === 0) return null
      return opts.multiple ? result.filePaths : result.filePaths[0]
    }
  )

  ipcMain.handle(
    'dialog:saveDialog',
    async (_e, args: { options: { title?: string; defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> } }) => {
      const opts = args.options ?? {}
      const win = BrowserWindow.getFocusedWindow() ?? undefined
      // 同 openDialog：无聚焦窗口时走无父窗口重载
      const result = win
        ? await dialog.showSaveDialog(win, {
            title: opts.title,
            defaultPath: opts.defaultPath,
            filters: opts.filters as Electron.FileFilter[] | undefined
          })
        : await dialog.showSaveDialog({
            title: opts.title,
            defaultPath: opts.defaultPath,
            filters: opts.filters as Electron.FileFilter[] | undefined
          })
      if (result.canceled || !result.filePath) return null
      return result.filePath
    }
  )

  // ── 引擎通道（阶段 4：serve SDK 直连）──

  // 未注入 serverManager 时所有引擎通道统一抛错（测试环境/引擎未初始化）
  // async：先等待 serve 就绪（ready 共享启动 promise），避免前端请求早于健康检查完成（ECONNREFUSED 竞态）
  const requireClient = async (): Promise<OcClient> => {
    if (!serverManager) throw new Error('引擎未初始化：server-manager 未注入')
    await serverManager.ready()
    return serverManager.getClient()
  }

  ipcMain.handle(
    'chat:sendMessage',
    async (
      _e,
      args: {
        sessionId: string
        message: string
        model?: { providerID: string; modelID: string }
        agent?: string
        attachments?: Array<{ path: string; name: string }>
        variant?: string
      }
    ) => {
      if (typeof args?.sessionId !== 'string' || typeof args?.message !== 'string') {
        throw new Error(`chat:sendMessage 参数非法: ${JSON.stringify(args)}`)
      }
      // variant 可选字符串校验：非字符串（如数字/对象）拒绝，防注入非法 body 字段
      if (args.variant !== undefined && typeof args.variant !== 'string') {
        throw new Error(`chat:sendMessage variant 必须是字符串: ${JSON.stringify(args.variant)}`)
      }
      // 附件参数校验：可选数组，每项必须含绝对路径 + 展示名（绝对路径由 assertValidFsPath 拦截越界）
      let attachments: Array<{ path: string; name: string }> = []
      if (args.attachments !== undefined) {
        if (!Array.isArray(args.attachments)) {
          throw new Error(`chat:sendMessage attachments 必须是数组: ${JSON.stringify(args.attachments)}`)
        }
        for (const a of args.attachments) {
          if (!a || typeof a.name !== 'string' || !a.name.trim() || typeof a.path !== 'string') {
            throw new Error(`chat:sendMessage attachment 非法: ${JSON.stringify(a)}`)
          }
          assertValidFsPath(a.path)
        }
        attachments = args.attachments
      }
      // promptAsync 立即返回（204），结果通过 SSE 事件流回前端；model 由前端传入（settings.model），
      // 缺省时用 provider.ts 默认 pro（serve 全局默认在 oc-config.ts 写 config.model）；
      // agent 由前端传入（settings.currentAgent：双星/build/plan，缺省走 serve 默认 Build）
      const model = args.model && args.model.providerID && args.model.modelID ? args.model : undefined
      const extra = {
        model: model ?? { providerID: 'ds', modelID: DEFAULT_MODEL.id },
        ...(typeof args?.agent === 'string' && args.agent ? { agent: args.agent } : {}),
        // variant 思考强度透传（spec 实测 prompt_async body 顶层字段；空串/缺省不传）
        ...(typeof args?.variant === 'string' && args.variant ? { variant: args.variant } : {}),
      }
      const client = await requireClient()
      if (attachments.length === 0) {
        // 无附件：保持便捷调用（text 单 part）
        await client.session.promptAsync(args.sessionId, args.message, extra)
      } else {
        // 有附件：text part 在前 + file part（mime 按扩展名推断、url 用 file:// URL——serve 约定）
        const parts = buildSendParts(args.message, attachments)
        await client.session.promptPartsAsync(args.sessionId, parts, extra)
      }
      return { accepted: true }
    }
  )

  // ✨ 输入消息优化（原型发送左侧功能）：临时会话润色 → 提取回复 → 删除临时会话。
  // 独立临时会话避免污染当前会话历史；promptAsync 异步提交（结果走 SSE），轮询 messages 直到 assistant 文本出现。
  // 2026-08-08 修复：①指定 build agent（临时会话默认双星会触发读文件/工具流，润色只需纯文本回复——用户报错根因）；
  // ②超时 20s→60s（deepseek-v4-pro 长推理，20s 内未回复即报「润色超时」——用户报错嫌疑）。
  ipcMain.handle('ai:polishMessage', async (_e, args: { text: string; refs?: Array<{ label?: string; content?: string; path?: string }> }) => {
    const text = typeof args?.text === 'string' ? args.text.trim() : ''
    if (!text) throw new Error('ai:polishMessage text 必须是非空字符串')
    const client = await requireClient()
    let tempId = ''
    try {
      const s = await client.session.create({ title: '消息润色' })
      // oc-sdk create 返回 Session 本体（normalizeError 已解包 data）
      tempId = s.id || ''
      if (!tempId) throw new Error('临时会话创建失败')
      // agent: build——纯文本润色不执行工具（build 遵循模型指令直接输出；默认双星会读文件/多轮工具流）
      // model: flash + variant low——润色是短文本任务，快模型足够（v4-pro 推理慢 2-3 倍，2026-08-08 用户讨论「直连 vs 走引擎」后选定）
      await client.session.promptAsync(tempId, await buildPolishPrompt(text, args?.refs), {
        agent: 'build',
        model: { providerID: 'deepseek', modelID: 'deepseek-v4-flash' },
        variant: 'low',
      })
      // promptAsync 立即返回，结果异步生成——轮询直到回复出现（500ms × 120 = 60s 上限）
      let polished = ''
      for (let i = 0; i < 120 && !polished; i++) {
        await new Promise((r) => setTimeout(r, 500))
        const msgs = await client.session.messages(tempId)
        polished = extractAssistantText(msgs)
      }
      if (!polished) throw new Error('润色超时：模型未在 60 秒内回复')
      return { ok: true, text: polished }
    } finally {
      // 尽力清理临时会话（失败不阻断——serve 侧会残留一条「消息润色」会话，可接受）
      if (tempId) {
        try { await client.session.delete(tempId) } catch { /* 清理失败可接受 */ }
      }
    }
  })

  ipcMain.handle('engine:testConnection', async (_e, args: { apiKey: string }) => {
    // 设置面板「测试连接」：写 key 到 serve 隔离配置 + 验证 serve 可达
    if (typeof args?.apiKey !== 'string' || !args.apiKey.trim()) {
      return { ok: false, message: 'API Key 不能为空' }
    }
    try {
      // ① 写隔离配置（serve 读取 provider.deepseek.options.apiKey 使用，阶段 0 实测：无需 env 注入）
      await ensureConfig(app.getPath('userData'), { apiKey: args.apiKey.trim(), permissionMode: 'default' })
      // ② 验证 serve 可达（provider.list 成功即 serve 就绪；key 的有效性由下次请求隐式验证）
      await (await requireClient()).config.providers()
      return { ok: true, message: '配置已写入，serve 就绪' }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('provider:modelVariants', async (_e, args: { modelId?: string }) => {
    // 思考强度选择器数据源：从 /provider 响应提取指定模型的 variants keys 数组。
    // variants 是 spec 实测字段（如 deepseek-v4-flash={low,high,max}），SDK ProviderListResponse 类型未生成——
    // 用宽类型提取（与 provider.ts listDeepseekModels 同模式）。modelId 兼容带/不带 provider 前缀。
    if (typeof args?.modelId !== 'string' || !args.modelId.trim()) return []
    const modelId = args.modelId.trim()
    const resp = await (await requireClient()).config.providers()
    const all = (resp as { all?: unknown }).all as Array<{ id: string; models?: Record<string, { id: string; variants?: Record<string, unknown> }> }> | undefined
    for (const p of all ?? []) {
      for (const [mid, m] of Object.entries(p.models ?? {})) {
        if (mid === modelId || m.id === modelId) {
          return Object.keys(m.variants ?? {})
        }
      }
    }
    return []
  })

  ipcMain.handle('engine:refresh', async () => {
    // 重启 serve（右上角刷新按钮 / 数据模式切换：配置/预置变更立即生效）；stopServer 幂等，startServer 内部有 ready 缓存。
    // 返回 {ok, error?} 而非抛错：数据模式切换需失败回滚再重试（settings store setDataMode），
    // 抛给渲染层会中断回滚链（D8 P0 防引擎停摆）；未注入 serverManager 同样以 error 形式返回。
    if (!serverManager) return { ok: false, error: '引擎未初始化：server-manager 未注入' }
    try {
      await serverManager.stopServer().catch(() => {})
      await serverManager.startServer()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('chat:stopSession', async (_e, args: { sessionId: string }) => {
    // 引擎未初始化（requireClient）失败必须抛给前端，不进入 abort 容错
    const client = await requireClient()
    try {
      await client.session.abort(args.sessionId)
    } catch {
      // abort 端点阶段 0 实测返回 500 但事件流 session.idle 证明中断生效（S7）——容错：不因 500 抛错
    }
    return { stopped: true }
  })

  ipcMain.handle('session:create', async (_e, args: { title?: string; cwd?: string }) => {
    // cwd 透传 serve query.directory：新会话绑定当前工作区，切换工作区后列表刷新才可见（会话跟随工作区）
    const s = await (await requireClient()).session.create({
      title: typeof args?.title === 'string' ? args.title : undefined,
      cwd: typeof args?.cwd === 'string' && args.cwd ? args.cwd : undefined,
    })
    return toSessionData(s)
  })

  ipcMain.handle('session:list', async (_e, args: { directory?: string } = {}) => {
    // directory 透传 serve 过滤：会话跟随工作区（OC session 绑定 project/directory）
    const list = await (await requireClient()).session.list(args.directory)
    return list.map(toSessionData)
  })

  ipcMain.handle('session:get', async (_e, args: { id: string }) => {
    const s = await (await requireClient()).session.get(args.id)
    return toSessionData(s)
  })

  ipcMain.handle('session:delete', async (_e, args: { id: string }) => {
    await (await requireClient()).session.delete(args.id)
    return { deleted: true }
  })

  ipcMain.handle('session:rename', async (_e, args: { id: string; title: string }) => {
    const s = await (await requireClient()).session.rename(args.id, args.title)
    return toSessionData(s)
  })

  ipcMain.handle('session:fork', async (_e, args: { id: string; messageID?: string }) => {
    // 服务端分叉：新会话继承原会话上下文，标题自动追加「 (fork #N)」（阶段 0 实测 S8）
    const s = await (await requireClient()).session.fork(args.id, typeof args?.messageID === 'string' ? args.messageID : undefined)
    return toSessionData(s)
  })

  ipcMain.handle('message:list', async (_e, args: { sessionId: string; limit?: number; before?: string }) => {
    // 参数校验：sessionId 必填；limit 可选正整数（1-1000）；before 可选字符串（消息 ID 分页游标）
    if (typeof args?.sessionId !== 'string' || !args.sessionId) {
      throw new Error(`message:list sessionId 参数非法: ${JSON.stringify(args)}`)
    }
    if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 1000)) {
      throw new Error(`message:list limit 必须是 1-1000 的正整数: ${String(args.limit)}`)
    }
    if (args.before !== undefined && typeof args.before !== 'string') {
      throw new Error(`message:list before 必须是字符串: ${String(args.before)}`)
    }
    // 透传 limit/before：首屏 limit=50 取最近 N 条；滚动到顶 before=首条消息 id 取更早
    const msgs = await (await requireClient()).session.messages(args.sessionId, {
      limit: args.limit,
      before: args.before,
    })
    return msgs.map(toMessageData)
  })

  ipcMain.handle('permission:respond', async (_e, args: { sessionId: string; permissionId: string; response: 'once' | 'always' | 'reject' }) => {
    // 响应枚举白名单校验（SDK 1.18.13：once/always/reject，杜绝前端注入非法值）
    if (!['once', 'always', 'reject'].includes(args.response)) {
      throw new Error(`permission:respond response 非法: ${String(args.response)}`)
    }
    await (await requireClient()).permission.respond(args.sessionId, args.permissionId, args.response)
    return { responded: true }
  })

  // 校验 question 回答数组：必须是非空 string[][]（每项是该问题选中的 label 数组）
  function assertAnswersShape(answers: unknown): asserts answers is string[][] {
    if (!Array.isArray(answers) || !answers.every((a) => Array.isArray(a) && a.every((x) => typeof x === 'string'))) {
      throw new Error(`question:reply answers 非法: 需要 string[][]（每项为选中 label 数组）`)
    }
  }

  // 取 serve 连接信息（requireClient 已保证 serve 就绪，getServerInfo 必有 baseURL/凭据）
  const getServerAuth = (): { baseURL: string; authHeader: string } => {
    if (!serverManager) throw new Error('引擎未初始化：server-manager 未注入')
    const info = serverManager.getServerInfo()
    if (!info.baseURL || !info.username || !info.password) {
      throw new Error('question 通道：serve 连接信息不完整')
    }
    return { baseURL: info.baseURL, authHeader: basicAuthHeader(info.username, info.password) }
  }

  ipcMain.handle('question:reply', async (_e, args: { sessionId: string; requestId: string; answers: string[][] }) => {
    // SDK 1.18.13 无 question 方法（阶段 0 实测），用裸 fetch 调 serve 原生端点
    if (typeof args?.sessionId !== 'string' || !args.sessionId || typeof args?.requestId !== 'string' || !args.requestId) {
      throw new Error(`question:reply 参数非法: ${JSON.stringify(args)}`)
    }
    assertAnswersShape(args.answers)
    // 先 await ready（共享启动 promise），避免 serve 未就绪时 getServerInfo 拿不到连接信息
    await requireClient()
    const { baseURL, authHeader } = getServerAuth()
    const res = await fetch(`${baseURL}/question/${encodeURIComponent(args.requestId)}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authHeader },
      body: JSON.stringify({ answers: args.answers }),
    })
    if (!res.ok) {
      throw new Error(`question:reply 失败（HTTP ${res.status}）：${await res.text().catch(() => '')}`)
    }
    return { ok: true }
  })

  ipcMain.handle('question:reject', async (_e, args: { sessionId: string; requestId: string }) => {
    if (typeof args?.sessionId !== 'string' || !args.sessionId || typeof args?.requestId !== 'string' || !args.requestId) {
      throw new Error(`question:reject 参数非法: ${JSON.stringify(args)}`)
    }
    await requireClient()
    const { baseURL, authHeader } = getServerAuth()
    const res = await fetch(`${baseURL}/question/${encodeURIComponent(args.requestId)}/reject`, {
      method: 'POST',
      headers: { Authorization: authHeader },
    })
    if (!res.ok) {
      throw new Error(`question:reject 失败（HTTP ${res.status}）：${await res.text().catch(() => '')}`)
    }
    return { ok: true }
  })

  // 命令菜单「压缩上下文」：调 serve v2 compact 端点（SDK 1.18.13 无 compact 方法，spec 实测 /api/session/{id}/compact POST 204）。
  // 与 question 通道同模式：裸 fetch + Basic 认证（先 await ready 保证连接信息就绪）。
  ipcMain.handle('session:compact', async (_e, args: { id: string }) => {
    if (typeof args?.id !== 'string' || !args.id) {
      throw new Error(`session:compact id 参数非法: ${JSON.stringify(args)}`)
    }
    await requireClient()
    const { baseURL, authHeader } = getServerAuth()
    const res = await fetch(`${baseURL}/api/session/${encodeURIComponent(args.id)}/compact`, {
      method: 'POST',
      headers: { Authorization: authHeader },
    })
    if (!res.ok) {
      throw new Error(`session:compact 失败（HTTP ${res.status}）：${await res.text().catch(() => '')}`)
    }
    return { ok: true }
  })

  // ── 右侧面板数据源（阶段 6 遗留 P1-P3：记忆/计划/状态，文件监听实时刷新）──

  ipcMain.handle('memory:list', async () => {
    const userDataDir = app.getPath('userData')
    // 项目记忆目录跟随渲染进程工作区（ui-settings.json 持久化）；工作区切换时重建项目 watcher
    const cwd = await readProjectCwd(userDataDir)
    getPanelWatchers()?.refreshProject(cwd)
    return listMemories(userDataDir, cwd)
  })

  ipcMain.handle('memory:confirm', async (_e, args: { file: string }) => {
    // 路径安全：file 必须位于记忆目录内（panel.ts resolveMemoryDir 校验，防越界改写）
    const userDataDir = app.getPath('userData')
    return confirmMemory(userDataDir, await readProjectCwd(userDataDir), args?.file)
  })

  ipcMain.handle('memory:remove', async (_e, args: { file: string }) => {
    // 路径安全：file 必须位于记忆目录内（panel.ts resolveMemoryDir 校验，防越界删除）
    const userDataDir = app.getPath('userData')
    return removeMemory(userDataDir, await readProjectCwd(userDataDir), args?.file)
  })

  ipcMain.handle('plans:list', async () => {
    return listPlans(app.getPath('userData'))
  })

  ipcMain.handle('status:get', async () => {
    return getStatusState(app.getPath('userData'))
  })

  // 保留的 ping 通道（无业务用途，供调试探活）
  ipcMain.on('ping', () => console.log('pong'))
}

// ══════════════════════════════════════════════════════════════════
// 引擎数据映射（OC Session/Message → 前端 SessionData/MessageData 契约）
// ══════════════════════════════════════════════════════════════════

/**
 * ISO 毫秒 → 前端兼容时间串。
 * 注意：前端 session store 的 toLocalSession 会拼 "Z" 再 new Date（new Date(s.created_at + "Z")），
 * 因此这里必须去掉 toISOString 的毫秒+Z 后缀，否则 "…000Z"+"Z" 解析失败。
 */
export function formatOcTime(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, '')
}

/** OC Session → 前端 SessionData（对齐 electron-bridge.ts 类型定义） */
export function toSessionData(s: Session): {
  id: string
  title: string
  cli_session_id: string | null
  cwd: string
  model: string
  status: string
  mode: string
  created_at: string
  updated_at: string
  message_count: number
  total_tokens: number | null
  total_cost: number | null
} {
  return {
    id: s.id,
    title: s.title,
    // OC 无 CLI 会话概念（serve 会话即 ses_xxx），保留字段置 null
    cli_session_id: null,
    cwd: s.directory,
    model: '',
    // OC Session 无 status 字段（busy/idle 走事件流），前端以事件为准，此处给占位 idle
    status: 'idle',
    mode: '',
    created_at: formatOcTime(s.time.created),
    updated_at: formatOcTime(s.time.updated),
    // 消息数需另查 messages（避免 N+1），列表场景给 0（前端以事件流实时刷新为准）
    message_count: 0,
    total_tokens: null,
    total_cost: null,
  }
}

/** serve FilePart → 前端 AttachedFile（{name, path}）；path 优先本地 source.path，兜底 url */
function filePartToAttachment(p: { filename?: string; url: string; source?: { path?: string } }): { name: string; path: string } {
  const path = p.source?.path ?? p.url
  const name = p.filename ?? basename(path) ?? p.url
  return { name, path }
}

/** assistant 消息 parts → 前端 contentBlocks 时间线（thinking → tool_use+tool_result → text，工具结果紧跟工具卡片） */
function buildHistoryContentBlocks(
  parts: Array<{ type: string; text?: string; callID?: string; tool?: string; state?: { status?: string; input?: Record<string, unknown>; output?: string; error?: string } }>
): Array<{
  type: 'thinking' | 'tool_use' | 'tool_result' | 'text'
  content?: string
  toolUse?: { id: string; name: string; input: Record<string, unknown>; result?: string; isError?: boolean }
  toolResult?: { toolUseId: string; content: string; isError?: boolean }
}> {
  const blocks: Array<{
    type: 'thinking' | 'tool_use' | 'tool_result' | 'text'
    content?: string
    toolUse?: { id: string; name: string; input: Record<string, unknown>; result?: string; isError?: boolean }
    toolResult?: { toolUseId: string; content: string; isError?: boolean }
  }> = []
  // 思考块：全部 reasoning part 聚合（与流式 synthesizeBlocks 一致，thinking 在最前）
  const thinking = parts
    .filter((p) => p.type === 'reasoning')
    .map((p) => p.text ?? '')
    .filter(Boolean)
    .join('\n')
  if (thinking) blocks.push({ type: 'thinking', content: thinking })
  // 工具块：仅完成/错误态（pending/running 是流式中间态，历史消息取终态）
  for (const p of parts) {
    if (p.type !== 'tool' || !p.callID || !p.tool) continue
    const status = p.state?.status
    if (status !== 'completed' && status !== 'error') continue
    const isError = status === 'error'
    const toolUse = { id: p.callID, name: p.tool, input: p.state?.input ?? {}, result: isError ? p.state?.error ?? '' : p.state?.output ?? '', isError }
    blocks.push({ type: 'tool_use', toolUse })
    // 工具结果块紧跟对应工具卡片（MessageBubble 渲染 tool_use 内嵌结果，tool_result 块保证数据完整性）
    blocks.push({ type: 'tool_result', toolResult: { toolUseId: p.callID, content: toolUse.result, isError } })
  }
  // 文本块：非 synthetic text part 聚合（synthetic 是 serve 回显的临时占位，历史消息应排除）
  const text = parts
    .filter((p) => p.type === 'text' && !(p as { synthetic?: boolean }).synthetic)
    .map((p) => p.text ?? '')
    .filter(Boolean)
    .join('\n')
  if (text) blocks.push({ type: 'text', content: text })
  return blocks
}

// ── ✨ 输入消息润色辅助（ai:polishMessage 用）──

/** 润色指令前缀：中文写作助手，直接输出优化结果不解释（防污染输入框）（导出供测试断言） */
export const POLISH_PROMPT =
  '你是专业的中文写作助手。请优化下面的用户消息，使其表达更清晰、准确、有条理，保持原意和语气，不改变用户意图。直接输出优化后的消息，不要任何解释、前缀或引号。\n\n消息：'

/** 引用文件内容截断上限（防超大文件打爆 prompt，50KB ≈ 1.5 万 token） */
const POLISH_REF_MAX_BYTES = 50_000

/**
 * 组装润色 prompt：带用户显式引用的上下文（chips：选区片段 content / 附件文件 path）。
 * 引用仅作背景理解（明确告知模型不要引用到输出中）；文件读取失败跳过该引用不阻断润色。
 * 2026-08-08 用户确认方案：不带对话历史（不可预期/贵/慢），带显式引用（用户意图明确）。
 */
export async function buildPolishPrompt(
  text: string,
  refs?: Array<{ label?: string; content?: string; path?: string }>,
): Promise<string> {
  if (!refs || refs.length === 0) return POLISH_PROMPT + text
  const blocks: string[] = []
  for (const r of refs) {
    if (r.content) {
      blocks.push(`【${r.label || '引用片段'}】\n${r.content}`)
    } else if (r.path) {
      try {
        const content = await fsp.readFile(r.path, 'utf-8')
        blocks.push(`【${r.label || r.path}】\n${content.slice(0, POLISH_REF_MAX_BYTES)}`)
      } catch {
        // 文件读不到（已删除/无权限）——跳过该引用，不阻断润色
      }
    }
  }
  if (blocks.length === 0) return POLISH_PROMPT + text
  return (
    `你是专业的中文写作助手。请优化下面的用户消息，使其表达更清晰、准确、有条理，保持原意和语气，不改变用户意图。\n` +
    `以下是用户显式引用的参考内容（仅作背景理解，不要引用到输出中）：\n\n` +
    `${blocks.join('\n\n')}\n\n` +
    `要优化的消息：${text}\n\n` +
    `直接输出优化后的消息，不要任何解释、前缀或引号。`
  )
}

/** 提取最后一条 assistant 消息的全部 text part（润色回复；多 part 拼接；导出供测试） */
export function extractAssistantText(msgs: SessionMessage[]): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.info.role !== 'assistant') continue
    const texts = m.parts
      .filter((p) => p.type === 'text')
      .map((p) => (p as { text?: string }).text || '')
    const joined = texts.join('')
    if (joined.trim()) return joined
  }
  return ''
}

/**
 * OC SessionMessage → 前端 MessageData（content 为 JSON blob，与前端 saveMessage 存档格式一致）。
 * 结构保持 message:list 契约不变（id/session_id/role/content/token_usage/created_at），
 * 仅 content 从纯文本升级为完整还原的 JSON 串——前端 loadMessages 已内置 JSON blob 解析（chat.ts），
 * 工具调用/思考在切会话后不再丢失（G2 拍板项）。
 */
export function toMessageData(sm: SessionMessage): {
  id: string
  session_id: string
  role: string
  content: string
  token_usage: string
  created_at: string
} {
  const info = sm.info as { id: string; sessionID: string; role: string; time: { created: number; completed?: number }; tokens?: { input: number; output: number; cost?: number } }
  const parts = sm.parts as Array<{ type: string; text?: string; synthetic?: boolean; filename?: string; url?: string; source?: { path?: string }; callID?: string; tool?: string; state?: { status?: string; input?: Record<string, unknown>; output?: string; error?: string } }>

  let content: string
  if (info.role === 'user') {
    // 用户消息：text parts 拼接 + FilePart 附件（有附件才出 JSON blob，纯文本保持旧格式兼容）
    const text = parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text ?? '')
      .filter(Boolean)
      .join('\n')
    const attachments = parts
      .filter((p) => p.type === 'file' && p.url)
      .map((p) => filePartToAttachment(p as { filename?: string; url: string; source?: { path?: string } }))
    content = attachments.length ? JSON.stringify({ text, attachments }) : text
  } else {
    // assistant 消息：完整还原 thinking/toolUses/contentBlocks/durationMs/tokens/cost
    const text = parts
      .filter((p) => p.type === 'text' && !p.synthetic)
      .map((p) => p.text ?? '')
      .filter(Boolean)
      .join('\n')
    const thinking = parts
      .filter((p) => p.type === 'reasoning')
      .map((p) => p.text ?? '')
      .filter(Boolean)
      .join('\n')
    // 工具调用：仅终态（completed/error），id=callID、name=tool、input=state.input、result=output/error
    const toolUses = parts
      .filter((p) => p.type === 'tool' && p.callID && p.tool && (p.state?.status === 'completed' || p.state?.status === 'error'))
      .map((p) => ({
        id: p.callID!,
        name: p.tool!,
        input: p.state?.input ?? {},
        result: p.state?.status === 'error' ? p.state?.error ?? '' : p.state?.output ?? '',
        isError: p.state?.status === 'error',
      }))
    const contentBlocks = buildHistoryContentBlocks(parts)
    // 尽力而为的统计：durationMs 用消息 completed-created 差；tokens 取 SDK 顶层字段；
    // cost 在 step-finish part 上（SDK AssistantMessage.tokens 无 cost 字段，阶段 0 实测）
    const durationMs = info.time.completed !== undefined ? info.time.completed - info.time.created : undefined
    const stepFinish = parts.find((p) => p.type === 'step-finish') as { cost?: number } | undefined
    content = JSON.stringify({
      text,
      thinking,
      toolUses,
      contentBlocks,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(info.tokens?.input !== undefined ? { inputTokens: info.tokens.input } : {}),
      ...(info.tokens?.output !== undefined ? { outputTokens: info.tokens.output } : {}),
      ...(stepFinish?.cost !== undefined ? { costUSD: stepFinish.cost } : {}),
    })
  }

  // assistant 消息带 tokens（SDK AssistantMessage.tokens），user 消息无——转 JSON 串兼容 MessageData.token_usage
  const tokenUsage = info.tokens ? JSON.stringify(info.tokens) : ''
  return {
    id: info.id,
    session_id: info.sessionID,
    role: info.role,
    content,
    token_usage: tokenUsage,
    created_at: formatOcTime(info.time.created),
  }
}

// ══════════════════════════════════════════════════════════════════
// 引擎事件转发（serve SSE → renderer）
// ══════════════════════════════════════════════════════════════════

/**
 * 建立 serve SSE 事件转发：每事件经 events.ts mapServeEvent 映射后 send("engine:event")，
 * server-manager 状态变化 send("engine:status")。窗口关闭时清理订阅。
 * 调用方（index.ts）需先 startServer 成功再调本函数。
 */
export async function startEngineEvents(win: BrowserWindow, manager: ServerManager): Promise<void> {
  const info = manager.getServerInfo()
  if (info.running && info.baseURL && info.username && info.password) {
    const stop = await subscribeEvents({
      baseURL: info.baseURL,
      username: info.username,
      password: info.password,
      onEvent: (evt) => {
        if (!win.isDestroyed()) win.webContents.send('engine:event', evt)
      },
      onError: (err) => {
        console.error('[engine] SSE 订阅错误：', err)
      },
    })
    // 窗口关闭即中断订阅（SDK 底层 abort fetch + 退出消费循环）
    win.on('closed', () => stop())
  }
  // serve 进程状态（启动/退出/崩溃）→ engine:status，前端连接指示依赖
  manager.onStatusChange((s) => {
    if (!win.isDestroyed()) win.webContents.send('engine:status', s)
  })
}

