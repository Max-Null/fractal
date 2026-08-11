import { describe, it, expect, beforeEach, vi } from "vitest";
import { defineComponent } from "vue";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

import MemoryPanel from "./MemoryPanel.vue";
import ContextPanel from "./ContextPanel.vue";
import PlansPanel from "./PlansPanel.vue";
import CapabilitiesPanel from "./CapabilitiesPanel.vue";
import { useChatStore } from "@/stores/chat";
import { useSessionStore } from "@/stores/session";

// CapabilitiesPanel 用 vue-i18n（其他面板硬编码中文）——mock t 返回 key，断言不依赖文案
vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

// mock electron-bridge：面板数据源通道（listMemories/confirmMemory/removeMemory/readMemory/listPlans/readPlan/onPanelUpdate）
const listMemoriesMock = vi.fn();
const confirmMemoryMock = vi.fn();
const removeMemoryMock = vi.fn();
const readMemoryMock = vi.fn();
const listPlansMock = vi.fn();
const readPlanMock = vi.fn();
const listCapabilitiesMock = vi.fn();
vi.mock("@/lib/electron-bridge", () => ({
  listMemories: (...args: unknown[]) => listMemoriesMock(...args),
  confirmMemory: (...args: unknown[]) => confirmMemoryMock(...args),
  removeMemory: (...args: unknown[]) => removeMemoryMock(...args),
  readMemory: (...args: unknown[]) => readMemoryMock(...args),
  listPlans: (...args: unknown[]) => listPlansMock(...args),
  readPlan: (...args: unknown[]) => readPlanMock(...args),
  listCapabilities: (...args: unknown[]) => listCapabilitiesMock(...args),
  onPanelUpdate: () => () => {},
  // ContextPanel 依赖 session store（activeSession 查询）——store 的 watch 回调会调 bridge 这些函数，mock 补全防炸
  setActiveSession: vi.fn(),
  listSessions: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  renameSession: vi.fn(),
}));

// 详情弹窗子组件 stub：open prop 控制可见性 + close 按钮模拟真实 ModalShell 的 header ×（真实组件依赖全局 $t，测试环境不挂 app）
const ModalShellStub = defineComponent({
  props: ["open"],
  emits: ["close"],
  template: `<div v-if="open" class="modal-stub"><slot name="header" /><button class="stub-close" @click="$emit('close')">×</button><slot /><slot name="footer" /></div>`,
});
// MarkdownRenderer stub：直接渲染 content 文本（真实组件含 marked/mermaid 异步链路）
const MarkdownRendererStub = defineComponent({
  props: ["content"],
  template: `<div class="md-stub">{{ content }}</div>`,
});

// 记忆条目工厂：减少重复字段
const mem = (file: string, title: string, status: "pending" | "auto" | "suggest" = "auto", desc = "", preview = "") => ({
  file,
  title,
  status,
  desc,
  preview,
});

