<script setup lang="ts">
// 预置技能分组骨架：阶段 6 接入预置包清单（oc-plus 全家桶：双星四 agent / 分形插件 / 技能包）
// 后由数据源填充，此处为占位列表
const groups = [
  {
    label: "双星四 Agent",
    items: [
      { name: "双星", desc: "主助手 · 四阶段编排", ico: "✦", kind: "agent" },
      { name: "工匠", desc: "编码执行 · LSP 感知", ico: "工", kind: "agent" },
      { name: "参谋", desc: "方案推演 · 风险评估", ico: "谋", kind: "agent" },
      { name: "军师", desc: "全局规划 · 阶段编排", ico: "师", kind: "agent" },
    ],
  },
  {
    label: "分形插件",
    items: [
      { name: "记忆管家（Guardian）", desc: "6 触发线 · 三层记忆 · 计划导航", ico: "◈", kind: "plugin" },
      { name: "agents-priority", desc: "Agent 协作优先级编排", ico: "✦", kind: "plugin" },
      { name: "opencode-acp", desc: "ACP 双工协议集成桥", ico: "⇄", kind: "plugin" },
    ],
  },
  {
    label: "技能包 · 14 个",
    items: [
      { name: "提交审查", desc: "commit 前审查工作流", ico: "🔍", kind: "skill" },
      { name: "设计文档", desc: "方案 + 原型并行输出", ico: "📝", kind: "skill" },
      { name: "代码整理", desc: "注释 + 分层重排", ico: "🧹", kind: "skill" },
    ],
  },
];
</script>

<template>
  <div class="skills-panel">
    <div class="panel-tip">技能列表将在阶段 6 接入（预置包 oc-plus 全家桶清单）</div>

    <template v-for="g in groups" :key="g.label">
      <div class="pgroup">{{ g.label }}</div>
      <div v-for="it in g.items" :key="it.name" class="pitem">
        <span class="pitem-ico" :class="`pitem-ico--${it.kind}`">{{ it.ico }}</span>
        <div class="pitem-info">
          <div class="pitem-name">{{ it.name }}</div>
          <div class="pitem-sub">{{ it.desc }}</div>
        </div>
        <!-- 开关占位：阶段 6 接入预置能力开关（opencode.json 读写） -->
        <span class="switch switch--on"></span>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* ── 技能面板：对齐原型 v0.23 panel-body / 预置 tab ── */
.skills-panel {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
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
  margin-bottom: 4px;
}

/* 分组标题 */
.pgroup {
  font-size: 10.5px;
  letter-spacing: 0.08em;
  color: var(--text-muted);
  text-transform: uppercase;
  padding: 6px 2px 0;
}

/* 条目 */
.pitem {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-dim);
  background: var(--bg-elevated);
}
.pitem-ico {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
}
.pitem-ico--agent { background: var(--accent-glow); color: var(--accent); }
/* violet 无现成柔和变量，用 color-mix 按主题色生成 */
.pitem-ico--plugin { background: color-mix(in srgb, var(--violet) 14%, transparent); color: var(--violet); }
.pitem-ico--skill { background: var(--amber-glow); color: var(--amber); }
.pitem-info {
  flex: 1;
  min-width: 0;
}
.pitem-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-bright);
}
.pitem-sub {
  font-size: 10.5px;
  color: var(--text-muted);
}

/* 开关占位（阶段 6 接入配置读写后变为可交互） */
.switch {
  position: relative;
  width: 30px;
  height: 16px;
  border-radius: 999px;
  background: var(--bg-active);
  flex-shrink: 0;
}
.switch--on { background: var(--accent-dim); }
.switch--on::after {
  content: "";
  position: absolute;
  top: 2px;
  right: 2px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #fff;
}
</style>
