// SubTaskHistoryList 测试：历史子任务入口的展开/收起、项渲染（去后缀/时长）、open emit
import { describe, it, expect, beforeEach } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import SubTaskHistoryList from "./SubTaskHistoryList.vue";
import type { HistorySubTask } from "@/stores/chat";

// 测试用最小 i18n（en locale：子任务计数/单位/兜底 agent 名）
const i18n = createI18n({
  legacy: false,
  locale: "en",
  messages: {
    en: {
      chat: {
        subTaskHistoryCount: "{n} sub-task(s)",
        subTaskHistoryUnit: "s",
        subTaskMonitorTitle: "Sub-agent running",
      },
    },
  },
});

/** 构造历史子任务项（title 带 serve 自动追加的 (@xx subagent) 后缀） */
function makeSub(id: string, over: Partial<HistorySubTask> = {}): HistorySubTask {
  return {
    id,
    agent: "工匠",
    title: "查看项目文档 (@general subagent)",
    createdAt: new Date("2026-01-01T10:30:00").getTime(),
    endedAt: new Date("2026-01-01T10:30:45").getTime(),
    ...over,
  };
}

function mountList(subTasks: HistorySubTask[]): VueWrapper {
  return mount(SubTaskHistoryList, {
    props: { subTasks },
    global: { plugins: [i18n] },
  });
}

describe("SubTaskHistoryList", () => {
  beforeEach(() => {});

  it("入口行显示子任务数量（2 sub-task(s)）", () => {
    const wrapper = mountList([makeSub("ses_a"), makeSub("ses_b")]);
    expect(wrapper.text()).toContain("2 sub-task(s)");
    // 默认收起：列表不渲染
    expect(wrapper.find(".subtask-history-item").exists()).toBe(false);
  });

  it("点击入口 → 展开列表；再点击 → 收起", async () => {
    const wrapper = mountList([makeSub("ses_a")]);
    const toggle = wrapper.find(".subtask-history-toggle");

    await toggle.trigger("click");
    expect(wrapper.find(".subtask-history-item").exists()).toBe(true);

    await toggle.trigger("click");
    expect(wrapper.find(".subtask-history-item").exists()).toBe(false);
  });

  it("项渲染：徽标 + agent 名 + 去后缀标题 + HH:mm 时间 + 时长秒数", () => {
    const wrapper = mountList([makeSub("ses_a")]);
    // 展开后检查项内容
    return wrapper.find(".subtask-history-toggle").trigger("click").then(() => {
      const item = wrapper.find(".subtask-history-item");
      const text = item.text();
      expect(text).toContain("👷"); // 工匠徽标
      expect(text).toContain("工匠");
      expect(text).toContain("查看项目文档"); // 去 (@general subagent) 后缀
      expect(text).not.toContain("subagent");
      expect(text).toContain("10:30"); // HH:mm
      expect(text).toContain("45s"); // 45 秒
    });
  });

  it("agent 为空 → 徽标 🤖 + 显示「Sub-agent running」兜底", () => {
    const wrapper = mountList([makeSub("ses_a", { agent: "" })]);
    return wrapper.find(".subtask-history-toggle").trigger("click").then(() => {
      const text = wrapper.find(".subtask-history-item").text();
      expect(text).toContain("🤖");
      expect(text).toContain("Sub-agent running");
    });
  });

  it("无 endedAt → 时长显示 0s", () => {
    const wrapper = mountList([makeSub("ses_a", { endedAt: undefined })]);
    return wrapper.find(".subtask-history-toggle").trigger("click").then(() => {
      expect(wrapper.find(".subtask-history-item").text()).toContain("0s");
    });
  });

  it("点击列表项 → emit('open', subId)", async () => {
    const wrapper = mountList([makeSub("ses_a")]);
    await wrapper.find(".subtask-history-toggle").trigger("click");
    await wrapper.find(".subtask-history-item").trigger("click");
    expect(wrapper.emitted("open")).toBeTruthy();
    expect(wrapper.emitted("open")![0]).toEqual(["ses_a"]);
  });

  it("多个子任务 → 全部渲染（按传入顺序）", async () => {
    const wrapper = mountList([makeSub("ses_a"), makeSub("ses_b", { id: "ses_b", agent: "军师", title: "生成测试 (@craftsman subagent)" })]);
    await wrapper.find(".subtask-history-toggle").trigger("click");
    const items = wrapper.findAll(".subtask-history-item");
    expect(items).toHaveLength(2);
    expect(items[1].text()).toContain("🧭"); // 军师徽标
  });
});
