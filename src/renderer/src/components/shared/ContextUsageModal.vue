<script setup lang="ts">
/** 上下文用量弹窗——展示 token 消耗（固定开销估算 + 实际消息用量），
 *  2026-08-15：接入 opencode-acp 插件真实数据（压缩块列表/分类/统计），支持手动解压 /compact
 *  数据流：open 时 watch activeSessionId → acp:getState → detected=true 展示真实构成；无 ACP 数据回退估算 */
import { computed, ref, watch, onUnmounted } from "vue";
import { useSettingsStore } from "@/stores/settings";
import { useSessionStore } from "@/stores/session";
import { formatNum } from "@/lib/utils";
import ModalShell from "./ModalShell.vue";
import {
  useContextUsage,
  CONTEXT_FIXED_OVERHEAD,
  pctOf,
} from "@/composables/useContextUsage";
import {
  getAcpSessionState,
  decompressAcpBlock,
  type AcpSessionState,
} from "@/lib/acp-bridge";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: []; compact: [] }>();

const settings = useSettingsStore();
const session = useSessionStore();

// 上下文占用统一口径（useContextUsage：最后消息 input+cacheRead+cacheWrite + 固定开销）
// 2026-08-15：与 ContextIndicator 共用同一计算，两处数字一致
const { limit, msgTokens, totalUsed, freeSpace, pctNum } = useContextUsage();

/** 单行百分比格式化（模板用） */
const pct = (val: number) => pctOf(val, limit.value);

// 用量分类行（bottom-to-top 堆叠顺序对应 bar 图表）
interface Row { key: string; tokens: number }
const rows = computed<Row[]>(() => [
  { key: "systemPrompt", tokens: CONTEXT_FIXED_OVERHEAD.systemPrompt },
  { key: "systemTools", tokens: CONTEXT_FIXED_OVERHEAD.systemTools },
  { key: "mcpTools", tokens: CONTEXT_FIXED_OVERHEAD.mcpTools },
  { key: "customAgents", tokens: CONTEXT_FIXED_OVERHEAD.customAgents },
  { key: "memoryFiles", tokens: CONTEXT_FIXED_OVERHEAD.memoryFiles },
  { key: "skills", tokens: CONTEXT_FIXED_OVERHEAD.skills },
  { key: "messages", tokens: msgTokens.value },
]);

/** 分类展示行：ACP 检测到时用真实分类（缺失 role 的 system 兜底估算并标注 *），否则回退固定开销估算
 *  key 需与 i18n contextUsage.* 对齐；estimated 标记"估算"星号 */
const displayRows = computed(() => {
  if (acpState.value?.detected && acpState.value.categories.length > 0) {
    return acpState.value.categories.map((c) => ({
      key: c.role,
      tokens: c.tokens,
      estimated: c.role === "system",
    }));
  }
  return rows.value.map((r) => ({ key: r.key, tokens: r.tokens, estimated: false }));
});

// ========== ACP 真实数据（2026-08-15）==========
/** ACP 状态：null=加载中 / 未检测到；失败时 error 字段携带原因 */
const acpState = ref<AcpSessionState | null>(null);
/** 请求序号：切会话快速拉取时旧响应不得覆盖新会话数据（竞态守卫） */
let loadSeq = 0;
/** 正在解压的 blockId（按钮 loading 态，同一时刻仅一个） */
const decompressingId = ref<number | null>(null);
/** 解压失败/已提交提示（3s 自动消失） */
const decompressNotice = ref("");
/** 解压提示定时器（onUnmounted 清理防泄漏） */
let decompressNoticeTimer: ReturnType<typeof setTimeout> | undefined;

/** 会话切换时重新拉取 ACP 状态；无会话时清空 */
async function loadAcpState() {
  const sid = session.activeSessionId;
  const seq = ++loadSeq;
  if (!sid) {
    acpState.value = null;
    return;
  }
  acpState.value = null; // 切换会话瞬间置空，避免旧会话数据闪现
  try {
    const state = await getAcpSessionState(sid);
    // 竞态守卫：仅当本次请求仍是最新序号才写入（旧响应丢弃）
    if (seq === loadSeq) acpState.value = state;
  } catch {
    if (seq === loadSeq) {
      // 主进程拉取失败（serve 未就绪等）——按未检测到兜底，不阻塞弹窗展示
      acpState.value = { detected: false, blocks: [], categories: [] };
    }
  }
}

