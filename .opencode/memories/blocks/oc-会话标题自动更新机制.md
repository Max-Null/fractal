<!-- type: knowledge --><!-- status: auto --><!-- description: OC 会话标题自动更新机制——ensureTitle 只认默认格式标题，分形需不传 title 触发 -->
# OC 会话标题自动更新（ensureTitle）触发条件

## 事实
- OC（serve）有内置自动标题机制：首条真实用户消息后，用 title agent + small_model 生成标题，经 session.updated 事件下发（prompt.ts ensureTitle）
- 触发硬条件（session.ts isDefaultTitle 正则）：标题必须是 OC 默认格式 `New session - <ISO时间戳>` 或 `Child session - <ISO时间戳>`，否则 ensureTitle 直接 return

## 原则
- 调用 session.create 时**不传 title**（undefined），serve 用默认格式创建，自动命名才会触发
- 传了自定义标题（如「新会话」）→ ensureTitle 短路 → 标题永不更新（2026-08-10 实测，非 small_model 配置问题）

## 反例
- ❌ 分形 createSession 传「新会话」→ 标题永远「新会话」（此前误判为 #14807 small_model 静默失败）
- ✅ 不传 title + small_model 配置 → 首条消息后自动生成 AI 标题

## 结论
- 标题自动更新链路：serve ensureTitle → session.updated（info.title 变化）→ 主进程 events.ts 产出 session_title 事件 → 前端 session store 本地更新
- 分形修复提交：e793628（2026-08-10）
