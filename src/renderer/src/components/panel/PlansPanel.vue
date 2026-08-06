<script setup lang="ts">
// plans/ 目录计划列表骨架：阶段 6 接入 GUI 读取 ~/.config/opencode/plans/，
// 此处为占位数据展示 UI 结构（标题/状态/进度条/步骤），数据源替换后由真实计划驱动
const placeholderPlans = [
  {
    title: "示例计划（占位）",
    status: { label: "执行中", cls: "active" },
    pct: 0,
    done: 0,
    total: 4,
    desc: "阶段 6 将读取 plans/ 目录中的真实计划",
    steps: ["步骤一（占位）", "步骤二（占位）", "步骤三（占位）", "步骤四（占位）"],
    curStep: 0,
  },
];

const empty = placeholderPlans.length === 0;
</script>

<template>
  <div class="plans-panel">
    <div class="panel-tip">计划列表将在阶段 6 接入（GUI 本地读取 ~/.config/opencode/plans/）</div>

    <!-- 空态：数据源无计划时展示 -->
    <div v-if="empty" class="plan-empty">
      <div class="plan-empty-big">📋</div>
      <div>暂无计划</div>
      <div class="plan-empty-sub">让双星规划复杂任务后，计划会显示在这里</div>
    </div>

    <!-- 计划卡片 -->
    <div v-for="p in placeholderPlans" :key="p.title" class="plan">
      <div class="plan-title">
        {{ p.title }}
        <span class="plan-status" :class="`plan-status--${p.status.cls}`">{{ p.status.label }}</span>
      </div>
      <div class="plan-bar">
        <div class="bar-track"><div class="bar-fill" :style="{ width: p.pct + '%' }"></div></div>
        <span class="plan-pct">{{ p.done }}/{{ p.total }}</span>
      </div>
      <div v-if="p.desc" class="plan-desc">{{ p.desc }}</div>
      <div class="plan-steps">
        <div
          v-for="(s, i) in p.steps"
          :key="s"
          class="pstep"
          :class="{ 'pstep--done': i < p.done, 'pstep--cur': i === p.curStep && i >= p.done }"
        >
          <span class="cb">{{ i < p.done ? '✓' : i === p.curStep && i >= p.done ? '·' : '○' }}</span>{{ s }}
        </div>
      </div>
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

/* 阶段提示条 */
.panel-tip {
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  background: var(--amber-glow);
  color: var(--amber);
  font-size: 11px;
  line-height: 1.5;
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
}
.plan-status--active { background: var(--accent-glow); color: var(--accent); }
.plan-status--paused { background: var(--bg-active); color: var(--text-secondary); }
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
.plan-steps {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}
.pstep {
  display: flex;
  gap: 8px;
  align-items: baseline;
  color: var(--text-secondary);
}
.pstep .cb {
  font-size: 11px;
  width: 14px;
  font-family: var(--font-mono);
}
.pstep--done {
  color: var(--text-muted);
  text-decoration: line-through;
  text-decoration-color: var(--border-bright);
}
.pstep--done .cb { color: var(--accent); text-decoration: none; }
.pstep--cur { color: var(--text-bright); }
</style>
