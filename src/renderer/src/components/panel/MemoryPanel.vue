<script setup lang="ts">
import { ref } from "vue";

// 三层记忆分组定义（阶段 6 接入插件记忆索引文件后由数据源填充，此处仅占位）
const layers = [
  { key: "global", label: "🌐 全局记忆", desc: "跨项目通用 · 双星偏好与习惯" },
  { key: "project", label: "📁 项目记忆", desc: "当前工作区 · 业务上下文" },
  { key: "session", label: "💬 会话记忆", desc: "本次会话 · 临时上下文" },
];

// 状态筛选 chips（原型 v0.23 记忆 tab：全部 / 待确认 / 已生效 / 观察中）
const chips = ["全部", "待确认", "已生效", "观察中"];
const searchQuery = ref("");
const activeChip = ref("全部");
</script>

<template>
  <div class="mem-panel">
    <div class="search-row">
      <input v-model="searchQuery" class="search-row-input" placeholder="搜索记忆…（本地检索）" />
      <button class="mini-btn" title="新增记忆">＋</button>
    </div>

    <div class="chips">
      <button
        v-for="c in chips"
        :key="c"
        class="chip"
        :class="{ 'chip--active': activeChip === c }"
        @click="activeChip = c"
      >{{ c }}</button>
    </div>

    <div class="panel-tip">记忆功能将在阶段 6 接入（插件写记忆索引文件 → GUI 实时刷新）</div>

    <div v-for="layer in layers" :key="layer.key" class="mem-group">
      <div class="mem-group-head">
        <span>{{ layer.label }}</span>
        <span class="mem-group-desc">{{ layer.desc }}</span>
      </div>
      <div class="mem-empty">
        <div class="mem-empty-big">🧠</div>
        <div>暂无{{ layer.label }}条目</div>
        <div class="mem-empty-sub">Agent 首次会话后将在此生成候选记忆</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ── 记忆面板：对齐原型 v0.23 panel-body（flex 滚动 + 内边距 + 纵向间距）── */
.mem-panel {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 14px;
  min-height: 0;
}

/* 搜索行 */
.search-row { display: flex; gap: 8px; }
.search-row-input {
  flex: 1;
  padding: 8px 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: 12px;
  outline: none;
  transition: border-color 0.2s;
}
.search-row-input:focus { border-color: var(--accent-line); }
.search-row-input::placeholder { color: var(--text-muted); }

/* 状态 chips */
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.chip {
  padding: 4px 11px;
  border-radius: 999px;
  font-size: 11px;
  color: var(--text-secondary);
  border: 1px solid var(--border-dim);
  cursor: pointer;
  transition: all 0.18s;
}
.chip:hover { color: var(--text-primary); }
.chip--active {
  border-color: var(--accent-line);
  color: var(--accent);
  background: var(--accent-glow);
}

/* 三层记忆分组 */
.mem-group { display: flex; flex-direction: column; gap: 8px; }
.mem-group-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.mem-group-head span:first-child { font-size: 12px; font-weight: 600; color: var(--text-bright); }
.mem-group-desc { font-size: 10.5px; color: var(--text-muted); }
.mem-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 20px 14px;
  border: 1px dashed var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  color: var(--text-muted);
  font-size: 11.5px;
}
.mem-empty-big { font-size: 22px; opacity: 0.6; }
.mem-empty-sub { font-size: 10.5px; }

/* ── 通用小按钮 / 阶段提示条（骨架阶段各面板复用）── */
.mini-btn {
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 11px;
  color: var(--text-secondary);
  border: 1px solid var(--border-dim);
  background: transparent;
  cursor: pointer;
  transition: all 0.15s;
}
.mini-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.panel-tip {
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  background: var(--amber-glow);
  color: var(--amber);
  font-size: 11px;
  line-height: 1.5;
}
</style>
