// acp-bridge 单元测试：验证 ACP 通道调用与参数透传（mock window.electronBridge）
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getAcpSessionState,
  decompressAcpBlock,
} from "./acp-bridge";

// 桩 window.electronBridge.invoke：记录通道与参数，返回可编程结果
const invokeMock = vi.fn();
beforeEach(() => {
  invokeMock.mockReset();
  (window as unknown as { electronBridge: unknown }).electronBridge = {
    invoke: invokeMock,
    on: vi.fn().mockReturnValue(() => {}),
    onInitWorkspace: vi.fn().mockReturnValue(() => {}),
  };
});

describe("getAcpSessionState", () => {
  it("调用 acp:getState 通道并透传 sessionId", async () => {
    invokeMock.mockResolvedValue({ detected: true, blocks: [], categories: [] });
    const res = await getAcpSessionState("ses_abc");
    expect(invokeMock).toHaveBeenCalledWith("acp:getState", { sessionId: "ses_abc" });
    expect(res.detected).toBe(true);
  });

  it("返回完整 ACP 状态（压缩块/分类/统计）", async () => {
    const acpData = {
      detected: true,
      blocks: [
        { blockId: 2, topic: "新块", compressedTokens: 9000, summaryTokens: 800, tier: 2, active: false, startId: "m00101", endId: "m00200", createdAt: "2026-08-15T10:00:00.000Z", summaryPreview: "…" },
      ],
      categories: [{ role: "user", tokens: 3200 }, { role: "assistant", tokens: 15000 }],
      totalPruneTokens: 3054778,
      modelContextLimit: 1000000,
    };
    invokeMock.mockResolvedValue(acpData);
    const res = await getAcpSessionState("ses_full");
    expect(res.blocks).toHaveLength(1);
    expect(res.blocks[0].tier).toBe(2);
    expect(res.categories[1].role).toBe("assistant");
    expect(res.totalPruneTokens).toBe(3054778);
  });
});

describe("decompressAcpBlock", () => {
  it("调用 acp:decompress 通道并透传 sessionId + blockId", async () => {
    invokeMock.mockResolvedValue({ ok: true });
    const res = await decompressAcpBlock("ses_abc", 3);
    expect(invokeMock).toHaveBeenCalledWith("acp:decompress", { sessionId: "ses_abc", blockId: 3 });
    expect(res.ok).toBe(true);
  });
});
