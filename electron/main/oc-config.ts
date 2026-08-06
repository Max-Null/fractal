// OC 配置读写：对齐 opencode 的配置文件结构（类 VSCode settings.json）
// 阶段 4 实现：读取/写入用户配置，支撑 agent 自检自改配置

/**
 * 读取当前生效的 OC 配置。
 * 阶段 4 实现：定位 XDG_CONFIG_HOME 下 opencode 配置并解析 JSON。
 */
export function loadOcConfig(): Record<string, unknown> {
  throw new Error('loadOcConfig 未实现：阶段 4')
}

/**
 * 写入 OC 配置（合并式更新，保留注释与未知字段）。
 * 阶段 4 实现。
 */
export function saveOcConfig(_patch: Record<string, unknown>): void {
  throw new Error('saveOcConfig 未实现：阶段 4')
}
