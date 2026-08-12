<!-- type: knowledge --><!-- status: auto --><!-- description: serve 补充消息排队语义——回答中发消息立即入库，runLoop 下一步带着继续，前端无需延迟 -->

# 分形-serve补充消息排队语义（promptAsync 中间插入）

- 事实：v1.18.16 源码实证（effect/runner.ts + session/prompt.ts + run-state.ts）：`ensureRunning` 对 Running 状态返回 `[awaitDone(run.done), st]`（排队）；`promptAsync` 走 `loop()` → `state.ensureRunning`（**不抛 BusyError**）；只有 `startShell`（terminal/pty）忙时才 `Effect.fail(new Busy())`
- 原则：会话回答中发新消息是**合法输入**——消息立即 createUserMessage 入库，`runLoop while(true)` 每步重取消息，补充消息写入后 `lastAssistant.parentID !== lastUser.id` 退出条件不满足，下一步带着补充消息继续（「4 节点补充影响 5678」是 serve 原生行为）
- 反例：❌ 曾做「延迟上屏+待处理条」（当前轮结束才发）——用户实测「完整输出一轮之后才发送，没有中间补充效果」，失去打断纠正的价值；且延迟会等 loop 退出，补充消息变全新一轮
- ✅ 实现：回答中发送立即上屏+立即发送，**先 stopSession 打断当前回合**（Claude Code/Cursor 行为）再 sendMessage；`isMidProcessing` 时不 startAssistantMessage（避免把流式中文本"偷"到新占位，文字节点断两半——用户实测回归）
- 结论：补充消息的正确语义 = 打断 + 立即发送；前端不要延迟入队，也不要提前切 assistant 占位

