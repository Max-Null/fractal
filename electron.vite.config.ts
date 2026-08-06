import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    // 目录迁移后入口在 electron/main，需显式指定
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'electron/main/index.ts') }
      }
    },
    // 不用 bytecodePlugin：系统 Node 编译的 V8 字节码与 Electron 内置 Node 不兼容（cachedDataRejected）
    // exclude @opencode-ai/sdk：SDK 是 ESM-only 包（exports 无 require 条件），主进程输出 CJS，
    // externalize 会导致运行时 require 失败（ERR_PACKAGE_PATH_NOT_EXPORTED）——bundle 进主进程转 CJS
    plugins: [externalizeDepsPlugin({ exclude: ['@opencode-ai/sdk'] })]
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'electron/preload/index.ts') }
      }
    },
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        // cc-gui 迁移代码用 @/ 别名指向 src，这里映射到 electron-vite 的 renderer 源码目录
        '@': resolve('src/renderer/src')
      }
    },
    // 注入运行时全局常量（SettingsPanel/ChatPanel 版本号展示；缺省时渲染进程 ReferenceError 白屏）
    define: {
      __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.1.0')
    },
    plugins: [vue(), tailwindcss()]
  }
})
