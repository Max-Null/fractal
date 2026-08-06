# 00a：serve 原生能力 → 分形产品功能映射表

> 版本：2026-08-07 ｜ 依据：`docs/知识/oc-engine/v1.18.x-serve-API能力清单.md`（162 端点）
> 状态标注：✅ 已接入 ｜ 🔵 可接未接（serve 原生，直接调 API 就有）｜ 🟡 部分（有替代实现）｜ ⚠️ 需自研/前端做 ｜ ⛔ 不做

## 一、会话域

| 产品功能 | serve 支撑 API | 状态 | 备注 |
|---------|---------------|------|------|
| 新建会话 | POST /session | ✅ | |
| 会话列表（按工作区过滤） | GET /session ?directory= | ✅ | 排序=前端（serve 无 sort） |
| 删除会话 | DELETE /session/{id} | ✅ | |
| 重命名 | PATCH /session/{id} | ✅ | |
| 分叉 | POST /session/{id}/fork | ✅ | |
| 中断生成 | POST /session/{id}/abort | ✅* | abort 返回 500 但事件流生效（C-15） |
| 历史消息 | GET /session/{id}/message | ✅ | 全量拉取 |
| **撤销/重做** | POST /session/{id}/revert / unrevert | 🔵 | v2 三段式更细（stage/clear/commit） |
| **会话摘要** | POST /session/{id}/summarize | 🔵 | 侧栏可显示摘要 |
| **分享** | POST /session/{id}/share | 🔵 | 生成分享链接 |
| **运行中切换模型** | POST /api/session/{id}/model | 🔵 | v2；比发消息带参更完整 |
| **运行中切换 agent** | POST /api/session/{id}/agent | 🔵 | v2 |
| 会话状态（忙碌/空闲） | GET /session/status | 🔵 | 侧栏忙碌角标 |
| 上下文详情 | GET /api/session/{id}/context | 🔵 | v2；上下文面板 |
| **上下文压缩** | POST /api/session/{id}/compact | 🔵 | v2；长会话管理 |
| 会话树/子会话 | GET /session/{id}/children | 🔵 | 分叉关系展示 |
| 归档 | （experimental 雏形） | ⚠️ | 不可依赖，暂不做 |

## 二、消息/交互域

| 产品功能 | serve 支撑 API | 状态 | 备注 |
|---------|---------------|------|------|
| 发送消息（流式） | POST /session/{id}/prompt_async + /event SSE | ✅ | 分形主通道 |
| 消息 part 增量渲染 | message.part.updated 事件 | ✅ | text/thinking/tool 分派 |
| 回合结束（耗时/token） | session.idle 事件 | ✅ | duration_ms 已补 |
| 消息历史时间线 | GET /session/{id}/message | ✅ | |
| **提问弹窗（question 工具）** | GET /question + POST /question/{id}/reply|reject（v2：/api/session/{id}/question/*） | 🔵 | **P5 闭环**——serve 原生，直接接 |
| 删除单条消息 | DELETE /session/{id}/message/{mid} | 🔵 | |
| 编辑 part（消息修正） | PATCH part/{pid} | 🔵 | |
| Todo 面板 | GET /session/{id}/todo | 🔵 | 前端 todo 显示可接 serve 数据 |
| 斜杠命令 | POST /session/{id}/command + GET /command | 🔵 | /compact /plan 等 |
| 等待回合完成（轮询） | POST /api/session/{id}/wait | 🔵 | v2；轻量场景替代 SSE |

## 三、工具域（文件/git/搜索）

| 产品功能 | serve 支撑 API | 状态 | 备注 |
|---------|---------------|------|------|
| 文件树/读取 | GET /file /file/content /file/status | 🟡 | 分形用自研 fs:* IPC；serve file API 可用但无必要换 |
| 文件写入/编辑 | ⚠️ serve 无 write API | ⚠️ | 自研 fs:* 正确选择 |
| git 状态/diff/提交 | GET /vcs*（status/diff/diff/raw）+ POST /vcs/apply | 🟡 | 分形用自研 git CLI；serve vcs 只读+apply，无 commit/stage |
| **全局搜索** | GET /find + /find/file + /find/symbol | 🔵 | 文件面板搜索可升级为全文搜索 |
| 工作区/项目管理 | GET /project + /project/current + /project/{id}/directories | 🔵 | 项目视图 |

## 四、控制域（权限/认证）

| 产品功能 | serve 支撑 API | 状态 | 备注 |
|---------|---------------|------|------|
| 权限审批弹窗 | permission.updated 事件 + POST /session/{id}/permissions/{pid} | ✅ | once/always/reject 已接 |
| **保存的权限规则管理** | GET/DELETE /api/permission/saved | 🔵 | v2；免审批持久化（v1.12 设计写配置，v2 有原生管理） |
| 权限请求列表 | GET /permission（v1）/ /api/permission/request（v2） | 🔵 | 待处理请求面板 |
| API Key 认证 | env 注入 + 配置写入 | ✅ | |
| provider OAuth | POST /provider/{id}/oauth/* | ⛔ | DeepSeek 用 Key 不需要 |

## 五、配置/设置域

| 产品功能 | serve 支撑 API | 状态 | 备注 |
|---------|---------------|------|------|
| 模型清单 | GET /provider + /config/providers | ✅ | |
| 配置读写 | GET/PATCH /config（v1）+ /api/config（v2） | 🟡 | 分形走文件生成（oc-config 双写），PATCH 未用 |
| 健康检查 | GET /global/health | ✅ | serve 就绪判定 |
| agent/技能/命令清单 | GET /agent + /skill + /command | 🔵 | 管理面板数据源（当前骨架占位 → 接真数据） |
| MCP 管理 | POST /mcp + /mcp/{name}/connect 等 | 🔵 | 管理面板 MCP tab 可接 |
| 预置包初始化 | （本地文件系统） | ⚠️ | 自研（阶段 8） |

## 六、serve 有而产品没有（反向表 → 产品建议）

| serve 能力 | 建议 | 优先级 |
|-----------|------|--------|
| question 提问 API | 接提问弹窗（P5 闭环） | 🔴 高（阶段 5 应有） |
| revert/unrevert 撤销 | 消息操作「撤销该回复」 | 🟡 中 |
| compact 上下文压缩 | 长会话「压缩上下文」按钮 | 🟡 中 |
| switchModel 运行中切模型 | 聊天中直接切模型（无需新会话） | 🟡 中 |
| summarize 会话摘要 | 侧栏会话摘要展示 | 🟢 低 |
| find 全文搜索 | 文件面板搜索增强 | 🟢 低 |
| permission/saved | 免审批规则可视化管理 | 🟡 中（v2 升级后） |
| v2 API 整体 | oc-sdk 升级 v2（获得 wait/compact/switch 等） | 🟡 中期规划 |

## 七、结论

1. **核心链路（会话/消息/权限/配置）已 100% 走 serve 原生**——上层设计成立
2. **最大缺口：question 提问 API 未接**（P5 从「待实测」变成「现成 API 未接」）——产品功能（提问弹窗）应尽快补
3. **自研合理项**：文件写入（serve 无）、git commit（serve vcs 只读）、排序/展示（serve 无 sort）
4. **中期方向**：oc-sdk 升级 v2 后解锁 compact/switchModel/switchAgent/wait/permission-saved
