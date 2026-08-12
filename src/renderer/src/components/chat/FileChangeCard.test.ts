// FileChangeCard 测试：文件修改卡片（清单渲染 / 状态徽标 / 点击展开 diff / write 探测升级 added / 相对路径 resolve / 展示相对化）
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import FileChangeCard from './FileChangeCard.vue'
import { readFileContent } from '@/lib/electron-bridge'
import type { FileChangeItem } from '@/stores/chat'

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: { en: { chat: { fileChanges: 'Files changed', added: 'added', modified: 'modified' } } }
})

// readFileContent mock：可注入不同错误；默认 ENOENT（文件不存在 → added 升级）
vi.mock('@/lib/electron-bridge', () => ({
  readFileContent: vi.fn()
}))

// useSettingsStore mock：cwd 可调（组件内 resolve 绝对路径与展示相对化都依赖工作区；测试避免真实 pinia 依赖）
const settingsMock = vi.hoisted(() => ({ cwd: 'H:/ws' }))
vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => ({ cwd: settingsMock.cwd })
}))

beforeEach(() => {
  settingsMock.cwd = 'H:/ws'
  // 清调用记录（保留 mock 实现），避免跨用例累积影响 toHaveBeenCalled 断言
  ;(readFileContent as any).mockClear()
  ;(readFileContent as any).mockRejectedValue(new Error('ENOENT: no such file'))
})

function mountCard(changes: FileChangeItem[]) {
  return mount(FileChangeCard, { props: { changes }, global: { plugins: [i18n] } })
}

describe('FileChangeCard', () => {
  it('渲染文件清单（图标 + 路径 + 状态徽标）', () => {
    const w = mountCard([
      { filePath: 'a.txt', toolName: 'write', newString: 'x', status: 'modified' }
    ])
    expect(w.text()).toContain('a.txt')
    expect(w.text()).toContain('modified')
  })

  it('点击文件行展开 diff 区（write 显示新内容代码块）', async () => {
    const w = mountCard([
      { filePath: 'a.txt', toolName: 'write', newString: 'hello', status: 'modified' }
    ])
    expect(w.find('.file-change-diff').exists()).toBe(false)
    await w.find('.file-change-item').trigger('click')
    expect(w.find('.file-change-diff').exists()).toBe(true)
    expect(w.text()).toContain('hello')
  })

  it('edit 显示 old→new 红绿对比', async () => {
    const w = mountCard([
      {
        filePath: 'a.ts',
        toolName: 'edit',
        oldString: '旧代码',
        newString: '新代码',
        status: 'modified'
      }
    ])
    await w.find('.file-change-item').trigger('click')
    expect(w.find('.file-change-old').text()).toContain('旧代码')
    expect(w.find('.file-change-new').text()).toContain('新代码')
  })

  it('write 文件不存在 → 状态升级 added', async () => {
    const w = mountCard([
      { filePath: 'new.txt', toolName: 'write', newString: 'x', status: 'modified' }
    ])
    // onMounted 探测为 async，需 flush 全部 promise 链后状态才落定
    await flushPromises()
    expect(w.text()).toContain('added')
  })

  it('write 探测非 ENOENT 错误（如权限）→ 保持 modified', async () => {
    ;(readFileContent as any).mockRejectedValue(new Error('EACCES: permission denied'))
    const w = mountCard([
      { filePath: 'a.txt', toolName: 'write', newString: 'x', status: 'modified' }
    ])
    await flushPromises()
    expect(w.text()).toContain('modified')
    expect(w.text()).not.toContain('added')
  })

  it('相对路径 + cwd → resolve 绝对路径探测 ENOENT → added（修复：相对路径被主进程拒绝）', async () => {
    const w = mountCard([
      { filePath: 'src/foo.ts', toolName: 'write', newString: 'x', status: 'modified' }
    ])
    await flushPromises()
    // 主进程 fs 通道强制绝对路径（ipc.ts assertValidFsPath），探测必须以 resolve 后的绝对路径调用
    expect(readFileContent).toHaveBeenCalledWith('H:/ws/src/foo.ts')
    expect(w.text()).toContain('added')
  })

  it('cwd 下绝对路径展示相对化；非 cwd 路径原样显示', async () => {
    const w = mountCard([
      { filePath: 'H:/ws/src/foo.ts', toolName: 'write', newString: 'x', status: 'modified' },
      { filePath: 'D:/other/bar.ts', toolName: 'edit', oldString: 'a', newString: 'b', status: 'modified' }
    ])
    expect(w.text()).toContain('src/foo.ts')
    expect(w.text()).not.toContain('H:/ws/src/foo.ts')
    expect(w.text()).toContain('D:/other/bar.ts')
  })

  it('无 cwd 时跳过探测保持 modified（相对路径无法 resolve）', async () => {
    settingsMock.cwd = ''
    const w = mountCard([
      { filePath: 'src/foo.ts', toolName: 'write', newString: 'x', status: 'modified' }
    ])
    await flushPromises()
    expect(readFileContent).not.toHaveBeenCalled()
    expect(w.text()).toContain('modified')
  })
})
