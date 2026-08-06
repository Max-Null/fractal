// serve 进程管理：spawn `opencode serve` 并隔离 XDG_CONFIG_HOME，阶段 4 实现
import type { ChildProcess } from 'child_process'

/**
 * 启动 OC serve 子进程。
 * 职责：spawn `opencode serve`（ACP 双工协议），设置 XDG_CONFIG_HOME 隔离
 * 用户配置与预置包，监听 stdout/stderr 转发事件。
 * 阶段 4 实现。
 */
export async function startServer(): Promise<ChildProcess> {
  throw new Error('startServer 未实现：阶段 4')
}

/**
 * 停止 OC serve 子进程并清理资源。
 * 阶段 4 实现。
 */
export async function stopServer(): Promise<void> {
  throw new Error('stopServer 未实现：阶段 4')
}
