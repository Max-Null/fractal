<script setup lang="ts">
import { ref, onMounted, onUnmounted, inject, nextTick, watch, type Ref } from "vue";
import { useI18n } from "vue-i18n";
import ConfirmDialog from "@/components/shared/ConfirmDialog.vue";
import {
  listDir, deleteFile, renameFile, moveFile, copyFile, createDir,
  revealInExplorer as reveal, type FileEntry,
} from "@/lib/electron-bridge";

const { t } = useI18n();

const props = defineProps<{
  entries: FileEntry[];
  selected: string | null;
  /** 文件操作后通知 FilePanel 刷新 */
  onFileChanged?: () => void;
  /** FilePanel 刷新计数器，变更时子 FileTree 刷新已展开目录 */
  refreshKey?: number;
}>();

const emit = defineEmits<{
  selectFile: [entry: FileEntry];
  navigateTo: [path: string];
}>();

// ═══ 剪贴板（通过 provide/inject 跨递归 FileTree 共享） ═══
interface ClipState { path: string; name: string; op: "copy" | "cut" }
const clip = inject<{ state: Ref<ClipState | null>; set: (v: ClipState | null) => void }>("file-clipboard");
const clipState = clip?.state;
const setClip = clip?.set;

// ═══ 双击文件 → 打开到右侧编辑面板 ═══
const openInPanel = inject<(f: { name: string; path: string }) => void>("openFileInPanel", () => {});

function onDblClick(entry: FileEntry) {
  if (!entry.is_dir) {
    openInPanel({ name: entry.name, path: entry.path });
  }
}

/** 提取文件所在目录路径 */
function parentPath(filePath: string): string {
  const p = filePath.lastIndexOf("\\");
  const s = filePath.lastIndexOf("/");
  const sep = Math.max(p, s);
  return sep > 0 ? filePath.slice(0, sep) : filePath;
}

// ═══ 右键菜单 ═══
const ctxMenu = ref<{ x: number; y: number; entry: FileEntry } | null>(null);
const menuRef = ref<HTMLElement | null>(null);

function onContextMenu(e: MouseEvent, entry: FileEntry) {
  e.preventDefault();
  e.stopPropagation();  // 阻止冒泡到父级 FileTree，避免菜单覆盖
  ctxMenu.value = { x: e.clientX, y: e.clientY, entry };
  // 等 DOM 渲染 + 布局完成，精确修正位置防止菜单超出视口
  nextTick(() => {
    requestAnimationFrame(() => {
      if (!ctxMenu.value || !menuRef.value) return;
      const rect = menuRef.value.getBoundingClientRect();
      const pad = 8;
      const m = ctxMenu.value;
      let x = m.x;
      let y = m.y;
      if (rect.right > window.innerWidth) {
        x = Math.max(pad, window.innerWidth - rect.width - pad);
      }
      if (rect.bottom > window.innerHeight) {
        y = Math.max(pad, window.innerHeight - rect.height - pad);
      }
      if (x !== m.x || y !== m.y) {
        ctxMenu.value = { ...m, x, y }; // 整体替换触发响应式更新
      }
    });
  });
}

function closeMenu() { ctxMenu.value = null; }
onMounted(() => document.addEventListener("click", closeMenu));
onUnmounted(() => document.removeEventListener("click", closeMenu));

// ═══ 内联重命名 ═══
const renamingPath = ref<string | null>(null);
const renameInput = ref("");
const renameRef = ref<HTMLInputElement | null>(null);
const renaming = ref(false);  // 防 Enter+blur 双重提交

function startRename(entry: FileEntry) {
  closeMenu();
  renamingPath.value = entry.path;
  renameInput.value = entry.name;
  nextTick(() => renameRef.value?.select());
}

async function commitRename(entry: FileEntry) {
  if (renaming.value) return;  // 已在执行中，跳过
  const newName = renameInput.value.trim();
  renamingPath.value = null;
  if (!newName || newName === entry.name) return;
  renaming.value = true;
  try {
    await renameFile(entry.path, newName);
    props.onFileChanged?.();
  } catch (e) {
    console.error("[FileTree] Rename failed:", e);
  } finally {
    renaming.value = false;
  }
}

function cancelRename() { renamingPath.value = null; }

