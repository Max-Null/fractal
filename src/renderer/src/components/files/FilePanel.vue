<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, provide, inject, type Ref } from "vue";

import { listDir, readFileContent, getWorkspaceRoot, type FileEntry } from "@/lib/electron-bridge";
import { translateError } from "@/lib/utils";
import { useI18n } from "vue-i18n";
import ErrorBoundary from "@/components/shared/ErrorBoundary.vue";
import FileTree from "./FileTree.vue";
import FilePreview from "./FilePreview.vue";
import GitPanel from "./GitPanel.vue";
import { PANEL_LAYOUT_KEY } from "@/composables/usePanelLayout";

const props = defineProps<{ navCounter?: number; navPath?: string; forceClose?: number }>();

const { t } = useI18n();
const collapsed = ref(true);
const rootPath = ref("");
const workspaceRoot = ref("");
const files = ref<FileEntry[]>([]);
const selectedFile = ref<string | null>(null);
const selectedFilePath = ref("");  // 完整路径，openModalPreview 从子目录选中文件时使用
const previewContent = ref("");
const openFileInPanel = inject<(f: { name: string; path: string }) => void>("openFileInPanel", () => {});

// 列宽由 usePanelLayout composable 统一管理
const layout = inject(PANEL_LAYOUT_KEY)!;

// ═══ 文件剪贴板（跨递归 FileTree 共享） ═══
interface ClipState { path: string; name: string; op: "copy" | "cut" }
const clipState = ref<ClipState | null>(null);
function setClip(v: ClipState | null) { clipState.value = v; }
provide("file-clipboard", { state: clipState as Ref<ClipState | null>, set: setClip });

