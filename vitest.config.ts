// vitest 配置：主进程纯函数单测（node 环境）+ 渲染进程组件测试（happy-dom 环境）
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
import { readFileSync } from 'fs'

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'))

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version)
  },
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer/src'),
      // public 目录资源在 vitest 中不自动映射，组件里 <img src="/logo.svg"> 需指向真实文件
      '/logo.svg': resolve(__dirname, 'src/renderer/public/logo.svg')
    }
  },
  test: {
    environment: 'happy-dom',
    // electron/main 下为主进程纯逻辑测试，保持 node 环境（不引入 DOM）
    environmentMatchGlobs: [['electron/**', 'node']],
    globals: true,
    setupFiles: ['./src/renderer/src/test-setup.ts'],
    include: ['src/renderer/src/**/*.{test,spec}.{ts,js}', 'electron/main/**/*.test.ts', 'electron/preload/**/*.test.ts']
  }
})
