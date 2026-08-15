# 繁忙时 Enter 行为设置-设计方案

> 版本：v1.0
> 日期：2026-08-16
> 状态：已确认待实施
> 关联：OC changelog「繁忙时 Enter 键行为仅在智能体运行时生效；Cmd/Ctrl+Enter 使用另一行为」——排队发送、插入发送

## 一、问题背景

当前「繁忙时发送新消息」行为是**硬编码插入发送**：AI 回答中用户按 Enter 发送 → `sendUserMessage` 内 `stopSession(sid)` 打断当前回答 → 新消息立即执行（ChatPanel.vue:876-877）。

用户此前在「插入发送 vs 排队发送」之间纠结过，最终定案插入发送。但两类场景都有诉求：

- **插入发送**：打断当前回答立即执行新指令（适合纠偏、抢时间）
- **排队发送**：不打断，当前回答自然结束后再执行（适合补充信息、不破坏长任务）

两种行为无法用单一硬编码满足，应做成设置项，用户按场景切换。

## 二、需求确认（用户已选定）

1. 新增设置项「繁忙时 Enter 行为」：`插入发送`（默认，当前行为）/ `排队发送`
2. **行为矩阵**（参考 OC changelog 设计）：

| 场景 | Enter | Ctrl/Cmd+Enter |
|------|-------|----------------|
| 繁忙时（AI 回答中） | 走设置项行为 | **固定走另一行为**（设置=插入则 Ctrl+Enter=排队，反之亦然） |
| 空闲时 | 普通发送（两行为等价） | 普通发送（两行为等价） |

> 用户最初误选「Ctrl+Enter 保持换行」，后更正为「Ctrl+Enter 固定另一行为」（2026-08-16 对话 m01826）。

## 三、现状链路

```
InputBar.vue:176 Enter && !shiftKey → send() → emit("send", text)
  → ChatPanel.handleSend → isMidProcessing = chat.isProcessing
  → sendUserMessage(fullText, attachments, { isMidProcessing })
    → if (isMidProcessing) stopSession(sid)  // 硬编码打断 = 插入发送
    → chat.addUserMessage → IPC 发送（serve 端支持排队，前端无需延迟）
```

## 四、关键设计决策

| # | 决策 | 理由 |
|---|------|------|
| D1 | 设置项 `busyEnterBehavior: "insert" \| "queue"` 存 `UiSettings`（localStorage + SQLite + settings.json 三写） | 与既有 UI 偏好（messageLayout/notifications 等）同一体系，复用三写机制，无新存储 |
| D2 | 默认 `"insert"` | 保持当前行为，存量用户无感知迁移 |
| D3 | 打断判定收拢到 `sendUserMessage`：`isMidProcessing && shouldInterrupt` | 唯一打断点（877 行），修饰键信息经 opts 传入，不改 IPC/主进程 |
| D4 | Ctrl/Cmd+Enter 固定另一行为：`shouldInterrupt = (setting==='insert') XOR (ctrlOrMeta)` | 实现 OC changelog 的「Cmd/Ctrl+Enter 使用另一行为」；空闲时两行为等价（无打断差异） |
| D5 | InputBar 发送时带修饰键标记（emit payload 扩展或独立 emit），不改 send 签名破坏既有调用 | 兼容现有 `send` emit 的测试与调用方（sendSlash/润色等） |

## 五、改动清单（4 文件 + schema + locale）

### 1. `src/renderer/src/stores/settings.ts`
- `UiSettings` 新增：`busyEnterBehavior: "insert" | "queue"`
- `getUiDefaults()` 默认 `"insert"`
- 三写持久化（applySettingsJson / saveSettings 同步）——参照 `messageLayout` 现有模式

### 2. `electron/main/settings.schema.json`
- 新增枚举：`busyEnterBehavior: { enum: ["insert", "queue"], description: "繁忙时 Enter 行为" }`

### 3. `src/renderer/src/components/settings/SettingsPanel.vue`
- 消息/发送区域新增下拉：「繁忙时按 Enter 发送」→ 插入发送 / 排队发送

### 4. `src/renderer/src/components/chat/InputBar.vue`
- 键盘：现有 `Enter && !e.shiftKey` → 发送（不变）
- 新增：`(e.ctrlKey || e.metaKey) && e.key === "Enter"` → 发送且带 `altBehavior: true` 标记
- `emit("send", text, altBehavior?)`（可选第三参，向后兼容）

### 5. `src/renderer/src/components/chat/ChatPanel.vue`
- `handleSend(text, altBehavior?)` → 透传
- `sendUserMessage` 打断判定：
```ts
// 繁忙时打断判定：设置=insert 且非 Ctrl（普通 Enter）→ 打断；设置=insert 且 Ctrl → 排队；
// 设置=queue 且非 Ctrl → 排队；设置=queue 且 Ctrl → 打断（Ctrl 恒为另一行为）
const shouldInterrupt = isMidProcessing && (
  (settings.busyEnterBehavior === "insert") !== Boolean(altBehavior)
)
if (shouldInterrupt) { try { await stopSession(sid); } catch { /* 打断失败不阻断 */ } }
```

### 6. `src/renderer/src/locales/*.json`
- 设置项标签/描述中英文

## 六、测试要点

| 层 | 用例 |
|----|------|
| settings store | 默认值 "insert"；三写持久化往返 |
| InputBar | Enter 发送不带 altBehavior；Ctrl+Enter 发送带 altBehavior；Shift+Enter 换行不变 |
| ChatPanel | 4 组合：insert+Enter 打断 / insert+Ctrl 不打断 / queue+Enter 不打断 / queue+Ctrl 打断 |
| SettingsPanel | 选项渲染 + 切换保存 |

## 七、边界与风险

- 非繁忙时 Ctrl+Enter 也发送（无打断差异，走普通路径）——行为矩阵已明确
- 排队发送依赖 serve 端排队能力（已确认：`sendUserMessage` 注释「serve 端排队，前端无需延迟」，无新增依赖）
- 打断失败静默（现有 catch 保留）——serve 兜底排队
- `send` emit 第三参向后兼容：现有调用方（sendSlash 等）不传 altBehavior，默认 undefined → 非 Ctrl 语义
- 无回滚风险：纯前端设置 + 打断判定改动，不动 IPC/主进程/OC 引擎

## 八、验收标准

1. 设置页出现「繁忙时按 Enter 发送」选项，默认插入发送
2. 繁忙时按 Enter → 打断当前回答立即执行（现状回归）
3. 繁忙时按 Ctrl+Enter → 不打断，排队执行
4. 设置切到排队发送：繁忙时按 Enter → 不打断排队；按 Ctrl+Enter → 打断
5. 空闲时 Enter / Ctrl+Enter 均正常发送
6. 重启后设置保持（三写持久化）
7. 相关测试全绿
