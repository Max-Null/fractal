/**
 * electronBridge 通道白名单（渲染进程可用的 IPC 通道）。
 *
 * 独立成模块（无 electron 依赖）供 preload 运行时引用 + channels.test.ts 静态扫描校验：
 * 主进程新增 ipcMain.handle / webContents.send 通道时，若忘加白名单，测试即红。
 *
 * 2026-08-14 教训：自动更新首次接入漏加 updater:status（on）+ updater:check/download/quit-and-install（invoke），
 * 渲染层运行时才报 Channel not allowed——该模块与测试即为此防回归。
 */
export const ALLOWED_INVOKE = [
  'fs:listDir', 'fs:readFileContent', 'fs:writeFile', 'fs:saveFileContent',
  'fs:deleteFile', 'fs:renameFile', 'fs:moveFile', 'fs:copyFile',
  'fs:createDir', 'fs:readFileBase64', 'fs:getWorkspaceRoot', 'fs:revealInExplorer',
  'git:status', 'git:diff', 'git:stage', 'git:unstage', 'git:commit', 'git:push',
  'settings:saveUiSettings', 'settings:loadUiSettings',
  'settings:saveProviderConfig', 'settings:loadProviderConfigs',
  'settings:getConfig', 'settings:saveSettings', 'settings:getSchema',
  'deepseek:getBalance', // 计费迭代：设置面板/上下文面板余额查询（主进程读 key，渲染层零接触）
  'kimi:getBalance', // 计费迭代：Kimi 多模态余额查询（与 deepseek:getBalance 对称，复用 DeepSeekBalanceResult）
  'logs:saveSessionDebugLog', 'logs:readServeLog', 'logs:loadSessionLogs', 'logs:readRendererLog',
  'app:getInfo',
  'dialog:openDialog', 'dialog:saveDialog',
  'chat:sendMessage', 'chat:stopSession',
  'session:create', 'session:list', 'session:get', 'session:delete', 'session:rename', 'session:fork', 'session:setActive',
  'session:compact', // 会话压缩（主进程 ipc.ts 已注册；2026-08-14 静态扫描测试发现漏加白名单——渲染层 compactSession 调用原本会报 Channel not allowed）
  'message:list', 'permission:respond',
  'question:reply', 'question:reject',
  'provider:modelVariants',
  'engine:getStatus',
  'engine:testConnection',
  'engine:testKimiConnection',
  'engine:refresh',
  'ai:polishMessage',
  'memory:list', 'memory:confirm', 'memory:remove', 'memory:read',
  'plans:list', 'plans:read',
  'status:get',
  'capabilities:list',
  'window:openWorkspace',
  'window:registerWorkspace',
  'preview:open',
  'pdf:htmlToPdf',
  'avatar:pick', 'avatar:clear', 'avatar:getPath', 'notification:show',
  'updater:check', 'updater:download', 'updater:quit-and-install' // 自动更新（主进程 updater.ts 注册）
] as const

/** 主进程 → 渲染进程事件通道白名单（engine:event=SSE 映射事件流 / engine:status=serve 运行状态 / config-changed=settings.json 变更广播 / engine:panel-update=面板数据源变更 / updater:status=自动更新状态推送） */
export const ALLOWED_ON = ['engine:event', 'engine:status', 'config-changed', 'engine:panel-update', 'updater:status'] as const
