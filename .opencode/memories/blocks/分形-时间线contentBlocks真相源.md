<!-- type: knowledge --><!-- status: auto --><!-- description: 消息时间线顺序真相源=contentBlocks 单写入点（append 三函数维护）；assistant 事件 content_blocks 增量模式只含 tool_result，全量覆盖假设失效 -->

# 分形时间线 contentBlocks 真相源

**事实**：时间线化需要「真实输出顺序」节点数据——流式事件序（SSE）即真实输出序。

**原则**：contentBlocks 由 appendText/appendThinking/addToolUse 三函数**每次调用同步维护**（单写入点，startsWith 去重移植）；setContentBlocks 降级为仅空初始化。

**反例**：
❌ assistant 事件的 content_blocks 全量覆盖（serve 增量模式只含 tool_result 块——全量恒完整假设已失效，覆盖会冲掉 append 维护的顺序块）
❌ buildHistoryContentBlocks 三段式聚合（thinking→tool→text——非交错真实序）
✅ 历史按 parts 原序构建；流式按事件序 append

**结论**：流式用 append 维护、历史用 parts 原序、旧存档 synthesizeBlocks 兜底——三层同一真相源。
