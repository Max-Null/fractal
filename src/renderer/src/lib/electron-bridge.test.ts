// electron-bridge 引擎桥单元测试：验证 IPC 参数转换与通道调用（mock window.electronBridge）
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  sendMessage,
  respondPermission,
  questionReply,
  questionReject,
  forkSession,
  testConnection,
  listMessages,
  loadModelVariants,
  compactSession,
  openWorkspaceWindow,
  onInitWorkspace,
  polishMessage,
  readServeLog,
  getAppInfo,
  pickAvatar,
  clearAvatar,
  getAvatarPath,
  showNotification,
  type SendOptions,
} from "./electron-bridge";

// 桩 window.electronBridge.invoke：记录通道与参数，返回可编程结果
const invokeMock = vi.fn();
// 桩 onInitWorkspace（preload 专用通道）：记录回调，返回可编程取消函数
const onInitWorkspaceBridgeMock = vi.fn();
beforeEach(() => {
  invokeMock.mockReset();
  onInitWorkspaceBridgeMock.mockReset();
  onInitWorkspaceBridgeMock.mockReturnValue(() => {});
  (window as unknown as { electronBridge: unknown }).electronBridge = {
    invoke: invokeMock,
    on: vi.fn().mockReturnValue(() => {}),
    onInitWorkspace: onInitWorkspaceBridgeMock,
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

  it("attachments（P6 附件链路）→ 原样透传给主进程", async () => {
    invokeMock.mockResolvedValue({ accepted: true });
    const attachments = [
      { path: "C:\\tmp\\report.pdf", name: "report.pdf" },
      { path: "C:\\tmp\\notes.md", name: "notes.md" },
    ];
    await sendMessage("ses-1", "看下附件", { attachments } as SendOptions);
    expect(invokeMock).toHaveBeenCalledWith("chat:sendMessage", {
      sessionId: "ses-1",
      message: "看下附件",
      attachments,
    });
  });

  it("无 attachments → 不传 attachments 字段（主进程走便捷调用）", async () => {
    invokeMock.mockResolvedValue({ accepted: true });
    await sendMessage("ses-1", "hi");
    expect(invokeMock).toHaveBeenCalledWith("chat:sendMessage", { sessionId: "ses-1", message: "hi" });
    expect(invokeMock.mock.calls[0][1]).not.toHaveProperty("attachments");
  });

  it("variant 参数 → 透传 chat:sendMessage（思考强度真实接入引擎）", async () => {
    invokeMock.mockResolvedValue({ accepted: true });
    await sendMessage("ses-1", "hi", { variant: "high" } as SendOptions);
    expect(invokeMock).toHaveBeenCalledWith("chat:sendMessage", {
      sessionId: "ses-1",
      message: "hi",
      variant: "high",
    });
  });

  it("variant 为空串 → 不传 variant（模型无 variants / 未选择）", async () => {
    invokeMock.mockResolvedValue({ accepted: true });
    await sendMessage("ses-1", "hi", { variant: "" } as SendOptions);
    expect(invokeMock).toHaveBeenCalledWith("chat:sendMessage", { sessionId: "ses-1", message: "hi" });
    expect(invokeMock.mock.calls[0][1]).not.toHaveProperty("variant");
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

describe("questionReply / questionReject（提问回答）", () => {
  it("questionReply → question:reply 通道带 answers（string[][]，按 questions 顺序）", async () => {
    invokeMock.mockResolvedValue({ ok: true });
    await questionReply("ses-1", "que-1", [["A 深色"]]);
    expect(invokeMock).toHaveBeenCalledWith("question:reply", {
      sessionId: "ses-1",
      requestId: "que-1",
      answers: [["A 深色"]],
    });
  });

  it("questionReply 多问题多选 answers 原样透传", async () => {
    invokeMock.mockResolvedValue({ ok: true });
    await questionReply("ses-1", "que-2", [["A", "B"], ["是"]]);
    expect(invokeMock).toHaveBeenCalledWith("question:reply", {
      sessionId: "ses-1",
      requestId: "que-2",
      answers: [["A", "B"], ["是"]],
    });
  });

  it("questionReject 拒绝 → question:reject 通道（无 answers）", async () => {
    invokeMock.mockResolvedValue({ ok: true });
    await questionReject("ses-1", "que-1");
    expect(invokeMock).toHaveBeenCalledWith("question:reject", {
      sessionId: "ses-1",
      requestId: "que-1",
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

  it("listMessages 传 limit+before → 透传到 message:list（分页游标）", async () => {
    invokeMock.mockResolvedValue([]);
    await listMessages("ses-1", { limit: 50, before: "msg_100" });
    expect(invokeMock).toHaveBeenCalledWith("message:list", { sessionId: "ses-1", limit: 50, before: "msg_100" });
  });

  it("listMessages 只传 limit → 透传不含 before", async () => {
    invokeMock.mockResolvedValue([]);
    await listMessages("ses-1", { limit: 50 });
    expect(invokeMock).toHaveBeenCalledWith("message:list", { sessionId: "ses-1", limit: 50 });
  });

  it("polishMessage 传 text → ai:polishMessage 通道", async () => {
    invokeMock.mockResolvedValue({ ok: true, text: "优化后的消息" });
    await polishMessage("请优化这条");
    expect(invokeMock).toHaveBeenCalledWith("ai:polishMessage", { text: "请优化这条" });
  });

  it("polishMessage 带 refs → 透传引用上下文", async () => {
    invokeMock.mockResolvedValue({ ok: true, text: "优化" });
    const refs = [{ label: "选区片段", content: "const a = 1" }, { label: "b.ts", path: "C:\\b.ts" }];
    await polishMessage("优化", refs);
    expect(invokeMock).toHaveBeenCalledWith("ai:polishMessage", { text: "优化", refs });
  });
});

describe("loadModelVariants / compactSession（思考强度与压缩 API）", () => {
  it("loadModelVariants → provider:modelVariants（模型 id 去 [1M] 标注）", async () => {
    invokeMock.mockResolvedValue(["low", "high", "max"]);
    const v = await loadModelVariants("deepseek-v4-flash[1M]");
    expect(invokeMock).toHaveBeenCalledWith("provider:modelVariants", { modelId: "deepseek-v4-flash" });
    expect(v).toEqual(["low", "high", "max"]);
  });

  it("loadModelVariants 空模型名 → 空数组（不 invoke）", async () => {
    const v = await loadModelVariants("  ");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(v).toEqual([]);
  });

  it("compactSession → session:compact（带会话 id）", async () => {
    invokeMock.mockResolvedValue({ ok: true });
    const r = await compactSession("ses-1");
    expect(invokeMock).toHaveBeenCalledWith("session:compact", { id: "ses-1" });
    expect(r.ok).toBe(true);
  });
});

describe("openWorkspaceWindow / onInitWorkspace（多窗口）", () => {
  it("openWorkspaceWindow → window:openWorkspace 通道带 path（新开窗口切工作区）", async () => {
    invokeMock.mockResolvedValue(undefined);
    await openWorkspaceWindow("H:\\ws-b");
    expect(invokeMock).toHaveBeenCalledWith("window:openWorkspace", { path: "H:\\ws-b" });
  });

  it("onInitWorkspace 注册 preload 专用通道并返回取消函数", () => {
    const cb = vi.fn();
    const unsub = onInitWorkspace(cb);
    expect(onInitWorkspaceBridgeMock).toHaveBeenCalledWith(cb);
    expect(typeof unsub).toBe("function");
  });
});

describe("readServeLog / getAppInfo（诊断面板引擎日志数据源，方案 D8）", () => {
  it("readServeLog 缺省 500 行 → logs:readServeLog { lines: 500 }", async () => {
    invokeMock.mockResolvedValue(["[12:00:00] engine boot"]);
    const r = await readServeLog();
    expect(invokeMock).toHaveBeenCalledWith("logs:readServeLog", { lines: 500 });
    expect(r).toEqual(["[12:00:00] engine boot"]);
  });

  it("readServeLog 指定行数 → 透传 lines", async () => {
    invokeMock.mockResolvedValue([]);
    await readServeLog(100);
    expect(invokeMock).toHaveBeenCalledWith("logs:readServeLog", { lines: 100 });
  });

  it("getAppInfo → app:getInfo 返回分形/OC 引擎/预置包三版本（无参数时 invoke 第二参数为 undefined，桥约定）", async () => {
    invokeMock.mockResolvedValue({ name: "分形", version: "1.2.3", engineVersion: "1.18.15", presetVersion: "1.1.0" });
    const r = await getAppInfo();
    expect(invokeMock).toHaveBeenCalledWith("app:getInfo", undefined);
    expect(r).toEqual({ name: "分形", version: "1.2.3", engineVersion: "1.18.15", presetVersion: "1.1.0" });
  });
});

describe("pickAvatar / clearAvatar / getAvatarPath / showNotification（设置页头像与系统通知）", () => {
  it("pickAvatar → avatar:pick 通道，成功返回 filename（avatar.{ext} 统一命名）", async () => {
    invokeMock.mockResolvedValue({ ok: true, filename: "avatar.png" });
    const r = await pickAvatar();
    expect(invokeMock).toHaveBeenCalledWith("avatar:pick", undefined);
    expect(r).toEqual({ ok: true, filename: "avatar.png" });
  });

  it("pickAvatar 用户取消 → ok=false 无 filename", async () => {
    invokeMock.mockResolvedValue({ ok: false });
    const r = await pickAvatar();
    expect(r).toEqual({ ok: false });
    expect(r.filename).toBeUndefined();
  });

  it("clearAvatar → avatar:clear 通道（删除头像目录，回退 emoji）", async () => {
    invokeMock.mockResolvedValue({ ok: true });
    const r = await clearAvatar();
    expect(invokeMock).toHaveBeenCalledWith("avatar:clear", undefined);
    expect(r).toEqual({ ok: true });
  });

  it("getAvatarPath → avatar:getPath 返回头像存储目录（渲染拼 file:// 前缀用）", async () => {
    invokeMock.mockResolvedValue("C:\\Users\\MaxNull\\AppData\\Roaming\\分形\\avatar");
    const r = await getAvatarPath();
    expect(invokeMock).toHaveBeenCalledWith("avatar:getPath", undefined);
    expect(r).toContain("avatar");
  });

  it("showNotification → notification:show 通道带 title/body", async () => {
    invokeMock.mockResolvedValue(undefined);
    await showNotification("AI 回答完成", "对话已生成");
    expect(invokeMock).toHaveBeenCalledWith("notification:show", { title: "AI 回答完成", body: "对话已生成" });
  });
});


