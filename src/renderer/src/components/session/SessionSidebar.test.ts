import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { createI18n } from "vue-i18n";
import { useSessionStore } from "@/stores/session";
import SessionSidebar from "./SessionSidebar.vue";

// Mock electron-bridge：listSessions 必须 reject（与无 Electron 环境行为一致），
// 否则 SessionSidebar onMounted 的 loadSessions 会用空列表覆盖测试手动 push 的会话
vi.mock("@/lib/electron-bridge", () => ({
  listSessions: () => Promise.reject(new Error("not-ready")),
  stopSession: () => Promise.resolve(),
}));

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
      },
    },
  },
});

// Stub router
const routerPush = vi.fn();
const mockRouter = {
  push: routerPush,
  currentRoute: { value: { path: "/chat" } },
};

function mountSidebar() {
  return mount(SessionSidebar, {
    global: {
      stubs: { "vue-router": true },
      provide: {
        router: mockRouter,
      },
      plugins: [createPinia(), i18n],
    },
  });
}

describe("SessionSidebar", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    routerPush.mockClear();
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
});
