# stage0 — OC serve 全链路实测（方案附录 B serve 轨）

对应设计方案「阶段 0：双轨协议实测（serve 为主）」。用真实 `opencode serve` 进程跑通全链路，产出 JSON 证据（fixtures/），结论回填方案附录 C 清单、`docs/设计/待定问题清单.md`（P4-P8）与 `docs/知识/oc-engine/`。

## 运行

前置：Node ≥ 22；`opencode` 在 PATH（本机已验证 1.18.5）。

```bash
npm install
node probe-serve.mjs --api-key sk-xxx   # 完整跑（协议 + 模型轮 + 工具轮 + abort）
node probe-serve.mjs --skip-model        # 仅协议层（无 key 时：启动/元数据/建会话/事件订阅/fork/标题）
node probe-serve.mjs --auto              # 附加验证 serve 是否支持 --auto（P4）
```

> 为什么必须 `--api-key`：D17 配置完全隔离下 serve 使用独立配置目录（`OPENCODE_APPNAME=oc-gui`），没有系统 OC 的 auth 凭据——这本身即是隔离生效的证据。注入的 key 同时放入 `DEEPSEEK_API_KEY` 与 `OPENAI_API_KEY`（provider 实际读取哪个由 `/provider` 结果确认）。

## 实测点映射

| 探针 | 验证内容 | 对应清单项 | 结论去向 |
|------|----------|-----------|----------|
| S0 | serve 启动 / 健康检查（/doc） | 附录 B 步骤 1-3 | 附录 C C-1 |
| S1 | OpenAPI spec 拉取 | 附录 B 步骤 3 | oc-engine |
| S2 | /app 版本 + appName 隔离 | D17 配置隔离 | 附录 C |
| S3 | /provider、/model 端点 + SDK 方法覆盖 | D16 模型固定 | oc-engine |
| S4 | SDK 建会话 | 附录 B 步骤 a | — |
| S5 | chat（POST /session/:id/message）+ SSE 事件流 + part 序列 | **P7**（回答时间线） | 附录 C C-4/C-5 |
| S6 | 工具调用 → permission.updated → 审批响应 | **P5**（question 通道）、**P6**（附件 parts）、C-2 | 附录 C C-2 |
| S7 | abort 中断 | 附录 B 步骤 e | 附录 C |
| S8 | fork 分叉 | 附录 B 步骤 g | 附录 C |
| S9 | PATCH /session/:id 标题 | 附录 B 步骤 b | — |

人工观察项（脚本不覆盖）：**P8** 会话级切换「配置变更」虚拟消息机制——GUI 侧行为，阶段 1 实现时验证；**P4** `--auto` 若脚本通过 `--auto` 启动验证。

## 产物

| 文件 | 内容 |
|------|------|
| fixtures/api-spec.json | serve OpenAPI 3.1 spec（SDK 封装依据） |
| fixtures/app.json | /app 响应（版本 + 隔离 appName） |
| fixtures/providers.json / models.json | provider / 模型清单（deepseek 模型 ID 确认） |
| fixtures/events-round1.json | 首轮消息完整 SSE 事件序列（part 类型序列 = P7 阶段识别依据） |
| fixtures/events-round2.json | 工具调用轮事件（含 permission 事件或默认放行证据） |
| fixtures/events-round3.json | abort 前后事件序列 |
| fixtures/messages-round*.json | session.messages() 完整结构（消息/part 层次） |
| fixtures/permission-event.json | permission.updated 原始结构（审批弹窗适配） |
| fixtures/summary.json | 汇总：事件类型计数 + 逐项结论表 |

## 回填清单（跑完对照）

1. 方案附录 C：C-1 起逐项填「已实测」+ 实测值；删除/降级未通过的
2. 待定问题清单：P4-P7 从「待实测」改 ✅（附证据文件引用）；P8 保持人工观察
3. oc-engine 数据格式文档：补 serve 事件类型表 / part 结构 / 端点表（带版本锚点 v1.18.5）
