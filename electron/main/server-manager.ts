// serve 进程管理：spawn `opencode serve` 并隔离 XDG_CONFIG_HOME（阶段 4 实现）
// 关键实测结论（阶段 0，勿重新发明）：
// - serve v1.15+ 默认要求 Basic 认证：凭据由 env OPENCODE_SERVER_USERNAME/PASSWORD 注入，SDK 带 Basic 头
// - 配置隔离：env XDG_CONFIG_HOME=<分形数据目录>/config → 全局配置路径变为 <XDG>/opencode/opencode.json
// - spawn 必须解析 npm shim 到原生 exe（%APPDATA%\npm\opencode.cmd → ...\opencode.exe），禁 shell:true
// - 健康检查轮询 GET /doc（带 Basic 头）200 即就绪
import { spawn, execFile, type ChildProcess } from 'node:child_process'

import { app } from 'electron'
import { createWriteStream, mkdirSync, renameSync, statSync, appendFileSync, existsSync, type WriteStream } from 'node:fs'
import { promises as fsp } from 'node:fs'
import net from 'node:net'
import crypto from 'node:crypto'
import { dirname, join } from 'node:path'
import { createOcClient, type OcClient } from './oc-sdk'
import { getConfig } from './settings'

/** serve 运行状态（供 getServerInfo / onStatusChange / engine:status 转发） */
export interface ServerInfo {
  running: boolean
  baseURL?: string
  username?: string
  password?: string
  port?: number
}

/** serve stderr 行处理器（提取自 spawnOnce 的 data 回调，便于单测）：转发 console（500 截断）。
 * 历史冲突检测已移除（2026-08-10）：8800 占用者实为 scout-websearch 插件而非官方桌面端，
 * 且 v2 server 经 OPENCODE_PORT 注入随机端口已避开 8800——冲突检测为死代码。
 * appendServeLog 落盘原文不受影响（诊断面板仍可见完整错误） */
export function handleServeStderrChunk(txt: string): void {
  if (txt.trim()) {
    console.error(`[serve] ${txt.trim().slice(0, 500)}`)
  }
}

/** 解析 serve listening 日志行提取 v1 端口（--port 0 随机分配后 serve 输出 listening 行）——
 * 分形不再预分配 v1 端口：serve --port 固定值时 v2 server 固定 8800 且 OPENCODE_PORT 不生效
 * （2026-08-09 实测：8800 被 scout-websearch 插件占用时 v2 server 启动失败）；--port 0 时 v2 跟随 OPENCODE_PORT、v1 随机由本函数解析 */
export function parseListeningPort(line: string): number | null {
  const m = line.match(/listening on https?:\/\/[^\s:]+:(\d+)/)
  return m ? Number(m[1]) : null
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
  /**
   * 数据模式覆盖（生产不传 → 走 settings 模块内存态，即设置页开关）：
   * 测试/e2e 传 'isolated' 强制数据隔离（XDG_DATA_HOME=临时目录），测试会话不落共享数据库
   */
  dataMode?: string
}

/**
 * 构建 serve spawn env（纯函数，便于单测 env 注入断言，不 spawn）：
 * 基础继承 process.env + 随机 Basic 凭据 + XDG_CONFIG_HOME 配置隔离（D17）。
 * dataMode='isolated' 时追加 XDG_DATA_HOME=<userDataDir>/data——serve 数据目录
 * （会话/SQLite 等）跟随 XDG_DATA_HOME（实测 serve 数据目录 = <XDG_DATA_HOME>/opencode/），
 * 与其他工具完全隔离；'shared'（默认）不注入 → 与其他工具共享系统数据目录。
 */
export function buildServeEnv(userDataDir: string, username: string, password: string, dataMode: string, v2Port?: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCODE_SERVER_USERNAME: username,
    OPENCODE_SERVER_PASSWORD: password,
    XDG_CONFIG_HOME: join(userDataDir, 'config'),
  }
  if (dataMode === 'isolated') {
    env.XDG_DATA_HOME = join(userDataDir, 'data')
  }
  // v2 server 端口（serve 1.18.15+ 内嵌 v2 API server，默认 8800）：注入 OPENCODE_PORT 随机端口
  // 使 v2 server 避开 8800（--port 0 时 OPENCODE_PORT 生效，实测）。8800 的占用者实为 scout-websearch
  // 插件（任何 opencode 实例加载即监听 8800）——分形预置已移除该插件（2026-08-10 认知更正），
  // 注入保留作防御：其他 serve 实例若仍监听 8800，v2 server 也不受影响
  // 防御：getFreePort 系统分配可能返回 65535 → +1 溢出 65536 → serve 解析失败回退 8800（2026-08-09 实测崩溃）
  if (v2Port) {
    env.OPENCODE_PORT = String(Math.min(v2Port, 65535))
  }
  return env
}

