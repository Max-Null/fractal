// IPC 通道注册：renderer 桥（electronBridge）的本地能力实现
// 通道前缀约定：fs: / git: / settings: / logs: / dialog:
// 引擎通道（chat: / session: / message: / permission:）阶段 4 接入 serve
import { app, dialog, ipcMain, shell, BrowserWindow } from 'electron'
import { promises as fsp } from 'node:fs'
import { join, dirname, basename, isAbsolute } from 'node:path'
import { execFile } from 'node:child_process'
import { type ServerManager } from './server-manager'
import { type OcClient, type SessionMessage } from './oc-sdk'
import type { Session } from '@opencode-ai/sdk'
import { subscribeEvents } from './events'
import { DEFAULT_MODEL } from './provider'
import { ensureConfig } from './oc-config'

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

export async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await fsp.mkdir(dirname(filePath), { recursive: true })
  await fsp.writeFile(filePath, JSON.stringify(data), 'utf-8')
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

  ipcMain.handle('chat:sendMessage', async (_e, args: { sessionId: string; message: string; model?: { providerID: string; modelID: string }; agent?: string }) => {
    if (typeof args?.sessionId !== 'string' || typeof args?.message !== 'string') {
      throw new Error(`chat:sendMessage 参数非法: ${JSON.stringify(args)}`)
    }
    // promptAsync 立即返回（204），结果通过 SSE 事件流回前端；model 由前端传入（settings.model），
    // 缺省时用 provider.ts 默认 pro（serve 全局默认在 oc-config.ts 写 config.model）；
    // agent 由前端传入（settings.currentAgent：双星/build/plan，缺省走 serve 默认 Build）
    const model = args.model && args.model.providerID && args.model.modelID ? args.model : undefined
    await (await requireClient()).session.promptAsync(args.sessionId, args.message, {
      model: model ?? { providerID: 'ds', modelID: DEFAULT_MODEL.id },
      ...(typeof args?.agent === 'string' && args.agent ? { agent: args.agent } : {}),
    })
    return { accepted: true }
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

  ipcMain.handle('session:create', async (_e, args: { title?: string }) => {
    const s = await (await requireClient()).session.create({ title: typeof args?.title === 'string' ? args.title : undefined })
    return toSessionData(s)
  })

  ipcMain.handle('session:list', async () => {
    const list = await (await requireClient()).session.list()
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

  ipcMain.handle('message:list', async (_e, args: { sessionId: string }) => {
    const msgs = await (await requireClient()).session.messages(args.sessionId)
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

/** OC SessionMessage → 前端 MessageData（text part 拼接为 content；tokens 序列化为字符串） */
export function toMessageData(sm: SessionMessage): {
  id: string
  session_id: string
  role: string
  content: string
  token_usage: string
  created_at: string
} {
  // 一个 OC 消息可能含多个 text part（step 之间分段），按行拼接还原完整内容
  const content = sm.parts
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text?: string }).text ?? '')
    .filter(Boolean)
    .join('\n')
  // assistant 消息带 tokens（SDK AssistantMessage.tokens），user 消息无——转 JSON 串兼容 MessageData.token_usage
  const info = sm.info as { id: string; sessionID: string; role: string; time: { created: number }; tokens?: { input: number; output: number; cost?: number } }
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

