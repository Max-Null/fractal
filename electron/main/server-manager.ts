// serve 进程管理：spawn `opencode serve` 并隔离 XDG_CONFIG_HOME（阶段 4 实现）
// 关键实测结论（阶段 0，勿重新发明）：
// - serve v1.15+ 默认要求 Basic 认证：凭据由 env OPENCODE_SERVER_USERNAME/PASSWORD 注入，SDK 带 Basic 头
// - 配置隔离：env XDG_CONFIG_HOME=<分形数据目录>/config → 全局配置路径变为 <XDG>/opencode/opencode.json
// - spawn 必须解析 npm shim 到原生 exe（%APPDATA%\npm\opencode.cmd → ...\opencode.exe），禁 shell:true
// - 健康检查轮询 GET /doc（带 Basic 头）200 即就绪
import { spawn, execFile, type ChildProcess } from 'node:child_process'

import { app } from 'electron'
import { promises as fsp } from 'node:fs'
import net from 'node:net'
import crypto from 'node:crypto'
import { join } from 'node:path'
import { createOcClient, type OcClient } from './oc-sdk'

/** serve 运行状态（供 getServerInfo / onStatusChange / engine:status 转发） */
export interface ServerInfo {
  running: boolean
  baseURL?: string
  username?: string
  password?: string
  port?: number
}

/** startServer 成功返回的连接参数（前端/ipc 建 SDK client 用） */
export interface StartServerResult {
  baseURL: string
  username: string
  password: string
  port: number
}

export interface ServerManagerOptions {
  /** 分形数据目录：XDG_CONFIG_HOME = <userDataDir>/config（生产传 app.getPath('userData')，测试传 tmpdir） */
  userDataDir: string
}

export interface ServerManager {
  /** 启动 serve（单例：已运行则返回已有实例），未安装 OC 时抛错「未安装 OC，sidecar 待阶段 7」 */
  startServer(): Promise<StartServerResult>
  /** 等待 serve 就绪（并发调用共享同一启动 promise；启动失败可重试）——引擎通道统一入口 */
  ready(): Promise<StartServerResult>
  /** 停止 serve：Windows tree kill + child.kill 兜底，置空状态 */
  stopServer(): Promise<void>
  /** 当前运行状态（含凭据，engine:status 转发用） */
  getServerInfo(): ServerInfo
  /** 懒创建会话客户端（startServer 成功后可用，内部缓存） */
  getClient(): OcClient
  /** 注册运行状态变化回调（start 成功 / 进程 exit / spawn error） */
  onStatusChange(cb: (info: ServerInfo) => void): void
}

// ══════════════════════════════════════════════════════════════════
// 内部状态（单例生命周期内持有，startServer 重复调用复用）
// ══════════════════════════════════════════════════════════════════

interface InternalState {
  child: ChildProcess | null
  baseURL?: string
  username?: string
  password?: string
  port?: number
  client: OcClient | null
  statusCallbacks: Array<(info: ServerInfo) => void>
  /** spawn 后失败标记：进程 exit/error 触发后 startServer 不应返回"已运行"的假状态 */
  failed: boolean
  /** ready() 缓存：并发调用共享同一次启动；失败置空可重试 */
  startPromise: Promise<StartServerResult> | null
}

