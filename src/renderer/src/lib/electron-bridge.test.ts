// electron-bridge 引擎桥单元测试：验证 IPC 参数转换与通道调用（mock window.electronBridge）
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  sendMessage,
  respondPermission,
  forkSession,
  testConnection,
  listMessages,
  type SendOptions,
} from "./electron-bridge";

// 桩 window.electronBridge.invoke：记录通道与参数，返回可编程结果
const invokeMock = vi.fn();
beforeEach(() => {
  invokeMock.mockReset();
  (window as unknown as { electronBridge: unknown }).electronBridge = {
    invoke: invokeMock,
    on: vi.fn().mockReturnValue(() => {}),
  };
});

describe("sendMessage（model 参数转换）", () => {
  it("带 [1M] 后缀的 CC 模型名 → 拆分 {providerID:'ds', modelID}（去上下文标注，serve 无 [1M]）", async () => {
    invokeMock.mockResolvedValue({ accepted: true });
    await sendMessage("ses-1", "你好", { model: "deepseek-v4-pro[1M]" } as SendOptions);
    expect(invokeMock).toHaveBeenCalledWith("chat:sendMessage", {
      sessionId: "ses-1",
      message: "你好",
      model: { providerID: "deepseek", modelID: "deepseek-v4-pro" },
    });
  });

  it("带 provider 前缀的模型名 → 原样拆分", async () => {
    invokeMock.mockResolvedValue({ accepted: true });
    await sendMessage("ses-1", "hi", { model: "deepseek/deepseek-v4-flash" } as SendOptions);
    expect(invokeMock).toHaveBeenCalledWith("chat:sendMessage", {
      sessionId: "ses-1",
      message: "hi",
      model: { providerID: "deepseek", modelID: "deepseek-v4-flash" },
    });
  });

  it("无 model 参数 → 不传 model（主进程用默认 pro）", async () => {
    invokeMock.mockResolvedValue({ accepted: true });
    await sendMessage("ses-1", "hi");
    expect(invokeMock).toHaveBeenCalledWith("chat:sendMessage", { sessionId: "ses-1", message: "hi" });
  });

  it("agent 参数 → 原样透传给主进程", async () => {
    invokeMock.mockResolvedValue({ accepted: true });
    await sendMessage("ses-1", "hi", { agent: "双星" } as SendOptions);
    expect(invokeMock).toHaveBeenCalledWith("chat:sendMessage", {
      sessionId: "ses-1",
      message: "hi",
      agent: "双星",
    });
  });
});

describe("respondPermission（审批响应）", () => {
  it("once 允许 → permission:respond 通道带三参数", async () => {
    invokeMock.mockResolvedValue({ responded: true });
    await respondPermission("ses-1", "perm-1", "once");
    expect(invokeMock).toHaveBeenCalledWith("permission:respond", {
      sessionId: "ses-1",
      permissionId: "perm-1",
      response: "once",
    });
  });

  it("reject 拒绝 → response='reject'", async () => {
    invokeMock.mockResolvedValue({ responded: true });
    await respondPermission("ses-1", "perm-2", "reject");
    expect(invokeMock).toHaveBeenCalledWith("permission:respond", {
      sessionId: "ses-1",
      permissionId: "perm-2",
      response: "reject",
    });
  });
});

describe("forkSession / testConnection / listMessages（IPC 直连）", () => {
  it("forkSession 默认不传 messageID（前端本地 id 非 OC messageID）", async () => {
    invokeMock.mockResolvedValue({ id: "ses_fork" });
    await forkSession("ses-1");
    expect(invokeMock).toHaveBeenCalledWith("session:fork", { id: "ses-1" });
  });

  it("testConnection 传 apiKey", async () => {
    invokeMock.mockResolvedValue({ ok: true, message: "就绪" });
    await testConnection("sk-test");
    expect(invokeMock).toHaveBeenCalledWith("engine:testConnection", { apiKey: "sk-test" });
  });

  it("listMessages 传 sessionId", async () => {
    invokeMock.mockResolvedValue([]);
    await listMessages("ses-1");
    expect(invokeMock).toHaveBeenCalledWith("message:list", { sessionId: "ses-1" });
  });
});


