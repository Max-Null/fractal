// getEngineVersion 测试：独立文件，完全 mock node:child_process（不真执行 opencode --version，~100ms）
// 说明：vitest 4.x 对 node: 内置模块的 importOriginal+spread 部分 mock 不生效（server-manager 仍拿到真实 execFile），
// 必须用「完全 mock + default 导出」；真 spawn 生命周期测试在 server-manager.test.ts（无 mock，二者互不干扰）。
// 引擎版本解析：resolveOpencodeBin 走 sidecar 分支（dev 下 resources/bin/opencode.exe 存在，不触发 where opencode），
// 因此 execFile 只被 resolveEngineVersion 调用一次（--version）。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getEngineVersion, resetEngineVersionCache, createServerManager } from './server-manager'

// serve 子进程池（spawn 返回的假 child）：cleanupStaleServes 的 powershell 与 serve 分开记录，
// 断言/触发 exit 都以 serveChildren 为索引（powershell 清理进程 mock 下自动秒退，不参与计数）
const serveChildren: Array<{ on: ReturnType<typeof vi.fn> }> = []

vi.mock('node:child_process', () => {
  const m = {
    // once：startServer 的健康检查/端口竞速注册 child.once('exit') 用
    spawn: vi.fn((cmd: string) => {
      const child = { on: vi.fn(), once: vi.fn(), kill: vi.fn(), pid: 1 }
      if (cmd === 'powershell') {
        // cleanupStaleServes 的清理进程 mock 下无真实进程，exit 永不触发会阻塞启动链——模拟秒退解阻塞
        queueMicrotask(() => {
          const exitCb = child.on.mock.calls.find((c: string[]) => c[0] === 'exit')
          exitCb?.[1]?.(0, null)
        })
      } else {
        serveChildren.push(child)
      }
      return child
    }),
    execFile: vi.fn(),
    execFileSync: vi.fn(),
  }
  // CJS interop：default 缺失会报 No "default" export（vitest 加载 mock 模块的要求）
  return { ...m, default: m }
})
import { execFile, spawn } from 'node:child_process'

describe('getEngineVersion', () => {
  const execFileMock = vi.mocked(execFile)

  beforeEach(() => {
    // 隔离模块级版本缓存，避免用例间串状态
    resetEngineVersionCache()
    execFileMock.mockReset()
  })

  it('解析 `--version` 输出首行返回引擎版本', async () => {
    execFileMock.mockImplementation(((_bin: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
      expect(args).toEqual(['--version'])
      cb(null, '1.18.15\n')
      return {} as never
    }) as never)
    expect(await getEngineVersion()).toBe('1.18.15')
  })

  it('模块级缓存：首次调用后再次调用不重复执行 execFile；重置后重新执行', async () => {
    execFileMock.mockImplementation(((_bin: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
      cb(null, '1.18.15')
      return {} as never
    }) as never)
    expect(await getEngineVersion()).toBe('1.18.15')
    expect(await getEngineVersion()).toBe('1.18.15')
    expect(execFileMock).toHaveBeenCalledTimes(1)
    resetEngineVersionCache()
    expect(await getEngineVersion()).toBe('1.18.15')
    expect(execFileMock).toHaveBeenCalledTimes(2)
  })

  it('执行失败 → 返回 未知（不抛错）', async () => {
    execFileMock.mockImplementation(((_bin: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
      cb(new Error('ENOENT: no such file'), '')
      return {} as never
    }) as never)
    expect(await getEngineVersion()).toBe('未知')
  })
})

describe('serve 异常退出自动重启', () => {
  const spawnMock = vi.mocked(spawn)
  const execFileMock = vi.mocked(execFile)
  // mock 环境无法真正监听 serve：startServer 会停在端口就绪竞速（30s 超时）——不 await 其完成，
  // 只验证 serve spawn 次数（自动重启是否发生）与退避上限
  const bootReady = (sm: ReturnType<typeof createServerManager>) => sm.ready().catch(() => {})
  // 自动重启延迟 1.5s：真实等待（fake timers 下 advanceTimersByTimeAsync 不等真实 IO，ready 链卡在 fsp.access/net）
  const waitAutoRestartDelay = () => new Promise((r) => setTimeout(r, 2_000))

  /** 取出第 n 次 serve spawn 的假 child 的 exit 回调（on('exit') 注册；n 以 serveChildren 为索引） */
  function grabServeExitCb(index: number): (code: number, signal: string | null) => void {
    const child = serveChildren[index]
    if (!child) throw new Error(`serve[${index}] 尚未 spawn`)
    const call = child.on.mock.calls.find((c: string[]) => c[0] === 'exit')
    if (!call) throw new Error(`serve[${index}] 未注册 exit 回调`)
    return call[1] as (code: number, signal: string | null) => void
  }

  beforeEach(() => {
    spawnMock.mockClear()
    serveChildren.length = 0
    execFileMock.mockReset()
    // resolveOpencodeBin 的 where 分支：vitest 的 cwd 非项目根（sidecar 候选全部 miss），
    // 落到 where opencode——mock 不调用回调会永远 pending，这里返回系统路径让解析走通
    execFileMock.mockImplementation(((bin: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
      if (bin === 'where') cb(null, 'C:\\fake\\opencode.exe\r\n')
      else cb(null, '')
      return {} as never
    }) as never)
  })

  it('外部 kill（exit 4294967295）后自动重启，5 分钟窗口最多 3 次', async () => {
    const sm = createServerManager({ userDataDir: 'C:\\tmp\\fractal-auto-restart', dataMode: 'isolated' })
    void bootReady(sm)
    // 等首次 serve spawn（resolveOpencodeBin/getFreePort 是真实 IO，走 waitFor 轮询）
    await vi.waitFor(() => expect(serveChildren.length).toBe(1), { timeout: 3_000 })

    // 模拟外部 kill：触发 exit 回调（4294967295 = Windows TerminateProcess）
    grabServeExitCb(0)(4294967295, null)
    await waitAutoRestartDelay()
    await vi.waitFor(() => expect(serveChildren.length).toBe(2), { timeout: 3_000 }) // 1.5s 延迟后自动重启

    // 再 kill 3 次：第 2、3 次重启，第 4 次（窗口内第 4 次异常）超限停止
    for (let i = 1; i <= 3; i++) {
      grabServeExitCb(i)(4294967295, null)
      await waitAutoRestartDelay()
    }
    // 初始 1 次 + 重启 3 次 = 4，第 4 次退出不再 spawn
    expect(serveChildren.length).toBe(4)
  }, 30_000)

  it('stopServer 取消待执行的自动重启（主动停止不触发自愈）', async () => {
    const sm = createServerManager({ userDataDir: 'C:\\tmp\\fractal-auto-restart-stop', dataMode: 'isolated' })
    void bootReady(sm)
    await vi.waitFor(() => expect(serveChildren.length).toBe(1), { timeout: 3_000 })

    // 异常退出 → 自动重启已排程，但主动 stop 应取消
    grabServeExitCb(0)(1, null)
    await sm.stopServer()
    await waitAutoRestartDelay()
    expect(serveChildren.length).toBe(1) // 未发生重启
  })
})
