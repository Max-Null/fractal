// 主进程入口：创建窗口、加载 renderer、串联 IPC 与 serve 生命周期
import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join, basename } from 'path'
import { promises as fsp } from 'node:fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerIpcHandlers, startEngineEvents } from './ipc'
import { createServerManager } from './server-manager'
import { ensureConfig } from './oc-config'
import { initPreset, ensurePresetConfig } from './preset'
import { watchSettings } from './settings'
import { startPanelWatchers, setPanelWatchers } from './panel'

// ── 单实例锁：SQLite 用户数据（settings/session 缓存）不支持双实例并发——第二个实例直接退出并聚焦已有窗口
// e2e 测试注入 OC_GUI_E2E=1 豁免（多个测试实例需要独立进程，且 app 可能在运行）
const isE2E = process.env.OC_GUI_E2E === '1'
const gotSingleInstanceLock = isE2E || app.requestSingleInstanceLock()

// e2e 隔离：独立 userData（SQLite + serve 配置目录都走临时目录），不碰正式数据、不与运行中的 app 竞争
// OC_GUI_E2E_SHARE=1 时跳过隔离（诊断用：豁免锁 + 复用正式 userData，需先关闭正式 app）
if (isE2E && process.env.OC_GUI_E2E_SHARE !== '1') {
  app.setPath('userData', join(app.getPath('temp'), 'oc-gui-e2e'))
} else {
  // 固定 userData = %APPDATA%\oc-gui：dev（electron .）默认 userData 是 %APPDATA%\Electron，
  // 与打包 app（%APPDATA%\oc-gui）分裂——API Key/主题/会话配置在两种运行方式间各存各的，
  // 表现为「dev 里设了亮色主题，打包 app 重启还是暗色」
  app.setPath('userData', join(app.getPath('appData'), 'oc-gui'))
}

// e2e 继承正式配置（API Key），保证真实引擎对话 e2e 可跑；正式配置不存在则走无 key 场景（onboarding 测试）
async function copyRealConfigForE2E(): Promise<void> {
  try {
    const e2eUserData = join(app.getPath('temp'), 'oc-gui-e2e')
    const realCfgPath = join(app.getPath('appData'), 'oc-gui', 'provider-configs.json')
    const raw = await fsp.readFile(realCfgPath, 'utf8')
    const cfg = JSON.parse(raw.replace(/^\uFEFF/, ''))
    if (cfg?.deepseek?.apiKey) {
      await fsp.mkdir(e2eUserData, { recursive: true })
      await fsp.writeFile(join(e2eUserData, 'provider-configs.json'), JSON.stringify(cfg), 'utf8')
    }
  } catch {
    // 正式配置不可读：忽略，e2e 走无 key 路径
  }
}
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
}

// serve 进程管理器：应用级单例（userData 隔离 XDG_CONFIG_HOME，D17 实测定案）
const serverManager = createServerManager({ userDataDir: app.getPath('userData') })

// createWindow：创建主窗口。workspace 有值时新窗口启动后切到目标工作区（多窗口支持，
// 交互模式变更——渲染进程点最近工作区非当前项 → 新开窗口，不再当前窗口内切换）
function createWindow(workspace?: string): BrowserWindow {
  // 窗口标题：指定工作区显示「分形 — 目录名」便于多窗口识别。
  // 注意：页面 <title>分形</title> 会在 load 完成后覆盖构造 title → did-finish-load 里 setTitle 兜底
  const windowTitle = workspace ? `分形 — ${basename(workspace)}` : '分形'
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    title: windowTitle,
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

  // 新窗口指定工作区：页面 load 完成后主进程主动下发工作区路径。
  // 比 URL query 更可靠（无编码/编码路径问题）；渲染进程 AppShell 监听 window:init-workspace →
  // cwd 切到目标工作区 + 会话列表按工作区过滤。once 保证只下发一次（页面重载不重复触发）
  if (workspace) {
    // 阻止页面 <title>（恒为「分形」）覆盖自定义窗口标题——多窗口用标题区分工作区
    mainWindow.on('page-title-updated', (e) => e.preventDefault())
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.setTitle(windowTitle)
      mainWindow.webContents.send('window:init-workspace', workspace)
    })
  }

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

  // e2e 复制正式配置后再注册 IPC（渲染进程 initFromDb 依赖 provider-configs.json）
  if (isE2E) await copyRealConfigForE2E()

  // 预置配置体系（阶段 8）：先初始化 oc-plus 全家桶（agents/skills/plugins 拷贝 + 幂等检测），
  // 再 merge default_agent/plugin/instructions 进 opencode.json——必须在 registerIpcHandlers 前完成，
  // 渲染进程经 IPC 启动 serve 时预置配置已就绪；ensureConfig（provider 受管字段）在 startServer 前再次合并。
  try {
    const presetResult = await initPreset(app.getPath('userData'))
    if (presetResult.initialized) {
      console.log(`[preset] 预置初始化完成 v${presetResult.version}`)
    }
    await ensurePresetConfig(app.getPath('userData'))
  } catch (err) {
    // 预置资源缺失（打包缺陷）不应阻断应用启动——记录后继续，serve 仍可跑但预置 agent/技能不生效
    console.error('[preset] 预置初始化失败（预置资源缺失？）：', err)
  }

  // 注册 IPC 通道（引擎通道注入 serverManager）
  registerIpcHandlers(serverManager)

  // 多窗口支持：渲染进程点最近工作区非当前项 → 新开窗口并切到目标工作区（交互模式变更，用户需求）
  // 校验 path 非空字符串——脏参数直接忽略，避免创建无意义窗口
  ipcMain.handle('window:openWorkspace', (_e, args: { path?: unknown }) => {
    if (typeof args?.path !== 'string' || args.path.length === 0) return
    createWindow(args.path)
  })

  const win = createWindow()

  // 配置监听（阶段 6，方案 3.8.3）：settings.json 变更 → config-changed 广播（GUI 表单/JSON 编辑器/agent 工具三路统一走文件）
  const stopConfigWatch = watchSettings(win, app.getPath('userData'))
  win.on('closed', () => stopConfigWatch())

  // 右侧面板数据源监听（P1-P3 拍板：GUI 文件监听实时刷新）：记忆/计划/状态文件变更 → engine:panel-update 广播
const panelWatchers = startPanelWatchers(win, app.getPath('userData'))
setPanelWatchers(panelWatchers)
win.on('closed', () => {
  panelWatchers.dispose()
  setPanelWatchers(null)
})

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
