// useSessionSwitch 首屏分页测试：DB 拉取带 limit=50，返回满 50 条 → hasMoreHistory=true
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useChatStore } from "@/stores/chat";
import { useSessionStore } from "@/stores/session";
import { useSessionSwitch } from "./useSessionSwitch";

const listMessagesMock = vi.fn();
vi.mock("vue-router", () => ({
  useRouter: () => ({ push: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock("@/lib/electron-bridge", () => ({
  listMessages: (...args: unknown[]) => listMessagesMock(...args),
}));

/** 构造 N 条升序历史消息（m0 最旧） */
function makeMsgs(n: number): Array<{ id: string; role: string; content: string; created_at: string }> {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    role: "user",
    content: `msg ${i}`,
    created_at: `2026-01-01T00:${String(i % 60).padStart(2, "0")}:00`,
  }));
}

describe("useSessionSwitch 首屏分页", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    listMessagesMock.mockReset();
    listMessagesMock.mockResolvedValue([]);
  });

  it("DB 拉取带 limit=50；返回满 50 条 → hasMoreHistory=true 且消息还原", async () => {
    const chat = useChatStore();
    // 不预置 activeSessionId（prevId=null → 无缓存，直接走 DB 拉取分支）
    listMessagesMock.mockResolvedValue(makeMsgs(50));

    const { switchTo } = useSessionSwitch();
    await switchTo("ses-1");

    expect(listMessagesMock).toHaveBeenCalledWith("ses-1", { limit: 50 });
    expect(chat.hasMoreHistory).toBe(true);
    expect(chat.messages).toHaveLength(50);
    expect(chat.messages[0].id).toBe("m0");
    expect(chat.messages[49].id).toBe("m49");
    // 首屏加载完成 → 退出加载态
    expect(chat.historyLoading).toBe(false);
  });

  it("返回 <50 条（如 10 条）→ hasMoreHistory=false（已到顶）", async () => {
    const chat = useChatStore();
    listMessagesMock.mockResolvedValue(makeMsgs(10));

    const { switchTo } = useSessionSwitch();
    await switchTo("ses-2");

    expect(listMessagesMock).toHaveBeenCalledWith("ses-2", { limit: 50 });
    expect(chat.hasMoreHistory).toBe(false);
    expect(chat.messages).toHaveLength(10);
  });

  it("切换竞态：拉取期间切到其他会话 → 过期结果丢弃", async () => {
    const chat = useChatStore();
    const session = useSessionStore();

    // 延迟 resolve：等待期间切到 ses-2，然后 resolve 过期结果
    let resolveFn: (v: unknown) => void = () => {};
    listMessagesMock.mockReturnValue(new Promise((res) => { resolveFn = res; }));

    const { switchTo } = useSessionSwitch();
    const pending = switchTo("ses-1");
    // doSwitch 已 setActiveSession("ses-1") 并开始拉取，此时模拟用户切到 ses-2
    session.setActiveSession("ses-2");
    resolveFn(makeMsgs(50));
    await pending;

    // 过期结果被 guard 丢弃：当前会话（ses-2）没有 ses-1 的消息
    expect(chat.messages).toHaveLength(0);
    expect(chat.hasMoreHistory).toBe(false);
  });
});
