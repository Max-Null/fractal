// server-manager 测试：单例/状态/生命周期（真 spawn serve 场景，CI 跳过）
// 说明：startServer 会真 spawn 系统 opencode serve（阶段 0 已实测），本地需已装 OC；
// CI 环境（无 OC / 慢）用 describe.skipIf(process.env.CI) 保护。
import { describe, it, expect, vi } from 'vitest'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServerManager, appendServeLog, closeServeLog, buildServeEnv, type ServerInfo } from './server-manager'

// CI 或无 DEEPSEEK_API_KEY 时不跑真 spawn（serve 冷启动 + 健康检查较慢，且 CI 无 OC）
const isCi = !!process.env.CI

describe('createServerManager（接口形态）', () => {
  it('返回四个生命周期方法（不 spawn）', () => {
    const manager = createServerManager({ userDataDir: tmpdir() })
    expect(typeof manager.startServer).toBe('function')
    expect(typeof manager.stopServer).toBe('function')
    expect(typeof manager.getServerInfo).toBe('function')
    expect(typeof manager.getClient).toBe('function')
    expect(typeof manager.onStatusChange).toBe('function')
    expect(manager.getServerInfo().running).toBe(false)
  })

  it('getClient 未启动时抛错', () => {
    const manager = createServerManager({ userDataDir: tmpdir() })
    expect(() => manager.getClient()).toThrow('serve 未启动')
  })
})

describe('buildServeEnv（spawn env 注入，纯函数不 spawn）', () => {
  it('shared（默认）→ 注入凭据 + XDG_CONFIG_HOME，无 XDG_DATA_HOME', () => {
    const env = buildServeEnv('C:\\oc-gui', 'user1', 'pass1', 'shared')
    expect(env.OPENCODE_SERVER_USERNAME).toBe('user1')
    expect(env.OPENCODE_SERVER_PASSWORD).toBe('pass1')
    expect(env.XDG_CONFIG_HOME).toBe('C:\\oc-gui\\config')
    expect(env.XDG_DATA_HOME).toBeUndefined()
  })

  it('isolated → 追加 XDG_DATA_HOME = <userData>/data', () => {
    const env = buildServeEnv('C:\\oc-gui', 'user1', 'pass1', 'isolated')
    expect(env.XDG_DATA_HOME).toBe('C:\\oc-gui\\data')
    // 配置隔离保留（D17 与数据隔离互不覆盖）
    expect(env.XDG_CONFIG_HOME).toBe('C:\\oc-gui\\config')
  })
})

