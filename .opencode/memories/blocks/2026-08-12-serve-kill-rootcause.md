<!-- type: knowledge --><!-- status: auto --><!-- description: serve 被杀根因：shared 模式下多 opencode 实例同库 SQLite 锁竞争；默认已改 isolated -->

# serve 被杀根因（dataMode 默认 isolated）

- 事实：分形 serve（opencode.exe）反复被硬杀（exit 4294967295），非心跳/自尽。根因=shared 模式下分形 serve 与官方桌面版/CLI 共享 `~/.local/share/opencode/opencode.db`（2.4GB），opencode 多实例同库是官方已知 bug（SQLite WAL 锁竞争→实例静默死亡，issue #29395/#36775，官方 workaround=各自独立 XDG_DATA_HOME）
- 原则：**任何场景不得再让分形 serve 与外部 opencode 实例同库**（2026-08-12 起 settings 默认 dataMode=isolated，XDG_DATA_HOME=<userData>/data）
- 反例：❌ 开发时起独立 `opencode.exe serve` 调试（不带隔离 env）→ 分形 serve 2-3 分钟内被锁竞争杀掉（0:54:53/0:55:45 实测）✅ 带 OPENCODE_SERVER_USERNAME/PASSWORD 且用 `--port 0` 独立端口也要注意：**同库仍互杀**——调试 serve 必须临时设独立 XDG_DATA_HOME
- 结论：serve 崩溃先查 crash dump 是否 4294967295 + 是否同时有别的 opencode 实例在跑；`opencode serve` 无心跳退出机制（源码 `await new Promise(()=>{})` 永久阻塞，SSE heartbeat 只保活客户端）
