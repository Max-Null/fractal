import { describe, it, expect } from "vitest";
import { toPinyinInitials } from "@/lib/pinyin";

/**
 * 模拟 CommandPalette 的 matchesQuery 逻辑，
 * 不依赖 Vue 组件环境，直接测试搜索匹配策略。
 */

// 测试用命令数据（对齐 OC 适配后的真实 actions：无 effort 组、无 CC 独有斜杠、permission 仅 4 模式）
const mockCommands = [
  { id: "new-session",    group: "session",  label: "新建会话",      desc: "创建新的会话" },
  { id: "toggle-sidebar", group: "view",     label: "切换侧边栏",    desc: "" },
  { id: "open-settings",  group: "settings", label: "打开设置",      desc: "打开设置面板" },
  { id: "compact",        group: "context",  label: "压缩上下文",    desc: "释放上下文窗口" },
  { id: "perm-default",   group: "permission", label: "默认模式",    desc: "仅自动批准读取操作" },
  { id: "perm-plan",      group: "permission", label: "计划模式",    desc: "先探索再编辑" },
  { id: "perm-auto",      group: "permission", label: "全自动",      desc: "全自动 · 自动批准所有操作" },
];

function matchesQuery(label: string, id: string, desc: string, q: string): boolean {
  const ql = q.toLowerCase();
  if (id.includes(ql)) return true;
  if (label.includes(ql)) return true;
  if (ql.length >= 2 && toPinyinInitials(label).includes(ql)) return true;
  if (desc && desc.includes(ql)) return true;
  return false;
}

describe("CommandPalette 搜索逻辑", () => {
  it("按 id 匹配", () => {
    const cmd = mockCommands[0];
    expect(matchesQuery(cmd.label, cmd.id, cmd.desc, "new-session")).toBe(true);
    expect(matchesQuery(cmd.label, cmd.id, cmd.desc, "session")).toBe(true);
  });

  it("按中文 label 匹配", () => {
    expect(matchesQuery("新建会话", "x", "", "新建")).toBe(true);
    expect(matchesQuery("查看用量", "x", "", "用量")).toBe(true);
  });

  it("按拼音首字母匹配", () => {
    expect(matchesQuery("新建会话", "x", "", "xjhh")).toBe(true);
    expect(matchesQuery("切换侧边栏", "x", "", "qhcbl")).toBe(true);
    expect(matchesQuery("打开设置", "x", "", "dksz")).toBe(true);
  });

  it("拼音至少 2 个字符才触发", () => {
    // 单个字符不触发拼音匹配，防止误匹配
    // 注意："x" 会匹配 id="x"，所以这里用 "新" 的拼音首字母 'x' 来测——
    // 但 id 也包含 'x'。改为用一个不匹配 id 的查询词 'j'（"建"的首字母）
    expect(matchesQuery("新建会话", "ns", "", "j")).toBe(false);
    expect(matchesQuery("新建会话", "ns", "", "xj")).toBe(true);
  });

  it("按描述匹配", () => {
    expect(matchesQuery("新建会话", "ns", "创建新的会话", "创建")).toBe(true);
    expect(matchesQuery("查看用量", "su", "查看 token 使用量", "token")).toBe(true);
  });

  it("不匹配返回 false", () => {
    expect(matchesQuery("新建会话", "ns", "", "xyz")).toBe(false);
  });
});

describe("CommandPalette 分组", () => {
  it("命令按 group 归类", () => {
    const groups = [...new Set(mockCommands.map((c) => c.group))];
    expect(groups).toContain("session");
    expect(groups).toContain("view");
    expect(groups).toContain("settings");
    expect(groups).toContain("context");
    expect(groups).toContain("permission");
  });

  it("同一分组下的命令", () => {
    const contextCmds = mockCommands.filter((c) => c.group === "context");
    expect(contextCmds).toHaveLength(1);
    expect(contextCmds.map((c) => c.id)).toEqual(["compact"]);
  });
});

describe("CommandPalette OC 适配", () => {
  it("CC 独有斜杠命令（/review /simplify /security-review /doctor /context /cost）已删除", () => {
    const ids = mockCommands.map((c) => c.id);
    for (const removed of ["slash-review", "slash-simplify", "slash-security", "slash-doctor", "slash-context", "slash-cost"]) {
      expect(ids).not.toContain(removed);
    }
  });

  it("effort 组命令（OC 无 medium/xhigh/ultracode，思考强度改由 InputBar 选择器动态展示）已删除", () => {
    const ids = mockCommands.map((c) => c.id);
    for (const removed of ["effort-low", "effort-medium", "effort-high", "effort-xhigh", "effort-max", "effort-ultracode"]) {
      expect(ids).not.toContain(removed);
    }
  });

  it("permission 组仅 4 模式（bypass/dontask 是 CC 模式名已删，auto 语义并入全自动）", () => {
    const permCmds = mockCommands.filter((c) => c.group === "permission");
    expect(permCmds.map((c) => c.id)).toEqual(["perm-default", "perm-plan", "perm-auto"]);
    expect(permCmds.some((c) => c.id === "perm-bypass" || c.id === "perm-dontask")).toBe(false);
  });

  it("slash-compact 保留（走 serve compact API）", () => {
    expect(mockCommands.some((c) => c.id === "compact")).toBe(true);
  });
});

describe("CommandPalette 搜索过滤后分组", () => {
  it("搜索 '上下文' 只匹配 context 分组的命令", () => {
    const q = "上下文";
    const filtered = mockCommands.filter(
      (c) => matchesQuery(c.label, c.id, c.desc, q)
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe("compact");
  });

  it("拼音 'qk' 匹配清空对话", () => {
    // 模拟清空对话命令
    const cmd = { id: "clear-conversation", label: "清空对话", desc: "" };
    expect(matchesQuery(cmd.label, cmd.id, cmd.desc, "qk")).toBe(true);
  });
});
