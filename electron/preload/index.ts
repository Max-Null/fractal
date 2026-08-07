import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {}

/**
 * electronBridge：渲染进程访问主进程能力的唯一通道。
 * - invoke: 请求-响应式 IPC（fs/git/settings/logs/dialog/chat/session/message/permission 等）
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
  'logs:saveSessionDebugLog', 'logs:saveSessionStderrLog', 'logs:loadSessionLogs',
  'dialog:openDialog', 'dialog:saveDialog',
  'chat:sendMessage', 'chat:stopSession',
  'session:create', 'session:list', 'session:get', 'session:delete', 'session:rename', 'session:fork',
  'message:list', 'permission:respond',
  'question:reply', 'question:reject',
  'engine:testConnection',
  'engine:refresh',
  'memory:list', 'memory:confirm', 'memory:remove',
  'plans:list',
  'status:get'
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
