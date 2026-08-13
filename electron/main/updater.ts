// 自动更新封装：electron-updater 事件 → 渲染层 updater:status 推送 + IPC handler。
// 开发模式（非打包）完全禁用——dev 无发布地址，注册 handler/静默检查无意义（2026-08-14）
import { app, ipcMain, type BrowserWindow } from "electron"
import electronUpdater from "electron-updater"

// electron-updater 是 CJS 模块：ESM 下必须解构 default（issue #7976），CJS 构建下也安全
const { autoUpdater } = electronUpdater

// 推送给渲染层的更新状态（扁平形状，渲染层 electron-bridge.ts 有对齐 interface）
export type UpdaterStatus =
  | { type: "checking" }
  | { type: "available"; version: string; releaseNotes: string }
  | { type: "not-available"; version: string }
  | { type: "progress"; percent: number; transferred: number; total: number; bytesPerSecond: number }
  | { type: "downloaded"; version: string }
  | { type: "error"; message: string }

// releaseNotes 可能是 string（GitHub notes）或 Note[]（generic provider），统一为纯文本
function extractNotes(notes: unknown): string {
  if (typeof notes === "string") return notes
  if (Array.isArray(notes)) {
    return notes
      .map((n) => (n && typeof n === "object" && "note" in n ? String((n as { note: string }).note) : ""))
      .filter(Boolean)
      .join("\n")
  }
  return ""
}

// 事件名 → 状态 payload；未知事件返回 null（避免误推送）
export function buildStatusPayload(eventName: string, info?: unknown): UpdaterStatus | null {
  const i = (info ?? {}) as Record<string, unknown>
  switch (eventName) {
    case "checking-for-update":
      return { type: "checking" }
    case "update-available":
      return { type: "available", version: String(i.version), releaseNotes: extractNotes(i.releaseNotes) }
    case "update-not-available":
      return { type: "not-available", version: String(i.version) }
    case "download-progress":
      return {
        type: "progress",
        percent: Number(i.percent) || 0,
        transferred: Number(i.transferred) || 0,
        total: Number(i.total) || 0,
        bytesPerSecond: Number(i.bytesPerSecond) || 0,
      }
    case "update-downloaded":
      return { type: "downloaded", version: String(i.version) }
    case "error":
      return { type: "error", message: translateError(info) }
    default:
      return null
  }
}

// 错误文案可读化：识别常见失败模式，避免把英文堆栈抛给小白用户；未识别则原样透传
export function translateError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/cannot find|latest\.yml/i.test(msg)) return "未找到更新信息，请稍后再试"
  if (/net::|econn|enotfound|network/i.test(msg)) return "网络连接失败，请检查网络后重试"
  if (/401|403|404/i.test(msg)) return "无法访问更新服务器"
  return msg
}

/**
 * 注册更新相关 IPC 与事件推送。getWindow 用于定位推送目标窗口（多窗口下推送焦点窗口即可）。
 * 非打包环境直接跳过（autoUpdater 在 dev 无发布配置会抛错）。
 */
export function registerUpdaterIpc(getWindow: () => BrowserWindow | null): void {
  if (!app.isPackaged) return

  // 先提示再下载：available 后由用户点「立即更新」才下载，避免静默占用带宽
  autoUpdater.autoDownload = false

  // 事件 → 渲染层（payload 精简，逐事件映射；未知事件忽略）
  const send = (status: UpdaterStatus): void => {
    const w = getWindow()
    w?.webContents.send("updater:status", status)
  }
  for (const ev of [
    "checking-for-update",
    "update-available",
    "update-not-available",
    "download-progress",
    "update-downloaded",
  ] as const) {
    autoUpdater.on(ev, (info?: unknown) => {
      const s = buildStatusPayload(ev, info)
      if (s) send(s)
    })
  }
  autoUpdater.on("error", (err: unknown) => send({ type: "error", message: translateError(err) }))

  // 启动静默检查（D5）：延迟 10s 不打扰启动流程，有新版才经 available 弹窗提示
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {})
  }, 10_000)

  ipcMain.handle("updater:check", () => autoUpdater.checkForUpdates())
  ipcMain.handle("updater:download", () => autoUpdater.downloadUpdate())
  ipcMain.handle("updater:quit-and-install", () => autoUpdater.quitAndInstall())
}
