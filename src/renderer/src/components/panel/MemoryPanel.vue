<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { listMemories, confirmMemory, removeMemory, readMemory, onPanelUpdate, type MemoryEntry, type MemoryDetail } from "@/lib/electron-bridge";
import ModalShell from "@/components/shared/ModalShell.vue";
import MarkdownRenderer from "@/components/shared/MarkdownRenderer.vue";

// 两层记忆分组（全局=真实全局 ~/.config/opencode/memories/blocks / 项目=当前工作区 .opencode/memories/blocks）。
// 注意：guardian 记忆框架的「三层」= memPath 0/1/2（全局/个人项目级/共享项目级），
// 不存在「会话记忆」——旧版 session 占位层是误读自创，已删除（2026-08-12）
const layers = [
  { key: "global", label: "🌐 全局记忆", desc: "跨项目通用 · 双星偏好与习惯" },
  { key: "project", label: "📁 项目记忆", desc: "当前工作区 · 业务上下文" },
];

// 状态筛选 chips（原型 v0.23 记忆 tab：全部 / 待确认 / 已生效 / 观察中）
// 注意：activeChip 存 status 值（pending/auto/suggest），与 label 解耦——直接用 label 比较 status 会永远不匹配
const chips = [
  { label: "全部", status: null },
  { label: "待确认", status: "pending" },
  { label: "已生效", status: "auto" },
  { label: "观察中", status: "suggest" },
] as const;

const searchQuery = ref("");
const activeChip = ref<string | null>(null); // null = 全部
const memoryData = ref<{ global: MemoryEntry[]; project: MemoryEntry[] }>({ global: [], project: [] });
// 详情弹窗状态：detail=当前查看的记忆全文；detailLoading=读取中；detailError=读取失败原因
const detail = ref<MemoryDetail | null>(null);
const detailLoading = ref(false);
const detailError = ref("");
// 标题快照：openDetail 时先从列表条目取标题——读取失败时 header 仍能显示标题（不依赖读取结果）
const detailTitle = ref("");
let stopPanel: (() => void) | null = null;

// 拉取记忆列表（首次挂载 + 文件监听广播 engine:panel-update(kind=memory)）
async function load() {
  try {
    memoryData.value = await listMemories();
  } catch (err) {
    console.error("[MemoryPanel] 加载记忆失败：", err);
  }
}

// 打开详情弹窗：先存标题快照（列表里有），再按 file 读全文（主进程越界校验），失败显示错误原因不关弹窗
async function openDetail(m: MemoryEntry) {
  detailTitle.value = m.title;
  detailLoading.value = true;
  detailError.value = "";
  try {
    detail.value = await readMemory(m.file);
  } catch (err) {
    detailError.value = `读取记忆失败：${err instanceof Error ? err.message : String(err)}`;
  } finally {
    detailLoading.value = false;
  }
}

// 关闭详情弹窗（ESC / 遮罩点击 / ×）
function closeDetail() {
  detail.value = null;
  detailError.value = "";
}

// 状态标签文案与角标 class 映射（pending=待确认 amber / auto=已生效 accent / suggest=观察中 faint）
const statusMeta: Record<MemoryEntry["status"], { label: string; cls: string }> = {
  pending: { label: "待确认", cls: "mem-badge--pending" },
  auto: { label: "已生效", cls: "mem-badge--auto" },
  suggest: { label: "观察中", cls: "mem-badge--suggest" },
};

// 搜索 + chips 双条件过滤（title/desc/preview 包含搜索词）
const visible = computed<Record<string, MemoryEntry[]>>(() => {
  const q = searchQuery.value.trim().toLowerCase();
  const filter = (list: MemoryEntry[]): MemoryEntry[] =>
    list.filter((m) => {
      if (activeChip.value !== null && m.status !== activeChip.value) return false;
      if (q && !`${m.title} ${m.desc} ${m.preview}`.toLowerCase().includes(q)) return false;
      return true;
    });
  return {
    global: filter(memoryData.value.global),
    project: filter(memoryData.value.project),
  };
});

// 操作：确认（pending → auto，主进程写回） / 删除（force rm），完成后重拉并关闭详情（快照已过期）
async function onConfirm(file: string) {
  try {
    await confirmMemory(file);
  } catch (err) {
    console.error("[MemoryPanel] 确认记忆失败：", err);
  }
  closeDetail();
  await load();
}
async function onRemove(file: string) {
  try {
    await removeMemory(file);
  } catch (err) {
    console.error("[MemoryPanel] 删除记忆失败：", err);
  }
  closeDetail();
  await load();
}

onMounted(async () => {
  await load();
  stopPanel = onPanelUpdate((p) => {
    if (p.kind === "memory") void load();
  });
});

