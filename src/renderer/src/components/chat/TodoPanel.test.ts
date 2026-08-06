// TodoPanel 组件测试：serve 原生 todo.updated → chat.todos 渲染（pending/in_progress/completed/cancelled + 空态）
import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import TodoPanel from "./TodoPanel.vue";
import { useChatStore } from "@/stores/chat";

const i18n = createI18n({
  legacy: false,
  locale: "en",
  messages: {
    en: {
      chat: {
        todos: "Task List",
        noTodos: "No tasks yet",
      },
    },
  },
});

describe("TodoPanel", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it("空态显示「暂无待办任务」", () => {
    const wrapper = mount(TodoPanel, { global: { plugins: [i18n] } });
    expect(wrapper.text()).toContain("No tasks yet");
    expect(wrapper.find(".todo-chip").exists()).toBe(false);
  });

  it("渲染 pending / in_progress / completed 三种状态（图标 ☐ ● ☑ + 完成计数）", () => {
    const chat = useChatStore();
    chat.setTodos([
      { content: "写 README", status: "pending", priority: "high" },
      { content: "运行测试", status: "in_progress", priority: "high" },
      { content: "git 提交", status: "completed", priority: "low" },
    ]);
    const wrapper = mount(TodoPanel, { global: { plugins: [i18n] } });

    expect(wrapper.text()).toContain("写 README");
    expect(wrapper.text()).toContain("运行测试");
    expect(wrapper.text()).toContain("git 提交");
    // 完成计数 1/3
    expect(wrapper.text()).toContain("1/3");

    const statuses = wrapper.findAll(".todo-chip-status").map(s => s.text());
    expect(statuses[0]).toBe("☐");
    expect(statuses[1]).toBe("●");
    expect(statuses[2]).toBe("☑");
    // 进行中展示 activeForm（即 content 兜底）
    expect(wrapper.find(".todo-chip--in_progress").text()).toContain("运行测试");
  });

  it("cancelled 状态灰掉显示（不隐藏）", () => {
    const chat = useChatStore();
    chat.setTodos([
      { content: "已取消任务", status: "cancelled" },
      { content: "正常任务", status: "pending" },
    ]);
    const wrapper = mount(TodoPanel, { global: { plugins: [i18n] } });

    expect(wrapper.text()).toContain("已取消任务");
    const cancelledChip = wrapper.find(".todo-chip--cancelled");
    expect(cancelledChip.exists()).toBe(true);
    expect(cancelledChip.text()).toContain("✕");
  });

  it("deleted 状态被过滤（不渲染）", () => {
    const chat = useChatStore();
    chat.todos.push({ content: "hidden", status: "deleted", activeForm: "hidden" });
    const wrapper = mount(TodoPanel, { global: { plugins: [i18n] } });

    expect(wrapper.text()).toContain("No tasks yet");
    expect(wrapper.text()).not.toContain("hidden");
  });
});
