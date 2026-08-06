// 主进程入口：创建窗口、加载 renderer、串联 IPC 与 serve 生命周期
import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { promises as fsp } from 'node:fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerIpcHandlers, startEngineEvents } from './ipc'
import { createServerManager } from './server-manager'
import { ensureConfig } from './oc-config'

// serve 进程管理器：应用级单例（userData 隔离 XDG_CONFIG_HOME，D17 实测定案）
const serverManager = createServerManager({ userDataDir: app.getPath('userData') })

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    // Windows/Linux 设置窗口图标（macOS 用 dock 图标，此字段无效）；resources/icon.png 由 scripts/gen-icons.js 生成
    ...(process.platform !== 'darwin' ? { icon } : {}),
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
  return mainWindow
}

app.whenReady().then(async () => {
  // Windows 通知/任务栏分组需要固定的 app user model id
  electronApp.setAppUserModelId('com.oc-gui')

  // dev 下 F12 开关 DevTools、prod 下屏蔽刷新快捷键
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // 注册 IPC 通道（引擎通道注入 serverManager）
  registerIpcHandlers(serverManager)

  const win = createWindow()

  // 引擎生命周期：启动 serve → 订阅 SSE 事件转发。
  // 未安装 OC 时抛错（sidecar 待阶段 7），应用仍可启动，前端经 engine:status 感知未连接。
  try {
    console.log('[engine] ready 开始')
    // 启动时同步引擎配置（必须在 startServer 之前：serve 启动时加载配置——阶段 0 实测）。
    // 读 GUI 保存的 provider key（provider-configs.json）；apiKey 空也写入 model/双星 agent 受管字段
    let savedApiKey = ''
    try {
      const saved = JSON.parse(await fsp.readFile(join(app.getPath('userData'), 'provider-configs.json'), 'utf-8')) as Record<string, { apiKey?: string }>
      savedApiKey = (saved?.deepseek?.apiKey ?? '').trim()
    } catch {
      // provider-configs.json 不存在（首次启动/未保存过设置）→ 用空 key，仅写入 model/agent 受管字段
    }
    await ensureConfig(app.getPath('userData'), { apiKey: savedApiKey, permissionMode: 'default' })
    // 统一走 ready()（与 ipc 引擎通道共享同一启动 promise，避免健康检查完成前返回未就绪参数）
    await serverManager.ready()
    console.log('[engine] ready 完成')
    await startEngineEvents(win, serverManager)
  } catch (err) {
    console.error('[engine] serve 启动失败（未安装 OC？）：', err)
  }

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

// 应用退出时停掉 serve（taskkill 树杀，避免残留 opencode 进程）
app.on('will-quit', () => {
  void serverManager.stopServer()
})
