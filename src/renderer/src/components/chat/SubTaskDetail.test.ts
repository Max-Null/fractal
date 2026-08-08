// SubTaskDetail 状态头测试：实时 running/done + 历史场景（subTasks 无记录）不再误显「运行中」
// 覆盖用户反馈：历史会话详情弹窗显示「运行中」bug——subTasks 缺失时默认 running
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import SubTaskDetail from "./SubTaskDetail.vue";
import { useChatStore } from "@/stores/chat";

// mock electron-bridge：listMessages（详情消息拉取）+ session store 初始化所需
const listMessagesMock = vi.fn();
vi.mock("@/lib/electron-bridge", () => ({
  listMessages: (...args: unknown[]) => listMessagesMock(...args),
  listSessions: vi.fn().mockResolvedValue([]),
  setActiveSession: vi.fn().mockResolvedValue({ ok: true }),
}));

const i18n = createI18n({
  legacy: false,
  locale: "en",
  messages: {
    en: {
      chat: {
        subTaskLoading: "Loading",
        subTaskNoContent: "No content",
        subTaskThinking: "Thinking",
        subTaskBackToParent: "Back to parent",
      },
      modal: { close: "Close" },
    },
  },
});

function mountDetail(subId: string) {
  return mount(SubTaskDetail, {
    props: { subId },
    // ModalShell 用 Teleport to body；stub teleport 原地渲染，wrapper.text() 可直接断言
    global: { stubs: { teleport: true }, plugins: [i18n] },
  });
}

describe("SubTaskDetail 状态头", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    listMessagesMock.mockReset();
    listMessagesMock.mockResolvedValue([]);
  });

  it("历史场景（chat.subTasks 无记录）：显示「✅ 已完成 · 历史记录」，不显示「🔄 运行中」", async () => {
    const wrapper = mountDetail("ses_history_1");
    await flushPromises();
    expect(wrapper.text()).toContain("✅ 已完成 · 历史记录");
    expect(wrapper.text()).not.toContain("🔄 运行中");
  });

  it("实时 done：显示「✅ 已完成」，不显示「历史记录」后缀", async () => {
    const chat = useChatStore();
    chat.subTasks["sub-live-done"] = {
      id: "sub-live-done",
      agent: "工匠",
      status: "done",
      deltaText: "",
      parts: [],
      startedAt: Date.now() - 5000,
      endedAt: Date.now(),
      summary: "摘要",
    };
    const wrapper = mountDetail("sub-live-done");
    await flushPromises();
    expect(wrapper.text()).toContain("✅ 已完成");
    expect(wrapper.text()).not.toContain("历史记录");
  });

  it("实时 running：显示「🔄 运行中」（回归）", async () => {
    const chat = useChatStore();
    chat.subTasks["sub-live-run"] = {
      id: "sub-live-run",
      agent: "工匠",
      status: "running",
      deltaText: "工作中",
      parts: [],
      startedAt: Date.now() - 3000,
    };
    const wrapper = mountDetail("sub-live-run");
    await flushPromises();
    expect(wrapper.text()).toContain("🔄 运行中");
    expect(wrapper.text()).not.toContain("历史记录");
  });
});
