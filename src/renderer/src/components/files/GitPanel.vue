<script setup lang="ts">
import { ref, watch, inject } from "vue";
import { gitStatus, gitDiff, gitStage, gitUnstage, gitCommit, gitPush, type GitStatus, type GitFile } from "@/lib/electron-bridge";
import { useI18n } from "vue-i18n";
import { emitChatCommand } from "@/composables/useCommandPalette";

const props = defineProps<{ repoPath: string }>();
const { t } = useI18n();

// 第四列 diff 面板（与文件编辑器互斥，共用同一列）
const openGitDiff = inject<(f: { path: string; diff: string }) => void>("openGitDiff", () => {});
const closeGitDiff = inject<() => void>("closeGitDiff", () => {});

const status = ref<GitStatus | null>(null);
const loading = ref(false);
const selectedFile = ref<GitFile | null>(null);  // 当前选中文件（用于高亮）
const commitMsg = ref("");
const amend = ref(false);
const pushAfter = ref(false);
const errorMsg = ref("");  // stage/unstage/commit/push 错误提示
const pushing = ref(false);
const pushResult = ref("");  // push 成功提示

async function refresh() {
  if (!props.repoPath) return;
  loading.value = true;
  errorMsg.value = "";
  try {
    status.value = await gitStatus(props.repoPath);
  } catch {
    status.value = null;
  } finally {
    loading.value = false;
  }
}

async function showDiff(file: GitFile) {
  selectedFile.value = file;
  try {
    const diff = await gitDiff(props.repoPath, file.path, file.status === "staged");
    openGitDiff({ path: file.path, diff });
  } catch {
    openGitDiff({ path: file.path, diff: t("git.diffError") });
  }
}

async function doStage(file: GitFile) {
  try {
    await gitStage(props.repoPath, [file.path]);
    errorMsg.value = "";
    refresh();
  } catch (e) {
    errorMsg.value = t("git.stageError") + ": " + String(e);
  }
}

async function doUnstage(file: GitFile) {
  try {
    await gitUnstage(props.repoPath, [file.path]);
    errorMsg.value = "";
    refresh();
  } catch (e) {
    errorMsg.value = t("git.unstageError") + ": " + String(e);
  }
}

async function doCommit() {
  const msg = commitMsg.value.trim();
  if (!msg) return;
  errorMsg.value = "";
  try {
    await gitCommit(props.repoPath, msg, amend.value);
    commitMsg.value = "";
    amend.value = false;
    selectedFile.value = null;
    closeGitDiff();

    if (pushAfter.value) {
      await doPush();
    } else {
      refresh();
    }
  } catch (e) {
    errorMsg.value = t("git.commitError") + ": " + String(e);
  }
}

async function doPush() {
  pushing.value = true;
  pushResult.value = "";
  errorMsg.value = "";
  try {
    await gitPush(props.repoPath);
    pushResult.value = t("git.pushSuccess");
    refresh();
  } catch (e) {
    errorMsg.value = t("git.pushError") + ": " + String(e);
  } finally {
    pushing.value = false;
  }
}

// 切换工作区时清理 diff 面板和错误提示
watch(() => props.repoPath, () => {
  selectedFile.value = null;
  closeGitDiff();
  errorMsg.value = "";
  pushResult.value = "";
  refresh();
}, { immediate: true });
</script>