onUnmounted(() => {
  stopPanel?.();
});
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
        :key="c.label"
        class="chip"
        :class="{ 'chip--active': activeChip === c.status }"
        @click="activeChip = c.status"
      >{{ c.label }}</button>
    </div>

    <div v-for="layer in layers" :key="layer.key" class="mem-group">
      <div class="mem-group-head">
        <span>{{ layer.label }}</span>
        <span class="mem-group-desc">{{ layer.desc }}</span>
      </div>

      <!-- global/project 过滤后为空也显示空态 -->
      <div v-if="visible[layer.key].length === 0" class="mem-empty">
        <div class="mem-empty-big">🧠</div>
        <div>暂无{{ layer.label }}条目</div>
        <div class="mem-empty-sub">Agent 首次会话后将在此生成候选记忆</div>
      </div>

      <!-- 记忆条目：点击打开详情弹窗 -->
      <div v-else v-for="m in visible[layer.key]" :key="m.file" class="mem-item" @click="openDetail(m)">
        <div class="mem-item-head">
          <span class="mem-item-title" :title="m.file">{{ m.title }}</span>
          <span class="mem-badge" :class="statusMeta[m.status].cls">{{ statusMeta[m.status].label }}</span>
        </div>
        <div v-if="m.desc" class="mem-item-desc">{{ m.desc }}</div>
        <div v-if="m.preview" class="mem-item-preview">{{ m.preview }}</div>
        <div class="mem-item-ops">
          <button v-if="m.status === 'pending'" class="mini-btn" @click.stop="onConfirm(m.file)">确认</button>
          <button class="mini-btn mini-btn--danger" @click.stop="onRemove(m.file)">删除</button>
        </div>
      </div>
    </div>

    <!-- 记忆详情弹窗：header 仅标题（快照）；状态角标/文件路径在 body 元信息行；
         打开条件覆盖 loading/error：读取失败时 detail 为 null，但弹窗仍需展示错误原因（否则静默失败） -->
    <ModalShell :open="detail !== null || detailLoading || detailError !== ''" size="md" @close="closeDetail">
      <template #header>
        <span class="modal-shell-title">{{ detailTitle || (detail?.title ?? "") }}</span>
      </template>

      <div v-if="detailLoading" class="mem-detail-loading">读取中…</div>
      <div v-else-if="detailError" class="mem-detail-error">{{ detailError }}</div>
      <div v-else-if="detail" class="mem-detail-body">
        <div class="mem-detail-meta">
          <span class="mem-badge" :class="statusMeta[detail.status].cls">{{ statusMeta[detail.status].label }}</span>
          <span class="mem-detail-file" :title="detail.file">{{ detail.file }}</span>
        </div>
        <div v-if="detail.desc" class="mem-detail-desc">{{ detail.desc }}</div>
        <!-- 剥掉 HTML 元数据注释行（type/status/description），只渲染 markdown 正文 -->
        <MarkdownRenderer :content="detail.content.replace(/<!--[\s\S]*?-->/g, '')" />
      </div>

      <!-- footer 仅确认操作（pending 才出现，非 pending 时整个 footer 不渲染）：
           删除入口保留在列表条目（用户需求 2026-08-12：详情弹窗去掉删除/关闭按钮，关闭走 ESC/遮罩/header ×） -->
      <template v-if="detail && detail.status === 'pending'" #footer>
        <button class="mini-btn" @click="onConfirm(detail.file)">确认</button>
      </template>
    </ModalShell>
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

/* 记忆条目卡片 */
.mem-item {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 10px 12px;
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-md);
  background: var(--bg-elevated);
}
.mem-item-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.mem-item-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-bright);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mem-item-desc {
  font-size: 11px;
  color: var(--text-secondary);
  line-height: 1.5;
}
.mem-item-preview {
  font-size: 10.5px;
  color: var(--text-muted);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.mem-item-ops {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
}
.mem-badge {
  flex-shrink: 0;
  font-size: 10px;
  padding: 1px 8px;
  border-radius: 999px;
  font-weight: 500;
}
/* 状态角标语义色：待确认 amber / 已生效 accent / 观察中 faint */
.mem-badge--pending { background: var(--amber-glow); color: var(--amber); }
.mem-badge--auto { background: var(--accent-glow); color: var(--accent); }
.mem-badge--suggest { background: var(--bg-active); color: var(--text-secondary); }

/* ── 通用小按钮 ── */
.mini-btn {
  padding: 3px 10px;
  border-radius: 6px;
  font-size: 11px;
  color: var(--text-secondary);
  border: 1px solid var(--border-dim);
  background: transparent;
  cursor: pointer;
  transition: all 0.15s;
}
.mini-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.mini-btn--danger:hover { color: var(--coral); border-color: var(--coral); }

/* ── 记忆详情弹窗：头部路径 / 正文排版 / 加载与错误态 ── */
/* 元信息行：状态角标 + 文件路径（title 提示全文） */
.mem-detail-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.mem-detail-file {
  font-size: 10.5px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mem-detail-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 60vh;
  overflow-y: auto;
}
.mem-detail-desc {
  font-size: 11.5px;
  color: var(--text-secondary);
  line-height: 1.6;
  padding: 8px 12px;
  border-left: 3px solid var(--accent-line);
  background: var(--bg-active);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
}
.mem-detail-loading,
.mem-detail-error {
  padding: 24px 0;
  text-align: center;
  font-size: 12px;
  color: var(--text-muted);
}
.mem-detail-error { color: var(--coral); }
</style>