describe("MemoryPanel", () => {
  beforeEach(() => {
    listMemoriesMock.mockReset();
    confirmMemoryMock.mockReset();
    removeMemoryMock.mockReset();
    readMemoryMock.mockReset();
    listMemoriesMock.mockResolvedValue({ global: [], project: [] });
    confirmMemoryMock.mockResolvedValue({ ok: true });
    removeMemoryMock.mockResolvedValue({ ok: true });
    readMemoryMock.mockResolvedValue({ ...mem("g1.md", "全局记忆A"), content: "<!-- status: pending -->\n# 全局记忆A\n正文全文" });
  });

  // 弹窗子组件 stub 挂载配置（MemoryPanel 用例统一使用）
  function mountPanel() {
    return mount(MemoryPanel, {
      global: { stubs: { ModalShell: ModalShellStub, MarkdownRenderer: MarkdownRendererStub } },
    });
  }

  it("拉取记忆并渲染两层分组 + 条目（title/desc/preview/状态角标）", async () => {
    listMemoriesMock.mockResolvedValue({
      global: [
        { file: "g1.md", title: "全局记忆A", status: "pending", desc: "跨项目习惯", preview: "正文预览…" },
        { file: "g2.md", title: "全局记忆B", status: "auto", desc: "", preview: "" },
      ],
      project: [{ file: "p1.md", title: "项目记忆", status: "suggest", desc: "业务上下文", preview: "项目正文" }],
    });
    const wrapper = mountPanel();
    await flushPromises();

    expect(listMemoriesMock).toHaveBeenCalledOnce();
    // 两层分组（全局 + 项目；会话层是误读占位，2026-08-12 已删）
    const groups = wrapper.findAll(".mem-group-head span:first-child").map(s => s.text());
    expect(groups).toHaveLength(2);
    expect(groups.join()).toContain("全局记忆");
    expect(groups.join()).toContain("项目记忆");
    // 条目渲染
    expect(wrapper.text()).toContain("全局记忆A");
    expect(wrapper.text()).toContain("跨项目习惯");
    expect(wrapper.text()).toContain("项目记忆");
    // 状态角标（待确认 pending 条目显示确认按钮；auto/suggest 不显示）
    expect(wrapper.findAll(".mem-badge").length).toBe(3);
    const confirmBtns = wrapper.findAll("button").filter(b => b.text() === "确认");
    expect(confirmBtns).toHaveLength(1);
  });

  it("搜索 + chips 过滤（标题/描述/预览包含搜索词）", async () => {
    listMemoriesMock.mockResolvedValue({
      global: [
        { file: "a.md", title: "Alpha", status: "pending", desc: "苹果", preview: "x" },
        { file: "b.md", title: "Beta", status: "auto", desc: "香蕉", preview: "y" },
      ],
      project: [],
    });
    const wrapper = mountPanel();
    await flushPromises();

    await wrapper.find("input.search-row-input").setValue("香蕉");
    expect(wrapper.text()).toContain("Beta");
    expect(wrapper.text()).not.toContain("Alpha");

    await wrapper.find("input.search-row-input").setValue("");
    const chips = wrapper.findAll("button.chip");
    await chips.find(c => c.text() === "待确认")!.trigger("click");
    expect(wrapper.text()).toContain("Alpha");
    expect(wrapper.text()).not.toContain("Beta");
  });

  it("确认/删除按钮 → 调 bridge 并重拉", async () => {
    listMemoriesMock.mockResolvedValue({
      global: [{ file: "g1.md", title: "待确认记忆", status: "pending", desc: "", preview: "" }],
      project: [],
    });
    const wrapper = mountPanel();
    await flushPromises();

    await wrapper.findAll("button").find(b => b.text() === "确认")!.trigger("click");
    await flushPromises();
    expect(confirmMemoryMock).toHaveBeenCalledWith("g1.md");
    expect(listMemoriesMock).toHaveBeenCalledTimes(2);

    await wrapper.findAll("button").find(b => b.text() === "删除")!.trigger("click");
    await flushPromises();
    expect(removeMemoryMock).toHaveBeenCalledWith("g1.md");
    expect(listMemoriesMock).toHaveBeenCalledTimes(3);
  });

  it("空态保留（两层全空时显示空态提示）", async () => {
    const wrapper = mountPanel();
    await flushPromises();
    expect(wrapper.findAll(".mem-empty").length).toBe(2);
    expect(wrapper.text()).toContain("暂无");
  });

  it("点击条目 → 打开详情弹窗（readMemory 全文 + 元数据注释剥除）", async () => {
    listMemoriesMock.mockResolvedValue({
      global: [mem("g1.md", "全局记忆A", "pending", "跨项目习惯", "预览…")],
      project: [],
    });
    readMemoryMock.mockResolvedValue({
      ...mem("g1.md", "全局记忆A", "pending", "跨项目习惯"),
      content: "<!-- type: knowledge --><!-- status: pending -->\n# 全局记忆A\n正文全文",
    });
    const wrapper = mountPanel();
    await flushPromises();
    // 初始无弹窗
    expect(wrapper.find(".modal-stub").exists()).toBe(false);

    await wrapper.find(".mem-item").trigger("click");
    await flushPromises();
    expect(readMemoryMock).toHaveBeenCalledWith("g1.md");
    // 弹窗出现：标题 + 状态角标 + 元数据注释已剥（渲染层只输出正文）
    expect(wrapper.find(".modal-stub").exists()).toBe(true);
    expect(wrapper.find(".modal-stub").text()).toContain("全局记忆A");
    expect(wrapper.find(".modal-stub").text()).toContain("跨项目习惯");
    expect(wrapper.find(".modal-stub").text()).not.toContain("<!--");
    expect(wrapper.find(".modal-stub").text()).toContain("正文全文");
  });

  it("详情弹窗关闭（header ×）后消失", async () => {
    listMemoriesMock.mockResolvedValue({
      global: [mem("g1.md", "全局记忆A")],
      project: [],
    });
    const wrapper = mountPanel();
    await flushPromises();
    await wrapper.find(".mem-item").trigger("click");
    await flushPromises();
    expect(wrapper.find(".modal-stub").exists()).toBe(true);

    // 关闭按钮（stub 模拟真实 ModalShell 的 header ×）→ 弹窗消失
    await wrapper.find(".stub-close").trigger("click");
    expect(wrapper.find(".modal-stub").exists()).toBe(false);
  });

  it("详情读取失败 → 弹窗显示错误原因（不崩溃）", async () => {
    listMemoriesMock.mockResolvedValue({
      global: [mem("g1.md", "全局记忆A")],
      project: [],
    });
    readMemoryMock.mockRejectedValue(new Error("记忆文件越界"));
    const wrapper = mountPanel();
    await flushPromises();
    await wrapper.find(".mem-item").trigger("click");
    await flushPromises();
    expect(wrapper.find(".modal-stub").exists()).toBe(true);
    expect(wrapper.text()).toContain("读取记忆失败");
  });
});

