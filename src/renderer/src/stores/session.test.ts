import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useSessionStore } from "./session";

describe("session store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
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
});
