import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { createI18n } from "vue-i18n";
import { useSessionStore } from "@/stores/session";
import { useChatStore } from "@/stores/chat";
import { useChatCommandBus, emitChatCommand } from "@/composables/useCommandPalette";
import SessionSidebar from "./SessionSidebar.vue";

// Mock electron-bridge：listSessions 必须 reject（与无 Electron 环境行为一致），
// 否则 SessionSidebar onMounted 的 loadSessions 会用空列表覆盖测试手动 push 的会话
const mockCreateSession = vi.fn();
vi.mock("@/lib/electron-bridge", () => ({
  listSessions: () => Promise.reject(new Error("not-ready")),
  stopSession: () => Promise.resolve(),
  createSession: (...args: unknown[]) => mockCreateSession(...args),
  setActiveSession: vi.fn(() => Promise.resolve()),
}));

// Mock vue-router：SessionSidebar 的 useRouter() 走 vue-router 的 Symbol 注入，
// provide: { router }（字符串键）无效——必须 mock useRouter 本身（2026-08-10 实测）
const { mockRouter, routerPush } = vi.hoisted(() => {
  const routerPush = vi.fn();
  return {
    routerPush,
    mockRouter: { push: routerPush, currentRoute: { value: { path: "/chat" } } },
  };
});
vi.mock("vue-router", () => ({ useRouter: () => mockRouter }));

const i18n = createI18n({
  legacy: false,
  locale: "en",
  messages: {
    en: {
      session: {
        title: "Sessions",
        new: "New session",
        search: "Search sessions…",
        rename: "Rename",
        delete: "Delete",
        clear: "Clear",
        noSessions: "No sessions yet. Click + above to create one",
        noMatching: "No matching sessions",
        alreadyNew: "Already a new session",
      },
    },
  },
});

// Stub router（vi.mock 提供 useRouter；此处保留兼容字段）
function mountSidebar() {
  return mount(SessionSidebar, {
    global: {
      plugins: [createPinia(), i18n],
    },
  });
}

describe("SessionSidebar", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    routerPush.mockClear();
    // chatCommand 是模块级 ref 跨用例共享——重置避免上个用例的 show-status 残留污染断言
    emitChatCommand("");
    mockCreateSession.mockReset();
    mockCreateSession.mockResolvedValue({
      id: "s-new",
      title: "New Chat",
      created_at: new Date().toISOString().slice(0, 19),
      updated_at: new Date().toISOString().slice(0, 19),
      message_count: 0,
      total_tokens: null,
      total_cost: null,
      mode: "cc",
    });
  });

  it("renders header with Sessions title", () => {
    const wrapper = mountSidebar();
    expect(wrapper.text()).toContain("Sessions");
  });

  it("renders new session button", () => {
    const wrapper = mountSidebar();
    const btn = wrapper.find("button[title='New session']");
    expect(btn.exists()).toBe(true);
  });

  it("renders search input", () => {
    const wrapper = mountSidebar();
    const input = wrapper.find("input[placeholder='Search sessions…']");
    expect(input.exists()).toBe(true);
  });

  it("shows empty state when no sessions", () => {
    const wrapper = mountSidebar();
    expect(wrapper.text()).toContain("No sessions yet");
  });

  it("filters sessions by title", async () => {
    const wrapper = mountSidebar();
    const store = useSessionStore();

    // Manually add sessions to the store (bypass backend)
    store.sessions.push(
      { id: "s1", title: "React Project", createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0, totalTokens: null, totalCost: null, mode: "cc" },
      { id: "s2", title: "Vue Docs", createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0, totalTokens: null, totalCost: null, mode: "cc" },
      { id: "s3", title: "Python Script", createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0, totalTokens: null, totalCost: null, mode: "cc" },
    );

    await wrapper.vm.$nextTick();

    // Should show all 3
    expect(wrapper.findAll("button[title='Rename']")).toHaveLength(3);

    // Type search query
    const input = wrapper.find("input[placeholder='Search sessions…']");
    await input.setValue("react");
    await wrapper.vm.$nextTick();

    // Should filter to 1
    const renameBtns = wrapper.findAll("button[title='Rename']");
    expect(renameBtns).toHaveLength(1);
    expect(wrapper.text()).toContain("React Project");
    expect(wrapper.text()).not.toContain("Vue Docs");
  });

  it("shows 'No matching sessions' when search has no results", async () => {
    const wrapper = mountSidebar();
    const store = useSessionStore();
    store.sessions.push(
      { id: "s1", title: "Hello", createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0, totalTokens: null, totalCost: null, mode: "cc" },
    );
    await wrapper.vm.$nextTick();

    const input = wrapper.find("input[placeholder='Search sessions…']");
    await input.setValue("xyz_not_found");
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain("No matching sessions");
  });

  it("clear button resets search", async () => {
    const wrapper = mountSidebar();
    const store = useSessionStore();
    store.sessions.push(
      { id: "s1", title: "Hello", createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0, totalTokens: null, totalCost: null, mode: "cc" },
    );
    await wrapper.vm.$nextTick();

    const input = wrapper.find("input[placeholder='Search sessions…']");
    await input.setValue("hello");
    await wrapper.vm.$nextTick();

    // Clear button should be visible
    const clearBtn = wrapper.find("button[title='Clear']");
    expect(clearBtn.exists()).toBe(true);

    await clearBtn.trigger("click");
    await wrapper.vm.$nextTick();

    // Should show all sessions again
    expect(wrapper.findAll("button[title='Rename']")).toHaveLength(1);
    expect((input.element as HTMLInputElement).value).toBe("");
  });

  it("new session button with empty current chat → emits show-status toast (not silently no-op)", async () => {
    const wrapper = mountSidebar();
    const { chatCommand } = useChatCommandBus();
    const btn = wrapper.find("button[title='New session']");
    await btn.trigger("click");
    await wrapper.vm.$nextTick();
    // 当前会话无消息 → 提示「已是新会话」，不创建不跳转（2026-08-10 反馈：按钮无效）
    expect(chatCommand.value.action).toBe("show-status:Already a new session");
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("new session button with non-empty current chat → creates session with current cwd", async () => {
    const wrapper = mountSidebar();
    const { chatCommand } = useChatCommandBus();
    const chat = useChatStore();
    chat.messages.push({
      id: "m1", role: "user", content: "hi", thinking: "", toolUses: [],
      timestamp: Date.now(), isStreaming: false,
    });
    await wrapper.vm.$nextTick();
    const btn = wrapper.find("button[title='New session']");
    await btn.trigger("click");
    await wrapper.vm.$nextTick();
    // 有消息 → 创建新会话（cwd 传 settings.cwd）+ 跳转 /chat
    expect(mockCreateSession).toHaveBeenCalledTimes(1);
    expect(routerPush).toHaveBeenCalledWith("/chat");
    expect(chatCommand.value.action).not.toContain("show-status");
  });
});