describe("ContextPanel", () => {
  // ContextPanel 依赖 pinia store（chat messages 聚合 + session activeSession）——每个用例独立实例
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("无活跃会话 → 提示暂无活跃会话", () => {
    const wrapper = mount(ContextPanel);
    expect(wrapper.find(".panel-tip").exists()).toBe(true);
    expect(wrapper.text()).toContain("暂无活跃会话");
  });

  it("有活跃会话 → 渲染会话信息（标题/工作区 basename/模型/Agent/创建时间）", () => {
    const sessionStore = useSessionStore();
    sessionStore.sessions.push({
      id: "s1",
      title: "测试会话",
      createdAt: new Date(2026, 7, 12, 10, 0, 0).getTime(),
      updatedAt: 0,
      messageCount: 5,
      totalTokens: null,
      totalCost: null,
      mode: "cc",
      cwd: "C:\\Projects\\demo",
      model: "ds/deepseek-v4-pro",
      agent: "双星",
    });
    sessionStore.activeSessionId = "s1";

    const wrapper = mount(ContextPanel);
    expect(wrapper.find(".panel-tip").exists()).toBe(false);
    const text = wrapper.text();
    expect(text).toContain("测试会话");
    expect(text).toContain("demo");
    expect(text).toContain("ds/deepseek-v4-pro");
    expect(text).toContain("双星");
    expect(text).toContain("08-12 10:00");
  });

  it("聚合消息 tokens/成本/统计（2 user + 1 assistant 带工具）", () => {
    const sessionStore = useSessionStore();
    sessionStore.sessions.push({ id: "s1", title: "T", createdAt: 0, updatedAt: 0, messageCount: 3, totalTokens: null, totalCost: null, mode: "cc" });
    sessionStore.activeSessionId = "s1";

    const chat = useChatStore();
    chat.messages.push(
      { id: "u1", role: "user", content: "hi", thinking: "", toolUses: [], timestamp: 0, isStreaming: false },
      {
        id: "a1",
        role: "assistant",
        content: "ok",
        thinking: "t",
        toolUses: [
          { id: "t1", name: "bash", input: {}, result: "x" },
          { id: "t2", name: "read", input: {}, result: "y" },
        ],
        timestamp: 0,
        isStreaming: false,
        inputTokens: 100,
        outputTokens: 50,
        costUSD: 0.01,
      },
      { id: "u2", role: "user", content: "again", thinking: "", toolUses: [], timestamp: 0, isStreaming: false },
    );

    const wrapper = mount(ContextPanel);
    const cards = wrapper.findAll(".stat-card");
    // 会话信息 / 上下文用量 / 成本 / 消息统计 四卡
    expect(cards.length).toBe(4);
    // 用量卡：输入 100 + 输出 50 = 总量 150
    expect(cards[1].text()).toContain("150");
    expect(cards[1].text()).toContain("100");
    expect(cards[1].text()).toContain("50");
    // 成本卡：$0.0100（4 位小数）
    expect(cards[2].text()).toContain("$0.0100");
    // 统计卡：3 消息 / 1 轮 / 2 工具
    expect(cards[3].text()).toContain("3");
    expect(cards[3].text()).toContain("1");
    expect(cards[3].text()).toContain("2");
  });
});