/** 解压块：loading → 驱动 promptAsync → 提示已提交（模型异步执行，数十秒后生效，不立即断言成功） */
async function onDecompress(blockId: number) {
  if (decompressingId.value !== null) return;
  decompressingId.value = blockId;
  decompressNotice.value = "";
  try {
    await decompressAcpBlock(session.activeSessionId, blockId);
    decompressNotice.value = "submitted"; // 提示文案 key，模板用 $t 渲染
    decompressNoticeTimer = setTimeout(() => (decompressNotice.value = ""), 4000);
  } catch (e) {
    decompressNotice.value = e instanceof Error ? e.message : String(e);
    decompressNoticeTimer = setTimeout(() => (decompressNotice.value = ""), 4000);
  } finally {
    decompressingId.value = null;
  }
}

// 弹窗打开时拉取 ACP 状态（组件常驻挂载，open 才显示；避免打开瞬间无数据闪烁）
// immediate:true 覆盖「首次挂载即 open」场景（watch 默认不触发初始值）
watch(
  () => props.open,
  (op) => {
    if (op) void loadAcpState();
  },
  { immediate: true },
);

// 会话切换且弹窗打开时才拉取（弹窗关闭时切会话不浪费请求）
watch(
  () => session.activeSessionId,
  () => {
    if (props.open) void loadAcpState();
  },
);

// 组件卸载时清理解压提示定时器（防止销毁后 4s 回调写已卸载组件）
onUnmounted(() => {
  if (decompressNoticeTimer) clearTimeout(decompressNoticeTimer);
});
</script>

