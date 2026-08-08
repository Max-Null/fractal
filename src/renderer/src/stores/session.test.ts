import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useSessionStore } from "./session";

// mock electron-bridge：仅覆盖 listSessions（sessionsLoading/竞态用例），其余保留原模块
const { listSessionsMock } = vi.hoisted(() => ({ listSessionsMock: vi.fn() }));
vi.mock("@/lib/electron-bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/electron-bridge")>();
  return { ...actual, listSessions: listSessionsMock };
});

describe("session store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    listSessionsMock.mockReset();
  });

  it("starts with empty active session", () => {
    const session = useSessionStore();
    expect(session.activeSessionId).toBe("");
    expect(session.sessions).toHaveLength(0);
  });

  it("creates a session and sets it active", async () => {
    const session = useSessionStore();
    const id = await session.createSession();

    expect(session.sessions).toHaveLength(1);
    expect(session.activeSessionId).toBe(id);
    expect(session.sessions[0].title).toBe("新会话");
  });

  it("switches active session", async () => {
    const session = useSessionStore();
    const id1 = await session.createSession();
    const id2 = await session.createSession();

    expect(session.activeSessionId).toBe(id2);
    session.setActiveSession(id1);
    expect(session.activeSessionId).toBe(id1);
  });

  it("renames session", async () => {
    const session = useSessionStore();
    const id = await session.createSession();

    await session.renameSession(id, "Debug Session");
    expect(session.sessions[0].title).toBe("Debug Session");
  });

  it("sessionsLoading：挂起请求期间为 true，完成后 false（空态加载中提示依赖）", async () => {
    let resolveList!: (v: unknown[]) => void;
    listSessionsMock.mockReturnValue(new Promise((r) => { resolveList = r; }));
    const session = useSessionStore();

    const p = session.loadSessions("H:\\proj");
    expect(session.sessionsLoading).toBe(true);

    resolveList([]);
    await p;
    expect(session.sessionsLoading).toBe(false);
  });

  it("loadSeq 竞态：先发旧工作区请求后发新工作区请求 → 只有最后一次结果生效", async () => {
    // 旧工作区请求挂起（serve 慢），新工作区请求先返回（快）
    let resolveOld!: (v: unknown[]) => void;
    listSessionsMock
      .mockReturnValueOnce(new Promise((r) => { resolveOld = r; })) // 第一次（旧工作区）
      .mockResolvedValueOnce([{ id: "s2", cwd: "H:\\new-proj" }]);     // 第二次（新工作区）
    const session = useSessionStore();

    const oldP = session.loadSessions("H:\\old-proj");
    const newP = session.loadSessions("H:\\new-proj");
    await newP; // 新请求先完成
    resolveOld([]); // 旧请求后完成——结果必须被丢弃
    await oldP;

    expect(session.sessions).toHaveLength(1);
    expect(session.sessions[0].id).toBe("s2");
  });
});