describe("PlansPanel", () => {
  beforeEach(() => {
    listPlansMock.mockReset();
    readPlanMock.mockReset();
    listPlansMock.mockResolvedValue({ plans: [], active: null });
    readPlanMock.mockResolvedValue({
      file: "2026-08-12-0100-详情计划.md", title: "详情计划", currentStep: 2, totalSteps: 5,
      status: "执行中", lastCompletedStep: "", updatedAt: 0, content: "# 详情计划\n## 当前步骤：2/5 | 状态：执行中\n正文",
    });
  });

  // 详情弹窗子组件 stub（与 MemoryPanel 用例相同：ModalShell 依赖全局 $t；MarkdownRenderer 异步链路）
  function mountPlansPanel() {
    return mount(PlansPanel, {
      global: { stubs: { ModalShell: ModalShellStub, MarkdownRenderer: MarkdownRendererStub } },
    });
  }

  it("渲染计划卡片（标题/状态标签/进度条/上一步完成/更新时间）", async () => {
    listPlansMock.mockResolvedValue({
      plans: [
        // 本地时区构造（渲染端 new Date(ms) 按本地格式化，避免 UTC/本地偏移断言差异）
        { file: "2026-08-07-0300-新计划.md", title: "新计划", currentStep: 2, totalSteps: 4, status: "执行中", lastCompletedStep: "步骤二完成", updatedAt: new Date(2026, 7, 12, 10, 0, 0).getTime() },
        { file: "2026-08-06-0000-旧计划.md", title: "旧计划", currentStep: 0, totalSteps: 0, status: "未知", lastCompletedStep: "", updatedAt: 0 },
      ],
      active: null,
    });
    const wrapper = mountPlansPanel();
    await flushPromises();

    expect(listPlansMock).toHaveBeenCalledOnce();
    expect(wrapper.text()).toContain("新计划");
    expect(wrapper.text()).toContain("执行中");
    expect(wrapper.text()).toContain("旧计划");
    expect(wrapper.text()).toContain("2/4");
    expect(wrapper.text()).toContain("上一步完成：步骤二完成");
    // 更新时间行（mtime 格式化显示）
    expect(wrapper.text()).toContain("更新于 08-12 10:00");
    // 执行中 → 进度条 50%
    const fills = wrapper.findAll(".bar-fill");
    expect(fills[0].attributes("style")).toContain("50%");
  });

  it("active 高亮 → 顶部「当前计划」卡片", async () => {
    listPlansMock.mockResolvedValue({
      plans: [],
      active: { title: "当前活跃计划", progress: "3/5", lastCompletedStep: "阶段三完成" },
    });
    const wrapper = mountPlansPanel();
    await flushPromises();

    expect(wrapper.find(".plan--active").exists()).toBe(true);
    expect(wrapper.find(".plan--active").text()).toContain("当前活跃计划");
    expect(wrapper.find(".plan--active").text()).toContain("当前计划");
    expect(wrapper.find(".plan--active").text()).toContain("3/5");
    expect(wrapper.find(".plan--active").text()).toContain("阶段三完成");
  });

  it("空态「暂无计划」", async () => {
    const wrapper = mountPlansPanel();
    await flushPromises();
    expect(wrapper.find(".plan-empty").exists()).toBe(true);
    expect(wrapper.text()).toContain("暂无计划");
  });

  it("点击计划卡片 → 打开详情弹窗（readPlan 全文 + 标题快照）", async () => {
    listPlansMock.mockResolvedValue({
      plans: [
        { file: "2026-08-12-0100-详情计划.md", title: "详情计划", currentStep: 2, totalSteps: 5, status: "执行中", lastCompletedStep: "", updatedAt: Date.UTC(2026, 7, 12, 10, 0, 0) },
      ],
      active: null,
    });
    readPlanMock.mockResolvedValue({
      file: "2026-08-12-0100-详情计划.md", title: "详情计划", currentStep: 2, totalSteps: 5,
      status: "执行中", lastCompletedStep: "", updatedAt: Date.UTC(2026, 7, 12, 10, 0, 0),
      content: "# 详情计划\n## 当前步骤：2/5 | 状态：执行中\n正文全文",
    });
    const wrapper = mountPlansPanel();
    await flushPromises();
    expect(wrapper.find(".modal-stub").exists()).toBe(false);

    await wrapper.find(".plan").trigger("click");
    await flushPromises();
    expect(readPlanMock).toHaveBeenCalledWith("2026-08-12-0100-详情计划.md");
    expect(wrapper.find(".modal-stub").exists()).toBe(true);
    expect(wrapper.find(".modal-stub").text()).toContain("详情计划");
    expect(wrapper.find(".modal-stub").text()).toContain("2/5");
    expect(wrapper.find(".modal-stub").text()).toContain("正文全文");
  });

  it("详情读取失败 → 弹窗显示错误原因（标题快照仍显示）", async () => {
    listPlansMock.mockResolvedValue({
      plans: [{ file: "2026-08-12-0100-详情计划.md", title: "详情计划", currentStep: 0, totalSteps: 0, status: "未知", lastCompletedStep: "", updatedAt: 0 }],
      active: null,
    });
    readPlanMock.mockRejectedValue(new Error("计划文件越界"));
    const wrapper = mountPlansPanel();
    await flushPromises();
    await wrapper.find(".plan").trigger("click");
    await flushPromises();
    expect(wrapper.find(".modal-stub").exists()).toBe(true);
    expect(wrapper.find(".modal-stub").text()).toContain("详情计划"); // 标题快照
    expect(wrapper.text()).toContain("读取计划失败");
  });
});

