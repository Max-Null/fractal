// electronBridge 白名单防回归测试：静态扫描主进程源码，提取全部 ipcMain.handle / webContents.send 通道，
// 断言都已加入 preload 白名单——主进程新增通道而忘记同步白名单时测试即红（2026-08-14 updater 两次漏加后建立）。
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { ALLOWED_INVOKE, ALLOWED_ON } from './channels'

// 扫描 electron/main 下全部非测试 .ts 源文件
function scanMainFiles(): string[] {
  const dir = path.join(__dirname, '..', 'main')
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => path.join(dir, f))
}

// 提取主进程注册的 invoke 通道（ipcMain.handle('x' / "x"）——兼容单双引号。
// 已知限制：只覆盖字面量通道；若未来改用变量注册（ipcMain.handle(channelVar, ...)）会静默漏扫，届时需同步本测试。
function extractHandles(): string[] {
  const channels: string[] = []
  for (const file of scanMainFiles()) {
    const src = fs.readFileSync(file, 'utf8')
    for (const m of src.matchAll(/ipcMain\.handle\(\s*["']([^"']+)["']/g)) channels.push(m[1])
  }
  return channels
}

// 提取主进程 → 渲染进程事件通道（webContents.send('x' / "x"）——仅主进程向渲染推送的事件
function extractSends(): string[] {
  const channels: string[] = []
  for (const file of scanMainFiles()) {
    const src = fs.readFileSync(file, 'utf8')
    for (const m of src.matchAll(/webContents\.send\(\s*["']([^"']+)["']/g)) channels.push(m[1])
  }
  return channels
}

// preload 里经「专用桥方法」直接 ipcRenderer.on 的通道（onInitWorkspace/onInitPreview/onForwardChat/onPreviewChanged），
// 绕过了通用 on() 的白名单校验——它们也是主进程→渲染事件，但暴露方式是专用方法，不属于 ALLOWED_ON 覆盖范围
function extractPreloadDedicatedOn(): string[] {
  const src = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf8')
  return [...src.matchAll(/ipcRenderer\.on\(\s*["']([^"']+)["']/g)].map((m) => m[1])
}

describe('preload 通道白名单', () => {
  it('ALLOWED_INVOKE 覆盖主进程注册的全部 invoke 通道（新增 handler 必须加白名单）', () => {
    const registered = extractHandles()
    expect(registered.length).toBeGreaterThan(0)
    const missing = registered.filter((c) => !(ALLOWED_INVOKE as readonly string[]).includes(c))
    expect(missing).toEqual([])
  })

  it('ALLOWED_ON 覆盖主进程推送的全部事件通道（新增 webContents.send 必须加白名单或走专用桥方法）', () => {
    const registered = extractSends()
    expect(registered.length).toBeGreaterThan(0)
    const dedicated = extractPreloadDedicatedOn()
    const missing = registered.filter(
      (c) => !(ALLOWED_ON as readonly string[]).includes(c) && !dedicated.includes(c)
    )
    expect(missing).toEqual([])
  })

  it('白名单内无重复条目', () => {
    expect(new Set(ALLOWED_INVOKE).size).toBe(ALLOWED_INVOKE.length)
    expect(new Set(ALLOWED_ON).size).toBe(ALLOWED_ON.length)
  })
})
