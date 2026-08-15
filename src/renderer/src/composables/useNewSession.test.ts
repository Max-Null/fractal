import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useNewSession } from "./useNewSession";
import { useSessionStore } from "@/stores/session";
import { useChatStore } from "@/stores/chat";
import { useSettingsStore } from "@/stores/settings";
import { useSessionDrafts } from "./useSessionDrafts";
import { emitChatCommand, useChatCommandBus } from "@/composables/useCommandPalette";

// mock vue-router：useNewSession 内部 router.push("/chat")；useSessionSwitch 里 .catch() 需要 Promise 返回值
const mockRouterPush = vi.fn(() => Promise.resolve());
vi.mock("vue-router", () => ({
  useRouter: () => ({ push: mockRouterPush }),
}));

// mock electron-bridge：session store 的 createSession 走 backend，返回后端会话形状
const mockCreateSessionBackend = vi.fn();
const mockListMessages = vi.fn();
vi.mock("@/lib/electron-bridge", () => ({
  createSession: (...args: unknown[]) => mockCreateSessionBackend(...args),
  setActiveSession: vi.fn(() => Promise.resolve()),
  listSessions: vi.fn(() => Promise.resolve([])),
  listMessages: (...args: unknown[]) => mockListMessages(...args),
  loadProviderConfigs: vi.fn(() => Promise.resolve({})),
  loadUiSettings: vi.fn(() => Promise.resolve("{}")),
  saveUiSettings: vi.fn(() => Promise.resolve()),
  listDir: vi.fn(() => Promise.resolve([])),
}));

/** 最小可用用户消息（handleNew 只检查 messages.length） */
function userMsg() {
  return {
    id: "m1", role: "user" as const, content: "hi", thinking: "", toolUses: [],
    timestamp: Date.now(), isStreaming: false,
  };
}

function mockBackendOk() {
  mockCreateSessionBackend.mockResolvedValue({
    id: "s-new",
    title: "New Chat",
    created_at: new Date().toISOString().slice(0, 19),
    updated_at: new Date().toISOString().slice(0, 19),
    message_count: 0,
    total_tokens: null,
    total_cost: null,
    mode: "cc",
  });
}

describe("useNewSession", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockRouterPush.mockClear();
    mockCreateSessionBackend.mockReset();
    mockListMessages.mockReset();
    mockListMessages.mockResolvedValue([]);
    mockBackendOk();
    // chatCommand 是模块级 ref 跨用例共享——重置避免上个用例的 draft-migrated 残留污染断言
    emitChatCommand("");
  });

  it("当前会话无消息 → current-empty（不创建、不跳转）", async () => {
    const { handleNew } = useNewSession();
    const res = await handleNew();
    expect(res).toBe("current-empty");
    expect(mockCreateSessionBackend).not.toHaveBeenCalled();
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it("当前会话有消息 → 创建新会话（cwd 绑 settings.cwd），清空消息并跳转 /chat", async () => {
    const settings = useSettingsStore();
    settings.cwd = "C:\\proj\\a";
    const chat = useChatStore();
    chat.messages.push(userMsg());

    const { handleNew } = useNewSession();
    const res = await handleNew();
    expect(res).toBe("created");
    // cwd 必须传给后端：会话跟随工作区，否则列表按工作区过滤后看不到。
    // 注意后端第 4 参是 title（未显式传=undefined）；locale 在 session store 内只用于生成默认标题
    expect(mockCreateSessionBackend).toHaveBeenCalledWith(settings.model, "C:\\proj\\a", undefined, undefined);
    expect(chat.messages.length).toBe(0);
    expect(mockRouterPush).toHaveBeenCalledWith("/chat");
  });

  it("列表最近会话是空会话 → 跳转复用（不创建，2026-08-15 用户确认：重启后最近空会话应复用）", async () => {
    const session = useSessionStore();
    const chat = useChatStore();
    // 当前会话有消息；列表最近（updatedAt 最大）会话是空会话
    chat.messages.push(userMsg());
    session.sessions.push(
      { id: "s-old", title: "旧会话", createdAt: 100, updatedAt: 100, messageCount: 5, totalTokens: null, totalCost: null, mode: "cc" },
      { id: "s-latest", title: "New Chat", createdAt: 200, updatedAt: 200, messageCount: 0, totalTokens: null, totalCost: null, mode: "cc" },
    );
    session.setActiveSession("s-old");

    const { handleNew } = useNewSession();
    const res = await handleNew();
    // 语义：跳转复用 s-latest，不创建新会话
    expect(res).toBe("jumped");
    expect(mockCreateSessionBackend).not.toHaveBeenCalled();
    expect(session.activeSessionId).toBe("s-latest");
  });

  it("列表最近会话非空 → 创建全新会话（空会话已清理/不复用）", async () => {
    const session = useSessionStore();
    const chat = useChatStore();
    chat.messages.push(userMsg());
    // 列表所有会话都有消息（无空会话可复用）
    session.sessions.push(
      { id: "s-a", title: "A", createdAt: 100, updatedAt: 100, messageCount: 3, totalTokens: null, totalCost: null, mode: "cc" },
    );
    session.setActiveSession("s-a");

    const { handleNew } = useNewSession();
    const res = await handleNew();
    expect(res).toBe("created");
    expect(mockCreateSessionBackend).toHaveBeenCalledTimes(1);
    expect(session.activeSessionId).toBe("s-new");
  });

  it("首页无会话草稿：新建成功后迁移到新会话并发 draft-migrated 事件", async () => {
    const drafts = useSessionDrafts();
    drafts._resetForTest();
    const chat = useChatStore();
    const { chatCommand } = useChatCommandBus();
    chat.messages.push(userMsg());
    // 首页草稿（NONE 槽）预置
    drafts.saveDraft(null, { text: "首页草稿", files: [], snippet: null });

    const { handleNew } = useNewSession();
    const res = await handleNew();
    expect(res).toBe("created");
    // NONE 槽草稿迁移到新会话（s-new 是 mock createSession 返回的 id）
    expect(drafts.getDraft("s-new").text).toBe("首页草稿");
    expect(drafts.hasDraft(null)).toBe(false);
    // draft-migrated 事件发出（ChatPanel 收到后重新恢复输入态）
    expect(chatCommand.value.action).toBe("draft-migrated");
  });

  it("无首页草稿：新建不迁移、不发 draft-migrated 事件", async () => {
    const drafts = useSessionDrafts();
    drafts._resetForTest();
    const chat = useChatStore();
    const { chatCommand } = useChatCommandBus();
    chat.messages.push(userMsg());

    const { handleNew } = useNewSession();
    await handleNew();
    expect(drafts.hasDraft(null)).toBe(false);
    expect(chatCommand.value.action).not.toBe("draft-migrated");
  });
});