describe("CapabilitiesPanel（生态清单）", () => {
  beforeEach(() => {
    listCapabilitiesMock.mockReset();
    listCapabilitiesMock.mockResolvedValue({ agents: [], skills: [], plugins: [], mcp: [] });
  });

  it("渲染 技能/Agent/插件/MCP 四分组（技能最前）+ 过滤 native + 条目详情", async () => {
    listCapabilitiesMock.mockResolvedValue({
      agents: [
        { name: "双星", description: "主力助手", mode: "primary", native: false },
        { name: "plan", description: "拆解计划", mode: "subagent", native: true },
      ],
      skills: [{ name: "mxy-commit-review", description: "审查提交工作流", location: "file:///x" }],
      plugins: [{ name: "fractal-guardian", source: "file:///C:/p/fractal-guardian.js" }],
      mcp: [
        { name: "github", status: "connected", type: "remote", target: "https://api.githubcopilot.com/mcp/" },
        { name: "exa", status: "disabled", type: "local", target: "npx exa" },
      ],
    });
    const wrapper = mount(CapabilitiesPanel);
    await flushPromises();

    // 四分组（i18n mock t 返回 key，断言 key 文本）；技能组排最前
    const groups = wrapper.findAll(".pgroup").map(s => s.text());
    expect(groups).toHaveLength(4);
    expect(groups[0]).toContain("panel.skillGroup");
    expect(groups.join()).toContain("panel.agentGroup");
    expect(groups.join()).toContain("panel.pluginGroup");
    expect(groups.join()).toContain("panel.mcpGroup");
    // 条目渲染：自定义 agent 显示、native 内置 agent 被过滤
    expect(wrapper.text()).toContain("双星");
    expect(wrapper.text()).not.toContain("plan");
    expect(wrapper.text()).toContain("fractal-guardian");
    // MCP 状态徽标 class（connected/disabled）
    expect(wrapper.find(".mcp-status--connected").exists()).toBe(true);
    expect(wrapper.find(".mcp-status--disabled").exists()).toBe(true);
    // MCP 类型标签（远程/本地）
    expect(wrapper.text()).toContain("panel.mcpRemote");
    expect(wrapper.text()).toContain("panel.mcpLocal");
  });

  it("空 bundle → 四分组均显示空态", async () => {
    const wrapper = mount(CapabilitiesPanel);
    await flushPromises();

    expect(listCapabilitiesMock).toHaveBeenCalledOnce();
    expect(wrapper.findAll(".pitem-empty")).toHaveLength(4);
  });

  it("接口失败（reject）→ 空态兜底不崩", async () => {
    listCapabilitiesMock.mockRejectedValue(new Error("boom"));
    const wrapper = mount(CapabilitiesPanel);
    await flushPromises();

    expect(wrapper.findAll(".pitem-empty")).toHaveLength(4);
  });
});
