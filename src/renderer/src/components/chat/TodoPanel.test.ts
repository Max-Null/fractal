// TodoPanel 组件测试（规格 D1-D10 重构后）：折叠态当前项/hover 展开收起/自动展开 15s/状态样式/面板隐藏
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { createI18n } from "vue-i18n";
import { nextTick } from "vue";
import { useChatStore } from "@/stores/chat";
import TodoPanel from "./TodoPanel.vue";

const i18n = createI18n({
  legacy: false,
  locale: "en",
  messages: {
    en: {
      chat: {
        todos: "Task List",
        todoExpand: "Expand task list",
        todoCollapse: "Collapse task list",
        noTodos: "No tasks yet",
      },
    },
  },
});

let pinia: Pinia;
beforeEach(() => {
  localStorage.clear();
  pinia = createPinia();
  setActivePinia(pinia);
});
afterEach(() => {
  vi.useRealTimers();
});

function mountPanel(): VueWrapper {
  return mount(TodoPanel, { global: { plugins: [i18n] } });
}

describe("TodoPanel（折叠态 D1）", () => {
  it("折叠态显示当前任务：第一个 in_progress 序号 = visibleTodos 中 index+1", async () => {
    const chat = useChatStore();
    // 4 项，第 2 项 in_progress（序号 ②，总数 ④）
    chat.setTodos([
      { content: "任务一", status: "completed" },
      { content: "列出 docs 目录结构", status: "in_progress" },
      { content: "写测试", status: "pending" },
      { content: "收尾", status: "pending" },
    ]);
    const wrapper = mountPanel();
    await nextTick();
    expect(wrapper.find(".todo-panel-collapsed").exists()).toBe(true);
    expect(wrapper.find(".todo-current").text()).toContain("②");
    expect(wrapper.find(".todo-current").text()).toContain("④");
    expect(wrapper.find(".todo-current-text").text()).toBe("列出 docs 目录结构");
  });

  it("无 in_progress → 第一 pending 作为当前项", async () => {
    const chat = useChatStore();
    chat.setTodos([
      { content: "甲", status: "pending" },
      { content: "乙", status: "pending" },
    ]);
    const wrapper = mountPanel();
    await nextTick();
    expect(wrapper.find(".todo-current").text()).toContain("①");
    expect(wrapper.find(".todo-current-text").text()).toBe("甲");
  });

  it("折叠态无 todo → 空态提示（不显示序号）", async () => {
    const wrapper = mountPanel();
    await nextTick();
    expect(wrapper.find(".todo-panel-empty").exists()).toBe(true);
    expect(wrapper.find(".todo-current").exists()).toBe(false);
  });

  it("默认折叠：列表不渲染（todos 在 mount 前已设 → 不触发自动展开）", async () => {
    const chat = useChatStore();
    chat.setTodos([{ content: "a", status: "pending" }]);
    const wrapper = mountPanel();
    await nextTick();
    expect(wrapper.find(".todo-panel-list").exists()).toBe(false);
  });
});

describe("TodoPanel（hover 展开/收起 D4）", () => {
  it("mouseenter 展开 / mouseleave 收起（删除点击 toggle）", async () => {
    const chat = useChatStore();
    chat.setTodos([{ content: "a", status: "pending" }]);
    const wrapper = mountPanel();
    await nextTick();
    expect(wrapper.find(".todo-panel-list").exists()).toBe(false);

    await wrapper.find(".todo-panel").trigger("mouseenter");
    await nextTick();
    expect(wrapper.find(".todo-panel-list").exists()).toBe(true);

    await wrapper.find(".todo-panel").trigger("mouseleave");
    await nextTick();
    expect(wrapper.find(".todo-panel-list").exists()).toBe(false);
  });
});

