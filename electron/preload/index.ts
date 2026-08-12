import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {}

/**
 * electronBridge：渲染进程访问主进程能力的唯一通道。
 * - invoke: 请求-响应式 IPC（fs/git/settings/logs/dialog/pdf/chat/session/message/permission 等）
 * - on: 主进程 → 渲染进程事件订阅（引擎事件流等），返回取消订阅函数
 *
 * 安全：invoke/on 通道白名单——渲染进程只能调已注册的本地能力通道，
 * 新增通道时同步追加对应白名单（阶段 4：引擎通道 chat:/session:/message:/permission: + engine:event/status）。
 */
const ALLOWED_INVOKE = [
  'fs:listDir', 'fs:readFileContent', 'fs:writeFile', 'fs:saveFileContent',
  'fs:deleteFile', 'fs:renameFile', 'fs:moveFile', 'fs:copyFile',
  'fs:createDir', 'fs:readFileBase64', 'fs:getWorkspaceRoot', 'fs:revealInExplorer',
  'git:status', 'git:diff', 'git:stage', 'git:unstage', 'git:commit', 'git:push',
  'settings:saveUiSettings', 'settings:loadUiSettings',
  'settings:saveProviderConfig', 'settings:loadProviderConfigs',
  'settings:getConfig', 'settings:saveSettings', 'settings:getSchema',
  'deepseek:getBalance', // 计费迭代：设置面板/上下文面板余额查询（主进程读 key，渲染层零接触）
  'logs:saveSessionDebugLog', 'logs:readServeLog', 'logs:loadSessionLogs', 'logs:readRendererLog',
  'app:getInfo',
  'dialog:openDialog', 'dialog:saveDialog',
  'chat:sendMessage', 'chat:stopSession',
  'session:create', 'session:list', 'session:get', 'session:delete', 'session:rename', 'session:fork', 'session:setActive',
  'message:list', 'permission:respond',
  'question:reply', 'question:reject',
  'provider:modelVariants',
  'engine:getStatus',
  'engine:testConnection',
  'engine:refresh',
  'ai:polishMessage',
  'memory:list', 'memory:confirm', 'memory:remove', 'memory:read',
  'plans:list', 'plans:read',
  'status:get',
  'capabilities:list',
  'window:openWorkspace',
  'window:registerWorkspace',
  'preview:open',
  'pdf:htmlToPdf'
] as const

/** 主进程 → 渲染进程事件通道白名单（engine:event=SSE 映射事件流 / engine:status=serve 运行状态 / config-changed=settings.json 变更广播 / engine:panel-update=面板数据源变更） */
const ALLOWED_ON = ['engine:event', 'engine:status', 'config-changed', 'engine:panel-update'] as const

const electronBridge = {
  invoke: (channel: string, ...args: unknown[]) => {
    if (!ALLOWED_INVOKE.includes(channel as (typeof ALLOWED_INVOKE)[number])) {
      throw new Error(`Channel "${channel}" not allowed via electronBridge`)
    }
    return ipcRenderer.invoke(channel, ...args)
  },
  on: (channel: string, cb: (data: unknown) => void) => {
    if (!ALLOWED_ON.includes(channel as (typeof ALLOWED_ON)[number])) {
      throw new Error(`Channel "${channel}" not allowed via electronBridge`)
    }
    const listener = (_e: IpcRendererEvent, data: unknown) => cb(data)
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  },
  // 新窗口工作区下发（window:init-workspace）：主进程 createWindow(workspace) 在 did-finish-load 后推送，
  // 返回取消订阅函数（照现有 on 模式，但该通道只在「带工作区启动的新窗口」场景出现，单独暴露更明确）
  onInitWorkspace: (cb: (path: string) => void) => {
    const listener = (_e: IpcRendererEvent, path: string) => cb(path)
    ipcRenderer.on('window:init-workspace', listener)
    return () => {
      ipcRenderer.removeListener('window:init-workspace', listener)
    }
  },
  // 预览独立窗口文件路径下发（window:init-preview）：主进程 openPreviewWindow 在 did-finish-load 后推送，
  // 渲染层 AppShell 监听后切换为独立预览布局（同 init-workspace 模式）
  onInitPreview: (cb: (path: string) => void) => {
    const listener = (_e: IpcRendererEvent, path: string) => cb(path)
    ipcRenderer.on('window:init-preview', listener)
    return () => {
      ipcRenderer.removeListener('window:init-preview', listener)
    }
  },
  // 预览独立窗口「发送到对话」转发：standalone 预览窗口无会话上下文，把 tip 载荷发给主进程
  // 转投主窗口（主窗口 AppShell 收到后走本地命令总线，等价面板内发送）。双向：
  // forwardChat = 本窗口发起转发（send）；onForwardChat = 主窗口接收被转发载荷（on）
  forwardChat: (payload: string) => {
    ipcRenderer.send('preview:forward-chat', payload)
  },
  onForwardChat: (cb: (payload: string) => void) => {
    const listener = (_e: IpcRendererEvent, payload: string) => cb(payload)
    ipcRenderer.on('window:forward-chat', listener)
    return () => {
      ipcRenderer.removeListener('window:forward-chat', listener)
    }
  },
  // 预览窗口自动刷新：主窗口 oc-file-changed（agent 改文件）→ 主进程广播预览窗口。
  // notifyPreviewChanged = 主窗口发起（send）；onPreviewChanged = 预览窗口接收刷新信号（on）
  notifyPreviewChanged: () => {
    ipcRenderer.send('preview:file-changed')
  },
  onPreviewChanged: (cb: () => void) => {
    const listener = () => cb()
    ipcRenderer.on('window:preview-changed', listener)
    return () => {
      ipcRenderer.removeListener('window:preview-changed', listener)
    }
  },
  // 渲染层 console 桥上报（main.ts 拦截 console 后调用）：单向 fire-and-forget，
  // 主进程仅调试模式落盘 renderer.log——走 ipcRenderer.send 不走 invoke（无回包，高频不阻塞）
  debugLog: (level: string, msg: string) => {
    ipcRenderer.send('debug:console', { level, msg })
  },
  // 拖放/粘贴文件取真实绝对路径：Electron 32+ 移除了 File.path 扩展，
  // 必须经 webUtils.getPathForFile 转换（无路径时返回空串，渲染层退化用文件名兜底）
  getPathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
    contextBridge.exposeInMainWorld('electronBridge', electronBridge)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
  // @ts-ignore (define in dts)
  window.electronBridge = electronBridge
}