describe.skipIf(isCi)('server-manager 生命周期（真 spawn）', () => {
  it('startServer → running / 客户端可用 / 二次调用复用单例 → stopServer 后 running=false', async () => {
    const dir = await fsp.mkdtemp(join(tmpdir(), 'oc-server-test-'))
    const manager = createServerManager({ userDataDir: dir })
    try {
      const first = await manager.startServer()
      expect(first.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      expect(first.username).toBeTruthy()
      expect(first.password).toBeTruthy()

      // 健康检查通过 → running=true，状态回调触发
      let statusInfo = manager.getServerInfo()
      expect(statusInfo.running).toBe(true)
      expect(statusInfo.baseURL).toBe(first.baseURL)

      // 单例：重复 startServer 返回同一实例（不重复 spawn、端口不变）
      const second = await manager.startServer()
      expect(second.port).toBe(first.port)
      expect(second.baseURL).toBe(first.baseURL)

      // 并发 startServer（index 启动链 + 渲染层 IPC 双入口）：进行中互斥共享同一次启动——
      // 修复前 startPromise 缓存会被 exit 回调置空，并发时各自 startServer → 双 serve 不同端口（2026-08-08 实测）
      const [c1, c2] = await Promise.all([manager.startServer(), manager.startServer()])
      expect(c1.baseURL).toBe(c2.baseURL)
      expect(c1.port).toBe(c2.port)

      // 客户端可用（认证头生效）
      const client = manager.getClient()
      expect(client.session).toBeTruthy()

      // onStatusChange 注册后 stopServer 触发回调（running=false）
      const onStatus = vi.fn<(info: ServerInfo) => void>()
      manager.onStatusChange(onStatus)
      await manager.stopServer()
      expect(manager.getServerInfo().running).toBe(false)
      expect(onStatus).toHaveBeenCalled()
      // 最近一次状态回调 running=false（stopServer 置空状态后 emitStatus）
      const lastInfo = onStatus.mock.calls.at(-1)?.[0]
      expect(lastInfo?.running).toBe(false)

      // stopServer 幂等：重复调用不抛错
      await manager.stopServer()
    } finally {
      // 兜底清理（断言失败时也确保 serve 被杀，避免残留进程）
      await manager.stopServer().catch(() => {})
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
})

// ── appendServeLog（serve stderr 落盘 + 10MB 轮转，方案 D3/D5）──
// 不 spawn serve：直接测落盘函数（userDataDir 注入 tmpdir，轮转阈值注入小值）
describe('appendServeLog（serve stderr 落盘 + 轮转）', () => {
  it('追加写入带 [HH:mm:ss] 前缀，首次自动建 logs 目录', async () => {
    const dir = await fsp.mkdtemp(join(tmpdir(), 'oc-serve-log-'))
    const logFile = join(dir, 'logs', 'serve.log')
    try {
      appendServeLog(logFile, 'loading path')
      appendServeLog(logFile, 'listening on port 58143')
      await closeServeLog(logFile)
      const content = await fsp.readFile(logFile, 'utf-8')
      // 两行均带 [HH:mm:ss] 时间戳前缀（本地时间），内容完整（无 500 截断）；末尾允许换行（补 \n 保证独立成行）
      expect(content).toMatch(/^\[\d{2}:\d{2}:\d{2}\] loading path\n\[\d{2}:\d{2}:\d{2}\] listening on port 58143\n?$/)
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  it('超过阈值 → 轮转为 serve.1.log（旧档），serve.log 重建继续写', async () => {
    const dir = await fsp.mkdtemp(join(tmpdir(), 'oc-serve-rotate-'))
    const logFile = join(dir, 'serve.log')
    try {
      // 小阈值注入（maxBytes=20）：前两条约 30 字节未触发（写前 stat 均未超阈值），
      // 关闭旧流后第三次写触发轮转——旧档 serve.1.log，serve.log 重建
      appendServeLog(logFile, 'AAAA', 20)
      appendServeLog(logFile, 'BBBB', 20)
      await closeServeLog(logFile)
      appendServeLog(logFile, 'CCCC', 20)
      await closeServeLog(logFile)

      const oldContent = await fsp.readFile(join(dir, 'serve.1.log'), 'utf-8')
      expect(oldContent).toContain('AAAA')
      expect(oldContent).toContain('BBBB')
      const newContent = await fsp.readFile(logFile, 'utf-8')
      expect(newContent).toContain('CCCC')
      expect(newContent).not.toContain('AAAA')
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  it('轮转 rename 失败（serve.1.log 被目录占用）→ 降级继续追加当前文件，不抛错', async () => {
    const dir = await fsp.mkdtemp(join(tmpdir(), 'oc-serve-rotatefail-'))
    const logFile = join(dir, 'serve.log')
    try {
      // 前两条写满阈值（20B），关闭旧流让第三次写重新 stat 触发轮转
      appendServeLog(logFile, 'AAAA', 20)
      appendServeLog(logFile, 'BBBB', 20)
      await closeServeLog(logFile)
      // serve.1.log 建成目录 → renameSync(文件 → 目录) 必然失败（Windows EPERM）——方案 7.2「降级继续追加」
      await fsp.mkdir(join(dir, 'serve.1.log'))
      expect(() => appendServeLog(logFile, 'CCCC', 20)).not.toThrow()
      await closeServeLog(logFile)
      // 降级生效：serve.log 仍可读到新内容
      const content = await fsp.readFile(logFile, 'utf-8')
      expect(content).toContain('CCCC')
      // rename 未生效：serve.1.log 仍是目录
      expect((await fsp.stat(join(dir, 'serve.1.log'))).isDirectory()).toBe(true)
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })
})
