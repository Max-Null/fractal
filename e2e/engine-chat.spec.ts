// 真实引擎端到端验证（临时验证脚本）：启动 app → 发消息 → 等待模型流式回复
// 依赖：本机已装 OC + provider-configs.json 已配置 API Key（serve 启动加载配置）
import { test, expect } from '@playwright/test'
import { _electron as electron } from 'playwright'

test('真实引擎对话：发消息收到流式回复', async () => {
  test.setTimeout(120000)
  const app = await electron.launch({ args: ['out/main/index.js'] })
  try {
    const win = await app.firstWindow()
    // 等待输入框出现（app + serve 启动约 8-15s）
    await win.waitForSelector('textarea', { timeout: 45000 })
    // 输入并发送
    await win.fill('textarea', '只回复两个字：你好')
    await win.press('textarea', 'Enter')
    // 等待用户消息上屏（发送成功的信号）
    await win.waitForSelector('text=只回复两个字：你好', { timeout: 15000 })
    // 等待 assistant 回复包含「你好」（流式渲染完成后）
    await win.waitForSelector('text=你好', { timeout: 90000 })
  } finally {
    await app.close()
  }
})
