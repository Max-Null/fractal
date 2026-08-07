import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";

import MemoryPanel from "./MemoryPanel.vue";
import StatusPanel from "./StatusPanel.vue";
import PlansPanel from "./PlansPanel.vue";
import SkillsPanel from "./SkillsPanel.vue";

// mock electron-bridge：面板数据源通道（listMemories/confirmMemory/removeMemory/listPlans/getStatusState/onPanelUpdate）
const listMemoriesMock = vi.fn();
const confirmMemoryMock = vi.fn();
const removeMemoryMock = vi.fn();
const listPlansMock = vi.fn();
const getStatusStateMock = vi.fn();
vi.mock("@/lib/electron-bridge", () => ({
  listMemories: (...args: unknown[]) => listMemoriesMock(...args),
  confirmMemory: (...args: unknown[]) => confirmMemoryMock(...args),
  removeMemory: (...args: unknown[]) => removeMemoryMock(...args),
  listPlans: (...args: unknown[]) => listPlansMock(...args),
  getStatusState: (...args: unknown[]) => getStatusStateMock(...args),
  onPanelUpdate: () => () => {},
}));

describe("MemoryPanel", () => {
  beforeEach(() => {
    listMemoriesMock.mockReset();
    confirmMemoryMock.mockReset();
    removeMemoryMock.mockReset();
    listMemoriesMock.mockResolvedValue({ global: [], project: [] });
    confirmMemoryMock.mockResolvedValue({ ok: true });
    removeMemoryMock.mockResolvedValue({ ok: true });
  });

  it("拉取记忆并渲染三层分组 + 条目（title/desc/preview/状态角标）", async () => {
    listMemoriesMock.mockResolvedValue({
      global: [
        { file: "g1.md", title: "全局记忆A", status: "pending", desc: "跨项目习惯", preview: "正文预览…" },
        { file: "g2.md", title: "全局记忆B", status: "auto", desc: "", preview: "" },
      ],
      project: [{ file: "p1.md", title: "项目记忆", status: "suggest", desc: "业务上下文", preview: "项目正文" }],
    });
    const wrapper = mount(MemoryPanel);
    await flushPromises();

    expect(listMemoriesMock).toHaveBeenCalledOnce();
    // 三层分组保留
    const groups = wrapper.findAll(".mem-group-head span:first-child").map(s => s.text());
    expect(groups).toHaveLength(3);
    expect(groups.join()).toContain("全局记忆");
    expect(groups.join()).toContain("项目记忆");
    expect(groups.join()).toContain("会话记忆");
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
    const wrapper = mount(MemoryPanel);
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
    const wrapper = mount(MemoryPanel);
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

  it("空态保留（三层全空时显示空态提示）", async () => {
    const wrapper = mount(MemoryPanel);
    await flushPromises();
    expect(wrapper.findAll(".mem-empty").length).toBe(3);
    expect(wrapper.text()).toContain("暂无");
  });
});

describe("StatusPanel", () => {
  beforeEach(() => {
    getStatusStateMock.mockReset();
    getStatusStateMock.mockResolvedValue({ exists: false, state: null });
  });

  it("exists=false → 顶部提示 Guardian 状态文件未生成", async () => {
    const wrapper = mount(StatusPanel);
    await flushPromises();
    expect(wrapper.find(".panel-tip").exists()).toBe(true);
    expect(wrapper.text()).toContain("Guardian 状态文件未生成");
  });

  it("exists=true → 渲染六张 stat-card 并取 state 字段值", async () => {
    getStatusStateMock.mockResolvedValue({
      exists: true,
      state: {
        engine: { running: true, port: 54321 },
        assertions: { count: 7, level: 2, last: "SDK 版本" },
        reviews: { pendingCount: 3, lastEdit: "a.ts" },
        feedbackLoop: { count: 2 },
        knowledge: { lastCommit: "abc123", commitCount: 5, memoryCount: 2 },
        plan: { title: "测试计划", currentStep: 2, totalSteps: 4 },
      },
    });
    const wrapper = mount(StatusPanel);
    await flushPromises();

    expect(wrapper.findAll(".stat-card").length).toBeGreaterThanOrEqual(6);
    expect(wrapper.text()).toContain("运行中");
    expect(wrapper.text()).toContain("54321");
    expect(wrapper.text()).toContain("7");
    expect(wrapper.text()).toContain("3 条");
    expect(wrapper.text()).toContain("2 轮");
    expect(wrapper.text()).toContain("abc123");
    expect(wrapper.text()).toContain("测试计划");
    // 计划进度条 2/4 → 50%
    const fill = wrapper.find(".bar-fill");
    expect(fill.attributes("style")).toContain("50%");
  });

  it("存在状态文件时不显示未生成提示", async () => {
    getStatusStateMock.mockResolvedValue({ exists: true, state: { engine: { running: true } } });
    const wrapper = mount(StatusPanel);
    await flushPromises();
    expect(wrapper.find(".panel-tip").exists()).toBe(false);
  });
});

describe("PlansPanel", () => {
  beforeEach(() => {
    listPlansMock.mockReset();
    listPlansMock.mockResolvedValue({ plans: [], active: null });
  });

  it("渲染计划卡片（标题/状态标签/进度条/上一步完成）", async () => {
    listPlansMock.mockResolvedValue({
      plans: [
        { file: "2026-08-07-0300-新计划.md", title: "新计划", currentStep: 2, totalSteps: 4, status: "执行中", lastCompletedStep: "步骤二完成" },
        { file: "2026-08-06-0000-旧计划.md", title: "旧计划", currentStep: 0, totalSteps: 0, status: "未知", lastCompletedStep: "" },
      ],
      active: null,
    });
    const wrapper = mount(PlansPanel);
    await flushPromises();

    expect(listPlansMock).toHaveBeenCalledOnce();
    expect(wrapper.text()).toContain("新计划");
    expect(wrapper.text()).toContain("执行中");
    expect(wrapper.text()).toContain("旧计划");
    expect(wrapper.text()).toContain("2/4");
    expect(wrapper.text()).toContain("上一步完成：步骤二完成");
    // 执行中 → 进度条 50%
    const fills = wrapper.findAll(".bar-fill");
    expect(fills[0].attributes("style")).toContain("50%");
  });

  it("active 高亮 → 顶部「当前计划」卡片", async () => {
    listPlansMock.mockResolvedValue({
      plans: [],
      active: { title: "当前活跃计划", progress: "3/5", lastCompletedStep: "阶段三完成" },
    });
    const wrapper = mount(PlansPanel);
    await flushPromises();

    expect(wrapper.find(".plan--active").exists()).toBe(true);
    expect(wrapper.find(".plan--active").text()).toContain("当前活跃计划");
    expect(wrapper.find(".plan--active").text()).toContain("当前计划");
    expect(wrapper.find(".plan--active").text()).toContain("3/5");
    expect(wrapper.find(".plan--active").text()).toContain("阶段三完成");
  });

  it("空态「暂无计划」", async () => {
    const wrapper = mount(PlansPanel);
    await flushPromises();
    expect(wrapper.find(".plan-empty").exists()).toBe(true);
    expect(wrapper.text()).toContain("暂无计划");
  });
});

describe("SkillsPanel（未改造，保留原骨架断言）", () => {
  it("renders preset groups with agent/plugin/skill items", () => {
    const wrapper = mount(SkillsPanel);
    const groups = wrapper.findAll(".pgroup").map(s => s.text());
    expect(groups.join()).toContain("双星四 Agent");
    expect(groups.join()).toContain("分形插件");
    expect(groups.join()).toContain("技能包");
    const items = wrapper.findAll(".pitem");
    expect(items.length).toBeGreaterThanOrEqual(8);
    expect(wrapper.find(".switch").exists()).toBe(true);
  });
});
