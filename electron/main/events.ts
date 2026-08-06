// OC 会话事件处理：消费 serve 输出的 StreamFrontendEvent，转发给 renderer
// 契约见 stage0 实测 events-*.json（阶段 4 实现）

/**
 * 处理单条会话事件。
 * 职责：解析 stream event 并推送给 renderer（经 webContents.send），
 * 保证前端组件零改造——事件契约 StreamFrontendEvent 不变。
 * 阶段 4 实现。
 */
export function handleSessionEvent(_event: unknown): void {
  throw new Error('handleSessionEvent 未实现：阶段 4')
}

/**
 * 从 serve stdout 解析事件流。
 * 阶段 4 实现：处理多行 JSON、会话 id 与 user message 关联。
 */
export function parseEventStream(_chunk: string): unknown[] {
  throw new Error('parseEventStream 未实现：阶段 4')
}
