// provider 管理：拉取/缓存 /provider 响应，维护模型列表
// 阶段 4 实现：经 serve 拉取 providers 并缓存，供模型选择器使用

/**
 * 拉取并缓存 provider 列表。
 * 阶段 4 实现：调用 serve 的 /provider 接口，写入本地缓存。
 */
export async function fetchProviders(): Promise<unknown[]> {
  throw new Error('fetchProviders 未实现：阶段 4')
}