<template>
  <div class="git-panel flex flex-col h-full overflow-hidden">
    <!-- 分支名 -->
    <div class="git-branch-bar">
      <span v-if="status" class="git-branch-icon">⎇</span>
      <span v-if="status" class="git-branch-name">{{ status.branch }}</span>
      <button @click="refresh" class="git-refresh-btn" :title="$t('file.refresh')">⟳</button>
    </div>

    <!-- 错误提示 -->
    <div v-if="errorMsg" class="git-error-bar">{{ errorMsg }}</div>

    <!-- 推送成功提示 -->
    <div v-if="pushResult" class="git-push-ok">{{ pushResult }}</div>

    <!-- 文件列表 -->
    <div class="git-files flex-1 overflow-y-auto">
      <div v-if="loading" class="git-empty">{{ $t('chat.loading') }}</div>
      <div v-else-if="!status" class="git-empty">
        <div class="git-empty-text">{{ $t('git.notRepo') }}</div>
        <button
          @click="emitChatCommand('git-init')"
          class="git-init-btn"
          :title="$t('git.initRepoDesc')"
        >⎇ {{ $t('git.initRepo') }}</button>
      </div>
      <template v-else>
        <!-- Staged -->
        <div v-if="status.staged.length" class="git-section">
          <div class="git-section-header">▲ {{ $t('git.staged') }} ({{ status.staged.length }})</div>
          <div
            v-for="f in status.staged" :key="f.path"
            @click="showDiff(f)"
            class="git-file-row"
            :class="{ 'git-file-row--active': selectedFile?.path === f.path }"
          >
            <span class="git-file-status staged">S</span>
            <span class="git-file-name">{{ f.path }}</span>
            <button @click.stop="doUnstage(f)" class="git-file-action" :title="$t('git.unstageTooltip')">−</button>
          </div>
        </div>
        <!-- Modified -->
        <div v-if="status.modified.length" class="git-section">
          <div class="git-section-header">● {{ $t('git.modified') }} ({{ status.modified.length }})</div>
          <div
            v-for="f in status.modified" :key="f.path"
            @click="showDiff(f)"
            class="git-file-row"
            :class="{ 'git-file-row--active': selectedFile?.path === f.path }"
          >
            <span class="git-file-status modified">M</span>
            <span class="git-file-name">{{ f.path }}</span>
            <button @click.stop="doStage(f)" class="git-file-action" :title="$t('git.stageTooltip')">+</button>
          </div>
        </div>
        <!-- Untracked -->
        <div v-if="status.untracked.length" class="git-section">
          <div class="git-section-header">+ {{ $t('git.untracked') }} ({{ status.untracked.length }})</div>
          <div
            v-for="f in status.untracked" :key="f.path"
            @click="showDiff(f)"
            class="git-file-row"
            :class="{ 'git-file-row--active': selectedFile?.path === f.path }"
          >
            <span class="git-file-status untracked">U</span>
            <span class="git-file-name">{{ f.path }}</span>
            <button @click.stop="doStage(f)" class="git-file-action" :title="$t('git.stageTooltip')">+</button>
          </div>
        </div>
        <div v-if="!status.staged.length && !status.modified.length && !status.untracked.length" class="git-empty">
          {{ $t('git.clean') }}
        </div>
      </template>
    </div>

    <!-- Commit -->
    <div v-if="status?.staged.length" class="git-commit-bar">
      <div class="git-commit-controls">
        <input
          v-model="commitMsg"
          @keydown.enter="doCommit"
          :placeholder="$t('git.commitPlaceholder')"
          class="git-commit-input"
        />
        <button @click="doCommit" class="git-commit-btn" :disabled="!commitMsg.trim() || pushing">
          {{ $t('git.commit') }}
        </button>
        <button
          v-if="!pushAfter"
          @click="doPush"
          class="git-push-btn"
          :disabled="pushing"
          :title="$t('git.push')"
        >
          {{ pushing ? $t('git.pushing') : '⇧' }}
        </button>
      </div>
      <div class="git-commit-options">
        <label class="git-option-label">
          <input type="checkbox" v-model="amend" class="git-option-checkbox" />
          {{ $t('git.amend') }}
        </label>
        <label class="git-option-label">
          <input type="checkbox" v-model="pushAfter" class="git-option-checkbox" />
          {{ $t('git.pushAfter') }}
        </label>
      </div>
    </div>
  </div>
</template>

<style scoped>
.git-panel { font-size: 0.786rem; color: var(--text-secondary); }
.git-branch-bar {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 10px; flex-shrink: 0;
  border-bottom: 1px solid var(--border-dim);
}
.git-branch-icon { color: var(--accent); font-size: 0.929rem; }
.git-branch-name { font-weight: 600; color: var(--text-bright); }
.git-refresh-btn {
  margin-left: auto; width: 20px; height: 20px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 4px; color: var(--text-muted); cursor: pointer;
  transition: background 150ms;
}
.git-refresh-btn:hover { background: var(--bg-hover); }

