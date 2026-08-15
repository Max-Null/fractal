# 决策：fractal 基座选择 — 维持 OpenCode，DeepSeek Harness 暂不切换

> 日期：2026-08-14
> 状态：已决策（待触发「重评估条件」）
> 决策人：MaxNull
> 关联仓库：fractal（本仓库）、DeepSeek Harness（`H:\MaxNull\WorkStation\deepseek-harness`）
> 结论绑定：OpenCode 1.18.x；DeepSeek Harness 截至 2026-08-14 无 tagged release（git tag 为空，HEAD `47f9438` @ 2026-08-13）

---

## 一、背景

1. 最初基座为 Claude Code（CC），因其闭源等问题决定更换核心。
2. 等待 DeepSeek Harness 发布约两个月未果，改用 OpenCode（OC）作为基座。
3. fractal 1.0.0 交付、正式分享给朋友的第二天，DeepSeek Harness 发布。
4. fractal 指定 DeepSeek 为唯一 LLM，DSH 从定位上是最匹配的基座——因此必须明确「是否切换到 DSH」。

## 二、关键事实（据实核查，非情绪判断）

### 2.1 fractal 是两层结构：壳与引擎适配层分离

| 层 | 文件 | 引擎相关 |
|---|---|---|
| 壳（渲染层 + IPC + 事件契约） | `src/renderer/`、`electron/preload/`、`StreamFrontendEvent` 契约 | 无关 |
| 引擎适配层 | `electron/main/oc-sdk.ts`、`server-manager.ts`、`events.ts` | 深度绑定 `opencode serve` |

`StreamFrontendEvent` 事件契约不变（迁移 cc-gui 时定下的关键决策），意味着换引擎时前端组件零改造。**换引擎的工作量集中在这一层，不是整个产品重做。**

### 2.2 DSH 当前对外接口是 automation-only，喂不饱富 GUI

核查 `packages/acp`、`packages/sdk` 文档（2026-08-14）：

| 能力 | fractal GUI 需要 | DSH 当前 ACP / SDK | OC（现状） |
|---|---|---|---|
| 流式 token / reasoning / 工具时间线 | 需要 | ❌ 仅回传已提交完整回答 | ✅ SSE 事件流 |
| 会话 list / resume / fork / delete | 需要 | ❌ 仅支持全新会话 | ✅ |
| 权限审批弹窗（once/always/reject） | 需要 | ❌ 按策略自动决策，无交互 | ✅ |
| 文件浏览 / 生态清单 | 需要 | ❌ 不暴露 fs / MCP | ✅ |
| 回合中断（mid-turn cancel） | 需要 | ❌ 无 | ✅ |

- DSH ACP 文档原文：*Automation-only*；Known Limitations 明确 *"load, list, resume, delete, and fork are unsupported"*、*"committed answers only"*（流式进度、reasoning、工具活动、计划、标题都不上线）；权限 *"resolve one-shot permission requests by policy"*（策略自动决策，非交互弹窗）。
- DSH SDK Known Limitations：*no mid-turn cancel*、*no per-prompt result*、*client→server notifications 与 server→client requests 均 unimplemented*（审批交互是未来项）。
- 对照：OC 的 ACP 本身已支持 session list/fork/resume/load + 流式 + 审批（见 `实测记录.md` 阶段 0），而 fractal 落地代码最终走 `opencode serve` + SDK 以获取更富的接口。**DSH 今天的 ACP 比 OC 的 ACP 更薄，遑论 serve。**

### 2.3 DSH 处于 pre-release，无兼容承诺

- 其根 AGENTS.md 明确：首个 tagged release 前保留 pre-release 段；SQLite 用单调 `SCHEMA_VERSION`；`dsh-session` 的 `SESSION_FORMAT_VERSION` 为 0、无兼容承诺。
- 含义：今日押注 DSH 作为产品基座，大概率随其迭代反复重写。

### 2.4 oc-plus 的记忆层与引擎深度耦合（第三块，此前判断遗漏）

