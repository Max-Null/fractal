// Playwright 配置：Electron e2e 冒烟，workers 必须为 1（Electron 实例只能串行）
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1,
  // 关闭内置 webServer：Electron 由 _electron.launch 直接拉起，不需要 HTTP 服务
  use: {}
})
