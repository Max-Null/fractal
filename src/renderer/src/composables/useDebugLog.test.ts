import { describe, it, expect, beforeEach } from "vitest";
import { useDebugLog } from "./useDebugLog";

describe("useDebugLog", () => {
  // 模块级状态在测试间共享，每次重置到无会话状态
  let log: ReturnType<typeof useDebugLog>;
  beforeEach(() => {
    log = useDebugLog();
    log.setSession(""); // 清空 currentSessionId，确保测试隔离
    log.clear();
  });

  it("starts with empty lines and hidden", () => {
    expect(log.lines.value).toEqual([]);
    expect(log.visible.value).toBe(false);
  });

  it("adds lines for current session after setSession", () => {
    log.setSession("session-1");
    log.add("line 1");
    log.add("line 2");
    expect(log.lines.value).toEqual(["line 1", "line 2"]);
  });

  it("ignores add() when no session is set", () => {
    // beforeEach 已重置为无会话
    log.add("orphan");
    expect(log.lines.value).toEqual([]);
  });

  it("caps at 200 lines per session", () => {
    log.setSession("s1");
    for (let i = 0; i < 250; i++) {
      log.add(`line ${i}`);
    }
    expect(log.lines.value).toHaveLength(200);
    expect(log.lines.value[0]).toBe("line 50");
    expect(log.lines.value[199]).toBe("line 249");
  });

  it("toggle switches visibility", () => {
    expect(log.visible.value).toBe(false);
    log.toggle();
    expect(log.visible.value).toBe(true);
    log.toggle();
    expect(log.visible.value).toBe(false);
  });

  it("clear empties current session lines", () => {
    log.setSession("s1");
    log.add("a");
    log.add("b");
    log.clear();
    expect(log.lines.value).toEqual([]);
  });

  it("setSession restores saved lines when switching back", () => {
    log.setSession("session-a");
    log.add("from a");

    log.setSession("session-b");
    log.add("from b");

    log.setSession("session-a");
    expect(log.lines.value).toEqual(["from a"]);

    log.setSession("session-b");
    expect(log.lines.value).toEqual(["from b"]);
  });

  it("different instances share underlying storage via version counter", () => {
    const logA = useDebugLog();
    const logB = useDebugLog();

    logA.setSession("shared");
    logA.add("via A");
    // 版本号递增，logB 的 computed 自动重新求值
    expect(logB.lines.value).toEqual(["via A"]);

    logB.add("via B");
    expect(logA.lines.value).toEqual(["via A", "via B"]);
  });

  it("exportLines returns a copy of stored lines", () => {
    const log = useDebugLog();
    log.setSession("exp");
    log.add("a");
    log.add("b");
    const exported = log.exportLines("exp");
    expect(exported).toEqual(["a", "b"]);
    // 不修改原始存储
    exported.push("c");
    expect(log.lines.value).toEqual(["a", "b"]);
  });

  it("importLines restores lines into store", () => {
    const log = useDebugLog();
    log.setSession("restore");
    log.importLines("restore", ["x", "y", "z"]);
    expect(log.lines.value).toEqual(["x", "y", "z"]);
  });

  it("importLines caps at 200 lines", () => {
    const log = useDebugLog();
    const big = Array.from({ length: 250 }, (_, i) => `line ${i}`);
    log.setSession("big");
    log.importLines("big", big);
    expect(log.lines.value).toHaveLength(200);
    expect(log.lines.value[0]).toBe("line 50");
  });
});
