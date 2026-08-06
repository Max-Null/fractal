// 主进程入口：创建窗口、加载 renderer、串联 IPC 与 serve 生命周期
import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerIpcHandlers } from './ipc'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    // 外部链接一律走系统浏览器，避免在应用内新开窗口破坏单窗口会话模型
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // dev 用 ELECTRON_RENDERER_URL（vite dev server），prod 用打包后的 html
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // Windows 通知/任务栏分组需要固定的 app user model id
  electronApp.setAppUserModelId('com.oc-gui')

  // dev 下 F12 开关 DevTools、prod 下屏蔽刷新快捷键
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // 注册 IPC 通道（阶段 4 填充具体实现）
  registerIpcHandlers()

  createWindow()

  app.on('activate', function () {
    // macOS 点击 Dock 图标时若无窗口则重建（其他平台由 window-all-closed 处理退出）
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // macOS 惯例保持应用常驻，其余平台关闭全部窗口即退出
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