describe("TodoPanel（自动展开 15s D2/D3）", () => {
  it("todos 变化 → 自动展开；15s 无变化 → 收起", async () => {
    vi.useFakeTimers();
    const chat = useChatStore();
    const wrapper = mountPanel();
    await nextTick();
    expect(wrapper.find(".todo-panel-list").exists()).toBe(false);

    // todos 变化触发自动展开
    chat.setTodos([{ content: "新任务", status: "pending" }]);
    await nextTick();
    expect(wrapper.find(".todo-panel-list").exists()).toBe(true);

    // 15s 到点自动收起
    vi.advanceTimersByTime(15_000);
    await nextTick();
    expect(wrapper.find(".todo-panel-list").exists()).toBe(false);
  });

  it("频繁变化续期：15s 内再次变化 → 计时重置", async () => {
    vi.useFakeTimers();
    const chat = useChatStore();
    const wrapper = mountPanel();
    await nextTick();

    chat.setTodos([{ content: "第一轮", status: "pending" }]);
    await nextTick();
    // 10s 后再次变化（重置 15s 计时）
    vi.advanceTimersByTime(10_000);
    chat.setTodos([{ content: "第二轮", status: "in_progress" }]);
    await nextTick();
    // 从第二次变化算 10s（距首次 20s）→ 仍展开
    vi.advanceTimersByTime(10_000);
    await nextTick();
    expect(wrapper.find(".todo-panel-list").exists()).toBe(true);
    // 再 5s（距第二次 15s）→ 收起
    vi.advanceTimersByTime(5_000);
    await nextTick();
    expect(wrapper.find(".todo-panel-list").exists()).toBe(false);
  });

  it("15s 到点鼠标在面板内（hover 在场）→ 保持展开", async () => {
    vi.useFakeTimers();
    const chat = useChatStore();
    const wrapper = mountPanel();
    await nextTick();

    chat.setTodos([{ content: "任务", status: "pending" }]);
    await nextTick();
    await wrapper.find(".todo-panel").trigger("mouseenter");
    await nextTick();
    vi.advanceTimersByTime(15_000);
    await nextTick();
    // autoExpanded=false，但 hoverExpanded=true → expanded 仍 true
    expect(wrapper.find(".todo-panel-list").exists()).toBe(true);

    // mouseleave → 真正收起
    await wrapper.find(".todo-panel").trigger("mouseleave");
    await nextTick();
    expect(wrapper.find(".todo-panel-list").exists()).toBe(false);
  });
});

describe("TodoPanel（状态样式 D5）", () => {
  it("chip 按状态渲染对应 class（completed/in_progress/pending/cancelled）", async () => {
    const chat = useChatStore();
    chat.setTodos([
      { content: "完成项", status: "completed" },
      { content: "进行中", status: "in_progress" },
      { content: "待办", status: "pending" },
      { content: "取消项", status: "cancelled" },
    ]);
    const wrapper = mountPanel();
    await nextTick();
    await wrapper.find(".todo-panel").trigger("mouseenter");
    await nextTick();
    const chips = wrapper.findAll(".todo-chip");
    expect(chips).toHaveLength(4);
    expect(chips[0].classes()).toContain("todo-chip--completed");
    expect(chips[1].classes()).toContain("todo-chip--in_progress");
    expect(chips[2].classes()).toContain("todo-chip--pending");
    expect(chips[3].classes()).toContain("todo-chip--cancelled");
  });
});

describe("TodoPanel（面板隐藏 D10）", () => {
  it("全部完成且已有快照 → 活动面板不渲染（记录卡替代）", async () => {
    const chat = useChatStore();
    chat.setTodos([
      { content: "甲", status: "completed" },
      { content: "乙", status: "completed" },
    ]);
    chat.pushTodoSnapshot({ round: 1, endedAt: 1, todos: [], completedAll: true });
    const wrapper = mountPanel();
    await nextTick();
    expect(wrapper.find(".todo-panel").exists()).toBe(false);
    expect(wrapper.find(".todo-panel-collapsed").exists()).toBe(false);
  });

  it("全部完成但无快照（回合收尾中）→ 面板仍显示（避免闪现空白）", async () => {
    const chat = useChatStore();
    chat.setTodos([{ content: "甲", status: "completed" }]);
    const wrapper = mountPanel();
    await nextTick();
    expect(wrapper.find(".todo-panel").exists()).toBe(true);
  });

  it("部分完成 → 面板显示折叠态（不隐藏、不生成记录卡逻辑在 chat store）", async () => {
    const chat = useChatStore();
    chat.setTodos([
      { content: "做完的", status: "completed" },
      { content: "没做完的", status: "pending" },
    ]);
    const wrapper = mountPanel();
    await nextTick();
    expect(wrapper.find(".todo-panel").exists()).toBe(true);
    expect(wrapper.find(".todo-panel-collapsed").exists()).toBe(true);
  });
});
