<script setup lang="ts">
// 会话流文件修改卡片：展示回合内 write/edit 修改的文件清单，点击单文件展开 diff 区
// 状态判定：write 条目 mounted 时探测文件存在性——不存在升级 added（尽力而为，失败保持 modified）
import { ref, onMounted } from "vue";
import { FilePlus2, FilePenLine, ChevronDown, ChevronRight } from "lucide-vue-next";
import { readFileContent } from "@/lib/electron-bridge";
import type { FileChangeItem } from "@/stores/chat";

const props = defineProps<{ changes: FileChangeItem[] }>();

/** 展开态：filePath → boolean（默认全收起） */
const expanded = ref<Record<string, boolean>>({});
function toggle(path: string) {
  expanded.value = { ...expanded.value, [path]: !expanded.value[path] };
}

/** write 条目探测升级：文件已不存在 → added（新增）；存在或探测失败 → 保持 modified */
const status = ref<Record<string, FileChangeItem["status"]>>({});
onMounted(async () => {
  for (const c of props.changes) {
    // 仅 write 条目需要探测；edit 必然修改已存在文件，无需探测
    if (c.toolName !== "write") continue;
    try {
      await readFileContent(c.filePath);
      status.value[c.filePath] = "modified";
    } catch (err) {
      // 只有确认文件不存在（ENOENT）才升级 added；IPC/权限等其他错误保持 modified（尽力而为语义）
      status.value[c.filePath] = String(err instanceof Error ? err.message : err).includes("ENOENT") ? "added" : "modified";
    }
  }
});
function statusFor(c: FileChangeItem): FileChangeItem["status"] {
  return status.value[c.filePath] ?? c.status;
}
</script>

<template>
  <div class="file-change-card">
    <div v-for="c in changes" :key="c.filePath" class="file-change-item" @click="toggle(c.filePath)">
      <div class="file-change-item__row">
        <ChevronRight v-if="!expanded[c.filePath]" class="file-change-chevron" :size="12" />
        <ChevronDown v-else class="file-change-chevron" :size="12" />
        <!-- 图标规范：lucide 组件；新增 FilePlus2（绿）、修改 FilePenLine（蓝） -->
        <FilePlus2 v-if="statusFor(c) === 'added'" class="file-change-icon" :size="14" />
        <FilePenLine v-else class="file-change-icon" :size="14" />
        <span class="file-change-path">{{ c.filePath }}</span>
        <span class="file-change-badge" :class="'file-change-badge--' + statusFor(c)">
          {{ statusFor(c) === "added" ? $t('chat.added') : $t('chat.modified') }}
        </span>
      </div>
      <div v-if="expanded[c.filePath]" class="file-change-diff">
        <!-- edit：old→new 红绿对比；write：新内容代码块 -->
        <template v-if="c.oldString != null">
          <pre class="file-change-old">{{ c.oldString }}</pre>
          <pre class="file-change-new">{{ c.newString ?? "" }}</pre>
        </template>
        <pre v-else class="file-change-new">{{ c.newString ?? "" }}</pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 卡片容器：时间线内嵌，圆角边框 + 表面背景 */
.file-change-card {
  border: 1px solid var(--border-dim);
  border-radius: 8px;
  background: var(--bg-surface);
  overflow: hidden;
  font-size: 12px;
}
/* 单文件行：hover 高亮，整行可点击展开 */
.file-change-item {
  cursor: pointer;
  padding: 6px 10px;
}
.file-change-item:hover {
  background: var(--bg-hover);
}
.file-change-item__row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.file-change-chevron {
  color: var(--text-muted);
  flex-shrink: 0;
}
.file-change-icon {
  flex-shrink: 0;
}
/* 状态徽标色：新增=翠绿（--accent）/ 修改=信息蓝（--blue） */
.file-change-badge {
  margin-left: auto;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 999px;
}
.file-change-badge--added {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
.file-change-badge--modified {
  color: var(--blue);
  background: color-mix(in srgb, var(--blue) 12%, transparent);
}
/* diff 区：红（old）绿（new）代码块，限高滚动 */
.file-change-diff {
  margin-top: 6px;
  max-height: 240px;
  overflow-y: auto;
}
.file-change-old,
.file-change-new {
  margin: 0;
  padding: 4px 8px;
  font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-all;
}
/* --danger 未在色板定义，fallback 到 --coral（错误红）；与 main.css 既有 var(--danger, #f87171) 风格一致 */
.file-change-old {
  background: color-mix(in srgb, var(--danger, var(--coral)) 8%, transparent);
  color: var(--text-secondary);
}
.file-change-new {
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}
</style>
