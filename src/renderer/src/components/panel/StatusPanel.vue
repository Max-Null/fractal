<script setup lang="ts">
// 状态面板骨架：触发线监控数据（断言计数/审查队列/无反馈环/知识提取/计划进度）
// 将在阶段 6 经 .fractal-state.json / serve 事件流接入，此处为占位
</script>

<template>
  <div class="status-panel">
    <div class="panel-tip">引擎状态将在阶段 6 接入（serve 事件流 / .fractal-state.json 实时监听）</div>

    <!-- 引擎状态 -->
    <div class="stat-card">
      <div class="stat-head"><span class="stat-ico stat-ico--g">◎</span>引擎</div>
      <div class="stat-row"><span class="k">serve</span><span class="v">未运行</span></div>
      <div class="stat-row"><span class="k">端口</span><span class="v">--</span></div>
      <div class="stat-row"><span class="k">隔离配置</span><span class="v dim">阶段 6 接入</span></div>
    </div>

    <!-- 联网查证：断言计数（分级） -->
    <div class="stat-card">
      <div class="stat-head"><span class="stat-ico stat-ico--a">◈</span>联网查证</div>
      <div class="stat-row"><span class="k">断言计数</span><span class="v">0 / 0</span></div>
      <div class="stat-row"><span class="k">等级</span><span class="meter"><i /><i /><i /></span></div>
      <div class="stat-desc">最近断言「<span class="w">--</span>」未查证 —— 暂无数据</div>
    </div>

    <!-- 编辑审查队列 -->
    <div class="stat-card">
      <div class="stat-head"><span class="stat-ico stat-ico--g">◫</span>编辑审查</div>
      <div class="stat-row"><span class="k">待审查队列</span><span class="v">0 条</span></div>
      <div class="stat-desc">最近编辑：--</div>
    </div>

    <!-- 无反馈环 -->
    <div class="stat-card">
      <div class="stat-head"><span class="stat-ico stat-ico--r">◉</span>无反馈环</div>
      <div class="stat-row"><span class="k">连续编辑无验证</span><span class="v">0 轮</span></div>
      <div class="stat-desc">状态正常</div>
    </div>

    <!-- 知识提取 -->
    <div class="stat-card">
      <div class="stat-head"><span class="stat-ico stat-ico--v">❖</span>知识提取</div>
      <div class="stat-row"><span class="k">最近提交</span><span class="v">--</span></div>
      <div class="stat-desc">已从 0 次提交中提取 0 条候选记忆</div>
    </div>

    <!-- 计划进度行 -->
    <div class="stat-card">
      <div class="stat-head"><span class="stat-ico stat-ico--g">📋</span>计划进度</div>
      <div class="stat-row"><span class="k">当前计划</span><span class="v">--</span></div>
      <div class="plan-bar">
        <div class="bar-track"><div class="bar-fill" :style="{ width: '0%' }"></div></div>
        <span class="plan-pct">0%</span>
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

/* 等级 meter（触发线分级示意） */
.meter { display: flex; gap: 3px; align-items: center; }
.meter i {
  width: 12px;
  height: 5px;
  border-radius: 2px;
  background: var(--bg-active);
}

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
