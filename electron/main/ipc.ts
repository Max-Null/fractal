// IPC 通道注册：renderer 桥（electronBridge）的本地能力实现
// 通道前缀约定：fs: / git: / settings: / logs: / dialog:
// 引擎通道（send_message/stream-event 等）阶段 4 接入 serve 后在此注册
import { app, dialog, ipcMain, shell, BrowserWindow } from 'electron'
import { promises as fsp } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { execFile } from 'node:child_process'

// ── 工具函数 ──

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
async function readJsonFile(filePath: string, fallback: unknown): Promise<unknown> {
  try {
    const raw = await fsp.readFile(filePath, 'utf-8')
    return JSON.parse(raw)
  } catch {
    // 文件不存在或损坏 → 返回兜底值（首次启动场景）
    return fallback
  }
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await fsp.mkdir(dirname(filePath), { recursive: true })
  await fsp.writeFile(filePath, JSON.stringify(data), 'utf-8')
}

/** 解析 git status --porcelain 输出为结构化 GitStatus */
function parseGitStatus(stdout: string): {
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
 * 注册全部主进程 IPC handler。
 * 职责：实现 renderer 桥（electronBridge.invoke）的本地能力通道。
 * 阶段 4 追加引擎通道（send_message/stop_session 等）与事件推送。
 */
export function registerIpcHandlers(): void {
  // ── 文件系统 ──

  ipcMain.handle('fs:listDir', async (_e, args: { path: string }) => {
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
    return fsp.readFile(args.path, 'utf-8')
  })

  ipcMain.handle('fs:writeFile', (_e, args: { path: string; content: string }) => {
    return fsp.writeFile(args.path, args.content, 'utf-8')
  })

  ipcMain.handle('fs:saveFileContent', (_e, args: { path: string; content: string }) => {
    return fsp.writeFile(args.path, args.content, 'utf-8')
  })

  ipcMain.handle('fs:deleteFile', (_e, args: { path: string }) => {
    return fsp.rm(args.path, { recursive: true, force: true })
  })

  ipcMain.handle('fs:renameFile', async (_e, args: { path: string; newName: string }) => {
    const newPath = join(dirname(args.path), args.newName)
    await fsp.rename(args.path, newPath)
    return newPath
  })

  ipcMain.handle('fs:moveFile', async (_e, args: { path: string; destDir: string }) => {
    const newPath = join(args.destDir, basename(args.path))
    await fsp.rename(args.path, newPath)
    return newPath
  })

  ipcMain.handle('fs:copyFile', async (_e, args: { path: string; destDir: string }) => {
    const newPath = join(args.destDir, basename(args.path))
    await fsp.copyFile(args.path, newPath)
    return newPath
  })

  ipcMain.handle('fs:createDir', (_e, args: { path: string }) => {
    return fsp.mkdir(args.path, { recursive: true })
  })

  ipcMain.handle('fs:readFileBase64', async (_e, args: { path: string }) => {
    const buf = await fsp.readFile(args.path)
    return buf.toString('base64')
  })

  ipcMain.handle('fs:getWorkspaceRoot', () => {
    // 阶段 2：默认用户主目录（可浏览）；阶段 4 由 serve 工作区决定
    return app.getPath('home')
  })

  ipcMain.handle('fs:revealInExplorer', (_e, args: { path: string }) => {
    shell.showItemInFolder(args.path)
  })

  // ── Git（git CLI 执行）──

  ipcMain.handle('git:status', async (_e, args: { repoPath: string }) => {
    const stdout = await execGit(args.repoPath, ['status', '--porcelain=v1', '-b'])
    return parseGitStatus(stdout)
  })

  ipcMain.handle('git:diff', async (_e, args: { repoPath: string; file: string; staged: boolean }) => {
    const diffArgs = args.staged ? ['diff', '--cached', '--', args.file] : ['diff', '--', args.file]
    return execGit(args.repoPath, diffArgs)
  })

  ipcMain.handle('git:stage', async (_e, args: { repoPath: string; files: string[] }) => {
    await execGit(args.repoPath, ['add', '--', ...args.files])
  })

  ipcMain.handle('git:unstage', async (_e, args: { repoPath: string; files: string[] }) => {
    await execGit(args.repoPath, ['restore', '--staged', '--', ...args.files])
  })

  ipcMain.handle('git:commit', async (_e, args: { repoPath: string; message: string; amend: boolean }) => {
    const commitArgs = args.amend ? ['commit', '--amend', '-m', args.message] : ['commit', '-m', args.message]
    return execGit(args.repoPath, commitArgs)
  })

  ipcMain.handle('git:push', async (_e, args: { repoPath: string }) => {
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
    (_e, args: { providerId: string; apiKey: string; baseUrl: string; model: string }) => {
      const file = join(app.getPath('userData'), 'provider-configs.json')
      const current = readJsonFile(file, {}) as Promise<Record<string, unknown>>
      return current.then(async (cfg) => {
        const next = { ...cfg, [args.providerId]: { apiKey: args.apiKey, baseUrl: args.baseUrl, model: args.model } }
        await writeJsonFile(file, next)
      })
    }
  )

  ipcMain.handle('settings:loadProviderConfigs', async () => {
    const cfg = await readJsonFile(join(app.getPath('userData'), 'provider-configs.json'), {})
    return cfg as Record<string, { apiKey: string; baseUrl: string; model: string }>
  })

  // ── 会话日志持久化（userData/session-logs/{sessionId}/）──

  ipcMain.handle('logs:saveSessionDebugLog', (_e, args: { sessionId: string; linesJson: string }) => {
    const file = join(app.getPath('userData'), 'session-logs', args.sessionId, 'debug.json')
    return fsp.mkdir(dirname(file), { recursive: true }).then(() => fsp.writeFile(file, args.linesJson, 'utf-8'))
  })

  ipcMain.handle('logs:saveSessionStderrLog', (_e, args: { sessionId: string; linesJson: string }) => {
    const file = join(app.getPath('userData'), 'session-logs', args.sessionId, 'stderr.json')
    return fsp.mkdir(dirname(file), { recursive: true }).then(() => fsp.writeFile(file, args.linesJson, 'utf-8'))
  })

  ipcMain.handle('logs:loadSessionLogs', async (_e, args: { sessionId: string }) => {
    const dir = join(app.getPath('userData'), 'session-logs', args.sessionId)
    const debugFile = join(dir, 'debug.json')
    const stderrFile = join(dir, 'stderr.json')
    const debug = await fsp.readFile(debugFile, 'utf-8').catch(() => null)
    const stderr = await fsp.readFile(stderrFile, 'utf-8').catch(() => null)
    return [debug, stderr] as [string | null, string | null]
  })

  // ── 文件对话框（替代 @tauri-apps/plugin-dialog）──

  ipcMain.handle(
    'dialog:openDialog',
    async (
      _e,
      args: { options: { directory?: boolean; multiple?: boolean; title?: string; defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> } }
    ) => {
      const opts = args.options ?? {}
      const win = BrowserWindow.getFocusedWindow() ?? undefined
      const properties: Array<'openFile' | 'openDirectory' | 'multiSelections'> = []
      // 目录模式与文件模式互斥，directory 优先
      if (opts.directory) {
        properties.push('openDirectory')
      } else {
        properties.push('openFile')
      }
      if (opts.multiple) properties.push('multiSelections')
      const result = await dialog.showOpenDialog(win!, {
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
      const result = await dialog.showSaveDialog(win!, {
        title: opts.title,
        defaultPath: opts.defaultPath,
        filters: opts.filters as Electron.FileFilter[] | undefined
      })
      if (result.canceled || !result.filePath) return null
      return result.filePath
    }
  )

  // 占位：阶段 4 实现 send_message / stop_session 等引擎通道
  ipcMain.on('ping', () => console.log('pong'))
}
