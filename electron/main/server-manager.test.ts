// server-manager 测试：单例/状态/生命周期（真 spawn serve 场景，CI 跳过）
// 说明：startServer 会真 spawn 系统 opencode serve（阶段 0 已实测），本地需已装 OC；
// CI 环境（无 OC / 慢）用 describe.skipIf(process.env.CI) 保护。
import { describe, it, expect, vi } from 'vitest'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServerManager, type ServerInfo } from './server-manager'

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
