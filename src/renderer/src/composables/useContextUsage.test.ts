// useContextUsage 统一口径测试：两组件（ContextIndicator/ContextUsageModal）共用同一计算，
// 数字必须一致（2026-08-15 修复：此前工具栏只算 inputTokens 无固定开销，与弹窗分叉）
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useChatStore, type Message } from "@/stores/chat";
import {
  lastMessageTokens,
  messageTokensTotal,
  fixedOverheadTotal,
  CONTEXT_FIXED_OVERHEAD,
  resolveContextLimit,
  pctOf,
  contextStatusColor,
  useContextUsage,
} from "./useContextUsage";

// settings store 依赖 localStorage / SQLite mock——用 hoisted 可变状态 + 简单函数 mock（对齐 FilePanel.test.ts 模式）
// 注意：真实 Pinia setup store 访问 .model/.contextLimit 会解包 ref 返回原始值；mock 需模拟该行为
const settingsState = vi.hoisted(() => {
  const { ref } = require("vue");
  const model = ref("deepseek/deepseek-v4-pro");
  const contextLimit = ref(0);
  return {
    // Pinia setup store 的 ref 字段解包：getter 返回 .value，setter 写 .value
    get model() { return model.value; },
    set model(v: string) { model.value = v; },
    get contextLimit() { return contextLimit.value; },
    set contextLimit(v: number) { contextLimit.value = v; },
    _modelRef: model,
    _contextLimitRef: contextLimit,
  };
});
vi.mock("@/stores/settings", () => ({
  useSettingsStore: () => settingsState,
}));

/** 构造一条最小可用 Message（store 类型要求必填字段齐全） */
function mkMessage(partial: Partial<Message> & { role: "user" | "assistant" }): Message {
  return {
    id: `m-${Math.random()}`,
    content: "",
    thinking: "",
    toolUses: [],
    timestamp: Date.now(),
    isStreaming: false,
    ...partial,
  };
}

function chatMessages(): Message[] {
  return useChatStore().messages as unknown as Message[];
}

describe("lastMessageTokens / messageTokensTotal", () => {
  it("取最后一条含 tokens 的 assistant 消息（input+cacheRead+cacheWrite）", () => {
    const messages = [
      mkMessage({ role: "user", content: "hi" }),
      mkMessage({ role: "assistant", content: "first", inputTokens: 500 }),
      mkMessage({ role: "assistant", content: "second", inputTokens: 800, cacheReadTokens: 900, cacheWriteTokens: 100 }),
    ];
    const t = lastMessageTokens(messages);
    expect(t).toEqual({ input: 800, cacheRead: 900, cacheWrite: 100 });
    expect(messageTokensTotal(t)).toBe(1800);
  });

  it("中间夹着无 tokens 的 assistant 消息也能找到更早的含 tokens 消息", () => {
    const messages = [
      mkMessage({ role: "assistant", content: "a", inputTokens: 100, cacheReadTokens: 50 }),
      mkMessage({ role: "assistant", content: "b" }), // 无 tokens（如纯思考后未计费）
    ];
    const t = lastMessageTokens(messages);
    expect(messageTokensTotal(t)).toBe(150);
  });

  it("无任何 tokens → 全 0", () => {
    expect(messageTokensTotal(lastMessageTokens([]))).toBe(0);
    expect(messageTokensTotal(lastMessageTokens([mkMessage({ role: "user", content: "x" })]))).toBe(0);
  });
});

describe("固定开销", () => {
  it("固定开销 = 各项之和", () => {
    const expected = 1500 + 10500 + 200 + 2600 + 1200 + 6100;
    expect(fixedOverheadTotal()).toBe(expected);
    expect(Object.values(CONTEXT_FIXED_OVERHEAD).reduce((a, b) => a + b, 0)).toBe(expected);
  });
});

describe("resolveContextLimit（模型窗口上限）", () => {
  beforeEach(() => {
    settingsState.contextLimit = 0;
    settingsState.model = "deepseek/deepseek-v4-pro";
  });

  it("手动设置优先", () => {
    settingsState.contextLimit = 50000;
    expect(resolveContextLimit()).toBe(50000);
  });

  it("[1M] 后缀 / deepseek-v4 → 1M", () => {
    expect(resolveContextLimit()).toBe(1_000_000);
  });

  it("claude → 200k", () => {
    settingsState.model = "anthropic/claude-sonnet-4-6";
    expect(resolveContextLimit()).toBe(200_000);
  });

  it("未知模型 → 128k 保守值", () => {
    settingsState.model = "some/custom-model";
    expect(resolveContextLimit()).toBe(128_000);
  });
});

describe("pctOf / contextStatusColor", () => {
  it("百分比格式化 1 位小数", () => {
    expect(pctOf(89_600, 1_000_000)).toBe("9.0");
  });

  it("状态色阈值：90+ coral / 75+ amber / 其余 accent", () => {
    expect(contextStatusColor(95)).toBe("var(--coral)");
    expect(contextStatusColor(80)).toBe("var(--amber)");
    expect(contextStatusColor(50)).toBe("var(--accent)");
  });
});

describe("useContextUsage（两组件共用口径）", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    settingsState.contextLimit = 0;
    settingsState.model = "deepseek/deepseek-v4-pro";
    useChatStore().clearMessages();
  });

  it("used = 最后消息 input+cache+cacheWrite + 固定开销；pct 四舍五入", () => {
    chatMessages().push(
      mkMessage({ role: "assistant", content: "x", inputTokens: 80_000, cacheReadTokens: 9_000, cacheWriteTokens: 600 }),
    );
    const { totalUsed, limit, pctNum, pctRounded } = useContextUsage();
    expect(limit.value).toBe(1_000_000);
    // 89,600 + 22,100 = 111,700 → 11.2%
    expect(totalUsed.value).toBe(89_600 + fixedOverheadTotal());
    expect(pctNum.value).toBeCloseTo((111_700 / 1_000_000) * 100);
    expect(pctRounded.value).toBe(11);
  });

  it("无消息 → 仅固定开销", () => {
    const { totalUsed, msgTokens } = useContextUsage();
    expect(msgTokens.value).toBe(0);
    expect(totalUsed.value).toBe(fixedOverheadTotal());
  });
});

