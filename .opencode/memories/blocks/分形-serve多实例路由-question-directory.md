<!-- type: knowledge --><!-- status: auto --><!-- description: serve 多实例按工作区目录路由，question 等裸 fetch 必须带 directory query 否则跨工作区 404 -->

# 分形-serve 多实例路由（question 必须带 directory）

- 事实：`opencode serve` 是多实例架构，每个工作区目录一个 instance，question pending 等状态存在**各实例自己的 Map**。serve 用 WorkspaceRoutingMiddleware 路由 HTTP 请求：`directory` query → `x-opencode-directory` header → 兜底 `process.cwd()`
- 原则：分形主进程所有**裸 fetch** 调 serve 端点时，若目标状态可能归属非默认工作区，必须带 `?directory=<当前工作区>`（来自 `readProjectCwd` 读 ui-settings.json 的 cwd）
- 反例：❌ question:reply/reject 只带 Authorization 不带 directory → 提问发生在 test 工作区（实例 A），提交时 reply 路由到 fractal 默认实例（实例 B）→ `404 QuestionNotFoundError`「提交答案后没反应」（2026-08-12 实测）
- ✅ 修复：`electron/main/ipc.ts` question:reply（:947）/question:reject（:964）fetch URL 加 `?directory=${encodeURIComponent(cwd)}`，无 cwd 时回退不带（默认实例路由，与旧行为一致）；ipc.test.ts 新增 3 条断言
- 结论：跨工作区场景下，凡是用 `getServerAuth()` 裸 fetch 的通道（question、compact 等），都要审视实例归属；v1 SDK client 走的是 `createOpencodeClient`（oc-sdk.ts:276 只带 Authorization，同样默认实例）——分形目前主窗口即默认实例，切换工作区靠 window:openWorkspace 新窗口，跨窗口引擎请求可能仍踩此坑

