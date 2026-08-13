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

## 三、决策

1. **维持 OpenCode 为 fractal 唯一引擎核**，fractal 继续交付、继续给朋友用。
2. **DeepSeek Harness 列为观察项 / 候选第二引擎**，不切换、不投入产品改造。
3. **抽出 EngineAdapter 边界**：把 `oc-sdk.ts` + `server-manager.ts` 归纳为一个引擎适配接口，OC 为第一个实现；未来 DSH 提供交互式接口后再加 `dsh-adapter` 实现，壳层不动。
4. **oc-plus 资产保留**：预置包的镜像契约（`agents-manifest.json` + CHANGELOG + 版本对齐）、skills/agents/MCP 预置内容引擎无关，可整体带走；仅 OC 插件 API 部分绑定 OC。

## 四、触发重评估的条件（任一满足即回到本决策）

- [ ] DSH 提供交互式对外接口（流式 + 审批交互 + 会话管理），而非仅 automation ACP/SDK
- [ ] DSH 发布首个 tagged release、公开 API 稳定
- [ ] OC 出现不可接受的阻塞问题（许可证 / 维护停滞 / 关键能力缺失）

## 五、关联文档

- `docs/实测记录.md`（OC ACP 阶段 0 实测，结论绑定 1.18.x）
- `docs/设计/分形-设计方案.md`（整体方案）
- `docs/变更记录.md`
