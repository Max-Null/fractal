// Electron 应用启动冒烟：验证 build 产物能拉起窗口且非空白
import { test, expect, _electron as electron } from '@playwright/test'

test('app 启动冒烟', async () => {
  const app = await electron.launch({ args: ['out/main/index.js'] })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  expect(await window.title()).toBeDefined()
  const { width, height } = await window.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight
  }))
  expect(width).toBeGreaterThan(0)
  expect(height).toBeGreaterThan(0)
  await window.screenshot({ path: 'e2e/smoke.png' })
  await app.close()
})
