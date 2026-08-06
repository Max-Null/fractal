// Playwright 配置：Electron e2e 冒烟，workers 必须为 1（Electron 实例只能串行）
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1,
  // 单实例锁豁免：e2e 启动的 app 是独立实例，与运行中的正式 app 共存
  globalSetup: './e2e/global-setup.ts',
  // 关闭内置 webServer：Electron 由 _electron.launch 直接拉起，不需要 HTTP 服务
  use: {}
})