// ═══ 删除 ═══
// 原生 confirm 替换为 ConfirmDialog（2026-08-13 用户反馈弹窗太丑）：state 驱动
const deleteTarget = ref<FileEntry | null>(null);
async function onDeleteConfirm() {
  const entry = deleteTarget.value;
  deleteTarget.value = null;
  if (!entry) return;
  try {
    await deleteFile(entry.path);
    props.onFileChanged?.();
  } catch (e) {
    console.error("[FileTree] Delete failed:", e);
    alert(String(e));
  }
}
function onDeleteCancel() { deleteTarget.value = null; }
function doDelete(entry: FileEntry) {
  closeMenu();
  deleteTarget.value = entry;
}

// ═══ 复制 / 剪切 ═══
async function doCopy(entry: FileEntry, op: "copy" | "cut") {
  closeMenu();
  setClip?.({ path: entry.path, name: entry.name, op });
}

// ═══ 粘贴 ═══
async function doPaste(destDir: string) {
  closeMenu();
  if (!clipState?.value) return;
  const src = clipState.value;
  try {
    if (src.op === "cut") {
      await moveFile(src.path, destDir);
    } else {
      await copyFile(src.path, destDir);
    }
    setClip?.(null);
    props.onFileChanged?.();
  } catch (e) {
    console.error("Paste failed:", e);
  }
}

// ═══ 新建文件夹 ═══
async function doNewFolder(parentDir: string) {
  closeMenu();
  const name = prompt(t("file.newFolderPrompt"));
  if (!name?.trim()) return;
  try {
    // 跨平台路径拼接：避免硬编码 \\ 或 /
    const sep = parentDir.includes("/") && !parentDir.includes("\\") ? "/" : "\\";
    await createDir(parentDir + sep + name.trim());
    props.onFileChanged?.();
  } catch (e) {
    console.error("Create dir failed:", e);
  }
}

// ═══ 在文件管理器中打开 ═══
async function revealInExplorer(entry: FileEntry) {
  closeMenu();
  try { await reveal(entry.path); } catch {}
}

// ═══ 添加到对话 ═══
function addToChat(entry: FileEntry) {
  closeMenu();
  window.dispatchEvent(new CustomEvent("attach-files", { detail: [{ name: entry.name, path: entry.path }] }));
}

// ═══ 复制路径/文件名 ═══
async function copyToClipboard(text: string) {
  closeMenu();
  try { await navigator.clipboard.writeText(text); } catch {}
}

// ═══ 展开/收起 ═══
const expandedDirs = ref<Record<string, FileEntry[]>>({});
const loadingDirs = ref<Record<string, boolean>>({});

// 文件操作后刷新所有已展开目录（避免子目录内操作后 UI 陈旧）
watch(() => props.refreshKey, async () => {
  const keys = Object.keys(expandedDirs.value);
  if (keys.length === 0) return;
  await Promise.all(keys.map(async (key) => {
    try {
      expandedDirs.value[key] = await listDir(key);
    } catch { /* 目录可能已被删除 */ }
  }));
  expandedDirs.value = { ...expandedDirs.value };
});

async function toggleDir(entry: FileEntry) {
  if (!entry.is_dir) {
    emit("selectFile", entry);
    return;
  }
  const key = entry.path;
  if (expandedDirs.value[key]) {
    delete expandedDirs.value[key];
    expandedDirs.value = { ...expandedDirs.value };
  } else {
    loadingDirs.value[key] = true;
    loadingDirs.value = { ...loadingDirs.value };
    try {
      const children = await listDir(entry.path);
      expandedDirs.value[key] = children;
      expandedDirs.value = { ...expandedDirs.value };
    } catch { /* permission denied */ }
    finally {
      delete loadingDirs.value[key];
      loadingDirs.value = { ...loadingDirs.value };
    }
  }
}

function icon(isDir: boolean, name: string): string {
  if (isDir) {
    const key = name;
    for (const k in expandedDirs.value) {
      if (k.endsWith("\\" + key) || k.endsWith("/" + key) || k === key) return "📂";
    }
    return "📁";
  }
  const ext = name.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: "🔷", tsx: "⚛️", js: "🟨", vue: "💚", rs: "🦀",
    py: "🐍", css: "🎨", html: "🌐", json: "📋", md: "📝",
    yml: "⚙️", yaml: "⚙️", sql: "🗄️", toml: "⚙️",
    svg: "🖼️", png: "🖼️", ico: "🖼️",
    sh: "💻", bat: "💻", ps1: "💻",
  };
  return map[ext || ""] || "📄";
}

