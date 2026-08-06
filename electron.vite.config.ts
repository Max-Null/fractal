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
    plugins: [externalizeDepsPlugin()]
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
    plugins: [vue(), tailwindcss()]
  }
})
