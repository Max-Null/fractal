import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";

import MemoryPanel from "./MemoryPanel.vue";
import StatusPanel from "./StatusPanel.vue";
import PlansPanel from "./PlansPanel.vue";
import SkillsPanel from "./SkillsPanel.vue";

// 骨架组件均为纯静态占位 UI，无外部依赖，直接 mount 验证结构完整性

describe("panel skeletons", () => {
  it("MemoryPanel renders search row, chips and three memory layer groups", () => {
    const wrapper = mount(MemoryPanel);
    expect(wrapper.find("input.search-row-input").exists()).toBe(true);
    expect(wrapper.findAll("button.chip").length).toBe(4);
    // 三层记忆分组：全局 / 项目 / 会话
    const groups = wrapper.findAll(".mem-group-head span:first-child").map(s => s.text());
    expect(groups).toHaveLength(3);
    expect(groups.join()).toContain("全局记忆");
    expect(groups.join()).toContain("项目记忆");
    expect(groups.join()).toContain("会话记忆");
    // 空态提示：阶段 6 接入
    expect(wrapper.text()).toContain("阶段 6 接入");
  });

  it("StatusPanel renders engine/trigger-line stat cards with placeholder data", () => {
    const wrapper = mount(StatusPanel);
    const cards = wrapper.findAll(".stat-card");
    expect(cards.length).toBeGreaterThanOrEqual(5);
    expect(wrapper.text()).toContain("引擎");
    expect(wrapper.text()).toContain("断言计数");
    expect(wrapper.text()).toContain("计划进度");
    // 占位值
    expect(wrapper.text()).toContain("未运行");
  });

  it("PlansPanel renders plan card skeleton with title/status/progress", () => {
    const wrapper = mount(PlansPanel);
    expect(wrapper.find(".plan").exists()).toBe(true);
    expect(wrapper.find(".plan-title").text()).toContain("计划");
    expect(wrapper.find(".plan-status").exists()).toBe(true);
    expect(wrapper.find(".bar-track").exists()).toBe(true);
    expect(wrapper.find(".plan-pct").exists()).toBe(true);
    expect(wrapper.find(".pstep").exists()).toBe(true);
  });

  it("SkillsPanel renders preset groups with agent/plugin/skill items", () => {
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
