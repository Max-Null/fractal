// TodoRecordCard 组件测试：默认折叠摘要 / 点击展开明细 / 时间格式化 / 完成计数
import { describe, it, expect, beforeEach } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import TodoRecordCard from "./TodoRecordCard.vue";
import type { TodoSnapshot } from "@/lib/electron-bridge";

const i18n = createI18n({
  legacy: false,
  locale: "en",
  messages: {
    en: {
      chat: {
        todoRecord: "Todos",
        todoRecordDone: "done",
      },
    },
  },
});

const baseSnap: TodoSnapshot = {
  round: 1,
  endedAt: 0,
  todos: [
    { content: "列出 docs 目录结构", status: "completed" },
    { content: "写测试", status: "cancelled" },
    { content: "收尾", status: "completed" },
  ],
  completedAll: true,
};

function mountCard(snapshot: TodoSnapshot = baseSnap): VueWrapper {
  return mount(TodoRecordCard, {
    props: { snapshot },
    global: { plugins: [i18n] },
  });
}

describe("TodoRecordCard", () => {
  it("默认折叠：显示「📋 待办 n/m 完成 · HH:mm」摘要，明细不渲染", () => {
    const wrapper = mountCard();
    // 完成数 = completed + cancelled = 3，共 3 项
    expect(wrapper.find(".todo-record-card__title").text()).toBe("Todos");
    expect(wrapper.find(".todo-record-card__count").text()).toContain("3/3");
    expect(wrapper.find(".todo-record-card__count").text()).toContain("done");
    expect(wrapper.find(".todo-record-card__list").exists()).toBe(false);
    expect(wrapper.find(".todo-record-card__header").attributes("aria-expanded")).toBe("false");
  });

  it("点击展开明细：completed ✓ / cancelled 灰删线；再点收起", async () => {
    const wrapper = mountCard();
    await wrapper.find(".todo-record-card__header").trigger("click");
    expect(wrapper.find(".todo-record-card__list").exists()).toBe(true);
    const chips = wrapper.findAll(".todo-record-chip");
    expect(chips).toHaveLength(3);
    expect(chips[0].classes()).toContain("todo-record-chip--completed");
    expect(chips[0].text()).toContain("列出 docs 目录结构");
    expect(chips[1].classes()).toContain("todo-record-chip--cancelled");
    expect(wrapper.find(".todo-record-card__header").attributes("aria-expanded")).toBe("true");

    await wrapper.find(".todo-record-card__header").trigger("click");
    expect(wrapper.find(".todo-record-card__list").exists()).toBe(false);
  });

  it("时间格式化：endedAt → HH:mm（本地时区）", () => {
    const d = new Date();
    d.setHours(14, 30, 0, 0);
    const snapshot = { ...baseSnap, endedAt: d.getTime() };
    const wrapper = mountCard(snapshot);
    expect(wrapper.find(".todo-record-card__time").text()).toBe("14:30");
  });
});
