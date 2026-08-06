import { describe, it, expect } from "vitest";
import { toPinyinInitials } from "./pinyin";

describe("toPinyinInitials", () => {
  it("提取中文字符串拼音首字母", () => {
    expect(toPinyinInitials("新建会话")).toBe("xjhh");
    expect(toPinyinInitials("切换侧边栏")).toBe("qhcbl");
    expect(toPinyinInitials("打开设置")).toBe("dksz");
    expect(toPinyinInitials("清空对话")).toBe("qkdh");
    expect(toPinyinInitials("上下文统计")).toBe("sxwtj");
    expect(toPinyinInitials("压缩上下文")).toBe("yssxw");
  });

  it("纯英文保持不变", () => {
    expect(toPinyinInitials("new-session")).toBe("new-session");
    expect(toPinyinInitials("/context")).toBe("/context");
  });

  it("混合中英文", () => {
    expect(toPinyinInitials("初始化 CLAUDE.md")).toBe("csh claude.md");
  });

  it("空字符串", () => {
    expect(toPinyinInitials("")).toBe("");
  });

  it("非中文字符原样返回", () => {
    expect(toPinyinInitials("Ctrl+N")).toBe("ctrl+n");
    expect(toPinyinInitials("123")).toBe("123");
  });
});
