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
      onInitPreview: (cb: (path: string) => void) => () => void
      /** 预览独立窗口发起「发送到对话」转发（send 单向，无回包） */
      forwardChat: (payload: string) => void
      /** 主窗口接收预览窗口转发载荷（window:forward-chat），返回取消订阅函数 */
      onForwardChat: (cb: (payload: string) => void) => () => void
      /** 主窗口发起预览自动刷新（oc-file-changed → 主进程广播预览窗口；send 单向） */
      notifyPreviewChanged: () => void
      /** 预览窗口接收刷新信号（主进程 window:preview-changed 推送），返回取消订阅函数 */
      onPreviewChanged: (cb: () => void) => () => void
      /** 渲染层 console 桥上报（main.ts 拦截 console 后调用；主进程仅调试模式落盘） */
      debugLog: (level: string, msg: string) => void
      /** 拖放/粘贴文件取真实绝对路径（webUtils.getPathForFile 桥；无路径返回空串） */
      getPathForFile: (file: File) => string
    }
  }
}