/** 健康检查：轮询 GET /doc（带 Basic 头），200 即就绪；2s 间隔、30s 超时 */
async function waitHealthy(baseURL: string, authHeader: string, timeoutMs = 30_000): Promise<void> {
  const intervalMs = 2_000
  const deadline = Date.now() + timeoutMs
  // 循环直到超时：每次失败 sleep 2s 后重试（serve 冷启动通常 <5s）
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseURL}/doc`, { headers: { Authorization: authHeader } })
      if (res.status === 200) return
    } catch {
      // fetch 网络错误 = serve 尚未监听端口，继续重试
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`serve 健康检查超时（${timeoutMs}ms）：${baseURL}/doc 未就绪`)
}

/** 查找空闲 TCP 端口（net 模块，bind 0 自动分配后释放） */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

/** 内置 sidecar 运行失败标记：spawn error 后置 true，下次解析跳过内置走系统兜底（军师审查 🔴3） */
let sidecarBroken = false
/** 最近一次解析是否来自内置 sidecar（spawn error 时判断是否标记 broken） */
let lastResolvedFromSidecar = false

/**
 * 解析 opencode 可执行文件（优先内置 sidecar，系统安装兜底——D8 阶段 7 实现）：
 * 1. resources/bin/opencode.exe（开发）或 process.resourcesPath/bin/opencode.exe（打包 extraResources）
 * 2. 系统安装（where opencode）：原生 exe 或 .cmd/.bat shim（Node CreateProcess 不解析 .cmd → 读 shim 提取真实 exe，阶段 0 踩坑 #2）
 */
async function resolveOpencodeBin(): Promise<string> {
  // ① 内置 sidecar（优先）：打包 = process.resourcesPath/bin/；dev = 项目根 resources/bin（多候选）
  // 注意：dev 下 getAppPath() 返回入口目录（out/main 或 out）——用「向上两级/一级找项目根」+ cwd 双候选兜底
  // 单测环境无 electron app（undefined）——process.cwd() 为项目根，vitest 由项目根运行
  const isPackaged = app?.isPackaged === true
  const binName = process.platform === 'win32' ? 'opencode.exe' : 'opencode'
  const sidecarCandidates = isPackaged
    ? [join(process.resourcesPath, 'bin', binName)]
    : [
        join(process.cwd(), 'resources', 'bin', binName), // dev 启动（WorkingDirectory=项目根，最常用）
        join(app?.getAppPath?.() ?? '', '..', '..', 'resources', 'bin', binName), // 入口在 out/main → 项目根
        join(app?.getAppPath?.() ?? '', '..', 'resources', 'bin', binName), // 入口在 out → 项目根
      ]
  if (!sidecarBroken) {
    for (const bundled of sidecarCandidates) {
      try {
        await fsp.access(bundled)
        lastResolvedFromSidecar = true
        return bundled
      } catch {
        // 该候选不存在 → 尝试下一个
      }
    }
  }
  lastResolvedFromSidecar = false

  // ② 非 Windows：PATH 直接可执行，交给 spawn 解析
  if (process.platform !== 'win32') return 'opencode'

  // where opencode：可能返回多条（PATH 中多处安装），取第一条可用的
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile('where', ['opencode'], { encoding: 'utf-8' }, (err, out) => {
      if (err) reject(err)
      else resolve(out)
    })
  }).catch(() => '')

  const candidates = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  if (candidates.length === 0) {
    throw new Error('未找到 opencode：内置 sidecar 与系统安装均缺失（运行 scripts/download-opencode.js 安装内置引擎）')
  }

  for (const cand of candidates) {
    // 原生 exe 直接可用
    if (/\.exe$/i.test(cand)) return cand
    // .cmd/.bat shim：读内容解析 `node "%~dp0...\opencode.exe"` 目标
    if (/\.(cmd|bat)$/i.test(cand)) {
      try {
        const content = await fsp.readFile(cand, 'utf8')
        const shimDir = cand.replace(/[\\/][^\\/]+$/, '')
        const m = content.match(/"([^"]*%dp0%[^"]*\.exe)"/i)
        if (m) {
          const p = m[1].replace(/%dp0%/i, shimDir)
          await fsp.access(p) // 存在性检查，失败则试下一个候选
          return p
        }
      } catch {
        // shim 解析失败 → 试下一个候选
      }
    }
  }
  throw new Error('未安装 OC，sidecar 待阶段 7')
}

/** 工厂：创建 server manager（userDataDir 注入便于集成测试；生产传 app.getPath('userData')） */
export function createServerManager(options: ServerManagerOptions): ServerManager {
  const state: InternalState = {
    child: null,
    client: null,
    statusCallbacks: [],
    failed: false,
    startPromise: null,
  }

  function toInfo(): ServerInfo {
    return {
      running: state.child !== null && !state.failed,
      baseURL: state.baseURL,
      username: state.username,
      password: state.password,
      port: state.port,
    }
  }

  /** 通知全部状态回调（幂等：多次 exit 重复回调由消费方自行去重） */
  function emitStatus(): void {
    const info = toInfo()
    for (const cb of state.statusCallbacks) {
      try {
        cb(info)
      } catch {
        // 回调异常不阻断其他订阅者（webContents.send 可能因窗口销毁抛错）
      }
    }
  }

  async function startServer(): Promise<StartServerResult> {
    // 单例：已有存活进程直接返回（不重复 spawn）
    if (state.child && !state.failed) {
      return {
        baseURL: state.baseURL!,
        username: state.username!,
        password: state.password!,
        port: state.port!,
      }
    }
    // 上次 spawn 失败残留 → 先清理（failed=true 且 child 已退出）
    state.child = null
    state.failed = false
    state.client = null

    const bin = await resolveOpencodeBin()

    const port = await getFreePort()
    const baseURL = `http://127.0.0.1:${port}`

    // 本地回环 + 随机凭据：serve 默认 Basic 认证（阶段 0 踩坑 #5），随机防探测
    const username = 'oc-' + crypto.randomBytes(6).toString('hex')
    const password = crypto.randomBytes(16).toString('hex')
    // D17 配置隔离：XDG_CONFIG_HOME 指向分形数据目录，serve 全局配置不再读用户 ~/.config
    const xdg = join(options.userDataDir, 'config')

    const child = spawn(
      bin,
      ['serve', '--port', String(port), '--hostname', '127.0.0.1'],
      {
        env: {
          ...process.env,
          OPENCODE_SERVER_USERNAME: username,
          OPENCODE_SERVER_PASSWORD: password,
          XDG_CONFIG_HOME: xdg,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )


    // 启动日志转发（serve 输出可能是 UTF-16，console 直接打会乱码——仅记录不展示）
    child.stdout?.on('data', (d: Buffer) => {
      void d // 预留：阶段 5 接入日志面板
    })
    // serve stderr 转发 console（serve 启动失败/运行错误排查关键信息；输出编码可能 UTF-16 或 UTF-8，双解码尝试）
    child.stderr?.on('data', (d: Buffer) => {
      try {
        const utf8 = d.toString('utf8').replace(/\u0000/g, '')
        const txt = utf8.includes('\ufffd') ? d.toString('utf16le').replace(/\u0000/g, '') : utf8
        if (txt.trim()) console.error(`[serve] ${txt.trim().slice(0, 500)}`)
      } catch {
        /* 转码失败不阻断 */
      }
    })

    // spawn 失败（ENOENT 等）→ 置 failed，回调通知前端；内置 sidecar 失败则标记损坏，下次解析走系统兜底
    child.on('error', (err) => {
      if (lastResolvedFromSidecar && !sidecarBroken) {
        sidecarBroken = true
        console.error('[server-manager] 内置 sidecar spawn 失败，后续将使用系统安装的 OC 兜底')
      }
      state.failed = true
      state.child = null
      state.startPromise = null // 启动缓存失效，允许下次 ready 重建
      console.error(`[server-manager] serve spawn 失败：${err.message}`)
      emitStatus()
    })

    // 进程退出（正常/被杀/崩溃）→ 置空状态并通知（前端 engine:status 感知连接断开）
    child.on('exit', (code, signal) => {

      state.child = null
      state.failed = true
      state.startPromise = null // 启动缓存失效，允许下次 ready 重建
      console.log(`[server-manager] serve 退出 code=${code} signal=${signal ?? ''}`)
      emitStatus()
    })

    state.child = child
    state.baseURL = baseURL
    state.username = username
    state.password = password
    state.port = port

    // 健康检查失败 → 清理进程并抛错（调用方可捕获提示用户）
    const authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64')
    try {

      await waitHealthy(baseURL, authHeader)

    } catch (err) {

      state.failed = true
      state.child = null
      await killTree(child)
      emitStatus()
      throw err
    }

    emitStatus()
    return { baseURL, username, password, port }
  }

  /** 树杀进程：Windows 用 taskkill /T（连带子进程），非 Windows child.kill */
  async function killTree(child: ChildProcess): Promise<void> {
    if (process.platform === 'win32') {
      try {
        await new Promise<void>((resolve) => {
          execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { encoding: 'utf-8' }, () => resolve())
        })
      } catch {
        // taskkill 失败（进程已退出）→ child.kill 兜底
        child.kill()
      }
      return
    }
    child.kill()
  }

  async function stopServer(): Promise<void> {
    const child = state.child
    // 停止后启动缓存必须失效：否则后续 ready() 返回已死 serve 的连接参数（2026-08-06 实测：设置自动保存杀 serve 后永不重启）
    state.startPromise = null
    if (!child) {
      state.failed = true
      state.client = null
      emitStatus()
      return
    }
    // 先置状态再杀：kill 触发的 exit 回调幂等（running 已 false）
    state.child = null
    state.failed = true
    state.client = null
    await killTree(child)
    emitStatus()
  }

  /** 等待 serve 就绪：首次调用触发 startServer 并缓存 promise，并发调用（前端多通道同时请求）共享同一次启动。
   *  失败/退出时在 catch / exit 处理器里置空（见 startServer），下次 ready 重建 */
  function ready(): Promise<StartServerResult> {
    if (!state.startPromise) {
      state.startPromise = startServer().catch((err) => {
        // 启动失败清空缓存，允许下次 ready 重试（resolveOpencodeBin 抛错等瞬态失败）
        state.startPromise = null
        throw err
      })
    }
    return state.startPromise
  }

  function getClient(): OcClient {
    if (!state.client) {
      if (!state.baseURL || !state.username || !state.password) {
        throw new Error('serve 未启动，无法创建客户端')
      }
      state.client = createOcClient({
        baseURL: state.baseURL,
        username: state.username,
        password: state.password,
      })
    }
    return state.client
  }

  function onStatusChange(cb: (info: ServerInfo) => void): void {
    state.statusCallbacks.push(cb)
  }

  return { startServer, ready, stopServer, getServerInfo: toInfo, getClient, onStatusChange }
}