export interface ServerManager {
  /** 启动 serve（单例：已运行则返回已有实例），未安装 OC 时抛错「未安装 OC，sidecar 待阶段 7」 */
  startServer(): Promise<StartServerResult>
  /** 等待 serve 就绪（并发调用共享同一启动 promise；启动失败可重试）——引擎通道统一入口 */
  ready(): Promise<StartServerResult>
  /** 停止 serve：Windows tree kill + child.kill 兜底，置空状态 */
  stopServer(): Promise<void>
  /** 同步停止 serve（应用退出专用）：不依赖事件循环，will-quit 后 async 清理实测冻结 */
  syncStop(): void
  /** 当前运行状态（含凭据，engine:status 转发用） */
  getServerInfo(): ServerInfo
  /** 懒创建会话客户端（startServer 成功后可用，内部缓存） */
  getClient(): OcClient
  /** 注册运行状态变化回调（start 成功 / 进程 exit / spawn error） */
  onStatusChange(cb: (info: ServerInfo) => void): void
  /** 等待 serve 初始化完成（stderr 输出 message=init 行；每次 spawn 重建信号，超时抛错）——
   *  SSE 订阅必须等它：/doc 健康检查可达时 serve 可能仍在加载，过早订阅挂在未就绪窗口（2026-08-11 实测零事件） */
  waitEventConnected(timeoutMs?: number): Promise<void>
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
  /** ready() 缓存：并发调用共享同一次启动；失败置空可重试 */  startPromise: Promise<StartServerResult> | null
  /** 主动停止标记：stopServer 置 true，防止退出时误 dump 崩溃日志（正常停止 code!=0 不算崩溃） */
  stopping: boolean
  /** spawn 时间戳（崩溃 dump 上下文：exit 回调诊断实例寿命用） */
  startedAt?: number
}

/** serve 初始化完成信号（stderr 输出 message=init 行）：SSE 订阅必须等它——/doc 健康检查可达时 serve
 *  可能仍在加载（事件总线未初始化），过早订阅挂在未就绪窗口（SDK fetch 无超时，2026-08-11 实测零事件）。
 *  注意：不能用 event connected 行做信号——它是「有客户端订阅 /event」时才打的回声日志，serve 启动时不输出 */
interface ServerInitSignal {
  promise: Promise<void>
  resolve: () => void
}

function newServerInitSignal(): ServerInitSignal {
  let resolve: (() => void) | null = null
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve: () => resolve?.() }
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
/** 启动代数：stopServer 时 ++，使进行中的 startServer 重试循环在 spawn 前放弃（防双 serve 竞态，2026-08-08 实测） */
let startGeneration = 0
/** 最近一次解析是否来自内置 sidecar（spawn error 时判断是否标记 broken） */
let lastResolvedFromSidecar = false

/** serve 自动重启退避：5 分钟窗口最多 3 次（崩溃循环保护——外部 kill/崩溃后自动恢复，但禁止重启风暴打满 CPU） */
const AUTO_RESTART_WINDOW_MS = 5 * 60_000
const AUTO_RESTART_MAX = 3
const AUTO_RESTART_DELAY_MS = 1_500

/**
 * 构造 serve 启动参数（B1：engine.logLevel 白名单外/缺失不加参，serve 用默认级别）。
 * 提取为纯函数便于单测（spawn 参数无法在 vitest 中直接断言 node:child_process 调用）。
 */
