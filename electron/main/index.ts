// 主进程入口：创建窗口、加载 renderer、串联 IPC 与 serve 生命周期
import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join, basename } from 'path'
import { promises as fsp, appendFileSync } from 'node:fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerIpcHandlers, startEngineEvents } from './ipc'
import { createServerManager } from './server-manager'
import { ensureConfig } from './oc-config'
import { migrateUserDataIfNeeded } from './migrate-userdata'
import { initPreset, ensurePresetConfig } from './preset'
import { watchSettings, loadSettings } from './settings'
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
  // 固定 userData = %APPDATA%\fractal（2026-08-08 产品名对齐，原 oc-gui）：dev（electron .）默认 userData 是
  // %APPDATA%\Electron，与打包 app 分裂——API Key/主题/会话配置在两种运行方式间各存各的，
  // 表现为「dev 里设了亮色主题，打包 app 重启还是暗色」；旧目录数据由 migrateUserDataIfNeeded 一次性迁移
  app.setPath('userData', join(app.getPath('appData'), 'fractal'))
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
// e2e 模式（OC_GUI_E2E=1）强制数据隔离（XDG_DATA_HOME=临时 userData/data）：
// 测试会话不落共享数据库（opencode.db），防止污染正式会话列表（2026-08-08 清理 49 个测试残留后根治）
const serverManager = createServerManager({
  userDataDir: app.getPath('userData'),
  dataMode: isE2E ? 'isolated' : undefined,
})

// createWindow：创建主窗口。workspace 有值时新窗口启动后切到目标工作区（多窗口支持，
// 交互模式变更——渲染进程点最近工作区非当前项 → 新开窗口，不再当前窗口内切换）
// 窗口去重：winWorkspaces 记录 win.id → workspace，openWorkspace 前查重——同工作区已有窗口直接聚焦
//（避免同工作区多窗口同时用一个会话造成数据混乱，2026-08-09 用户要求）
const winWorkspaces = new Map<number, string>()
function createWindow(workspace?: string): BrowserWindow {
  const windowTitle = workspace ? `分形 — ${basename(workspace)}` : '分形'
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    // 最小尺寸：四栏布局（rail/侧栏/聊天/面板）在窄窗口下组件挤压变形、圆点折叠异常，
    // 过扁时聊天区高度不可用（2026-08-09 用户要求「不能无限窄和扁」）
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: windowTitle,
    autoHideMenuBar: true,
    ...(process.platform !== 'darwin' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })
  winWorkspaces.set(mainWindow.id, workspace ?? '')

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // 超时兜底（2026-08-08）：大工作区/慢盘时渲染层首帧可能远超 ready-to-show 阈值，
  // 死等会导致窗口永远不可见（visible=false——实测新窗口场景）；超时强制显示，
  // 窗口先展示渲染层统一的「加载中」界面（AppShell initializing 机制），内容就绪自然替换
  setTimeout(() => {
    if (!mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show()
      diag('ready-to-show 超时强制显示')
    }
  }, 3000)

  // 诊断：新窗口「创建了但没显示」排查（2026-08-08）——ready-to-show 不触发 = 渲染层首帧未画
  const diag = (msg: string) => {
    console.log(`[win:${mainWindow.id}] ${msg}`)
    try { appendFileSync(join(app.getPath('userData'), 'dialog.log'), `[win:${mainWindow.id}] ${msg}\n`) } catch { /* 日志失败不阻断 */ }
  }
  mainWindow.webContents.on('did-finish-load', () => diag('did-finish-load'))
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => diag(`did-fail-load code=${code} desc=${desc}`))
  mainWindow.webContents.on('render-process-gone', (_e, details) => diag(`render-process-gone reason=${details.reason}`))

  // 新窗口指定工作区：页面 load 完成后主进程主动下发工作区路径。
  // 比 URL query 更可靠（无编码/编码路径问题）；渲染进程 AppShell 监听 window:init-workspace →
  // cwd 切到目标工作区 + 会话列表按工作区过滤。once 保证只下发一次（页面重载不重复触发）
  if (workspace) {
    // 阻止页面 <title>（恒为「分形」）覆盖自定义窗口标题——多窗口用标题区分工作区
    mainWindow.on('page-title-updated', (e) => e.preventDefault())
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.setTitle(windowTitle)
      // 延时下发：did-finish-load 可能早于渲染层 AppShell onMounted 的监听注册（Vue 挂载时序），
      // 300ms 冗余确保新窗口必收到 init-workspace（消息丢失 = 新窗口 cwd 停留在旧工作区）
      setTimeout(() => {
        mainWindow.webContents.send('window:init-workspace', workspace)
      }, 300)
    })
  }

  mainWindow.webContents.setWindowOpenHandler((details) => {
    // 外部链接一律走系统浏览器，避免在应用内新开窗口破坏单窗口会话模型
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // dev 用 ELECTRON_RENDERER_URL（vite dev server），prod 用打包后的 html
  // workspace 以 URL query 传给渲染层（渲染层读 location.search 初始化工作区——零时序依赖，
  // 比 did-finish-load 后 IPC 下发可靠；后者 300ms 竞态下可能丢消息 = 新窗口 cwd 停在旧工作区）
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const url = new URL(process.env['ELECTRON_RENDERER_URL'])
    if (workspace) url.searchParams.set('workspace', workspace)
    mainWindow.loadURL(url.toString())
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'), { query: workspace ? { workspace } : undefined })
  }
  return mainWindow
}

