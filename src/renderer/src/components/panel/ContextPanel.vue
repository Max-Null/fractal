<script setup lang="ts">
// 上下文详情面板：当前会话的消息用量/成本/统计 + DeepSeek 账户余额（2026-08-12 计费迭代）
// 数据源：chat store messages（响应式——消息流更新自动刷新）+ session store activeSession
// 聚合口径：消息级 inputTokens/outputTokens/costCNY（toMessageData：info.tokens + 本地价格表计算，历史+实时都有值）
import { computed, onMounted, ref } from "vue";
import { useChatStore } from "@/stores/chat";
import { useSessionStore } from "@/stores/session";
import { getBalance, type DeepSeekBalanceResult } from "@/lib/electron-bridge";

const chat = useChatStore();
const sessionStore = useSessionStore();

/** 当前活跃会话（sessions 数组按 id 匹配，切换会话自动跟随） */
const activeSession = computed(() =>
  sessionStore.sessions.find((s) => s.id === sessionStore.activeSessionId) ?? null
);

// ── 消息聚合（响应式：流式消息的 tokens/cost 写入即触发刷新）──
const inputTokens = computed(() => chat.messages.reduce((sum, m) => sum + (m.inputTokens ?? 0), 0));
const outputTokens = computed(() => chat.messages.reduce((sum, m) => sum + (m.outputTokens ?? 0), 0));
const totalTokens = computed(() => inputTokens.value + outputTokens.value);
// 人民币成本聚合：仅 costCNY（纯美元旧存档走 hasCostCNY=false 显示 --，不做 USD 混算——币种不可混加）
const costSum = computed(() => chat.messages.reduce((sum, m) => sum + (m.costCNY ?? 0), 0));
// 是否含人民币成本：新消息（实时流/历史加载）都有 costCNY；纯旧存档只有 costUSD 时显示 "--"（非 0）
const hasCostCNY = computed(() => chat.messages.some((m) => m.costCNY !== undefined));
/** 成本卡显示文本：无成本字段的纯旧存档显示 "--"（避免误报 ¥0.0000）；有人民币成本才算聚合 */
const costText = computed(() => (hasCostCNY.value ? fmtCost(costSum.value) : "--"));
const assistantCount = computed(() => chat.messages.filter((m) => m.role === "assistant").length);
const toolCount = computed(() => chat.messages.reduce((sum, m) => sum + (m.toolUses?.length ?? 0), 0));

// ── DeepSeek 账户余额（计费迭代：设置面板 + 本卡片两处显示）──
const balance = ref<DeepSeekBalanceResult | null>(null);
const balanceLoading = ref(false);

/** 查询余额；无 API Key 或失败时静默降级（不阻断面板渲染） */
async function refreshBalance() {
  if (balanceLoading.value) return;
  balanceLoading.value = true;
  try {
    balance.value = await getBalance();
  } catch {
    balance.value = { ok: false, message: "余额查询失败" };
  } finally {
    balanceLoading.value = false;
  }
}

onMounted(refreshBalance);

/** 余额展示文本：CNY 总余额（多个币种取 CNYW） */
const balanceText = computed(() => {
  if (!balance.value) return "--";
  if (!balance.value.ok) return balance.value.message ?? "查询失败";
  const cny = balance.value.balanceInfos?.find((b) => b.currency === "CNY")
    ?? balance.value.balanceInfos?.[0];
  return cny ? `¥${Number(cny.totalBalance).toFixed(2)}` : "--";
});

/** 千分位格式化（tokens/成本小数值不动） */
function fmtNum(n: number): string {
  return n.toLocaleString("zh-CN");
}

/** 成本显示：¥ + 4 位小数（DeepSeek 每百万 token 人民币计价，会话级成本常 < 0.01） */
function fmtCost(n: number): string {
  return `¥${n.toFixed(4)}`;
}

/** 时间短格式（MM-DD HH:mm；跨年补 YYYY-MM-DD） */
function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad = (x: number) => String(x).padStart(2, "0");
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.getFullYear() === new Date().getFullYear() ? md : `${d.getFullYear()}-${md}`;
}

/** 工作区 basename（cwd 尾部段；根目录原样） */
function cwdBase(cwd?: string): string {
  if (!cwd) return "--";
  const parts = cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || cwd;
}
</script>

