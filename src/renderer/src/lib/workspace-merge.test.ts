// workspace-merge 纯函数测试：本地 recent + serve 会话目录聚合的合并去重语义
import { describe, it, expect } from "vitest";
import { mergeWorkspaces } from "./workspace-merge";

describe("mergeWorkspaces（本地 recent 优先 + serve 补充去重）", () => {
  it("local 为空 → 只返回 serve 目录（按出现序）", () => {
    expect(mergeWorkspaces([], ["A", "B", "C"])).toEqual(["A", "B", "C"]);
  });

  it("serve 为空 → 只返回 local 原序", () => {
    expect(mergeWorkspaces(["A", "B"], [])).toEqual(["A", "B"]);
  });

  it("都为空 → 空数组", () => {
    expect(mergeWorkspaces([], [])).toEqual([]);
  });

  it("serve 含 local 重复项 → 去重且 local 优先（serve 重复项不追加）", () => {
    expect(mergeWorkspaces(["A", "B"], ["B", "C", "A"])).toEqual(["A", "B", "C"]);
  });

  it("local 自身有重复 → 去重保序（首次出现位置为准）", () => {
    expect(mergeWorkspaces(["A", "B", "A"], ["C"])).toEqual(["A", "B", "C"]);
  });

  it("serve 自身有重复 → 去重（首次出现位置为准）", () => {
    expect(mergeWorkspaces(["A"], ["B", "C", "B", "C"])).toEqual(["A", "B", "C"]);
  });

  it("空串被过滤（local 脏数据 / serve 未绑定工作区）", () => {
    expect(mergeWorkspaces(["", "A", ""], ["", "B", ""])).toEqual(["A", "B"]);
  });
});
