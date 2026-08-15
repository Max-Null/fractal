<script setup lang="ts">
// 会话流文件修改卡片：展示回合内 write/edit 修改的文件清单，点击单文件展开 diff 区
// 状态判定：write 条目 mounted 时探测文件存在性——不存在升级 added（尽力而为，失败保持 modified）
import { ref, onMounted } from 'vue'
import { FilePlus2, FilePenLine, ChevronDown, ChevronRight } from 'lucide-vue-next'
import { readFileContent } from '@/lib/electron-bridge'
import { useSettingsStore } from '@/stores/settings'
import type { FileChangeItem } from '@/stores/chat'

const props = defineProps<{ changes: FileChangeItem[] }>()

/** 展开态：filePath → boolean（默认全收起） */
const expanded = ref<Record<string, boolean>>({})
function toggle(path: string) {
  expanded.value = { ...expanded.value, [path]: !expanded.value[path] }
}

/** 绝对路径判定：正斜杠开头（Unix）/ UNC 反斜杠 / Windows 盘符——主进程 fs 通道强制绝对路径（ipc.ts assertValidFsPath） */
function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || p.startsWith('\\\\') || /^[a-zA-Z]:/.test(p)
}

/** write 条目探测升级：文件已不存在 → added（新增）；存在或探测失败 → 保持 modified */
const status = ref<Record<string, FileChangeItem['status']>>({})
onMounted(async () => {
  // OC 原始 file_path 多为相对路径（src/foo.ts），主进程拒绝相对路径（非 ENOENT 错误）→ 基于工作区 resolve 成绝对路径
  const cwd = useSettingsStore().cwd
  for (const c of props.changes) {
    // 仅 write 条目需要探测；edit 必然修改已存在文件，无需探测
    if (c.toolName !== 'write') continue
    // 无 cwd 时相对路径无法 resolve → 跳过探测保持 modified（尽力而为语义）
    if (!cwd) continue
    const abs = isAbsolutePath(c.filePath)
      ? c.filePath
      : `${cwd.replace(/[\\/]+$/, '')}/${c.filePath}`
    try {
      await readFileContent(abs)
      status.value[c.filePath] = 'modified'
    } catch (err) {
      // 只有确认文件不存在（ENOENT）才升级 added；IPC/权限等其他错误保持 modified（尽力而为语义）
      status.value[c.filePath] = String(err instanceof Error ? err.message : err).includes('ENOENT')
        ? 'added'
        : 'modified'
    }
  }
})
function statusFor(c: FileChangeItem): FileChangeItem['status'] {
  return status.value[c.filePath] ?? c.status
}

/** 展示用相对路径：在 cwd 下则去掉 cwd 前缀（分隔符归一），否则原样（设计 3.4：路径相对 cwd 展示） */
function displayPath(p: string): string {
  const cwd = useSettingsStore().cwd
  if (!cwd) return p
  const norm = (s: string) => s.replace(/\\/g, '/')
  const cwdN = norm(cwd).replace(/\/+$/, '')
  const pN = norm(p)
  return pN.startsWith(cwdN + '/') ? pN.slice(cwdN.length + 1) : p
}

/** 文本拆行带行号（1 起始；空文本返回空数组——write 无 newString 时不渲染行号） */
function toLines(text: string | undefined): Array<{ n: number; text: string }> {
  if (!text) return []
  return text.split('\n').map((t, i) => ({ n: i + 1, text: t }))
}
</script>

<template>
  <div class="file-change-card">
    <div
      v-for="c in changes"
      :key="c.filePath"
      class="file-change-item"
      @click="toggle(c.filePath)"
    >
      <div class="file-change-item__row">
        <ChevronRight v-if="!expanded[c.filePath]" class="file-change-chevron" :size="12" />
        <ChevronDown v-else class="file-change-chevron" :size="12" />
        <!-- 图标规范：lucide 组件；新增 FilePlus2（绿）、修改 FilePenLine（蓝） -->
        <FilePlus2 v-if="statusFor(c) === 'added'" class="file-change-icon" :size="14" />
        <FilePenLine v-else class="file-change-icon" :size="14" />
        <span class="file-change-path" :title="displayPath(c.filePath)">{{ displayPath(c.filePath) }}</span>
        <span class="file-change-badge" :class="'file-change-badge--' + statusFor(c)">
          {{ statusFor(c) === 'added' ? $t('chat.added') : $t('chat.modified') }}
        </span>
      </div>
      <div v-if="expanded[c.filePath]" class="file-change-diff">
        <!-- edit：old→new 红绿对比；write：新内容代码块。均为「行号 + 文本」行列表 -->
        <template v-if="c.oldString != null">
          <div class="file-change-old">
            <div v-for="line in toLines(c.oldString)" :key="'o' + line.n" class="diff-line">
              <span class="diff-line-num">{{ line.n }}</span>
              <span class="diff-line-text">{{ line.text }}</span>
            </div>
          </div>
          <div class="file-change-new">
            <div v-for="line in toLines(c.newString)" :key="'n' + line.n" class="diff-line">
              <span class="diff-line-num">{{ line.n }}</span>
              <span class="diff-line-text">{{ line.text }}</span>
            </div>
          </div>
        </template>
        <div v-else class="file-change-new">
          <div v-for="line in toLines(c.newString)" :key="line.n" class="diff-line">
            <span class="diff-line-num">{{ line.n }}</span>
            <span class="diff-line-text">{{ line.text }}</span>
          </div>
        </div>
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
  font-size: 0.857rem;
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
/* 路径：flex 子项默认 min-width:auto 会按内容宽度撑开，长路径把徽标挤出容器 →
 * min-width:0 + overflow 让路径可收缩，单行省略号截断；title 属性 hover 显示完整路径 */
.file-change-path {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 状态徽标色：新增=翠绿（--accent）/ 修改=信息蓝（--blue） */
.file-change-badge {
  margin-left: auto;
  font-size: 0.714rem;
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
/* diff 区：红（old）绿（new）行列表，限高滚动 */
.file-change-diff {
  margin-top: 6px;
  max-height: 240px;
  overflow-y: auto;
}
/* 块容器：背景整块着色（行号列同底色，VSCode diff 风格）；内边距移到行容器 */
.file-change-old,
.file-change-new {
  margin: 0;
  padding: 4px 0;
  font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace;
  font-size: 0.786rem;
}
/* --danger 未在色板定义，fallback 到 --coral（错误红）；与 main.css 既有 var(--danger, #f87171) 风格一致 */
.file-change-old {
  background: color-mix(in srgb, var(--danger, var(--coral)) 8%, transparent);
  color: var(--text-secondary);
}
.file-change-new {
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}
/* 单行：行号列（固定宽右对齐）+ 文本（保留换行/断词） */
.diff-line {
  display: flex;
  padding: 0 8px;
}
.diff-line-num {
  flex-shrink: 0;
  width: 2.4em;
  text-align: right;
  padding-right: 10px;
  color: var(--text-muted);
  opacity: 0.6;
  user-select: none;
  font-variant-numeric: tabular-nums;
}
.diff-line-text {
  flex: 1;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
