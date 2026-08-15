import { describe, it, expect, beforeEach } from "vitest";
import { useSessionDrafts, type SessionDraft } from "./useSessionDrafts";

// 草稿跟随会话存储单测：跨组件共享 Map + 无会话槽迁移 + 标记判断
const drafts = useSessionDrafts();
const mkDraft = (partial: Partial<SessionDraft> = {}): SessionDraft => ({
  text: "草稿",
  files: [],
  snippet: null,
  ...partial,
});
const mkFile = (name = "a.txt"): { name: string; path: string; size?: number; mtimeMs?: number } => ({
  name,
  path: `H:\\${name}`,
});

describe("useSessionDrafts", () => {
  beforeEach(() => {
    drafts._resetForTest();
  });

  it("saveDraft/getDraft 读写往返（深拷贝，外部修改不影响存储）", () => {
    const file = mkFile();
    drafts.saveDraft("ses-1", mkDraft({ text: "你好", files: [file], snippet: { content: "选区", label: "l" } }));
    const got = drafts.getDraft("ses-1");
    expect(got.text).toBe("你好");
    expect(got.files).toHaveLength(1);
    expect(got.snippet?.content).toBe("选区");
    // 深拷贝：改外部数组不影响已存草稿
    got.files.push(mkFile("b.txt"));
    expect(drafts.getDraft("ses-1").files).toHaveLength(1);
  });

  it("无草稿 getDraft 返回空草稿（不写入脏条目）", () => {
    expect(drafts.getDraft("ses-x")).toEqual({ text: "", files: [], snippet: null });
    expect(drafts.hasDraft("ses-x")).toBe(false);
  });

  it("hasDraft：空草稿不算、文字/附件/选区任一非空都算", () => {
    drafts.saveDraft("ses-1", mkDraft({ text: "" }));
    expect(drafts.hasDraft("ses-1")).toBe(false);
    drafts.saveDraft("ses-1", mkDraft({ text: "有字" }));
    expect(drafts.hasDraft("ses-1")).toBe(true);
    drafts.saveDraft("ses-2", mkDraft({ text: "", files: [mkFile()] }));
    expect(drafts.hasDraft("ses-2")).toBe(true);
    drafts.saveDraft("ses-3", mkDraft({ text: "", snippet: { content: "选", label: "l" } }));
    expect(drafts.hasDraft("ses-3")).toBe(true);
  });

  it("无会话槽：null/undefined/空串归一化到同一槽位", () => {
    drafts.saveDraft(null, mkDraft({ text: "首页草稿" }));
    expect(drafts.getDraft(undefined).text).toBe("首页草稿");
    expect(drafts.getDraft("").text).toBe("首页草稿");
    expect(drafts.hasDraft(null)).toBe(true);
  });

  it("migrateNoneDraft：无会话草稿迁移到新会话并清空 NONE 槽", () => {
    drafts.saveDraft(null, mkDraft({ text: "首页草稿" }));
    expect(drafts.migrateNoneDraft("ses-new")).toBe(true);
    expect(drafts.getDraft("ses-new").text).toBe("首页草稿");
    expect(drafts.hasDraft(null)).toBe(false);
  });

  it("migrateNoneDraft：目标已有草稿时以目标为准，NONE 槽丢弃", () => {
    drafts.saveDraft(null, mkDraft({ text: "首页草稿" }));
    drafts.saveDraft("ses-new", mkDraft({ text: "已有草稿" }));
    drafts.migrateNoneDraft("ses-new");
    expect(drafts.getDraft("ses-new").text).toBe("已有草稿");
    expect(drafts.hasDraft(null)).toBe(false);
  });

  it("migrateNoneDraft：无 NONE 草稿返回 false", () => {
    expect(drafts.migrateNoneDraft("ses-new")).toBe(false);
  });

  it("clearDraft 删除草稿（含 NONE 槽）", () => {
    drafts.saveDraft("ses-1", mkDraft({ text: "删我" }));
    drafts.clearDraft("ses-1");
    expect(drafts.hasDraft("ses-1")).toBe(false);
    drafts.saveDraft(null, mkDraft({ text: "首页" }));
    drafts.clearDraft(null);
    expect(drafts.hasDraft(null)).toBe(false);
  });

  it("version 每次写操作自增（列表标记刷新依据）", () => {
    const v0 = drafts.version();
    drafts.saveDraft("ses-1", mkDraft());
    expect(drafts.version()).toBeGreaterThan(v0);
    drafts.clearDraft("ses-1");
    expect(drafts.version()).toBeGreaterThan(v0 + 1);
  });

  it("setPolishResult → saveDraft 合并：润色文本替代草稿 text（跨会话写回与 captureDraft 竞态解决）", () => {
    drafts.saveDraft("ses-a", mkDraft({ text: "旧草稿" }));
    // 润色跨会话写回：登记 pending（不直接改草稿）
    drafts.setPolishResult("ses-a", "润色后");
    // 随后 ChatPanel captureDraft(A) 用 InputBar 旧文本保存——saveDraft 合并 pending 润色文本
    drafts.saveDraft("ses-a", mkDraft({ text: "旧草稿" }));
    expect(drafts.getDraft("ses-a").text).toBe("润色后");
    // pending 已消费：再次 saveDraft 不重复合并
    drafts.saveDraft("ses-a", mkDraft({ text: "后续编辑" }));
    expect(drafts.getDraft("ses-a").text).toBe("后续编辑");
  });

  it("clearDraft 丢弃待合并润色结果", () => {
    drafts.setPolishResult("ses-a", "润色后");
    drafts.clearDraft("ses-a");
    // pending 已清：saveDraft 不再合并
    drafts.saveDraft("ses-a", mkDraft({ text: "正常草稿" }));
    expect(drafts.getDraft("ses-a").text).toBe("正常草稿");
  });
});
