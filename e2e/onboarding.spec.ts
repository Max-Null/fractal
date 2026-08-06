// Onboarding 首屏冒烟：无 API Key → 显示引导（步骤/输入框/跳过）；有 API Key → 直接主界面
// 自适应两种情况，避免依赖开发机是否已配置 key
import { test, expect } from '@playwright/test'
import { _electron as electron } from 'playwright'

test('onboarding 首屏引导：无 key 显示引导可跳过，有 key 直接进主界面', async () => {
  test.setTimeout(120000)
  const app = await electron.launch({ args: ['out/main/index.js'] })
  try {
    const win = await app.firstWindow()
    // 启动完成：出现引导卡片或主界面输入框（有 key 时跳过引导直接主界面）
    await win.waitForSelector('.ob-card, textarea', { timeout: 60000 })

    const hasOb = await win.locator('.ob-card').count()
    if (hasOb > 0) {
      // 无 key：验证引导要素后点跳过进入主界面
      await win.waitForSelector('.ob-logo h1')
      await win.waitForSelector('.ob-step')
      await win.waitForSelector('input[type="password"]')
      // 点右上角跳过
      await win.click('.ob-skip')
      await win.waitForSelector('textarea', { timeout: 30000 })
    } else {
      // 有 key：直接主界面
      expect(await win.locator('textarea').count()).toBeGreaterThan(0)
    }
  } finally {
    await app.close()
  }
})