// Drag-to-resize splitter between file tree and preview
const activeTab = ref<"files" | "git">("files");  // 面板 Tab 切换
const refreshKey = ref(0);  // 文件操作后触发 FileTree 刷新展开目录
const splitRatio = ref(35); // 文件树占比 %
const draggingSplit = ref(false);
function onSplitDragStart(e: MouseEvent) {
  e.preventDefault();
  draggingSplit.value = true;
  const panelEl = (e.target as HTMLElement).closest(".sb-file-panel-body") as HTMLElement | null;
  if (!panelEl) return;
  const startY = e.clientY;
  const startRatio = splitRatio.value;
  const onMove = (ev: MouseEvent) => {
    const dy = ev.clientY - startY;
    const pct = (dy / panelEl.clientHeight) * 100;
    splitRatio.value = Math.min(80, Math.max(10, startRatio + pct));
  };
  const onUp = () => {
    draggingSplit.value = false;
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

// CC 修改工作区文件后自动刷新文件面板
function onCcFileChanged() {
  refreshDir();
  // 当前预览的文件可能已被修改 → 重新加载预览内容
  if (selectedFilePath.value) openFile({ name: selectedFile.value || "", path: selectedFilePath.value, is_dir: false, size: 0 });
}

onMounted(async () => {
  try {
    workspaceRoot.value = await getWorkspaceRoot();
    // 优先使用外部传入的工作区路径（从 settings/SQLite 恢复），其次用自动检测的根目录
    rootPath.value = props.navPath || workspaceRoot.value;
    files.value = await listDir(rootPath.value);
  } catch { workspaceRoot.value = ""; }
  window.addEventListener("cc-file-changed", onCcFileChanged);
});

onUnmounted(() => {
  window.removeEventListener("cc-file-changed", onCcFileChanged);
});

// Listen for external navigation signal (e.g. header CWD click)
watch(() => props.navCounter, async () => {
  const path = props.navPath;
  if (!path) return;
  collapsed.value = false;
  rootPath.value = path;
  clearPreview();
  try { files.value = await listDir(path); } catch {}
});
// navPath 变更 → 同步文件面板（覆盖刷新后 settings 从 SQLite 恢复的场景）
watch(() => props.navPath, async (path) => {
  if (!path || path === rootPath.value) return;
  rootPath.value = path;
  clearPreview();
  try { files.value = await listDir(path); } catch {}
});
watch(() => props.forceClose, () => { collapsed.value = true; });
// 打开面板时自动刷新目录（CC 可能已修改文件）
watch(collapsed, async (v) => {
  if (!v && rootPath.value) { try { files.value = await listDir(rootPath.value); } catch {} }
});

/** 清空文件预览状态 */
function clearPreview() {
  selectedFile.value = null;
  selectedFilePath.value = "";
  previewContent.value = "";
}

function goRoot() {
  navigateTo(workspaceRoot.value);
}

/** 刷新当前目录列表 */
async function refreshDir() {
  try { files.value = await listDir(rootPath.value); } catch {}
  refreshKey.value++;  // 通知 FileTree 刷新已展开子目录
}

async function navigateTo(path: string) {
  rootPath.value = path;
  try { files.value = await listDir(path); } catch {}
}

/** Word 文档扩展名 */
const DOCX_EXTS = new Set(["docx", "doc"]);

async function openFile(entry: FileEntry) {
  if (entry.is_dir) { navigateTo(entry.path); return; }
  selectedFile.value = entry.name;
  selectedFilePath.value = entry.path;  // 完整路径，供 openModalPreview 使用
  const ext = entry.name.split(".").pop()?.toLowerCase() || "";

  // 二进制/结构化文件：内联预览无法展示，直接跳到第四列，关闭内联预览
  if (DOCX_EXTS.has(ext) || ext === "xlsx" || ext === "xls" || ext === "csv" || ext === "pptx") {
    clearPreview();
    openFileInPanel({ name: entry.name, path: entry.path });
    return;
  }

  try { previewContent.value = await readFileContent(entry.path); }
  catch (e) {
    const { key, params } = translateError(e);
    previewContent.value = t(key, params as any);
  }
}

function openModalPreview() {
  if (selectedFile.value && selectedFilePath.value) {
    openFileInPanel({ name: selectedFile.value, path: selectedFilePath.value });
  }
}

// Split path into clickable segments for breadcrumb
const pathSegments = computed(() => {
  const path = rootPath.value.replace(/[\\/]$/, "");
  const parts = path.split(/[\\/]/).filter(Boolean);
  const segments: { label: string; fullPath: string }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const full = parts.slice(0, i + 1).join("\\");
    segments.push({ label: parts[i], fullPath: full + (i === 0 ? "\\" : "") });
  }
  return segments;
});

function goUp() {
  if (pathSegments.value.length <= 1) return;
  const parent = pathSegments.value[pathSegments.value.length - 2];
  navigateTo(parent.fullPath);
}
</script>

<template>
  <ErrorBoundary name="FilePanel">
    <div class="sb-file-panel">
    <!-- Drag handle (thin strip, visible when panel is open) -->
    <div
      v-if="!collapsed"
      @mousedown="layout.startResize('files', $event)"
      class="file-panel-drag-handle"
      :class="{ 'file-panel-drag-handle--active': layout.filesDragging.value }"
    ></div>

    <!-- Drawer pull-tab -->
    <button
      @click="collapsed = !collapsed"
      class="file-panel-tab"
      :class="{ 'file-panel-tab--open': !collapsed }"
      :title="collapsed ? $t('file.title') : ''"
    >
      <span class="file-panel-tab-label" :class="{ 'file-panel-tab-label--open': !collapsed }">
        {{ collapsed ? $t('file.title') : '◀' }}
      </span>
    </button>

    <!-- Panel body -->
    <aside
      class="file-panel-body"
      :class="{ 'file-panel-body--closed': collapsed }"
      :style="{ width: collapsed ? '0' : layout.filesWidth.value + 'px' }"
    >
      <div v-if="!collapsed" class="flex flex-col h-full">
        <!-- Breadcrumb -->
        <div class="flex items-center gap-0.5 px-2 py-1.5 text-[11px] shrink-0 overflow-hidden"
          :style="{ color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-dim)' }">
          <button @click="goRoot" class="hover:text-[var(--accent)] transition-colors shrink-0 mr-0.5" :title="$t('file.backToRoot')">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
          </button>
          <template v-for="(seg, i) in pathSegments" :key="seg.fullPath">
            <span class="text-[10px]" :style="{ color: 'var(--border-bright)' }" v-if="i > 0">›</span>
            <button
              @click="navigateTo(seg.fullPath)"
              class="hover:text-[var(--accent)] transition-colors truncate max-w-[120px] shrink-0"
              :class="{ 'font-medium': i === pathSegments.length - 1 }"
              :style="{ color: i === pathSegments.length - 1 ? 'var(--text-primary)' : 'var(--text-muted)' }"
            >
              {{ seg.label }}
            </button>
          </template>
          <!-- 刷新按钮靠右 -->
          <button @click="refreshDir" class="hover:text-[var(--accent)] transition-colors shrink-0 ml-auto" :title="$t('file.refresh')">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
          </button>
        </div>

        <!-- Tab 栏：文件 / Git -->
        <div class="file-panel-tabs">
          <button
            @click="activeTab = 'files'"
            class="file-panel-tab-btn"
            :class="{ 'file-panel-tab-btn--active': activeTab === 'files' }"
          >📁 {{ $t('file.title') }}</button>
          <button
            @click="activeTab = 'git'"
            class="file-panel-tab-btn"
            :class="{ 'file-panel-tab-btn--active': activeTab === 'git' }"
          >⎇ Git</button>
        </div>

        <!-- 文件 Tab -->
        <div v-if="activeTab === 'files'" class="sb-file-panel-body">
          <!-- File tree -->
          <div
            class="overflow-y-auto px-1 py-0.5 min-h-0"
            :style="selectedFile && previewContent ? { height: splitRatio + '%' } : { flex: 1 }"
          >
            <FileTree :entries="files" :selected="selectedFile" :onFileChanged="refreshDir" :refreshKey="refreshKey" @selectFile="openFile" @navigateTo="navigateTo" />
          </div>

          <!-- 拖动分隔条 -->
          <div
            v-if="selectedFile && previewContent"
            @mousedown="onSplitDragStart"
            class="shrink-0 cursor-row-resize select-none flex items-center justify-center"
            :style="{
              height: '6px',
              background: draggingSplit ? 'var(--accent-dim)' : 'transparent',
              borderTop: '1px solid var(--border-dim)',
            }"
          >
            <div
              class="rounded-full transition-colors"
              :style="{
                width: '24px', height: '3px',
                background: draggingSplit ? 'var(--accent)' : 'var(--border-bright)',
              }"
            />
          </div>

          <!-- Inline preview panel -->
          <div v-if="selectedFile && previewContent" class="flex flex-col min-h-0" :style="{ flex: 1 }">
            <div class="flex items-center justify-between px-3 h-8 text-[11px] shrink-0"
              :style="{ color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-dim)' }">
              <span class="truncate font-medium">{{ selectedFile }}</span>
              <div class="flex items-center gap-1">
                <button
                  @click="openModalPreview"
                  class="w-5 h-5 flex items-center justify-center rounded transition-colors hover:bg-[var(--bg-elevated)]"
                  style="color: var(--accent)"
                  :title="$t('file.openPreview')"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
                </button>
                <button
                  @click="selectedFile = null; selectedFilePath = ''; previewContent = ''"
                  class="w-6 h-6 flex items-center justify-center rounded-md hover:bg-[var(--bg-hover)] transition-colors text-sm shrink-0"
                  :style="{ color: 'var(--text-secondary)' }"
                  :title="$t('file.closePreview')"
                >&times;</button>
              </div>
            </div>
            <div class="flex-1 overflow-auto">
              <FilePreview :content="previewContent" :filename="selectedFile" />
            </div>
          </div>
        </div>

        <!-- Git Tab -->
        <div v-if="activeTab === 'git'" class="flex-1 flex flex-col overflow-hidden min-h-0">
          <GitPanel :repoPath="rootPath" />
        </div>
      </div>
    </aside>
  </div>
  </ErrorBoundary>
