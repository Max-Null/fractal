// 预置包管理：内置 MCP/skill/插件预置包，首次启动自动初始化
// 阶段 4 实现：首次启动把预置包复制到 XDG_CONFIG_HOME，用户零概念门槛

/**
 * 首次启动时初始化预置包。
 * 阶段 4 实现：检测标记文件判断是否已初始化，复制内置预置包到配置目录。
 */
export async function initializePresets(): Promise<void> {
  throw new Error('initializePresets 未实现：阶段 4')
}
