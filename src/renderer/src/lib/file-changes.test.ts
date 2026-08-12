// file-changes.test.ts：提取与合并纯函数（write/edit 提取、去重合并、缺失跳过）
import { describe, it, expect } from "vitest";
import { extractFileChanges, mergeFileChanges } from "./file-changes";
import type { ToolUse } from "@/stores/chat";

function tu(name: string, input: Record<string, unknown>): ToolUse {
  return { id: Math.random().toString(36).slice(2), name, input };
}

describe("extractFileChanges", () => {
  it("提取 write/edit 并合并同文件多次 edit（old/new 按序拼接）", () => {
    const result = extractFileChanges([
      tu("edit", { file_path: "a.txt", old_string: "1", new_string: "2" }),
      tu("write", { file_path: "b.txt", content: "hello" }),
      tu("edit", { file_path: "a.txt", old_string: "3", new_string: "4" }),
    ]);
    expect(result).toEqual([
      { filePath: "a.txt", toolName: "edit", oldString: "1\n3", newString: "2\n4", status: "modified" },
      { filePath: "b.txt", toolName: "write", newString: "hello", status: "modified" },
    ]);
  });

  it("跳过 file_path 缺失与无关工具", () => {
    const result = extractFileChanges([
      tu("bash", { command: "ls" }),
      tu("edit", { old_string: "x" }),
      tu("todowrite", { todos: [] }),
    ]);
    expect(result).toEqual([]);
  });
});

describe("mergeFileChanges", () => {
  it("合并同文件条目，保留首次出现顺序", () => {
    const result = mergeFileChanges([
      { filePath: "b.txt", toolName: "write", newString: "b", status: "modified" },
      { filePath: "a.txt", toolName: "edit", oldString: "1", newString: "2", status: "modified" },
      { filePath: "b.txt", toolName: "edit", oldString: "y", newString: "z", status: "modified" },
    ]);
    expect(result.map((c) => c.filePath)).toEqual(["b.txt", "a.txt"]);
  });
});
