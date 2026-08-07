<script setup lang="ts">
// 状态面板：Guardian 触发线监控（断言计数/审查队列/无反馈环/知识提取/计划进度）
// 数据源：<userDataDir>/config/opencode/.fractal-state.json（Guardian 插件未来写入，可能不存在）
// 字段约定（防御式读取：文件不存在/字段缺失 → 显示默认值，不抛错）
import { ref, computed, onMounted, onUnmounted } from "vue";
import { getStatusState, onPanelUpdate } from "@/lib/electron-bridge";

const exists = ref(false);
const state = ref<Record<string, unknown>>({});
let stopPanel: (() => void) | null = null;

async function load() {
  try {
    const r = await getStatusState();
    exists.value = r.exists;
    // state 可能是任意 JSON；统一按 Record 访问，字段缺失走 ?? 默认值
    state.value = r.exists && r.state && typeof r.state === "object" ? (r.state as Record<string, unknown>) : {};
  } catch (err) {
    console.error("[StatusPanel] 读取状态失败：", err);
    exists.value = false;
    state.value = {};
  }
}

// 各统计卡片字段（Guardian 约定名；文件不存在 → undefined → 默认值兜底）
const engine = computed(() => (state.value.engine as Record<string, unknown> | undefined) ?? {});
const assertions = computed(() => (state.value.assertions as Record<string, unknown> | undefined) ?? {});
const reviews = computed(() => (state.value.reviews as Record<string, unknown> | undefined) ?? {});
const feedbackLoop = computed(() => (state.value.feedbackLoop as Record<string, unknown> | undefined) ?? {});
const knowledge = computed(() => (state.value.knowledge as Record<string, unknown> | undefined) ?? {});
const plan = computed(() => (state.value.plan as Record<string, unknown> | undefined) ?? {});

// 断言等级 meter（1-3 档，缺省 0 → 灰色空档）
const assertionLevel = computed(() => {
  const lv = Number(assertions.value.level ?? 0);
  return Number.isFinite(lv) && lv >= 1 && lv <= 3 ? lv : 0;
});

// 计划进度条宽度（0-100%）
const planPct = computed(() => {
  const done = Number(plan.value.currentStep ?? 0);
  const total = Number(plan.value.totalSteps ?? 0);
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.min(100, Math.round((done / total) * 100));
});

// 无反馈环轮数（unknown 字段 → Number 归一化，模板比较运算需要确定数值类型）
const feedbackCount = computed(() => {
  const n = Number(feedbackLoop.value.count ?? 0);
  return Number.isFinite(n) ? n : 0;
});

onMounted(async () => {
  await load();
  stopPanel = onPanelUpdate((p) => {
    if (p.kind === "status") void load();
  });
});

onUnmounted(() => {
  stopPanel?.();
});
</script>

