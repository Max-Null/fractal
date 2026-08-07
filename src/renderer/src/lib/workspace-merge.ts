// workspace-merge.ts：工作区菜单聚合纯函数
// 数据源：本地 recentWorkspaces（localStorage/SQLite 持久化）+ serve 会话目录聚合（listSessions 全量提取 cwd）
// 场景：userData 迁移/清缓存后本地历史丢失，serve 会话仍带 directory（前端契约字段 cwd），可恢复工作区列表

/**
 * 合并本地 recent 与 serve 会话目录，返回去重保序的工作区列表。
 * 顺序：local 原序 → serve 中不在 local 的按出现序（local 优先，serve 补充）。
 * 空串防御性过滤：local 侧来自 localStorage 可能脏，serve 侧提取时也可能混入空值。
 */
export function mergeWorkspaces(local: string[], serve: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const p of local) {
    if (p && !seen.has(p)) {
      seen.add(p);
      result.push(p);
    }
  }
  for (const p of serve) {
    if (p && !seen.has(p)) {
      seen.add(p);
      result.push(p);
    }
  }
  return result;
}
