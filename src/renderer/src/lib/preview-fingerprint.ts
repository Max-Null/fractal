// 预览刷新指纹对比决策（2026-08-15）
// 输入：缓存指纹 + 确认路径完整指纹（stat + md5）
// 输出："skip"（内容未变，不刷新）| "update-stat"（仅 stat 变、内容未变：更新缓存不刷新）| "refresh"（内容真变：刷新）
export interface FileFingerprint {
  path: string;
  size: number;
  mtimeMs: number;
  md5: string | null;
}

export type FingerprintDecision = "skip" | "update-stat" | "refresh";

/** stat 维度（size + mtimeMs）是否一致：快路径（不读盘）用；md5 为 null 时 stat 一致即视为未变 */
export function sameStat(a: Pick<FileFingerprint, "size" | "mtimeMs">, b: Pick<FileFingerprint, "size" | "mtimeMs">): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/**
 * 对比缓存指纹与磁盘完整指纹，决定预览面板是否刷新。
 * - 无缓存或路径变化：首次加载/切文件后基准未建立 → 刷新（保守，保证最终一致）
 * - md5 一致：内容未变 → stat 全同则 skip（组件快路径通常已挡掉，此处双保险）；仅 stat 变（touch 等）则 update-stat（更新缓存不刷新）
 * - md5 不一致：内容真变（无论 stat 是否变，md5 为最终裁决）→ refresh
 */
export function decidePreviewRefresh(
  prev: FileFingerprint | null,
  full: FileFingerprint
): FingerprintDecision {
  if (!prev || prev.path !== full.path) return "refresh";
  if (prev.md5 === full.md5) {
    return sameStat(prev, full) ? "skip" : "update-stat";
  }
  return "refresh";
}
