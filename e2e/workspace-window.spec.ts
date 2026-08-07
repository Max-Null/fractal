// 多窗口 e2e：点击最近工作区非当前项 → 新开窗口并切到目标工作区（不切换当前窗口）
// 依赖 build 产物（test:e2e = npm run build && playwright test）
// 菜单数据不预置：本地 recent + serve 会话目录聚合（e2e 共享 userData 有 SQLite 残留，预置会被 initFromDb 覆盖）——
// 动态读取菜单项文本作断言基准，与数据无关
import { test, expect, _electron as electron } from '@playwright/test'

test('点击最近工作区非当前项 → 新开窗口并切到目标工作区', async () => {
  test.setTimeout(90000)
  const app = await electron.launch({ args: ['out/main/index.js'] })
  try {
    const win = await app.firstWindow()
    // 首次启动 e2e userData 无 onboarding 标记会弹引导 → 设置标记后 reload 进主界面
    await win.waitForLoadState('domcontentloaded')
    await win.evaluate(() => localStorage.setItem('sb-onboarding-dismissed', '1'))
    await win.reload()
    await win.waitForSelector('textarea', { timeout: 45000 })

    // 打开工作区菜单：菜单项来自本地 recent + serve 会话目录聚合
    await win.click('.ws-pill-arrow')
    await win.waitForSelector('.ws-menu-item')
    const itemCount = await win.locator('.ws-menu-item').count()
    // 环境无多工作区（serve 会话目录为空且本地 recent 无数据）→ 跳过该项（任务允许，主进程链路由探针验证）
    if (itemCount < 2) {
      test.skip(true, 'e2e 环境无多工作区（菜单项不足 2 个）')
      return
    }

    // 点击前记录当前 cwd（原窗口点击后不应变化）
    const beforeCwd = (await win.locator('.ws-pill-path').textContent()) ?? ''

    // 选第一个非当前工作区项（从第 1 项开始找，避免误点当前项触发「已在该工作区」分支）
    let targetIndex = -1
    for (let i = 0; i < itemCount; i++) {
      const t = await win.locator('.ws-menu-item-path').nth(i).textContent()
      if (t !== beforeCwd) {
        targetIndex = i
        break
      }
    }
    // 理论上菜单至少 1 项非当前（recent/serve 聚合含多工作区）；防御性保护
    if (targetIndex < 0) {
      test.skip(true, '菜单无非当前工作区项')
      return
    }
    const targetPath = (await win.locator('.ws-menu-item-path').nth(targetIndex).textContent()) ?? ''
    expect(targetPath).toBeTruthy()

    // 先挂 window 事件再点击（避免竞态漏捕获新窗口）
    const newWinPromise = app.waitForEvent('window')
    await win.locator('.ws-menu-item').nth(targetIndex).click()
    const newWin = await newWinPromise

    // 断言：窗口数量 2（原窗口 + 新窗口）
    await expect.poll(() => app.windows().length).toBe(2)
    // 新窗口 cwd = 目标工作区（主进程 did-finish-load 后下发 init-workspace 生效），原窗口 cwd 不变
    await newWin.waitForSelector('.ws-pill-path', { timeout: 30000 })
    await expect(newWin.locator('.ws-pill-path')).toHaveText(targetPath)
    await expect(win.locator('.ws-pill-path')).toHaveText(beforeCwd)
    // 新窗口标题：分形 — 目录名（OS 窗口标题，主进程 BrowserWindow.getTitle——
    // page.toHaveTitle 读的是 DOM document.title（恒为「分形」），不能验证窗口标题）
    const base = targetPath.split(/[\\/]/).pop() ?? ''
    const winTitles = (await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w) => w.getTitle())
    )) as string[]
    expect(winTitles).toContain(`分形 — ${base}`)
  } finally {
    await app.close()
  }
})