export function buildServeArgs(logLevel: unknown): string[] {
  const args = ['serve', '--port', '0', '--hostname', '127.0.0.1', '--print-logs']
  if (typeof logLevel === 'string' && ['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(logLevel)) {
    args.push('--log-level', logLevel)
  }
  return args
}

/**
 * 解析 opencode 可执行文件（优先内置 sidecar，系统安装兜底——D8 阶段 7 实现）：
 * 1. resources/bin/opencode.exe（开发）或 process.resourcesPath/bin/opencode.exe（打包 extraResources）
 * 2. 系统安装（where opencode）：原生 exe 或 .cmd/.bat shim（Node CreateProcess 不解析 .cmd → 读 shim 提取真实 exe，阶段 0 踩坑 #2）
 */
export async function resolveOpencodeBin(): Promise<string> {
  // ① B1 用户自定义路径（settings.json engine.opencodePath）：非空且存在 → 最高优先；
  //    路径无效 → 警告回落（不抛错——自定义路径损坏不应阻断引擎启动）
  const customPath = getConfig().config['engine.opencodePath']
  if (typeof customPath === 'string' && customPath.trim()) {
    try {
      await fsp.access(customPath.trim())
      lastResolvedFromSidecar = false
      return customPath.trim()
    } catch {
      console.warn(`[serve] 自定义 opencode 路径无效，回落内置/系统解析：${customPath}`)
    }
  }
  // ② 内置 sidecar（优先）：打包 = process.resourcesPath/bin/；dev = 项目根 resources/bin（多候选）
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

// ══════════════════════════════════════════════════════════════════
// 引擎版本查询（设置页「关于」三行版本之一）
// ══════════════════════════════════════════════════════════════════

/** 引擎版本缓存：`opencode --version` 执行 ~100ms，首次调用后固定；引擎升级场景重启 app 即刷新 */
let cachedEngineVersion: string | null = null

/** 测试辅助：重置引擎版本缓存（vitest 多用例注入不同 execFile 结果时隔离状态） */
export function resetEngineVersionCache(): void {
  cachedEngineVersion = null
}

/**
 * 查询 OC 引擎版本（内置 sidecar `opencode --version`）。
 * 执行失败（bin 缺失/解析错误）→ 返回 '未知'（展示兜底，不抛错——版本信息缺失不影响设置页渲染）。
 */
export async function getEngineVersion(): Promise<string> {
  if (cachedEngineVersion !== null) return cachedEngineVersion
  cachedEngineVersion = await resolveEngineVersion().catch(() => '未知')
  return cachedEngineVersion
}

/** 实际执行 `opencode --version` 并取首行（如 "1.18.15"）；解析失败抛错由 getEngineVersion 兜底 */
async function resolveEngineVersion(): Promise<string> {
  const bin = await resolveOpencodeBin()
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(bin, ['--version'], { encoding: 'utf-8', timeout: 10_000 }, (err, out) => {
      if (err) reject(err)
      else resolve(out)
    })
  })
  return stdout.trim().split(/\r?\n/)[0] || '未知'
}

/** 工厂：创建 server manager（userDataDir 注入便于集成测试；生产传 app.getPath('userData')） */
/**
 * 清理本应用残留的 serve 进程（一次性，startServer 首次调用前执行）：
 * - Windows 上 Stop-Process 强杀 electron 不会带走子进程（无父死子亡机制），app 崩溃/开发重启会残留旧 serve
 * - 残留 serve 与新 serve 并存 + 与官方桌面端共享 storage → SQLite 锁竞争 → 新 serve 秒退 exit 1（实测 2026-08-08）
 * - 匹配条件：CommandLine 含本应用 sidecar 路径（resources\bin\opencode.exe serve）——官方桌面端/系统 OC 路径不匹配，不会误杀
 */
let staleCleaned = false
export async function cleanupStaleServes(): Promise<void> {
  if (staleCleaned) return
  staleCleaned = true
  if (process.platform !== 'win32') return
  try {
    await new Promise<void>((resolve) => {
      const ps = spawn('powershell', [
        '-NoProfile',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='opencode.exe'\" | Where-Object { $_.CommandLine -match 'resources\\\\bin\\\\opencode.exe serve' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
      ], { windowsHide: true, stdio: 'ignore' })
      ps.on('exit', () => resolve())
      ps.on('error', () => resolve())
    })
  } catch {
    // 清理失败不阻断启动（serve 自身有 3 次重试兜底）
  }
}