</template>

<style scoped>
/* ── Tab 栏（文件 / Git）── */
.file-panel-tabs {
  display: flex;
  gap: 2px;
  padding: 4px 6px;
  border-bottom: 1px solid var(--border-dim);
}
.file-panel-tab-btn {
  padding: 2px 10px;
  border-radius: 4px;
  font-size: 11px;
  color: var(--text-muted);
  cursor: pointer;
  transition: background 150ms, color 150ms;
}
.file-panel-tab-btn:hover { color: var(--text-secondary); background: var(--bg-hover); }
.file-panel-tab-btn--active {
  color: var(--accent);
  background: var(--accent-glow);
}

/* ── 文件面板 ── */
.sb-file-panel {
  display: flex;
  overflow: hidden;
}

.sb-file-panel-body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

/* ── 拖拽把手 ── */
.file-panel-drag-handle {
  width: 0.375rem;
  flex-shrink: 0;
  cursor: col-resize;
  user-select: none;
  background: transparent;
  transition: background-color 150ms;
}
.file-panel-drag-handle:hover {
  background: rgba(6, 214, 160, 0.1);
}
.file-panel-drag-handle--active {
  background: var(--accent-dim);
}

/* ── 抽屉标签 ── */
.file-panel-tab {
  width: 1.75rem;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 0.5rem 0 0 0.5rem;
  cursor: pointer;
  user-select: none;
  transition: background 200ms, border 200ms;
  background: var(--bg-surface);
  color: var(--text-secondary);
  border: 1px solid var(--border-dim);
  border-right: none;
}
.file-panel-tab--open {
  background: var(--bg-elevated);
  border: none;
}

.file-panel-tab-label {
  transition: transform 200ms;
  writing-mode: vertical-rl;
  font-size: 10px;
  letter-spacing: 3px;
}
.file-panel-tab-label--open {
  transform: rotate(180deg);
}

/* ── 面板主体 ── */
.file-panel-body {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: width 200ms, min-width 200ms;
  background: var(--bg-surface);
  border-left: 1px solid var(--border-dim);
  min-width: 200px;
}
.file-panel-body--closed {
  min-width: 0;
  border-left: none;
}
</style>
