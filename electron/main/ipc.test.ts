// ipc.ts 纯函数单元测试（不依赖 electron 运行时，node 环境）
// 覆盖军师审查 🔴3：路径校验、git status 解析、JSON 持久化往返
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { assertValidFsPath, parseGitStatus, readJsonFile, writeJsonFile } from './ipc'

describe('assertValidFsPath（路径校验）', () => {
  it('接受正常绝对路径', () => {
    expect(() => assertValidFsPath('C:\\work\\fractal\\src')).not.toThrow()
    expect(() => assertValidFsPath('D:/tmp/file.txt')).not.toThrow()
  })

  it('拒绝空路径与相对路径', () => {
    expect(() => assertValidFsPath('')).toThrow('路径不能为空')
    expect(() => assertValidFsPath('  ')).toThrow('路径不能为空')
    expect(() => assertValidFsPath('relative/path.txt')).toThrow('路径必须是绝对路径')
    expect(() => assertValidFsPath('./x')).toThrow('路径必须是绝对路径')
  })

  it('拒绝 .. 逃逸段', () => {
    expect(() => assertValidFsPath('C:\\work\\..\\secret')).toThrow('路径不能包含 ..')
    expect(() => assertValidFsPath('C:/work/../../secret')).toThrow('路径不能包含 ..')
  })

  it('拒绝非字符串类型', () => {
    expect(() => assertValidFsPath(undefined as unknown as string)).toThrow('路径不能为空')
    expect(() => assertValidFsPath(42 as unknown as string)).toThrow('路径不能为空')
  })
})

describe('parseGitStatus（porcelain v1 解析）', () => {
  it('解析分支行与空仓库', () => {
    const r = parseGitStatus('## main...origin/main\n')
    expect(r.branch).toBe('main')
    expect(r.staged).toHaveLength(0)
    expect(r.modified).toHaveLength(0)
    expect(r.untracked).toHaveLength(0)
  })

  it('分类 staged / modified / untracked', () => {
    const r = parseGitStatus(
      [
        '## feature/x...origin/feature/x',
        ' M src/a.ts', // 工作区修改
        'A  src/new.ts', // 新暂存
        'M  src/b.ts', // 暂存+无工作区变更 → 仅 staged
        '?? untracked.md'
      ].join('\n')
    )
    expect(r.branch).toBe('feature/x')
    expect(r.modified.map((x) => x.path)).toEqual(['src/a.ts'])
    expect(r.staged.map((x) => x.path)).toEqual(['src/new.ts', 'src/b.ts'])
    expect(r.untracked.map((x) => x.path)).toEqual(['untracked.md'])
  })

  it('重命名输出取新路径（old -> new）', () => {
    const r = parseGitStatus('R  old.ts -> new.ts\n')
    expect(r.staged.map((x) => x.path)).toEqual(['new.ts'])
  })

  it('索引与工作区同变时文件只进 staged 一次', () => {
    const r = parseGitStatus('MM src/both.ts\n')
    expect(r.staged.map((x) => x.path)).toEqual(['src/both.ts'])
    expect(r.modified.map((x) => x.path)).toEqual(['src/both.ts'])
  })
})

describe('JSON 持久化往返（readJsonFile / writeJsonFile）', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fsp.mkdtemp(join(tmpdir(), 'ipc-test-'))
  })

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true })
  })

  it('写入后读回内容一致', async () => {
    const file = join(dir, 'cfg.json')
    const data = { provider: { ds: { apiKey: 'sk-test', model: 'deepseek-v4-flash' } }, nested: { a: [1, 2, 3] } }
    await writeJsonFile(file, data)
    const back = await readJsonFile(file, {})
    expect(back).toEqual(data)
  })

  it('文件不存在返回兜底值（首次启动场景）', async () => {
    const back = await readJsonFile(join(dir, 'missing.json'), { fallback: true })
    expect(back).toEqual({ fallback: true })
  })

  it('损坏 JSON 返回兜底值（不崩溃）', async () => {
    const file = join(dir, 'broken.json')
    await fsp.writeFile(file, '{ not valid json', 'utf-8')
    const back = await readJsonFile(file, 'default')
    expect(back).toBe('default')
  })

  it('嵌套目录自动创建（writeJsonFile mkdir recursive）', async () => {
    const file = join(dir, 'a', 'b', 'c.json')
    await writeJsonFile(file, { ok: true })
    expect(await readJsonFile(file, null)).toEqual({ ok: true })
  })
})
