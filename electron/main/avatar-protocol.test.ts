import { describe, it, expect, vi, beforeEach } from "vitest";

// mock electron 的 app / protocol（avatar-protocol 只依赖这两个 + readFile）
const { appMock, protocolMock } = vi.hoisted(() => ({
  appMock: { getPath: vi.fn() },
  protocolMock: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
}));
vi.mock("electron", () => ({ app: appMock, protocol: protocolMock }));

// mock readFile（node:fs/promises）：显式提供 readFile + default（importActual 对 node 内置模块展开不可靠）
const { readFileMock } = vi.hoisted(() => ({ readFileMock: vi.fn() }));
vi.mock("node:fs/promises", () => ({
  readFile: readFileMock,
  default: { readFile: readFileMock },
}));

import { registerAvatarScheme, handleAvatarProtocol } from "./avatar-protocol";

const AVATAR_DIR = "C:\\Users\\test\\AppData\\Roaming\\fractal\\avatar";

describe("avatar-protocol（头像本地图片自定义协议）", () => {
  beforeEach(() => {
    appMock.getPath.mockReturnValue("C:\\Users\\test\\AppData\\Roaming\\fractal");
    protocolMock.registerSchemesAsPrivileged.mockReset();
    protocolMock.handle.mockReset();
    readFileMock.mockReset();
  });

  it("registerAvatarScheme：注册 avatar scheme（standard/secure/bypassCSP/supportFetchAPI）", () => {
    registerAvatarScheme();
    expect(protocolMock.registerSchemesAsPrivileged).toHaveBeenCalledWith([
      { scheme: "avatar", privileges: { standard: true, secure: true, bypassCSP: true, supportFetchAPI: true } },
    ]);
  });

  it("handler：合法文件名 → 读文件返回 Response（正确 MIME）", async () => {
    handleAvatarProtocol();
    const handler = protocolMock.handle.mock.calls[0][1];
    readFileMock.mockResolvedValue(Buffer.from("png-bytes"));

    const res = await handler({ url: "avatar:///avatar.png" });

    expect(protocolMock.handle).toHaveBeenCalledWith("avatar", expect.any(Function));
    expect(readFileMock).toHaveBeenCalledWith(`${AVATAR_DIR}\\avatar.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("png-bytes");
  });

  it("handler：jpg 扩展名 → image/jpeg MIME", async () => {
    handleAvatarProtocol();
    const handler = protocolMock.handle.mock.calls[0][1];
    readFileMock.mockResolvedValue(Buffer.from("jpg-bytes"));
    const res = await handler({ url: "avatar:///avatar.jpg" });
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
  });

  it("handler：非法文件名（白名单外扩展名）→ 403，不读文件", async () => {
    handleAvatarProtocol();
    const handler = protocolMock.handle.mock.calls[0][1];
    const res = await handler({ url: "avatar:///evil.txt" });
    expect(res.status).toBe(403);
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("handler：路径遍历（../ 注入）→ 403，不读文件", async () => {
    handleAvatarProtocol();
    const handler = protocolMock.handle.mock.calls[0][1];
    const res = await handler({ url: "avatar:///../../provider-configs.json" });
    expect(res.status).toBe(403);
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("handler：文件不存在（readFile 抛错）→ 404", async () => {
    handleAvatarProtocol();
    const handler = protocolMock.handle.mock.calls[0][1];
    readFileMock.mockRejectedValue(new Error("ENOENT"));
    const res = await handler({ url: "avatar:///avatar.png" });
    expect(res.status).toBe(404);
  });

  it("handler：非法转义（%zz）→ 404 不抛异常（decodeURIComponent 兜底）", async () => {
    handleAvatarProtocol();
    const handler = protocolMock.handle.mock.calls[0][1];
    const res = await handler({ url: "avatar:///avatar%zz.png" });
    expect(res.status).toBe(404);
    expect(readFileMock).not.toHaveBeenCalled();
  });
});