app.whenReady().then(async () => {
  // Windows 通知/任务栏分组需要固定的 app user model id
  electronApp.setAppUserModelId('com.oc-gui')

  // userData 改名一次性迁移（oc-gui → fractal，2026-08-08）：必须在任何 userData 读写前执行
  // （settings/预置/日志/服务配置都依赖 userData 路径）；e2e 临时 userData 自动跳过
  migrateUserDataIfNeeded(app.getPath('userData'), join(app.getPath('appData'), 'oc-gui'))

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
    // 诊断日志：定位「点了没效果」（窗口未创建 vs 创建未显示）
    appendFileSync(join(app.getPath('userData'), 'dialog.log'), `[openWorkspace] path=${JSON.stringify(args?.path)}\n`)
    if (typeof args?.path !== 'string' || args.path.length === 0) return
    try {
      const target = args.path
      // 同工作区已有窗口：直接聚焦（restore/show/focus），不再开新窗口——避免同工作区双窗口共用会话（2026-08-09）
      const normKey = (p: string) => p.replace(/\\+$/, '').toLowerCase()
      const deduped = BrowserWindow.getAllWindows().find(
        (win) => normKey(winWorkspaces.get(win.id) ?? '') === normKey(target),
      )
      if (deduped) {
        if (deduped.isMinimized()) deduped.restore()
        deduped.show(); deduped.focus()
        appendFileSync(join(app.getPath('userData'), 'dialog.log'), `[openWorkspace] focus existing win=${deduped.id}\n`)
        return
      }
      const w = createWindow(target)
      appendFileSync(join(app.getPath('userData'), 'dialog.log'), `[openWorkspace] created id=${w.id} visible=${w.isVisible()}\n`)
    } catch (err) {
      appendFileSync(join(app.getPath('userData'), 'dialog.log'), `[openWorkspace] ERROR ${String(err)}\n`)
    }
  })

  // 渲染层上报当前工作区（窗口去重需要）：主窗口创建时 workspace 未传（登记为 ''），
  // 切回初始工作区会新开窗口——AppShell 串行链拿到 cwd 后调本通道登记（2026-08-09 用户实测）
  ipcMain.handle('window:registerWorkspace', (e, args: { cwd?: unknown }) => {
    if (typeof args?.cwd !== 'string' || args.cwd.length === 0) return
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win) winWorkspaces.set(win.id, args.cwd)
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
    // P0 数据模式时序：startServer 前必须加载 settings.json（dataMode 隔离判定依赖内存态）。
    // watchSettings 内部是 void loadSettings（异步不等待）——若不在此 await，首次启动
    // 独立模式（上一轮设置 dataMode=isolated）会读到 DEFAULT 默认值 shared，XDG_DATA_HOME 注入失效。
    // loadSettings 幂等（读盘 + 同步内存态），与 watchSettings 的异步加载重复执行无副作用。
    await loadSettings(app.getPath('userData'))
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
    // 首次启动偶发秒退（历史遗留竞态）：渲染层 IPC 会触发 ready() 重试，但 startEngineEvents
    // （engine:status 广播 + SSE 订阅）只有这里执行——不补执行会导致渲染层补拉缺失，
    // 会话列表空白（2026-08-08 实测）。重试一轮保证广播一定执行。
    console.warn('[engine] 引擎首次启动失败，重试中：', err)
    try {
      await serverManager.ready()
      await startEngineEvents(win, serverManager)
      console.log('[engine] ready 完成（重试后）')
    } catch (err2) {
      console.warn('[engine] 引擎重试仍失败（界面将按需再试）：', err2)
    }
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
