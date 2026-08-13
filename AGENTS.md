# 分形（Fractal / oc-gui）

面向非编程人员的 OpenCode 桌面 GUI，开箱即用，OC 为唯一引擎。

## 项目核心事实（硬约束）

- **产品**：分形；**项目代号**：oc-gui；**工作区**：本目录（H:\MaxNull\WorkStation\fractal）
- **引擎**：OpenCode（OC）唯一，通过内置 OC sidecar（`opencode serve` + `@opencode-ai/sdk`，SSE 事件流）集成，**不包含任何 CC（Claude Code）代码**
- **模型**：仅 DeepSeek（OC 内置 provider），**API Key 是唯一必填配置项**
- **UI**：整体迁移 cc-gui（H:\MaxNull\WorkStation\cc-gui）的设计资产——布局/会话管理/文件管理/会话区域/工具栏；**前后端事件契约 StreamFrontendEvent 不变**（前端组件零改造的关键）
- **配置体系**：类 VSCode settings.json + JSON Schema；agent 可自检自改配置（小白可直接让 agent 帮忙设置）
- **交付**：独立可安装工具，内置 OC sidecar（Electron extraResources），不依赖系统已装 OC
- **预置**：内置 MCP/skill/插件预置包，首次启动自动初始化，用户零概念门槛
- **预置来源**：`electron/resources/preset/` 是 oc-plus 全家桶的**镜像**（oc-plus 做核、分形做壳）。**禁止直接编辑 preset 文件**——由 oc-plus 仓库的 `node sync-to-fractal.mjs` 同步（含 agents-manifest.json 契约 + CHANGELOG + OC 版本对齐检查）；手动改会被下次同步覆盖

## 会话接续入口

**开始任何工作前，先读：`docs/设计/分形-设计方案.md`**（完整方案 v1.8+，含关键设计决策、迁移清单、实施计划、附录 A 关键技术结论、附录 B 实测指南、附录 C 待实测清单、附录 D 产品场景）。

**动手编码/迁移设计资产前，再读：`docs/知识/开发规范.md`**（整合自 cc-gui 开发规范：编码总则 / CSS 语义化命名 / 颜色系统 / 41 条设计决策参考（含继承/重写/删除标注）/ Git 提交规范；CC 专属条目已剔除）。

**做架构/产品决策或改造现有设计前，先查 `docs/决策/` 并落盘新决策**（一篇一决策、按日期归档；决策记录备查优先于动手写代码）。

**涉及 OC 机制（协议/插件 API/配置 schema）时，先查：`docs/知识/oc-engine/`**（OC 版本化知识库：版本矩阵 / 升级检查清单 / 插件 API / ACP 协议 / 配置 schema / 数据格式；OC 更新快，结论必须带版本锚点）。

> 产品无独立原型文档——UI 设计资产整体迁移自 cc-gui（H:\MaxNull\WorkStation\cc-gui），界面细节以 cc-gui 实现为准。

## 工作纪律

- 实施按设计方案「十、实施计划」的阶段顺序执行，**阶段 0（实测 opencode acp 真实报文）优先**，实测结论回填附录 C 清单
- 设计资产从 cc-gui 拷贝时对照「2.3 设计资产复用策略」：直接拷贝 / 契约适配 / 重写 / 删除四类，CC 专属内容一律不迁移
- 改动方案文档前先说明原因等确认；阶段完成标记不在此列
- 提交信息格式：`<type>: <中文简短描述>`
- 图标规范：按钮/功能图标一律用 `lucide-vue-next`（lucide 组件），禁止 emoji/Unicode 符号充当图标（详见 `docs/知识/开发规范.md` 四、图标规范）

## 计划文档规则（2026-08-12 更新：写入约定迁移到当前工作区）

复杂任务动手前，先输出计划给用户确认，确认后将计划写入：
- 临时计划（进行中的工作计划）→ 当前工作区 `.opencode/plans/{日期}-{时间}-{关键词}.md`（路径固定，供分形 GUI 面板读取。分钟级时间戳保证不重名）
- 正式计划（用户明确「保存计划」/「输出计划」）→ 当前工作区 `docs/计划/`

即使用户要求「输出到工作区」，也先在 `.opencode/plans/` 写一份再复制到用户指定位置，确保分形 GUI 始终能定位计划文件。

修改 `.opencode/plans/` 目录下的计划文件前，必须先向用户说明原因并等待确认。唯一例外：阶段完成后标记「状态：已完成」无需确认。
