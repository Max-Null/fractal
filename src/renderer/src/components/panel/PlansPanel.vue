<script setup lang="ts">
// 计划面板：plans/ 目录计划列表（隔离 + 系统两目录合并，文件监听实时刷新）
// 数据源：plans:list（IPC）→ { plans, active }；active 为 .active.json 第一项（当前计划高亮）
import { ref, computed, onMounted, onUnmounted } from "vue";
import { listPlans, onPanelUpdate, type PlanEntry, type PanelActivePlan } from "@/lib/electron-bridge";

const plans = ref<PlanEntry[]>([]);
const active = ref<PanelActivePlan | null>(null);
let stopPanel: (() => void) | null = null;

async function load() {
  try {
    const r = await listPlans();
    plans.value = r.plans;
    active.value = r.active;
  } catch (err) {
    console.error("[PlansPanel] 加载计划失败：", err);
  }
}

// 状态标签映射：执行中 accent / 已完成 success / 未知 faint
const statusMeta: Record<PlanEntry["status"], { label: string; cls: string }> = {
  执行中: { label: "执行中", cls: "plan-status--active" },
  已完成: { label: "已完成", cls: "plan-status--done" },
  未知: { label: "未知", cls: "plan-status--unknown" },
};

// 进度条宽度与数值文案（0/0 → 0%，避免 NaN）
function pctOf(p: PlanEntry): number {
  if (p.totalSteps <= 0) return 0;
  return Math.min(100, Math.round((p.currentStep / p.totalSteps) * 100));
}
function stepText(p: PlanEntry): string {
  return p.totalSteps > 0 ? `${p.currentStep}/${p.totalSteps}` : "0/0";
}

// 当前计划进度（.active.json progress 形如 "5/5" 或 "?/?"；解析失败显示原文）
const activePct = computed(() => {
  if (!active.value) return 0;
  const m = /(\d+)\s*\/\s*(\d+)/.exec(active.value.progress);
  if (!m) return 0;
  const total = Number(m[2]);
  if (!total) return 0;
  return Math.min(100, Math.round((Number(m[1]) / total) * 100));
});

onMounted(async () => {
  await load();
  stopPanel = onPanelUpdate((p) => {
    if (p.kind === "plans") void load();
  });
});

onUnmounted(() => {
  stopPanel?.();
});
</script>

<template>
  <div class="plans-panel">
    <!-- 当前计划（.active.json 第一项，顶部高亮） -->
    <div v-if="active" class="plan plan--active">
      <div class="plan-title">
        <span class="plan-live-dot"></span>{{ active.title }}
        <span class="plan-status plan-status--active">当前计划</span>
      </div>
      <div class="plan-bar">
        <div class="bar-track"><div class="bar-fill" :style="{ width: activePct + '%' }"></div></div>
        <span class="plan-pct">{{ active.progress }}</span>
      </div>
      <div v-if="active.lastCompletedStep" class="plan-desc">上一步完成：{{ active.lastCompletedStep }}</div>
    </div>

    <!-- 空态：数据源无计划时展示 -->
    <div v-if="plans.length === 0" class="plan-empty">
      <div class="plan-empty-big">📋</div>
      <div>暂无计划</div>
      <div class="plan-empty-sub">让双星规划复杂任务后，计划会显示在这里</div>
    </div>

    <!-- 计划卡片 -->
    <div v-for="p in plans" :key="p.file" class="plan">
      <div class="plan-title">
        {{ p.title }}
        <span class="plan-status" :class="statusMeta[p.status].cls">{{ statusMeta[p.status].label }}</span>
      </div>
      <div class="plan-bar">
        <div class="bar-track"><div class="bar-fill" :style="{ width: pctOf(p) + '%' }"></div></div>
        <span class="plan-pct">{{ stepText(p) }}</span>
      </div>
      <div v-if="p.lastCompletedStep" class="plan-desc">上一步完成：{{ p.lastCompletedStep }}</div>
    </div>
  </div>
</template>

<style scoped>
/* ── 计划面板：对齐原型 v0.23 panel-body / 计划 tab ── */
.plans-panel {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 14px;
  min-height: 0;
}

/* 空态 */
.plan-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 32px 14px;
  border: 1px dashed var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  color: var(--text-muted);
  font-size: 12px;
}
.plan-empty-big { font-size: 26px; opacity: 0.6; }
.plan-empty-sub { font-size: 10.5px; }

/* 计划卡片 */
.plan {
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-md);
  background: var(--bg-elevated);
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
/* 当前计划高亮（accent 边框 + 呼吸圆点） */
.plan--active {
  border-color: var(--accent-line);
  background: var(--accent-glow);
}
.plan-live-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 0 var(--accent);
  animation: plan-pulse 2s infinite;
  flex-shrink: 0;
}
@keyframes plan-pulse {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 60%, transparent); }
  70% { box-shadow: 0 0 0 5px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}
.plan-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-bright);
}
.plan-status {
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 999px;
  font-weight: 500;
  flex-shrink: 0;
}
.plan-status--active { background: var(--accent-glow); color: var(--accent); }
.plan-status--done { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); }
.plan-status--unknown { background: var(--bg-active); color: var(--text-secondary); }
.plan-bar { display: flex; align-items: center; gap: 10px; }
.bar-track {
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: var(--bg-active);
  overflow: hidden;
}
.bar-fill {
  height: 100%;
  border-radius: 2px;
  background: var(--accent);
  transition: width 0.6s ease;
}
.plan-pct {
  font-size: 11px;
  color: var(--accent);
  font-family: var(--font-mono);
}
.plan-desc {
  font-size: 11.5px;
  color: var(--text-secondary);
  line-height: 1.6;
}
</style>
