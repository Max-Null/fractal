// preview-fingerprint 测试：预览刷新指纹对比决策（skip / update-stat / refresh）
import { describe, it, expect } from "vitest";
import { decidePreviewRefresh, sameStat, type FileFingerprint } from "./preview-fingerprint";

function fp(partial: Partial<FileFingerprint> & { path: string }): FileFingerprint {
  return { size: 10, mtimeMs: 1000, md5: "abc", ...partial };
}

describe("sameStat（stat 维度对比：快路径不读盘判断）", () => {
  it("size 与 mtimeMs 均一致 → true", () => {
    expect(sameStat({ size: 10, mtimeMs: 1000 }, { size: 10, mtimeMs: 1000 })).toBe(true);
  });

  it("size 不同 → false", () => {
    expect(sameStat({ size: 10, mtimeMs: 1000 }, { size: 11, mtimeMs: 1000 })).toBe(false);
  });

  it("mtimeMs 不同 → false（touch 只改时间戳）", () => {
    expect(sameStat({ size: 10, mtimeMs: 1000 }, { size: 10, mtimeMs: 2000 })).toBe(false);
  });
});

describe("decidePreviewRefresh（预览刷新指纹对比决策）", () => {
  it("无缓存（首次加载）→ refresh（建立基准）", () => {
    expect(decidePreviewRefresh(null, fp({ path: "/a.txt" }))).toBe("refresh");
  });

  it("路径变化（切换文件）→ refresh", () => {
    const prev = fp({ path: "/a.txt" });
    expect(decidePreviewRefresh(prev, fp({ path: "/b.txt" }))).toBe("refresh");
  });

  it("stat 与 md5 均一致 → skip（内容未变，不刷新）", () => {
    const prev = fp({ path: "/a.txt" });
    expect(decidePreviewRefresh(prev, fp({ path: "/a.txt" }))).toBe("skip");
  });

  it("仅 stat 变、md5 一致（touch 等只改时间戳）→ update-stat（更新缓存不刷新）", () => {
    const prev = fp({ path: "/a.txt", size: 10, mtimeMs: 1000, md5: "abc" });
    const now = fp({ path: "/a.txt", size: 10, mtimeMs: 2000, md5: "abc" });
    expect(decidePreviewRefresh(prev, now)).toBe("update-stat");
  });

  it("md5 变化（内容真变）→ refresh", () => {
    const prev = fp({ path: "/a.txt", md5: "abc" });
    const now = fp({ path: "/a.txt", md5: "def" });
    expect(decidePreviewRefresh(prev, now)).toBe("refresh");
  });

  it("stat 与 md5 均变化 → refresh", () => {
    const prev = fp({ path: "/a.txt", size: 10, mtimeMs: 1000, md5: "abc" });
    const now = fp({ path: "/a.txt", size: 20, mtimeMs: 2000, md5: "def" });
    expect(decidePreviewRefresh(prev, now)).toBe("refresh");
  });

  it("md5 均为 null（主进程契约下不可达的防御分支）：stat 相同 → skip", () => {
    const prev = fp({ path: "/a.txt", size: 10, mtimeMs: 1000, md5: null });
    const now = fp({ path: "/a.txt", size: 10, mtimeMs: 1000, md5: null });
    expect(decidePreviewRefresh(prev, now)).toBe("skip");
  });

  it("md5 均为 null 且 stat 变化 → update-stat（无内容哈希时 stat 为唯一裁决）", () => {
    const prev = fp({ path: "/a.txt", size: 10, mtimeMs: 1000, md5: null });
    const now = fp({ path: "/a.txt", size: 20, mtimeMs: 2000, md5: null });
    expect(decidePreviewRefresh(prev, now)).toBe("update-stat");
  });
});
