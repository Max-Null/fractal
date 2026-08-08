// 诊断面板 e2e：按钮显示（事件日志非空）→ 展开 → 引擎日志页显示 serve.log 内容
// 依赖：本机已装 OC + provider-configs.json 已配置 API Key（serve 启动加载配置）
import { test, expect } from '@playwright/test'
import { _electron as electron } from 'playwright'

test('诊断面板：事件日志按钮 → 引擎日志页显示 serve 启动日志', async () => {
  test.setTimeout(120000)
  const app = await electron.launch({ args: ['out/main/index.js'] })
  try {
    const win = await app.firstWindow()
    // 等待输入框出现（app + serve 启动约 8-15s）
    await win.waitForSelector('textarea', { timeout: 45000 })
    // 发送一条消息触发引擎事件（事件日志非空 → 诊断按钮出现）
    await win.fill('textarea', '只回复两个字：你好')
    await win.press('textarea', 'Enter')
    await win.waitForSelector('text=你好', { timeout: 90000 })
    // 诊断信息按钮（事件日志非空才显示——回合完成记录保底，class=.debug-btn）
    const diagBtn = win.locator('.debug-btn')
    await diagBtn.waitFor({ timeout: 15000 })
    await diagBtn.click()
    // 面板展开 → 切引擎日志标签页（按钮文本「引擎日志」）
    const serveTab = win.locator('button', { hasText: '引擎日志' })
    await serveTab.waitFor({ timeout: 5000 })
    await serveTab.click()
    // 引擎日志内容非空（serve.log 尾部：loading/init 等）
    await win.waitForSelector('text=loading path', { timeout: 10000 })
    // 复制诊断信息按钮存在（title=复制诊断信息）
    const copyDiag = win.getByTitle(/复制诊断信息/)
    expect(await copyDiag.isVisible()).toBe(true)
  } finally {
    await app.close()
  }
})