export function createServerManager(options: ServerManagerOptions): ServerManager {
  const state: InternalState = {
    child: null,
    client: null,
    statusCallbacks: [],
    failed: false,
    startPromise: null,
    /** 主动停止标记：stopServer 置 true，防止退出时误 dump 崩溃日志（正常停止 code!=0 不算崩溃） */
    stopping: false,
    /** spawn 时间戳（崩溃 dump 上下文：exit 回调诊断实例寿命用） */
    startedAt: undefined,
  }
  /** 当前实例的 serve.log 路径（spawn 时赋值，stopServer 时 end 流） */
  let serveLogFile = ''
  /**
   * startServer 进行中互斥：并发调用（index 启动链 + 渲染层 IPC 双入口）共享同一次启动。
   * ready() 的 startPromise 缓存会被 exit 回调置空（秒退场景，2026-08-08 实测）——并发时
   * 两个调用各自 startServer → 双 serve 并存（同实测：34776+13964 双进程）。
   */
  let startInFlight: Promise<StartServerResult> | null = null

  /** 最近自动重启时间戳（窗口裁剪用） */
  let autoRestartTimes: number[] = []
  /** 待执行的自动重启 timer（stopServer 时取消——防主动停止后自杀重启） */
  let autoRestartTimer: NodeJS.Timeout | null = null
  /** serve 初始化完成信号（每次 spawn 重建；exit/stop 后不再 resolve，旧信号无人等待） */
  let serverInit: ServerInitSignal = newServerInitSignal()

  /** serve 异常退出（非主动停止且非零退出码）→ 延迟自动重启；5 分钟窗口 3 次上限防崩溃循环 */
  function scheduleAutoRestart(): void {
    const now = Date.now()
    autoRestartTimes = autoRestartTimes.filter((t) => now - t < AUTO_RESTART_WINDOW_MS)
    if (autoRestartTimes.length >= AUTO_RESTART_MAX) {
      console.warn(`[server-manager] serve 异常退出自动重启超限（${AUTO_RESTART_WINDOW_MS / 60_000} 分钟 ${AUTO_RESTART_MAX} 次），停止自动恢复，请手动刷新引擎`)
      return
    }
    // 进程已死：使进行中的旧启动链放弃（gen 检查点——与 stopServer 同机制，防旧重试循环再 spawn 出双 serve）
    startGeneration++
    autoRestartTimes.push(now)
    console.warn(`[server-manager] serve 异常退出，${AUTO_RESTART_DELAY_MS / 1000}s 后自动重启（第 ${autoRestartTimes.length}/${AUTO_RESTART_MAX} 次，${AUTO_RESTART_WINDOW_MS / 60_000} 分钟窗口）`)
    // 延迟 1.5s：给 exit 清理留时间（端口释放、serve 日志文件句柄），再走 ready() 重建（startPromise 已在 exit 回调置空）
    autoRestartTimer = setTimeout(() => {
      autoRestartTimer = null
      void ready().catch(() => {
        // 自动重启失败：startServer 内部已 emit 失败状态，前端保持离线，用户可手动刷新
      })
    }, AUTO_RESTART_DELAY_MS)
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

  /** 等待 serve 初始化完成（message=init 行输出）；超时抛错。无实例（已停止）时立即返回——
   *  调用方随后会因订阅目标失效自然失败；serve 崩溃后自动重启会重建信号 */
  async function waitServerInit(timeoutMs = 10_000): Promise<void> {
    await Promise.race([
      serverInit.promise,
      new Promise<never>((_, reject) => {
        const t = setTimeout(() => {
          reject(new Error(`serve 初始化超时（${timeoutMs}ms）：message=init 未输出`))
        }, timeoutMs)
        t.unref?.()
      }),
    ])
  }

async function startServer(): Promise<StartServerResult> {
    // 进行中互斥：并发调用共享同一次启动（见 startInFlight 注释）
    if (startInFlight) return startInFlight
    const run = async (): Promise<StartServerResult> => {
      // 单例：已有存活进程直接返回（不重复 spawn）
      if (state.child && !state.failed) {
        return {
          baseURL: state.baseURL!,
          username: state.username!,
          password: state.password!,
          port: state.port!,
        }
      }
      // 实际启动（engine:refresh 的 stopServer + startServer 走此路径）
      // 残留清理（一次性）：Windows 强杀父进程不会带走子进程（2026-08-08 实测：electron 被杀后
      // 旧 serve 残留，双 serve 并存 + 官方桌面端共享 storage → 竞争导致新 serve 秒退 exit 1 无声）。
      // 只清「本应用 bin 路径 + serve 参数」的进程——官方桌面端（@opencode-aidesktop）路径不匹配，安全
      await cleanupStaleServes()
      // 秒退容错（2026-08-07 实测）：首次 spawn 偶发秒退 exit 1（原因未定，可能与端口/环境竞争有关），
      // 第二次尝试几乎必然成功——若等待 30s 健康检查失败才抛错，启动链（ready → startEngineEvents）会卡死，
      // 渲染层 splash 永不消失。改为循环重试，健康检查失败立即进入下一次尝试。
      // generation 标记：stopServer 期间 ++startGeneration，使进行中的重试循环在下次 spawn 前放弃——
      // 否则旧循环会继续 spawn 出第二个 serve（双 serve 实测 2026-08-08：启动残留 2 个进程）
      const gen = ++startGeneration
      let lastErr: unknown = null
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (gen !== startGeneration) {
          // 启动已被 stopServer 取消（竞态），放弃本次启动——直接抛错不再重试
          throw new Error('serve 启动已取消（stopServer 竞态）')
        }
        if (attempt > 1) {
          console.log(`[server-manager] serve 第 ${attempt} 次启动尝试`)
          await new Promise((r) => setTimeout(r, 800))
        }
        try {
          return await spawnOnce()
        } catch (err) {
          lastErr = err
          // 清理失败状态，允许下一次尝试（exit 回调可能已置 failed/child=null）
          state.failed = false
          state.child = null
          state.client = null
          if (gen !== startGeneration) {
            // spawn 后/健康检查中又被 stopServer 取消——直接放弃，不再 spawn 下一个
            throw err instanceof Error ? err : new Error('serve 启动已取消（stopServer 竞态）')
          }
        }
      }
      state.failed = true
      throw lastErr instanceof Error ? lastErr : new Error('serve 连续 3 次启动失败')
    }
    startInFlight = run().finally(() => {
      startInFlight = null
    })
    return startInFlight
  }

  /** 单次 spawn + 健康检查（startServer 重试循环的单元；失败抛错由调用方处理） */
  async function spawnOnce(): Promise<StartServerResult> {
    // 上次 spawn 失败残留 → 先清理（failed=true 且 child 已退出）
    state.child = null
    state.failed = false
    state.client = null
    // 新 serve 实例的初始化信号：旧信号已 resolve/失效，重建等待新实例的 message=init 行
    serverInit = newServerInitSignal()

    const bin = await resolveOpencodeBin()

    // v2Port 仅用于 OPENCODE_PORT 注入（v2 server 端口，避开 8800——见 spawn 参数注释）
    const v2Port = await getFreePort()

    // 本地回环 + 随机凭据：serve 默认 Basic 认证（阶段 0 踩坑 #5），随机防探测
    const username = 'oc-' + crypto.randomBytes(6).toString('hex')
    const password = crypto.randomBytes(16).toString('hex')
    // D17 配置隔离：XDG_CONFIG_HOME 指向分形数据目录（buildServeEnv 内 join），serve 全局配置不再读用户 ~/.config
    // 数据隔离（dataMode）：options.dataMode 覆盖优先（测试/e2e 强制隔离）——
    // 否则读 settings 模块内存态（index.ts 启动链已 await loadSettings 保证已加载——
    // 否则首次启动独立模式会读到 DEFAULT 默认值 shared，数据目录注入失效）
    const dataMode = options.dataMode ?? (typeof getConfig().config['dataMode'] === 'string' ? (getConfig().config['dataMode'] as string) : 'shared')

    state.startedAt = Date.now()
    // B1 引擎日志级别（settings.json engine.logLevel）：白名单外/缺失不加参（serve 默认级别）
    const serveArgs = buildServeArgs(getConfig().config['engine.logLevel'])
    const child = spawn(
      bin,
      // --print-logs：serve 默认日志静默，加此参数后 INFO 日志（loading/listening/插件报错）输出到 stderr——
      // 诊断面板引擎日志页的数据源（方案 D1/D3；实测 2026-08-08：不加则 stderr 平时无数据，面板恒空）
      serveArgs,
      {
        env: buildServeEnv(options.userDataDir, username, password, dataMode, v2Port + 1),
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )

    // v1 端口就绪信号：listening 行解析后 resolve（健康检查先等此 Promise——serve --port 0 随机端口）
    let listeningReadyResolve: ((p: number) => void) | null = null
    const listeningReady = new Promise<number>((resolve) => {
      listeningReadyResolve = resolve
    })
    // 启动日志转发：serve 的 listening 行输出在 stdout（loading/插件日志在 stderr）——
    // --port 0 随机端口的 v1 实际端口只能从 stdout 解析（2026-08-09 实测）
    child.stdout?.on('data', (d: Buffer) => {
      try {
        const txt = d.toString('utf8').replace(/\u0000/g, '')
        const parsed = parseListeningPort(txt)
        if (parsed) {
          listeningReadyResolve?.(parsed)
          listeningReadyResolve = null
        }
      } catch {
        /* 解析失败不阻断 */
      }
    })
    // serve stderr tee：console 转发（开发排查，保留 500 截断）+ 落盘 serve.log（面板引擎日志页，写完整文本）。
    // 日志目录必须注入式（options.userDataDir）——测试传 tmpdir，不可用 app.getPath('userData')（会写真实用户数据）
    serveLogFile = join(options.userDataDir, 'logs', 'serve.log')
    // 崩溃诊断滚动缓冲（16KB）：serve 退出 code!=0 时 dump 原文到 serve-crash-<ts>.log——
    // 崩溃原因（如 doc-edit 实例化崩溃）常出现在 stderr 尾部，serve.log 行级处理可能丢最后未 flush 段（2026-08-08）
    let serveStderrTail = ''
    child.stderr?.on('data', (d: Buffer) => {
      try {
        const utf8 = d.toString('utf8').replace(/\u0000/g, '')
        const txt = utf8.includes('\ufffd') ? d.toString('utf16le').replace(/\u0000/g, '') : utf8
        serveStderrTail = (serveStderrTail + txt).slice(-16384)
        // console 转发（提取为 handleServeStderrChunk；serve.log 保留原文——诊断面板仍可见完整错误）
        handleServeStderrChunk(txt)
        // 落盘写完整文本（[HH:mm:ss] 前缀 + 10MB 轮转），console 的 500 截断不影响落盘
        appendServeLog(serveLogFile, txt)
        // 端口解析（一次）：listening 行 → v1 实际端口（serve --port 0 随机分配）
        const parsed = parseListeningPort(txt)
        if (parsed) {
          listeningReadyResolve?.(parsed)
          listeningReadyResolve = null
        }
        // serve 初始化完成信号（message=init 行）：SSE 订阅必须等它——/doc 可达时 serve 可能仍在
        // 加载（事件总线未初始化），过早订阅挂在未就绪窗口（SDK fetch 无超时 → 零事件，2026-08-11 实测）
        if (txt.includes('message=init')) {
          serverInit.resolve()
        }
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
      // 退出时收 serve 日志流（与 stopServer 对称；serve 崩溃时旧文件句柄不残留，下次启动重建）
      if (serveLogFile) void closeServeLog(serveLogFile)
      // 非零退出且非主动停止 → dump 崩溃现场（诊断 serve 崩溃根因；stderr 为空也写——
      // 实测 serve 崩溃 exit code=1 但 stderr 零输出（2026-08-08 两例），只有时间戳/进程上下文可用）
      if (code !== 0 && !state.stopping) {
        try {
          const crashFile = join(options.userDataDir, 'logs', `serve-crash-${Date.now()}.log`)
          const ctx = [
            `[exit code=${code} signal=${signal ?? ''} @ ${new Date().toISOString()}]`,
            `[run started @ ${state.startedAt ? new Date(state.startedAt).toISOString() : 'unknown'}]`,
            `[xdg data dir exists=${existsSync(join(options.userDataDir, 'data'))}]`,
          ].join('\n')
          appendFileSync(crashFile, ctx + '\n' + (serveStderrTail || '[stderr empty]'))
        } catch {
          /* dump 失败不阻断退出流程 */
        }
      }
      state.child = null
      state.failed = true
      state.startPromise = null // 启动缓存失效，允许下次 ready 重建
      // 进程已死：进行中的启动互斥失效（否则自动重启的 ready() 复用死启动 promise，等 30s 超时才重试）
      startInFlight = null
      // 异常退出（非主动停止且非零退出码）→ 自动重启（外部 kill/崩溃后免手动刷新；退避防崩溃循环）
      if (!state.stopping && code !== 0) {
        scheduleAutoRestart()
      }
      // 诊断：退出时打印 stopping/dump 条件/尾部长度——崩溃 dump 失效排查（2026-08-08：两例 exit 1 无 dump 文件）
      console.log(`[server-manager] serve 退出 code=${code} signal=${signal ?? ''} stopping=${state.stopping} dump=${code !== 0 && !state.stopping} tail=${serveStderrTail?.length ?? 0}`)
      emitStatus()
    })

    state.child = child
    state.username = username
    state.password = password

    // 健康检查失败 → 清理进程并抛错（调用方可捕获提示用户）
    const authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64')
    try {
      // 端口就绪与进程提前退出竞速：serve 秒退（code=1）时立即失败进入重试循环，
      // 否则等 30s 超时才失败，启动链（ready → startEngineEvents）卡死、渲染层 splash 永不消失（2026-08-07 实测）
      const actualPort = await Promise.race([
        listeningReady,
        new Promise<never>((_, reject) => {
          child.once('exit', (code) => reject(new Error(`serve 进程提前退出（code=${code}）`)))
        }),
        new Promise<never>((_, reject) => {
          const t = setTimeout(() => reject(new Error('serve 端口就绪超时（30s）')), 30_000)
          t.unref?.()
        }),
      ])
      const baseURL = `http://127.0.0.1:${actualPort}`
      state.baseURL = baseURL
      state.port = actualPort
      // 端口就绪后再健康检查（/doc 可达），同样与进程退出竞速
      await Promise.race([
        waitHealthy(baseURL, authHeader),
        new Promise<never>((_, reject) => {
          child.once('exit', (code) => reject(new Error(`serve 进程提前退出（code=${code}）`)))
        }),
      ])
    } catch (err) {

      state.failed = true
      state.child = null
      await killTree(child)
      emitStatus()
      throw err
    }

    emitStatus()
    return { baseURL: state.baseURL!, username, password, port: state.port! }
  }

  /** 树杀进程：Windows 用 taskkill /T（连带子进程），非 Windows child.kill */
  async function killTree(child: ChildProcess): Promise<void> {
    if (process.platform === 'win32') {
      // 先同步发信号（立即生效），taskkill 树杀仅作异步兜底——不能 await：退出流程中 execFile 回调依赖事件循环，
      // 事件循环挂起时（Electron will-quit preventDefault 后实测）回调永不触发导致 stopServer 永不完成（2026-08-09 e2e 卡死根因）
      child.kill()
      try {
        execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { encoding: 'utf-8' }, () => {})
      } catch {
        // taskkill 兜底失败忽略（child.kill 已生效）
      }
      return
    }
    child.kill()
  }

  async function stopServer(): Promise<void> {
    // 取消待执行的自动重启（主动停止不应触发自愈重启）
    if (autoRestartTimer) {
      clearTimeout(autoRestartTimer)
      autoRestartTimer = null
    }
    // 取消进行中的启动重试循环（startServer 的 generation 检查点会放弃后续 spawn——防双 serve）
    startGeneration++
    // 主动停止标记：本次退出不算崩溃（exit 回调跳过 serve-crash dump）
    state.stopping = true
    const child = state.child
    // 停止后启动缓存必须失效：否则后续 ready() 返回已死 serve 的连接参数（2026-08-06 实测：设置自动保存杀 serve 后永不重启）
    state.startPromise = null
    // 关闭 serve 日志流（serve 重启时旧流 end 后重建，避免旧文件句柄残留；end 后旧流数据已 flush）
    if (serveLogFile) void closeServeLog(serveLogFile)
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

  /**
   * 同步停止 serve（退出流程专用）：不依赖事件循环（will-quit 后 async 清理实测冻结），
   * child.kill 同步发信号（Windows 下 TerminateProcess 同步生效）；树杀交给 detached taskkill（不等待——execFileSync 在退出流程实测卡死）
   */
  function syncStop(): void {
    state.stopping = true
    const child = state.child
    state.child = null
    state.failed = true
    state.client = null
    if (!child) return
    // 先 destroy 管道：uv_close 同步把句柄从 libuv active 队列移除（EOF 回调不再需要）——
    // 退出流程中事件循环冻结，管道句柄留在 active 队列会让 app.exit 等不到空队列（2026-08-09 退出卡死根因）
    child.stdout?.destroy()
    child.stderr?.destroy()
    child.stdin?.destroy()
    child.kill()
    if (process.platform === 'win32') {
      try {
        // detached + unref：独立进程完成树杀，不阻塞/不参与父进程事件循环
        const t = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { detached: true, stdio: 'ignore' })
        t.unref()
      } catch {
        // taskkill 失败忽略（child.kill 已生效）
      }
    }
  }

  return { startServer, ready, stopServer, syncStop, getServerInfo: toInfo, getClient, onStatusChange, waitEventConnected: waitServerInit }
}

// ══════════════════════════════════════════════════════════════════
// serve 引擎日志落盘（诊断面板「引擎日志」页数据源，方案 D1/D3/D5）
// ══════════════════════════════════════════════════════════════════

/** serve.log 轮转阈值：超 10MB 改名 serve.1.log（覆盖旧档），只保留 1 份 */
const MAX_SERVE_LOG_BYTES = 10 * 1024 * 1024

/** 追加流缓存（按文件路径隔离；serve 重启时 stopServer end + 清理，startServer 复用/重建） */
const serveLogStreams = new Map<string, WriteStream>()
// 重建中的暂存队列：旧流已 end、新流未建（旧流 close 回调里建）期间的 append 先入队，
// 保证「同一 logFile 任一时刻最多一个活动流」，否则新旧流 open 完成顺序不确定 → 写序颠倒（flaky）
const serveLogPending = new Map<string, string[]>()
// 重建完成 Promise：closeServeLog 等待它（旧流 close 回调里新建流 + flush 后 end + resolve），
// 保证「close 后文件已创建且内容完整」，否则测试/停止场景读到 ENOENT 或空文件
const serveLogRebuilds = new Map<string, Promise<void>>()
/** 轮转失败警告位（rename EBUSY/EPERM 时只提示一次，避免高频 stderr 刷屏） */
const serveRotateWarned = new Set<string>()

/** 本地时间 [HH:mm:ss]（落盘行前缀，跨 serve 重启可区分先后） */
function serveLogTimestamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `[${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}]`
}

