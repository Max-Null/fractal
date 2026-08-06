// 数据持久化：会话历史、消息记录等本地存储
// 阶段 4 实现：SQLite（better-sqlite3）或 JSON 文件存储

/**
 * 初始化本地数据库。
 * 阶段 4 实现：创建会话/消息表结构。
 */
export async function initDatabase(): Promise<void> {
  throw new Error('initDatabase 未实现：阶段 4')
}

/**
 * 查询会话列表。
 * 阶段 4 实现。
 */
export async function listSessions(): Promise<unknown[]> {
  throw new Error('listSessions 未实现：阶段 4')
}