.git-error-bar {
  padding: 4px 10px; font-size: 0.714rem; flex-shrink: 0;
  color: var(--coral); background: var(--coral-glow);
  border-bottom: 1px solid var(--border-dim);
  white-space: pre-wrap; word-break: break-all;
}
.git-push-ok {
  padding: 4px 10px; font-size: 0.714rem; flex-shrink: 0;
  color: var(--accent); background: var(--accent-glow);
  border-bottom: 1px solid var(--border-dim);
}

.git-section { padding: 2px 0; }
.git-section-header {
  padding: 4px 10px; font-weight: 600; color: var(--text-muted);
  text-transform: uppercase; font-size: 0.714rem; letter-spacing: 0.5px;
}
.git-file-row {
  display: flex; align-items: center; gap: 6px;
  padding: 3px 10px; cursor: pointer;
  transition: background 100ms;
}
.git-file-row:hover { background: var(--bg-hover); }
.git-file-row--active { background: var(--accent-glow); }
.git-file-status {
  width: 14px; text-align: center; font-weight: 700; font-size: 0.714rem;
}
.git-file-status.staged { color: var(--accent); }
.git-file-status.modified { color: var(--amber); }
.git-file-status.untracked { color: var(--violet); }
.git-file-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.git-file-action {
  width: 16px; height: 16px; border-radius: 3px;
  font-size: 0.857rem; font-weight: 700; text-align: center;
  color: var(--text-muted); cursor: pointer; opacity: 0;
  transition: opacity 100ms, background 100ms;
}
.git-file-row:hover .git-file-action { opacity: 1; }
.git-file-action:hover { background: var(--bg-hover); color: var(--text-bright); }

.git-empty { padding: 20px; text-align: center; color: var(--text-muted); }
.git-empty-text { margin-bottom: 12px; }
.git-init-btn {
  padding: 6px 16px; border-radius: 6px;
  font-size: 0.857rem; font-weight: 600;
  background: var(--accent); color: var(--bg-root);
  cursor: pointer; transition: opacity 150ms;
}
.git-init-btn:hover { opacity: 0.85; }

.git-commit-bar {
  display: flex; flex-direction: column; gap: 4px;
  padding: 6px 10px;
  border-top: 1px solid var(--border-dim);
}
.git-commit-controls {
  display: flex; gap: 6px;
}
.git-commit-input {
  flex: 1; background: transparent; border: 1px solid var(--border-dim);
  border-radius: 4px; padding: 4px 8px; font-size: 0.786rem;
  color: var(--text-primary); outline: none;
}
.git-commit-input:focus { border-color: var(--accent-dim); }
.git-commit-btn {
  padding: 4px 12px; border-radius: 4px; font-size: 0.786rem; font-weight: 600;
  background: var(--accent); color: var(--bg-root);
  transition: opacity 150ms; cursor: pointer;
}
.git-commit-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.git-push-btn {
  width: 28px; height: 28px; border-radius: 4px;
  font-size: 0.929rem; display: flex; align-items: center; justify-content: center;
  color: var(--text-secondary); cursor: pointer;
  transition: background 150ms;
}
.git-push-btn:hover { background: var(--bg-hover); color: var(--text-bright); }
.git-push-btn:disabled { opacity: 0.4; cursor: not-allowed; }

.git-commit-options {
  display: flex; gap: 12px;
}
.git-option-label {
  display: flex; align-items: center; gap: 4px;
  font-size: 0.714rem; color: var(--text-muted); cursor: pointer;
  user-select: none;
}
.git-option-checkbox {
  width: 12px; height: 12px; cursor: pointer;
  accent-color: var(--accent);
}

.git-status-tag { display: none; }  /* prevents empty style block warning */
</style>
