import { describe, it, expect, beforeEach } from "vitest";
import {
  changelog,
  APP_VERSION,
  findEntry,
  localizedSections,
  getLastSeenVersion,
  markVersionSeen,
} from "./changelog";

describe("changelog", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("当前版本必须有对应条目（否则启动弹窗永不显示）", () => {
    // 发版流程：改 package.json version 后必须在 changelog 头部加同版本条目
    expect(findEntry(APP_VERSION)).toBeDefined();
  });

  it("findEntry 未命中时返回 undefined（不崩溃）", () => {
    expect(findEntry("9.9.9")).toBeUndefined();
  });

  it("条目按版本降序排列且版本号唯一", () => {
    const versions = changelog.map((e) => e.version);
    expect(new Set(versions).size).toBe(versions.length);
    const sorted = [...versions].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    expect(versions).toEqual(sorted);
  });

  it("localizedSections 按语言返回中/英文标题与条目", () => {
    const entry = findEntry(APP_VERSION)!;
    const zh = localizedSections(entry, "zh");
    const en = localizedSections(entry, "en");
    expect(zh.length).toBeGreaterThan(0);
    expect(zh[0].title).toBe(entry.sections[0].titleZh);
    expect(zh[0].items[0]).toBe(entry.sections[0].itemsZh[0]);
    expect(en[0].title).toBe(entry.sections[0].titleEn);
    expect(en[0].items[0]).toBe(entry.sections[0].itemsEn[0]);
  });

  it("markVersionSeen 写入后 getLastSeenVersion 可读回", () => {
    expect(getLastSeenVersion()).toBe("");
    markVersionSeen("1.0.0");
    expect(getLastSeenVersion()).toBe("1.0.0");
  });
});
