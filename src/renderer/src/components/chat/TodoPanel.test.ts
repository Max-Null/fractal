// TodoPanel 组件测试：serve 原生 todo.updated → chat.todos 渲染（pending/in_progress/completed/cancelled + 空态）+ 折叠（B 方案）
import { describe, it, expect, beforeEach, vi } from "vitest";
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
        todoExpand: "Expand task list",
        todoCollapse: "Collapse task list",
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

  // ── 折叠（方案 B）：默认展开 / 点击折叠持久化 / 折叠态恢复 / 计数徽标 ──

  it("默认展开：列表可见 + 总数徽标显示全部 todo 数（不区分状态）", () => {
    const chat = useChatStore();
    chat.setTodos([
      { content: "A", status: "pending" },
      { content: "B", status: "completed" },
      { content: "C", status: "cancelled" },
    ]);
    const wrapper = mount(TodoPanel, { global: { plugins: [i18n] } });

    expect(wrapper.find(".todo-panel-list").exists()).toBe(true);
    expect(wrapper.find(".todo-panel-header").attributes("aria-expanded")).toBe("true");
    // 徽标 = 可见总数 3（cancelled 保留显示）
    expect(wrapper.find(".todo-count-badge").text()).toBe("3");
    // 展开态保留完成计数 1/3（原有功能）
    expect(wrapper.text()).toContain("1/3");
  });

  it("点击标题栏折叠 → 列表收起 + localStorage 写入 sb-todo-collapsed=1；再点展开恢复=0", async () => {
    const chat = useChatStore();
    chat.setTodos([{ content: "A", status: "pending" }]);
    const wrapper = mount(TodoPanel, { global: { plugins: [i18n] } });

    await wrapper.find(".todo-panel-header").trigger("click");
    // leave 动画（max-height 0.2s）结束后列表从 DOM 移除——waitFor 轮询避免依赖动画时序
    await vi.waitFor(() => {
      expect(wrapper.find(".todo-panel-list").exists()).toBe(false);
    });
    expect(wrapper.find(".todo-panel-header").attributes("aria-expanded")).toBe("false");
    expect(localStorage.getItem("sb-todo-collapsed")).toBe("1");
    // 折叠态标题栏仍显示（标题 + 徽标 + 箭头）
    expect(wrapper.find(".todo-panel-title").exists()).toBe(true);
    expect(wrapper.find(".todo-count-badge").text()).toBe("1");

    await wrapper.find(".todo-panel-header").trigger("click");
    await vi.waitFor(() => {
      expect(wrapper.find(".todo-panel-list").exists()).toBe(true);
    });
    expect(localStorage.getItem("sb-todo-collapsed")).toBe("0");
  });

  it("折叠态持久化：localStorage 预置 sb-todo-collapsed=1 → 挂载后默认折叠", () => {
    localStorage.setItem("sb-todo-collapsed", "1");
    const chat = useChatStore();
    chat.setTodos([{ content: "A", status: "pending" }]);
    const wrapper = mount(TodoPanel, { global: { plugins: [i18n] } });

    expect(wrapper.find(".todo-panel-header").attributes("aria-expanded")).toBe("false");
    expect(wrapper.find(".todo-panel-list").exists()).toBe(false);
    // 标题栏（含总数徽标）仍显示，仅列表收起
    expect(wrapper.find(".todo-count-badge").text()).toBe("1");
  });

  it("折叠态下 todos 新增/更新不强制重新展开（列表保持收起）", async () => {
    localStorage.setItem("sb-todo-collapsed", "1");
    const chat = useChatStore();
    chat.setTodos([{ content: "A", status: "pending" }]);
    const wrapper = mount(TodoPanel, { global: { plugins: [i18n] } });

    // todos 更新（新增一条）→ 列表仍收起，仅徽标数字变化
    chat.setTodos([
      { content: "A", status: "pending" },
      { content: "B", status: "in_progress" },
    ]);
    await vi.waitFor(() => {
      expect(wrapper.find(".todo-count-badge").text()).toBe("2");
    });
    expect(wrapper.find(".todo-panel-list").exists()).toBe(false);
  });
});