/**
 * 追加一行到 serve.log（serve stderr tee 落盘）：
 * - 首次调用 mkdir logs 目录（userData/logs 首启不存在，不建则追加静默失败吞日志）
 * - createWriteStream({flags:'a'}) 追加——高频 stderr 不能 appendFileSync 阻塞主进程
 * - 写前 stat 超阈值 → rename serve.1.log（覆盖旧档）→ 重建流；rename 失败（Windows 文件占用）继续追加 + 警告一次
 * - maxBytes 供测试注入小阈值（生产默认 10MB）
 */
export function appendServeLog(logFile: string, text: string, maxBytes = MAX_SERVE_LOG_BYTES): void {
  try {
    // 重建中（旧流已 end、新流未建）：文本入队，由旧流 close 回调统一 flush——防双流并存写序颠倒
    const pendingArr = serveLogPending.get(logFile)
    if (pendingArr) {
      pendingArr.push(text)
      return
    }
    // 本次调用前是否已有缓存流：区分「首写新建」（stat 必 ENOENT——createWriteStream 打开文件是异步的）
    // 与「旧流 + 文件被删」（须销毁重建，否则写入落到已 unlink 的 inode，文件永远不出现）
    const hadStream = serveLogStreams.has(logFile)
    let stream = serveLogStreams.get(logFile)
    if (!stream) {
      mkdirSync(dirname(logFile), { recursive: true })
      stream = createWriteStream(logFile, { flags: 'a' })
      // 异步写错误（磁盘满/权限变更）会 emit 'error'，无监听器直接 throw → uncaughtException 崩主进程
      // （方案 7.2「写失败静默忽略」必须覆盖异步路径；损坏流标记后下次写入重建）
      stream.on('error', () => {
        serveLogStreams.delete(logFile)
      })
      serveLogStreams.set(logFile, stream)
    }
    // 轮转检查：stat 超限 → 改名 serve.1.log（覆盖旧档）→ 重建流
    let needsRotate = false
    try {
      needsRotate = statSync(logFile).size > maxBytes
    } catch {
      // stat 失败（ENOENT）两种场景：
      // ① 首写——createWriteStream 打开文件是异步的，此时文件尚未出现：跳过轮转（文件必空），write 会排队等待 open
      // ② 旧流 + 文件被删（用户手动删 serve.log）——旧流句柄指向已 unlink 的 inode：销毁重建，否则写入落到不存在的文件上
      if (hadStream) {
        // 重建串行化：本行入队 → 删除 map 条目 → end 旧流，close 回调里建新流并 flush 队列后 end（一次性重建）。
        // 旧流 end 与新流 open 是异步的，若立即建新流会双流并存，open 完成顺序不定 → 写序颠倒（历史 flaky）
        serveLogPending.set(logFile, [text])
        serveLogStreams.delete(logFile)
        const old = stream
        serveLogRebuilds.set(
          logFile,
          new Promise<void>((resolve) => {
            old.end(() => {
              const pending = serveLogPending.get(logFile) ?? []
              serveLogPending.delete(logFile)
              const s = createWriteStream(logFile, { flags: 'a' })
              s.on('error', () => {
                serveLogStreams.delete(logFile)
              })
              // open 完成后 flush 排队写入再 end——resolve 保证文件已创建且内容完整（closeServeLog 依赖）
              s.on('open', () => {
                s.end(() => {
                  serveLogRebuilds.delete(logFile)
                  resolve()
                })
              })
              for (const t of pending) s.write(`${serveLogTimestamp()} ${t}${t.endsWith('\n') ? '' : '\n'}`)
            })
          }),
        )
        return
      }
      needsRotate = false
    }
    if (needsRotate) {
      try {
        renameSync(logFile, join(dirname(logFile), 'serve.1.log'))
        stream.end()
      stream = createWriteStream(logFile, { flags: 'a' })
      stream.on('error', () => {
        serveLogStreams.delete(logFile)
      })
      serveLogStreams.set(logFile, stream)
      serveRotateWarned.delete(logFile) // 轮转成功 → 重置警告位，下次失败可再提示
      } catch (err) {
        // rename 失败（Windows 文件占用）→ 继续追加当前文件 + 警告一次（日志不能影响主流程）
        if (!serveRotateWarned.has(logFile)) {
          serveRotateWarned.add(logFile)
          console.warn(`[server-manager] serve.log 轮转失败（${err instanceof Error ? err.message : String(err)}），继续追加当前文件`)
        }
      }
    }
    // 落盘行带 [HH:mm:ss] 前缀；stderr chunk 可能不带换行，补 \n 保证每记录独立成行
    stream.write(`${serveLogTimestamp()} ${text}${text.endsWith('\n') ? '' : '\n'}`)
  } catch (err) {
    // 落盘失败（磁盘满/权限）→ 静默忽略（日志不能影响主流程），console 转发不受影响
    console.error(`[server-manager] serve.log 写入失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 关闭 serve 日志流（serve 停止时 end，重启时重建；省略参数则清空全部——测试隔离用）。返回 Promise 供测试等待 flush */
export function closeServeLog(logFile?: string): Promise<void> {
  const targets: WriteStream[] = []
  if (logFile) {
    const s = serveLogStreams.get(logFile)
    if (s) {
      targets.push(s)
      serveLogStreams.delete(logFile)
    }
  } else {
    for (const s of serveLogStreams.values()) targets.push(s)
    serveLogStreams.clear()
  }
  // 重建中的 Promise 一并等待：旧流 end 回调会建新流并 flush 后 resolve，保证 close 后文件存在且内容完整
  const rebuilds = logFile
    ? serveLogRebuilds.get(logFile)
      ? [serveLogRebuilds.get(logFile)!]
      : []
    : [...serveLogRebuilds.values()]
  return Promise.all([...targets.map((s) => new Promise<void>((resolve) => s.end(() => resolve()))), ...rebuilds]).then(() => {})
}
