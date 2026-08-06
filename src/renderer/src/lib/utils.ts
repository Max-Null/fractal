/** Shared utilities — one source of truth */

/** Format a number with k/M suffixes */
export function formatNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
}

/** Format token count with suffix */
export function formatTokenCount(n: number): string {
  return formatNum(n) + " tok";
}

/**
 * Map a Rust/CLI error string to an i18n key and params.
 * Pattern-match common errors; unrecognized ones get the raw string as `error` param.
 */
export function translateError(err: unknown): { key: string; params?: Record<string, string> } {
  const s = String(err ?? "");
  const lower = s.toLowerCase();

  // Claude CLI not found — 保留 Rust 返回的原始错误（含尝试的路径），方便用户排查
  if (lower.includes("is claude code cli installed") || lower.includes("program not found")) {
    return { key: "error.claudeNotFound", params: { detail: s } };
  }

  // File/dir read errors
  if (lower.includes("failed to read") || lower.includes("failed to read dir")) {
    return { key: "error.fileReadError", params: { error: s } };
  }

  // File write errors
  if (lower.includes("failed to write") || lower.includes("permission denied")) {
    return { key: "error.fileWriteError", params: { error: s } };
  }

  // Spawn / process errors
  if (lower.includes("failed to spawn") || lower.includes("failed to capture") || lower.includes("stdin write error")) {
    return { key: "error.spawnFailed", params: { error: s } };
  }

  // HTTP / network errors
  if (lower.includes("http error") || lower.includes("connection") || lower.includes("timeout") || lower.includes("network")) {
    return { key: "error.httpError", params: { error: s } };
  }

  // API 余额不足（402 Insufficient Balance）
  if (lower.includes("402") || lower.includes("insufficient") || lower.includes("balance")) {
    return { key: "error.insufficientBalance", params: { error: s } };
  }

  // Session errors
  if (lower.includes("session") && lower.includes("not found")) {
    return { key: "error.sessionNotFound", params: { error: s } };
  }

  // Generic
  return { key: "error.generic", params: { error: s } };
}
