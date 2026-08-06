// 应用设置：分形自身（GUI）的用户偏好，与 OC 配置解耦存储
// 阶段 4 实现：窗口状态、主题、默认模型等本地设置

/**
 * 读取应用设置。
 * 阶段 4 实现：从 userData 目录加载 settings.json。
 */
export function loadSettings(): Record<string, unknown> {
  throw new Error('loadSettings 未实现：阶段 4')
}

/**
 * 保存应用设置。
 * 阶段 4 实现。
 */
export function saveSettings(_settings: Record<string, unknown>): void {
  throw new Error('saveSettings 未实现：阶段 4')
}
