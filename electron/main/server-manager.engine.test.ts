// getEngineVersion 测试：独立文件，完全 mock node:child_process（不真执行 opencode --version，~100ms）
// 说明：vitest 4.x 对 node: 内置模块的 importOriginal+spread 部分 mock 不生效（server-manager 仍拿到真实 execFile），
// 必须用「完全 mock + default 导出」；真 spawn 生命周期测试在 server-manager.test.ts（无 mock，二者互不干扰）。
// 引擎版本解析：resolveOpencodeBin 走 sidecar 分支（dev 下 resources/bin/opencode.exe 存在，不触发 where opencode），
// 因此 execFile 只被 resolveEngineVersion 调用一次（--version）。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getEngineVersion, resetEngineVersionCache } from './server-manager'

vi.mock('node:child_process', () => {
  const m = {
    spawn: vi.fn(() => ({ on: vi.fn(), kill: vi.fn(), pid: 1 })),
    execFile: vi.fn(),
    execFileSync: vi.fn(),
  }
  // CJS interop：default 缺失会报 No "default" export（vitest 加载 mock 模块的要求）
  return { ...m, default: m }
})
import { execFile } from 'node:child_process'

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