<template>
  <div class="status-panel">
    <!-- Guardian 状态文件未生成提示（exists=false 时置顶，使用 Agent 会话后自动出现） -->
    <div v-if="!exists" class="panel-tip">Guardian 状态文件未生成（使用 Agent 会话后自动出现）</div>

    <!-- 引擎状态 -->
    <div class="stat-card">
      <div class="stat-head"><span class="stat-ico stat-ico--g">◎</span>引擎</div>
      <div class="stat-row"><span class="k">serve</span><span class="v">{{ engine.running ? "运行中" : "未运行" }}</span></div>
      <div class="stat-row"><span class="k">端口</span><span class="v">{{ engine.port ?? "--" }}</span></div>
      <div class="stat-row"><span class="k">隔离配置</span><span class="v dim">{{ exists ? "已启用" : "--" }}</span></div>
    </div>

    <!-- 联网查证：断言计数（分级） -->
    <div class="stat-card">
      <div class="stat-head"><span class="stat-ico stat-ico--a">◈</span>联网查证</div>
      <div class="stat-row"><span class="k">断言计数</span><span class="v">{{ assertions.count ?? 0 }} / 0</span></div>
      <div class="stat-row"><span class="k">等级</span><span class="meter"><i v-for="n in 3" :key="n" :class="{ 'meter--on': n <= assertionLevel }" /></span></div>
      <div class="stat-desc">最近断言「<span class="w">{{ assertions.last ?? "--" }}</span>」{{ exists ? "已查证" : "未查证 —— 暂无数据" }}</div>
    </div>

    <!-- 编辑审查队列 -->
    <div class="stat-card">
      <div class="stat-head"><span class="stat-ico stat-ico--g">◫</span>编辑审查</div>
      <div class="stat-row"><span class="k">待审查队列</span><span class="v">{{ reviews.pendingCount ?? 0 }} 条</span></div>
      <div class="stat-desc">最近编辑：{{ reviews.lastEdit ?? "--" }}</div>
    </div>

    <!-- 无反馈环 -->
    <div class="stat-card">
      <div class="stat-head"><span class="stat-ico stat-ico--r">◉</span>无反馈环</div>
      <div class="stat-row"><span class="k">连续编辑无验证</span><span class="v">{{ feedbackCount }} 轮</span></div>
      <div class="stat-desc">{{ feedbackCount > 0 ? "注意：连续编辑未验证" : "状态正常" }}</div>
    </div>

    <!-- 知识提取 -->
    <div class="stat-card">
      <div class="stat-head"><span class="stat-ico stat-ico--v">❖</span>知识提取</div>
      <div class="stat-row"><span class="k">最近提交</span><span class="v">{{ knowledge.lastCommit ?? "--" }}</span></div>
      <div class="stat-desc">已从 {{ knowledge.commitCount ?? 0 }} 次提交中提取 {{ knowledge.memoryCount ?? 0 }} 条候选记忆</div>
    </div>

    <!-- 计划进度行 -->
    <div class="stat-card">
      <div class="stat-head"><span class="stat-ico stat-ico--g">📋</span>计划进度</div>
      <div class="stat-row"><span class="k">当前计划</span><span class="v">{{ plan.title ?? "--" }}</span></div>
      <div class="plan-bar">
        <div class="bar-track"><div class="bar-fill" :style="{ width: planPct + '%' }"></div></div>
        <span class="plan-pct">{{ planPct }}%</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ── 状态面板：对齐原型 v0.23 panel-body / 状态 tab ── */
.status-panel {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 14px;
  min-height: 0;
}

/* 阶段提示条 */
.panel-tip {
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  background: var(--amber-glow);
  color: var(--amber);
  font-size: 11px;
  line-height: 1.5;
}

/* 状态卡片 */
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
  font-size: 12px;
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
  font-size: 10px;
}
.stat-ico--g { background: var(--accent-glow); color: var(--accent); }
.stat-ico--a { background: var(--amber-glow); color: var(--amber); }
.stat-ico--r { background: var(--coral-glow); color: var(--coral); }
/* violet 无现成柔和变量，用 color-mix 按主题色生成 */
.stat-ico--v { background: color-mix(in srgb, var(--violet) 14%, transparent); color: var(--violet); }
.stat-row {
  display: flex;
  justify-content: space-between;
  font-size: 11.5px;
}
.stat-row .k { color: var(--text-secondary); }
.stat-row .v { color: var(--text-primary); font-family: var(--font-mono); }
.stat-row .v.dim { color: var(--text-muted); }
.stat-desc {
  font-size: 11.5px;
  color: var(--text-secondary);
  line-height: 1.6;
}
.stat-desc .w { color: var(--amber); }

/* 等级 meter（触发线分级示意，点亮档位 ≤ assertionLevel） */
.meter { display: flex; gap: 3px; align-items: center; }
.meter i {
  width: 12px;
  height: 5px;
  border-radius: 2px;
  background: var(--bg-active);
}
.meter i.meter--on { background: var(--amber); }

/* 进度条 */
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
</style>
