<!-- type: knowledge --><!-- status: auto --><!-- description: 分形窗口去重机制：winWorkspaces 登记 + registerWorkspace 补主窗口洞 -->
# 分形窗口去重机制

**事实**：分形「同工作区窗口去重」：主进程 `winWorkspaces Map<win.id, workspace>`——`window:openWorkspace` 先比对已有窗口（normKey：去尾斜杠+小写）→ 命中直接 restore/show/focus，否则 createWindow(workspace) 登记。**主窗口创建时 workspace 未传（登记 ''）→ 切走再切回初始工作区匹配不上 → 新开窗口**（2026-08-09 用户实测）。

**原则**：渲染层拿到 cwd 后主动 `window:registerWorkspace` 上报（AppShell 串行链 ② 兜底后），主进程 `BrowserWindow.fromWebContents(e.sender)` 补登记；任何「创建时信息不全」的登记对象都要有事后补报通道。

**反例**：❌ 只登记 openWorkspace 创建的窗口（主窗口漏登记）；✅ 渲染层上报 + 失败降级开新窗口。

**结论**：窗口去重必须覆盖所有窗口创建路径，主窗口靠「渲染层上报」补洞。