<template>
  <div class="status-panel">
    <!-- 无活跃会话（首启未选会话） -->
    <div v-if="!activeSession" class="panel-tip">暂无活跃会话——从左侧选择或新建一个会话查看上下文详情</div>

    <template v-else>
      <!-- 会话信息 -->
      <div class="stat-card">
        <div class="stat-head"><span class="stat-ico stat-ico--v">📇</span>会话信息</div>
        <div class="stat-row"><span class="k">标题</span><span class="v ellipsis" :title="activeSession.title">{{ activeSession.title }}</span></div>
        <div class="stat-row"><span class="k">工作区</span><span class="v ellipsis" :title="activeSession.cwd">{{ cwdBase(activeSession.cwd) }}</span></div>
        <div class="stat-row"><span class="k">模型</span><span class="v">{{ activeSession.model || "--" }}</span></div>
        <div class="stat-row"><span class="k">Agent</span><span class="v">{{ activeSession.agent || "--" }}</span></div>
        <div class="stat-row"><span class="k">创建时间</span><span class="v">{{ fmtTime(activeSession.createdAt) }}</span></div>
      </div>

      <!-- 上下文用量 -->
      <div class="stat-card">
        <div class="stat-head"><span class="stat-ico stat-ico--g">◈</span>上下文用量</div>
        <div class="stat-big">{{ fmtNum(totalTokens) }} <span class="stat-unit">tokens</span></div>
        <div class="stat-row"><span class="k">输入</span><span class="v">{{ fmtNum(inputTokens) }}</span></div>
        <div class="stat-row"><span class="k">输出</span><span class="v">{{ fmtNum(outputTokens) }}</span></div>
        <div class="stat-desc">当前会话累计 tokens（消息级统计聚合）</div>
      </div>

      <!-- 成本 -->
      <div class="stat-card">
        <div class="stat-head"><span class="stat-ico stat-ico--a">¥</span>成本</div>
        <div class="stat-big">{{ costText }}</div>
        <div class="stat-desc">当前会话累计费用（人民币，按 DeepSeek 官方价格表本地计算）</div>
      </div>

      <!-- DeepSeek 账户余额（计费迭代：余额查询 API 实时拉取） -->
      <div class="stat-card">
        <div class="stat-head"><span class="stat-ico stat-ico--a">◉</span>账户余额</div>
        <div class="stat-big">{{ balanceText }}</div>
        <div class="stat-desc">DeepSeek 账户实时余额（{{ balanceLoading ? "查询中…" : "点击刷新" }}）</div>
        <button class="stat-refresh" @click="refreshBalance" :disabled="balanceLoading">刷新</button>
      </div>

      <!-- 消息统计 -->
      <div class="stat-card">
        <div class="stat-head"><span class="stat-ico stat-ico--g">◫</span>消息统计</div>
        <div class="stat-row"><span class="k">消息数</span><span class="v">{{ fmtNum(chat.messages.length) }}</span></div>
        <div class="stat-row"><span class="k">完成轮次</span><span class="v">{{ fmtNum(assistantCount) }}</span></div>
        <div class="stat-row"><span class="k">工具调用</span><span class="v">{{ fmtNum(toolCount) }}</span></div>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* ── 上下文详情面板：对齐原型 v0.23 panel-body 风格（沿用 stat-card 骨架）── */
.status-panel {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 14px;
  min-height: 0;
}

/* 提示条（无活跃会话） */
.panel-tip {
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  background: var(--amber-glow);
  color: var(--amber);
  font-size: 0.786rem;
  line-height: 1.5;
}

/* 统计卡片 */
.stat-card {
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-md);
  background: var(--bg-elevated);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.stat-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.857rem;
  font-weight: 600;
  color: var(--text-bright);
}
.stat-ico {
  width: 22px;
  height: 22px;
  border-radius: 7px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.714rem;
}
.stat-ico--g { background: var(--accent-glow); color: var(--accent); }
.stat-ico--a { background: var(--amber-glow); color: var(--amber); }
.stat-ico--v { background: color-mix(in srgb, var(--violet) 14%, transparent); color: var(--violet); }
.stat-row {
  display: flex;
  justify-content: space-between;
  font-size: 0.821rem;
  gap: 10px;
}
.stat-row .k { color: var(--text-secondary); flex-shrink: 0; }
.stat-row .v { color: var(--text-primary); overflow: hidden; }
.stat-row .ellipsis { text-overflow: ellipsis; white-space: nowrap; }
.stat-desc {
  font-size: 0.75rem;
  color: var(--text-tertiary);
  line-height: 1.4;
}
/* 大数字（总量/成本） */
.stat-big {
  font-size: 1.571rem;
  font-weight: 700;
  color: var(--text-bright);
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
}
.stat-unit {
  font-size: 0.786rem;
  font-weight: 500;
  color: var(--text-tertiary);
  margin-left: 4px;
}
/* 余额刷新按钮（stat-card 内小按钮，避免与 stat-desc 抢行） */
.stat-refresh {
  align-self: flex-start;
  margin-top: 2px;
  padding: 2px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-dim);
  background: var(--bg-elevated);
  color: var(--text-secondary);
  font-size: 0.75rem;
  cursor: pointer;
}
.stat-refresh:hover:not(:disabled) {
  color: var(--accent);
  border-color: var(--accent);
}
.stat-refresh:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