function sizeStr(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isExpanded(path: string): boolean { return !!expandedDirs.value[path]; }
function isLoading(path: string): boolean { return !!loadingDirs.value[path]; }
</script>

<template>
  <div class="text-xs select-none leading-relaxed">
    <template v-for="entry in entries" :key="entry.path">
      <!-- ═══ 内联重命名 ═══ -->
      <div v-if="renamingPath === entry.path" class="flex items-center gap-1.5 px-2 py-0.5">
        <span class="w-3.5 shrink-0"></span>
        <span class="text-xs shrink-0">{{ icon(entry.is_dir, entry.name) }}</span>
        <input
          ref="renameRef"
          v-model="renameInput"
          @keydown.enter="commitRename(entry)"
          @keydown.escape="cancelRename"
          @blur="commitRename(entry)"
          class="flex-1 text-xs bg-transparent border rounded px-1 py-px outline-none"
          :style="{ borderColor: 'var(--accent)', color: 'var(--text-bright)' }"
        />
        <span class="text-[10px] shrink-0" :style="{ color: 'var(--text-muted)' }">⏎</span>
      </div>

      <!-- ═══ 普通行 ═══ -->
      <div
        v-else
        @click="toggleDir(entry)"
        @dblclick="onDblClick(entry)"
        @contextmenu="onContextMenu($event, entry)"
        :class="[
          'flex items-center gap-1.5 px-2 py-0.5 rounded cursor-pointer transition-colors truncate',
          selected === entry.name
            ? 'bg-[var(--accent)]/10 text-[var(--accent)]'
            : 'hover:bg-[var(--bg-hover)]'
        ]"
        :style="{ color: selected === entry.name ? 'var(--accent)' : 'var(--text-secondary)' }"
      >
        <span
          v-if="entry.is_dir"
          class="w-3.5 shrink-0 text-center text-[10px]"
          :style="{ color: 'var(--text-muted)' }"
        >
          <span v-if="isLoading(entry.path)" class="inline-block animate-spin">⟳</span>
          <span v-else>{{ isExpanded(entry.path) ? '▼' : '▶' }}</span>
        </span>
        <span v-else class="w-3.5 shrink-0"></span>

        <span class="text-xs shrink-0">{{ icon(entry.is_dir, entry.name) }}</span>
        <span class="truncate">{{ entry.name }}</span>
        <span
          v-if="!entry.is_dir"
          class="ml-auto text-[10px] shrink-0"
          :style="{ color: 'var(--text-muted)' }"
        >{{ sizeStr(entry.size) }}</span>
      </div>

      <!-- ═══ 展开的子目录 ═══ -->
      <div v-if="entry.is_dir && isExpanded(entry.path)" class="ml-3.5 border-l"
        :style="{ borderColor: 'var(--border-dim)' }">
        <FileTree
          v-if="expandedDirs[entry.path]?.length"
          :entries="expandedDirs[entry.path]"
          :selected="selected"
          :onFileChanged="onFileChanged"
          :refreshKey="refreshKey"
          @selectFile="emit('selectFile', $event)"
          @navigateTo="emit('navigateTo', $event)"
        />
        <div v-else class="px-2 py-1 text-[10px]" :style="{ color: 'var(--text-muted)' }">
          {{ $t('file.empty') }}
        </div>
      </div>
    </template>

    <div
      v-if="entries.length === 0"
      class="px-2 py-4 text-center"
      :style="{ color: 'var(--text-muted)' }"
    >
      {{ $t('file.emptyDir') }}
    </div>

    <!-- ═══ 右键菜单 ═══ -->
    <Teleport to="body">
      <div
        ref="menuRef"
        v-if="ctxMenu"
        class="fixed z-50 py-1 rounded-lg shadow-lg border text-[11px] min-w-[180px]"
        :style="{
          left: ctxMenu.x + 'px',
          top: ctxMenu.y + 'px',
          background: 'var(--bg-elevated)',
          borderColor: 'var(--border-default)',
          color: 'var(--text-secondary)',
        }"
        @click.stop
      >
        <!-- 目录专用 -->
        <template v-if="ctxMenu.entry.is_dir">
          <button @click="doPaste(ctxMenu.entry.path)" :disabled="!clipState"
            class="w-full text-left px-3 py-1.5 transition-colors flex items-center gap-2"
            :class="clipState ? 'hover:bg-[var(--bg-hover)]' : ''"
            :style="{ opacity: clipState ? 1 : 0.3 }"
          >📥 {{ clipState ? $t('file.paste') : $t('file.paste') }}</button>
          <button @click="doNewFolder(ctxMenu.entry.path)"
            class="w-full text-left px-3 py-1.5 hover:bg-[var(--bg-hover)] transition-colors flex items-center gap-2"
          >📁 {{ $t('file.newFolder') }}</button>
          <div class="my-1 mx-2 border-t" :style="{ borderColor: 'var(--border-dim)' }"></div>
        </template>
        <!-- 通用操作 -->
        <template v-if="!ctxMenu.entry.is_dir">
          <button @click="addToChat(ctxMenu.entry)"
            class="w-full text-left px-3 py-1.5 hover:bg-[var(--bg-hover)] transition-colors flex items-center gap-2"
            :style="{ color: 'var(--accent)' }"
          >💬 {{ $t('file.addToChat') }}</button>
          <div class="my-1 mx-2 border-t" :style="{ borderColor: 'var(--border-dim)' }"></div>
        </template>
        <button @click="doCopy(ctxMenu.entry, 'copy')"
          class="w-full text-left px-3 py-1.5 hover:bg-[var(--bg-hover)] transition-colors flex items-center gap-2"
        >📋 {{ $t('file.copy') }}</button>
        <button @click="doCopy(ctxMenu.entry, 'cut')"
          class="w-full text-left px-3 py-1.5 hover:bg-[var(--bg-hover)] transition-colors flex items-center gap-2"
        >✂️ {{ $t('file.cut') }}</button>
        <template v-if="clipState">
          <button @click="doPaste(parentPath(ctxMenu.entry.path))" :disabled="!clipState"
            class="w-full text-left px-3 py-1.5 transition-colors flex items-center gap-2"
            :class="clipState ? 'hover:bg-[var(--bg-hover)]' : ''"
            :style="{ opacity: clipState ? 1 : 0.3 }"
          >📥 {{ $t('file.pasteInto') }}</button>
        </template>
        <button @click="startRename(ctxMenu.entry)"
          class="w-full text-left px-3 py-1.5 hover:bg-[var(--bg-hover)] transition-colors flex items-center gap-2"
        >✏️ {{ $t('file.rename') }}</button>
        <button @click="doDelete(ctxMenu.entry)"
          class="w-full text-left px-3 py-1.5 hover:bg-[var(--bg-hover)] transition-colors flex items-center gap-2"
          :style="{ color: 'var(--coral)' }"
        >🗑️ {{ $t('file.delete') }}</button>
        <div class="my-1 mx-2 border-t" :style="{ borderColor: 'var(--border-dim)' }"></div>
        <button @click="revealInExplorer(ctxMenu.entry)"
          class="w-full text-left px-3 py-1.5 hover:bg-[var(--bg-hover)] transition-colors flex items-center gap-2"
        >📂 {{ $t('file.reveal') }}</button>
        <button @click="copyToClipboard(ctxMenu.entry.path)"
          class="w-full text-left px-3 py-1.5 hover:bg-[var(--bg-hover)] transition-colors flex items-center gap-2"
        >🔗 {{ $t('file.copyPath') }}</button>
        <button @click="copyToClipboard(ctxMenu.entry.name)"
          class="w-full text-left px-3 py-1.5 hover:bg-[var(--bg-hover)] transition-colors flex items-center gap-2"
        >📝 {{ $t('file.copyName') }}</button>
      </div>
    </Teleport>

    <!-- 删除文件确认（ConfirmDialog danger：确认后删除） -->
    <ConfirmDialog
      :open="!!deleteTarget"
      :title="$t('file.delete')"
      :message="$t('file.confirmDelete', { name: deleteTarget?.name ?? '' })"
      :confirm-text="$t('modal.confirm')"
      :danger="true"
      @confirm="onDeleteConfirm"
      @cancel="onDeleteCancel"
    />
  </div>
</template>
