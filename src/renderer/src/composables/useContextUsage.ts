// 上下文占用统一口径（2026-08-15：ContextIndicator 与 ContextUsageModal 此前算法分叉——
// 工具栏只算 inputTokens 无固定开销显示 1%，弹窗算 input+cacheRead+cacheWrite+固定开销显示 9%，
// 同一数据源两处不一致。统一为弹窗口径，两组件共用本模块，杜绝再分叉）
import { computed } from "vue";
import { useChatStore, type Message } from "@/stores/chat";
import { useSettingsStore } from "@/stores/settings";

// 固定开销估算值（单位 tokens）——基于 CC 2.1 系统提示和工具定义的实测尺寸
// 这些值会随 CC 版本升级而变化，更新时以 `--verbose` 输出的 system prompt 长度为准
export const CONTEXT_FIXED_OVERHEAD = {
  systemPrompt: 1500, // 系统提示词（角色 + 规则）
  systemTools: 10500, // 内置工具定义（Bash/Read/Write/Edit/Glob/Grep 等）
  mcpTools: 200, // MCP 服务端注册工具
  customAgents: 2600, // 自定义 agent 定义
  memoryFiles: 1200, // Memory 文件内容
  skills: 6100, // 已安装 skill 定义
};

/** 模型上下文窗口上限（tokens）：手动设置优先，其次按模型名推断 */
export function resolveContextLimit(): number {
  const settings = useSettingsStore();
  if (settings.contextLimit > 0) return settings.contextLimit;
  const m = settings.model.toLowerCase();
  // 模型名中的 [1M] 后缀直接指示 1M 上下文
  if (m.includes("[1m]") || m.includes("deepseek-v4-pro") || m.includes("deepseek-v4")) return 1_000_000;
  if (m.includes("claude")) return 200_000;
  return 128_000; // 默认保守值
}

/**
 * 最后一次请求的完整上下文输入（消息级 tokens 明细）。
 * 仅取最后一条含 tokens 的 assistant 消息——serve 下发的消息级 input 是 adjusted 口径
 * （不含缓存命中），补 cacheRead/cacheWrite 才是完整上下文；不累加全部消息（每条 input 是
 * 「该回合新增输入」，累加会把多轮请求的上下文重复相加，2026-08-13 修复超估）。
 */
export function lastMessageTokens(messages: Message[]): { input: number; cacheRead: number; cacheWrite: number } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && (m.inputTokens || m.cacheReadTokens || m.cacheWriteTokens)) {
      return {
        input: m.inputTokens || 0,
        cacheRead: m.cacheReadTokens || 0,
        cacheWrite: m.cacheWriteTokens || 0,
      };
    }
  }
  return { input: 0, cacheRead: 0, cacheWrite: 0 };
}

/** 消息 tokens 总量（input + cacheRead + cacheWrite） */
export function messageTokensTotal(m: { input: number; cacheRead: number; cacheWrite: number }): number {
  return m.input + m.cacheRead + m.cacheWrite;
}

/** 固定开销总量 */
export function fixedOverheadTotal(): number {
  return Object.values(CONTEXT_FIXED_OVERHEAD).reduce((a, b) => a + b, 0);
}

/**
 * 上下文占用统一计算（computed 形式，供组件模板绑定）。
 * used = 最后消息 input+cacheRead+cacheWrite + 固定开销；limit = 模型窗口上限
 */
export function useContextUsage() {
  const chat = useChatStore();
  const settings = useSettingsStore();
  void settings; // contextLimit 读取在 resolveContextLimit 内，此处建立 store 依赖

  const limit = computed(() => resolveContextLimit());
  const msgTokens = computed(() => {
    const t = lastMessageTokens(chat.messages);
    return messageTokensTotal(t);
  });
  const totalUsed = computed(() => msgTokens.value + fixedOverheadTotal());
  const freeSpace = computed(() => Math.max(0, limit.value - totalUsed.value));
  const pctNum = computed(() => (totalUsed.value / limit.value) * 100);
  const pctRounded = computed(() => Math.min(100, Math.round(pctNum.value)));

  return { limit, msgTokens, totalUsed, freeSpace, pctNum, pctRounded };
}

/** 百分比单值格式化（弹窗分类行用） */
export function pctOf(value: number, limit: number): string {
  return ((value / limit) * 100).toFixed(1);
}

/** 状态色：90%+ coral（危险）、75%+ amber（警告）、其余 accent */
export function contextStatusColor(pct: number): string {
  if (pct >= 90) return "var(--coral)";
  if (pct >= 75) return "var(--amber)";
  return "var(--accent)";
}