<template>
  <ModalShell :open="open" @close="emit('close')">
    <template #header>
      <span class="text-sm font-semibold" :style="{ color: 'var(--text-bright)' }">
        {{ $t('contextUsage.title') }}
      </span>
      <span class="text-[0.786rem] font-mono ml-2" :style="{ color: 'var(--text-muted)' }">{{ settings.model }}</span>
    </template>

    <!-- 用量摘要 -->
    <div class="text-xl font-bold font-mono tabular-nums mb-1" :style="{ color: 'var(--text-bright)' }">
      {{ formatNum(totalUsed) }} / {{ formatNum(limit) }} tokens
      <span class="text-sm ml-1.5" :style="{ color: pctNum > 90 ? 'var(--coral)' : pctNum > 75 ? 'var(--amber)' : 'var(--text-muted)' }">
        ({{ pctNum.toFixed(1) }}%)
      </span>
    </div>
    <div class="h-1.5 rounded-full mb-4" :style="{ background: 'var(--bg-elevated)' }">
      <div class="h-full rounded-full transition-all" :style="{ width: Math.min(100, pctNum).toFixed(1) + '%', background: pctNum > 90 ? 'var(--coral)' : pctNum > 75 ? 'var(--amber)' : 'var(--accent)' }"></div>
    </div>

    <!-- ACP 压缩块列表（真实数据；未检测到时整块隐藏） -->
    <template v-if="acpState?.detected">
      <div class="flex items-center justify-between mb-1.5">
        <div class="text-[0.714rem] font-semibold uppercase tracking-wider" :style="{ color: 'var(--text-muted)' }">
          {{ $t('contextUsage.acpBlocks') }}
        </div>
        <div class="text-[0.714rem] font-mono" :style="{ color: 'var(--text-muted)' }">
          {{ $t('contextUsage.acpSaved', { n: formatNum(acpState.totalPruneTokens ?? 0) }) }}
        </div>
      </div>
      <div v-if="acpState.blocks.length === 0" class="text-xs py-2" :style="{ color: 'var(--text-muted)' }">
        {{ $t('contextUsage.acpNoBlocks') }}
      </div>
      <div v-else class="space-y-1 mb-3">
        <div
          v-for="b in acpState.blocks"
          :key="b.blockId"
          class="flex items-center gap-2 py-1.5 px-2 rounded-lg border"
          :style="{ background: 'var(--bg-elevated)', borderColor: 'var(--border-dim)', opacity: b.active ? 1 : 0.5 }"
        >
          <span
            class="shrink-0 text-[0.643rem] font-mono px-1 rounded"
            :style="{ background: b.tier > 1 ? 'var(--accent-dim)' : 'var(--bg-elevated)', color: b.tier > 1 ? 'var(--accent)' : 'var(--text-muted)' }"
          >T{{ b.tier }}</span>
          <div class="flex-1 min-w-0">
            <div class="text-xs truncate" :style="{ color: 'var(--text-primary)' }">{{ b.topic || 'b' + b.blockId }}</div>
            <div class="text-[0.643rem] font-mono truncate" :style="{ color: 'var(--text-muted)' }">
              {{ b.startId }} → {{ b.endId }}
            </div>
          </div>
          <div class="shrink-0 text-right">
            <div class="text-[0.643rem] font-mono tabular-nums" :style="{ color: 'var(--text-secondary)' }">
              {{ formatNum(b.compressedTokens) }} → {{ formatNum(b.summaryTokens) }}
            </div>
            <div v-if="!b.active" class="text-[0.643rem]" :style="{ color: 'var(--coral)' }">{{ $t('contextUsage.acpInactive') }}</div>
          </div>
          <button
            class="shrink-0 px-2 py-1 rounded text-[0.714rem] font-medium transition-colors disabled:opacity-50"
            :style="{ background: 'var(--accent-dim)', color: 'var(--accent)' }"
            :disabled="decompressingId !== null"
            @click="onDecompress(b.blockId)"
          >
            {{ decompressingId === b.blockId ? $t('contextUsage.decompressing') : $t('contextUsage.decompress') }}
          </button>
        </div>
      </div>
      <!-- 解压提示：submitted=已提交待模型执行（key 由 $t 渲染）；失败=e.message 原文 -->
      <p
        v-if="decompressNotice"
        class="text-[0.714rem] mb-2"
        :style="{ color: decompressNotice === 'submitted' ? 'var(--accent)' : 'var(--coral)' }"
      >
        {{ decompressNotice === 'submitted' ? $t('contextUsage.decompressSubmitted') : decompressNotice }}
      </p>
    </template>

    <!-- 分类表格：ACP 检测到时用真实分类（system 兜底估算并标注），否则回退固定开销估算 -->
    <div class="text-[0.714rem] font-semibold uppercase tracking-wider mb-1.5" :style="{ color: 'var(--text-muted)' }">{{ $t('contextUsage.category') }}</div>
    <table class="w-full text-xs mb-3">
      <thead>
        <tr :style="{ color: 'var(--text-muted)' }">
          <th class="text-left font-normal pb-1 w-28">{{ $t('contextUsage.category') }}</th>
          <th class="text-right font-normal pb-1 w-16">{{ $t('contextUsage.tokens') }}</th>
          <th class="text-right font-normal pb-1 w-12">%</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in displayRows" :key="r.key" class="border-b" :style="{ borderColor: 'var(--border-dim)' }">
          <td class="py-1.5" :style="{ color: 'var(--text-secondary)' }">
            {{ $t('contextUsage.' + r.key) }}
            <span v-if="r.estimated" class="text-[0.643rem]" :style="{ color: 'var(--text-muted)' }">*</span>
          </td>
          <td class="py-1.5 text-right tabular-nums font-mono" :style="{ color: 'var(--text-primary)' }">{{ formatNum(r.tokens) }}</td>
          <td class="py-1.5 text-right tabular-nums font-mono" :style="{ color: r.tokens / limit > 0.15 ? 'var(--amber)' : 'var(--text-muted)' }">
            {{ pct(r.tokens) }}%
          </td>
        </tr>
      </tbody>
    </table>

    <!-- 空闲空间 -->
    <div class="flex items-center justify-between py-2 px-3 rounded-lg mb-2" :style="{ background: 'var(--bg-elevated)' }">
      <span class="text-xs font-medium" :style="{ color: 'var(--text-bright)' }">
        {{ $t('contextUsage.freeSpace') }}
      </span>
      <span class="text-xs font-mono tabular-nums" :style="{ color: 'var(--accent)' }">
        {{ formatNum(freeSpace) }} ({{ pct(freeSpace) }}%)
      </span>
    </div>

    <p class="text-[0.714rem] leading-relaxed pb-1" :style="{ color: 'var(--text-muted)' }">
      {{ acpState?.detected ? $t('contextUsage.noteAcp') : $t('contextUsage.note') }}
    </p>

    <!-- Compact 按钮 — 点击后关闭弹窗 -->
    <button
      @click="emit('close'); emit('compact')"
      class="w-full py-2 rounded-lg text-xs font-medium transition-colors"
      style="background: var(--bg-elevated); color: var(--accent); border: 1px solid var(--accent-dim)"
    >🗜️ {{ $t('contextUsage.compact') }}</button>
  </ModalShell>
</template>
