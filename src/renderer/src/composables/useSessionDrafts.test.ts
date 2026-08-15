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

  // ── 持久化（2026-08-15 用户确认：草稿 localStorage 落盘，重启不丢失）──

  it("持久化：saveDraft/clearDraft 后 localStorage 同步更新", () => {
    drafts.saveDraft("ses-1", mkDraft({ text: "持久草稿", files: [mkFile()] }));
    const raw = localStorage.getItem("oc-gui.session-drafts.v1");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as Record<string, SessionDraft>;
    expect(parsed["ses-1"].text).toBe("持久草稿");
    expect(parsed["ses-1"].files).toHaveLength(1);
    // 无会话槽也持久化
    drafts.saveDraft(null, mkDraft({ text: "首页草稿" }));
    const parsed2 = JSON.parse(localStorage.getItem("oc-gui.session-drafts.v1")!) as Record<string, SessionDraft>;
    expect(parsed2["__draft_none__"].text).toBe("首页草稿");
    // clearDraft 同步移除
    drafts.clearDraft("ses-1");
    const parsed3 = JSON.parse(localStorage.getItem("oc-gui.session-drafts.v1")!) as Record<string, unknown>;
    expect(parsed3["ses-1"]).toBeUndefined();
  });

  it("重启恢复：清 Map 后从 localStorage 重新加载（模拟应用重启）", () => {
    drafts.saveDraft("ses-1", mkDraft({ text: "重启后还在" }));
    drafts.saveDraft(null, mkDraft({ text: "首页也在" }));
    // 模拟重启：_reloadFromStorageForTest 清 Map + 从 localStorage 恢复
    drafts._reloadFromStorageForTest();
    expect(drafts.getDraft("ses-1").text).toBe("重启后还在");
    expect(drafts.getDraft(null).text).toBe("首页也在");
  });

  it("损坏数据防御：非法 JSON 静默忽略，空草稿起步", () => {
    localStorage.setItem("oc-gui.session-drafts.v1", "{invalid json!!");
    drafts._reloadFromStorageForTest();
    expect(drafts.hasDraft("ses-1")).toBe(false);
    // 结构非法（缺 text）的条目被过滤
    localStorage.setItem("oc-gui.session-drafts.v1", JSON.stringify({ "ses-1": { files: [] } }));
    drafts._reloadFromStorageForTest();
    expect(drafts.hasDraft("ses-1")).toBe(false);
  });

  it("migrateNoneDraft 后持久化更新（NONE 槽删除、目标会话写入）", () => {
    drafts.saveDraft(null, mkDraft({ text: "首页草稿" }));
    drafts.migrateNoneDraft("ses-new");
    const parsed = JSON.parse(localStorage.getItem("oc-gui.session-drafts.v1")!) as Record<string, { text: string }>;
    expect(parsed["ses-new"].text).toBe("首页草稿");
    expect(parsed["__draft_none__"]).toBeUndefined();
  });

  // ── 润色状态按会话隔离（2026-08-15 用户反馈：按钮状态跟随会话）──

  it("setPolishState/isPolishing：状态按会话隔离，互不影响", () => {
    drafts.setPolishState("ses-a", true);
    expect(drafts.isPolishing("ses-a")).toBe(true);
    // B 会话不受 A 影响
    expect(drafts.isPolishing("ses-b")).toBe(false);
    drafts.setPolishState("ses-a", false);
    expect(drafts.isPolishing("ses-a")).toBe(false);
  });

  it("setPolishState 触发版本号自增（按钮 computed 依赖版本号重算）", () => {
    const v0 = drafts.version();
    drafts.setPolishState("ses-a", true);
    expect(drafts.version()).toBeGreaterThan(v0);
  });

  it("润色状态不持久化（瞬态，重启后清除）", () => {
    drafts.setPolishState("ses-a", true);
    drafts._reloadFromStorageForTest();
    expect(drafts.isPolishing("ses-a")).toBe(false);
  });
});
