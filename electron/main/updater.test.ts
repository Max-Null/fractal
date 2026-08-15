// 自动更新封装测试：事件→payload 映射、错误文案翻译、IPC 注册与静默检查
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// electron-updater 是 CJS 模块：mock default 导出，与实现侧 import electronUpdater 解构对齐
const { autoUpdaterMock, mockElectron } = vi.hoisted(() => {
  const autoUpdaterMock = {
    autoDownload: true,
    on: vi.fn(),
    checkForUpdates: vi.fn().mockResolvedValue(undefined),
    downloadUpdate: vi.fn().mockResolvedValue(undefined),
    quitAndInstall: vi.fn(),
  }
  return {
    autoUpdaterMock,
    mockElectron: {
      app: { isPackaged: true },
      ipcMain: { handle: vi.fn() },
    },
  }
})
vi.mock("electron", () => mockElectron)
vi.mock("electron-updater", () => ({ default: { autoUpdater: autoUpdaterMock } }))

import { buildStatusPayload, translateError, registerUpdaterIpc } from "./updater"

describe("buildStatusPayload", () => {
  it("maps checking-for-update", () => {
    expect(buildStatusPayload("checking-for-update")).toEqual({ type: "checking" })
  })
  it("maps update-available with string notes", () => {
    expect(buildStatusPayload("update-available", { version: "1.2.0", releaseNotes: "fix bugs" })).toEqual({
      type: "available",
      version: "1.2.0",
      releaseNotes: "fix bugs",
    })
  })
  it("maps update-available with Note[] notes", () => {
    const notes = [{ version: "1.2.0", note: "line1\nline2" }]
    expect(buildStatusPayload("update-available", { version: "1.2.0", releaseNotes: notes })).toEqual({
      type: "available",
      version: "1.2.0",
      releaseNotes: "line1\nline2",
    })
  })
  it("maps update-not-available", () => {
    expect(buildStatusPayload("update-not-available", { version: "1.1.0" })).toEqual({
      type: "not-available",
      version: "1.1.0",
    })
  })
  it("maps download-progress", () => {
    expect(
      buildStatusPayload("download-progress", {
        percent: 42,
        transferred: 42e6,
        total: 100e6,
        bytesPerSecond: 1e6,
      })
    ).toEqual({ type: "progress", percent: 42, transferred: 42e6, total: 100e6, bytesPerSecond: 1e6 })
  })
  it("maps update-downloaded", () => {
    expect(buildStatusPayload("update-downloaded", { version: "1.2.0" })).toEqual({
      type: "downloaded",
      version: "1.2.0",
    })
  })
  it("maps error with translated message", () => {
    expect(buildStatusPayload("error", new Error("Cannot find latest.yml"))).toEqual({
      type: "error",
      message: "未找到更新信息，请稍后再试",
    })
  })
  it("returns null for unknown event", () => {
    expect(buildStatusPayload("whatever")).toBeNull()
  })
})

describe("translateError", () => {
  it("latest.yml missing", () => {
    expect(translateError(new Error("Cannot find latest.yml"))).toBe("未找到更新信息，请稍后再试")
  })
  it("network failure", () => {
    expect(translateError(new Error("net::ERR_INTERNET_DISCONNECTED"))).toBe("网络连接失败，请检查网络后重试")
  })
  it("auth/not found", () => {
    expect(translateError(new Error("404 Not Found"))).toBe("无法访问更新服务器")
  })
  it("fallback raw message", () => {
    expect(translateError(new Error("weird stuff"))).toBe("weird stuff")
  })
})

describe("registerUpdaterIpc", () => {
  beforeEach(() => {
    autoUpdaterMock.on.mockClear()
    autoUpdaterMock.checkForUpdates.mockClear()
    mockElectron.ipcMain.handle.mockClear()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("registers events + handlers and disables autoDownload when packaged", () => {
    const getWindow = () => null as never
    registerUpdaterIpc(getWindow)
    expect(autoUpdaterMock.autoDownload).toBe(false)
    // 6 个事件订阅：checking/available/not-available/progress/downloaded + error
    expect(autoUpdaterMock.on).toHaveBeenCalledTimes(6)
    expect(mockElectron.ipcMain.handle.mock.calls.map((c: string[]) => c[0])).toEqual([
      "updater:check",
      "updater:download",
      "updater:quit-and-install",
    ])
  })

  it("schedules silent check 10s after startup", () => {
    const getWindow = () => null as never
    registerUpdaterIpc(getWindow)
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    vi.advanceTimersByTime(10_000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it("updater:check 失败：错误翻译后经 updater:status 推送（不 reject——安装版真实错误不再误报 devMode）", async () => {
    const sendMock = vi.fn()
    const getWindow = () => ({ webContents: { send: sendMock } }) as never
    registerUpdaterIpc(getWindow)
    // 从注册表取出 updater:check handler 直接调用
    const checkHandler = mockElectron.ipcMain.handle.mock.calls.find(
      (c: string[]) => c[0] === "updater:check"
    )![1] as () => Promise<void>
    autoUpdaterMock.checkForUpdates.mockRejectedValueOnce(new Error("net::ERR_INTERNET_DISCONNECTED"))
    await checkHandler()
    // 推送翻译后的可读文案，而非把原始错误 reject 给渲染层
    expect(sendMock).toHaveBeenCalledWith("updater:status", { type: "error", message: "网络连接失败，请检查网络后重试" })
  })

  it("dev 模式：注册占位 handler 抛 DEV_MODE（渲染层显示「开发模式不可用」而非 No handler registered）", () => {
    // mock 共享对象：临时切到 dev 模式，测试后恢复（避免影响其他用例）
    ;(mockElectron.app as { isPackaged: boolean }).isPackaged = false
    try {
      const getWindow = () => null as never
      registerUpdaterIpc(getWindow)
      // dev 不订阅事件、不静默检查
      expect(autoUpdaterMock.on).not.toHaveBeenCalled()
      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
      // 3 个 handler 仍注册（占位），调用抛 DEV_MODE_UPDATER_UNAVAILABLE
      const channels = mockElectron.ipcMain.handle.mock.calls.map((c: string[]) => c[0])
      expect(channels).toEqual(["updater:check", "updater:download", "updater:quit-and-install"])
      const devHandler = mockElectron.ipcMain.handle.mock.calls[0][1] as () => never
      expect(() => devHandler()).toThrow("DEV_MODE_UPDATER_UNAVAILABLE")
    } finally {
      ;(mockElectron.app as { isPackaged: boolean }).isPackaged = true
    }
  })
})
