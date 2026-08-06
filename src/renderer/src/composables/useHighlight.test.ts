import { describe, it, expect } from "vitest";
import { highlightCode } from "./useHighlight";

describe("highlightCode", () => {
  it("highlights known language", () => {
    const result = highlightCode('const x = 1;', "javascript");
    // highlight.js wraps in <span> tags
    expect(result).toContain("hljs");
    expect(result).toContain("const");
  });

  it("falls back to auto-detect for unknown language", () => {
    // highlightAuto 对无代码结构的纯文本不会添加 hljs 标签
    const result = highlightCode("hello world", "madeup-lang");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("auto-detect highlights code-like content with unknown lang", () => {
    // 包含代码关键字时 highlightAuto 会识别
    const result = highlightCode("const x = 1;", "madeup-lang");
    expect(result).toContain("hljs");
  });

  it("handles empty string", () => {
    const result = highlightCode("", "javascript");
    expect(typeof result).toBe("string");
  });

  it("auto-detects language when lang is empty", () => {
    const result = highlightCode("const x = 1;", "");
    expect(result).toContain("hljs");
  });

  it("highlights Python", () => {
    const result = highlightCode("def foo():\n    pass", "python");
    expect(result).toContain("hljs");
  });

  it("highlights Rust", () => {
    const result = highlightCode("fn main() {}", "rust");
    expect(result).toContain("hljs");
  });
});
