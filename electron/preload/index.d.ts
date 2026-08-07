import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface Window {
    electron: ElectronAPI
    api: unknown
    /** 渲染进程桥：invoke 请求-响应 + on 事件订阅（由 preload/index.ts 暴露） */
    electronBridge: {
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
      on: (channel: string, cb: (data: unknown) => void) => () => void
      /** 订阅新窗口工作区下发（window:init-workspace），返回取消订阅函数 */
      onInitWorkspace: (cb: (path: string) => void) => () => void
    }
  }
}