oc-plus 不是可剥离的预置包，而是对 OC 的增强，其中**分形 Guardian 记忆引擎**是核心价值：

- 实现方式：OC 插件 API 的三个 hook（`system.transform` 注入 system prompt、`chat.message` 同轮注入、`event` 事件监听）+ 三层存储（`blocks/` 知识块 + `triggers/` 触发规则 + `events.log` 原始日志）+ BM25/向量检索。
- 关键教训（已沉淀于 oc-plus 机制说明 §八）：曾用 `system.transform` 每轮注入 ~300+ 字符规则文本做「行为前门」，导致 system prompt 膨胀、token 命中率暴跌——「动 system prompt → 缓存命中失效」的实证，已废弃并替换为独立 flash 分类器。
- 结论：记忆机制长在引擎的提示词/上下文/事件 hook 上，**不是可整体带走的资产**；切 DSH 需按 DSH 原则（event-sourced 会话日志 + system-prompt 稳定 section + append-only 历史）重做记忆，而非迁移。

## 三、决策

1. **维持 OpenCode 为 fractal 唯一引擎核**，fractal 继续交付、继续给朋友用。
2. **DeepSeek Harness 列为观察项 / 候选第二引擎**，不切换、不投入产品改造。
3. **抽出 EngineAdapter 边界**：把 `oc-sdk.ts` + `server-manager.ts` 归纳为一个引擎适配接口，OC 为第一个实现；未来 DSH 提供交互式接口后再加 `dsh-adapter` 实现，壳层不动。
4. **oc-plus 分层看待，不夸大可迁移性**：skills/agents/MCP 预置内容与镜像契约（`agents-manifest.json` + CHANGELOG + 版本对齐）引擎无关，可带走；但**分形 Guardian 记忆引擎**（system.transform/chat.message/event hook + blocks/triggers/events.log + 检索）与 OC 插件 API 深度耦合，切 DSH 需按 DSH 原则重做，属「重写」而非「迁移」。

## 四、触发重评估的条件（任一满足即回到本决策）

- [ ] DSH 提供交互式对外接口（流式 + 审批交互 + 会话管理），而非仅 automation ACP/SDK
- [ ] DSH 发布首个 tagged release、公开 API 稳定
- [ ] OC 出现不可接受的阻塞问题（许可证 / 维护停滞 / 关键能力缺失）

## 五、关联文档

- `docs/实测记录.md`（OC ACP 阶段 0 实测，结论绑定 1.18.x）
- `docs/设计/分形-设计方案.md`（整体方案）
- `docs/变更记录.md`
- `docs/设计/DSH记忆插件-前置设计.md`（记忆引擎迁移的前置研究 + 实测结论）

## 六、补充：DSH 记忆适配实测探路结论（2026-08-14）

对 2.4「记忆引擎属重写」做了前置实测（两个临时 spike 跑通后已删，详细结论见 `docs/设计/DSH记忆插件-前置设计.md`）：

| 记忆能力 | DSH 落点 | 实测 |
|---|---|---|
| 稳定记忆注入 | `systemPrompt.section()` | ✅ 两次组装前缀稳定 |
| 动态触发 | `systemPrompt.context()` | ✅ 未命中零成本，命中贡献文本 |
| 自主学习事件源 | `session/event` | ✅ 收到 append 事件 |
| 跨会话记忆库 | `ctx.storage.domain`（json/sqlite KV） | ✅ 持久化 + 重开读回 |
| 检索 | BM25 移植 / 向量待外部嵌入 | 🔁 BM25 无依赖 / ⚠️ DSH 无 embedding seam |

**结论升级**：oc-plus 记忆引擎切 DSH 不是「未知能否」，而是「重写路径已全部实测验证，无未知空白」。剩余硬约束仅两项：①DSH pre-release（地基未稳）；②向量检索需外部嵌入源（可先用 BM25 顶上）。

**对本决策的影响**：维持 OpenCode 不变；但「重评估条件」一旦满足，记忆部分已有完整可执行地图，无需重新探路。
