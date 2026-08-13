<script setup lang="ts">
// KeyChangeDialog：API Key 变更引导弹窗——自动流程状态机（非手动按钮面板）。
// key 输入框 blur 检测到变化后，父组件自动串行执行「测试连接 → 保存并重启引擎」，
// 本弹窗只做进度/结果反馈：testing（测试中）→ saving（保存重启中）→ success（✓ 自动关闭）或 error（重试/取消）。
// 基于 ModalShell（统一遮罩/布局）；testing/saving 阶段禁止关闭，防止「看似取消实则后台仍在执行」。
import ModalShell from "./ModalShell.vue";

withDefaults(defineProps<{
  open: boolean;
  title: string;
  /** 动态文案：进度（testing/saving）或结果（success/error） */
  message: string;
  /** 自动流程阶段：testing 测试中 / saving 保存重启中 / success 成功 / error 失败 */
  phase: "testing" | "saving" | "success" | "error";
  retryText?: string;
  cancelText?: string;
}>(), {
  retryText: "",
  cancelText: "",
});

const emit = defineEmits<{ retry: []; cancel: [] }>();
</script>

<template>
  <!-- 进行中（testing/saving）禁止关闭：ESC/遮罩/× 全禁用，避免中断自动流程造成状态不一致 -->
  <ModalShell
    :open="open"
    size="sm"
    :closable="phase === 'error' || phase === 'success'"
    @close="emit('cancel')"
  >
    <template #header>{{ title }}</template>
    <div class="key-change-body">
      <!-- 进行中：spinner + 进度文案 -->
      <div v-if="phase === 'testing' || phase === 'saving'" class="key-change-progress">
        <span class="key-change-spinner" aria-hidden="true" />
        <span class="key-change-progress-text">{{ message }}</span>
      </div>
      <!-- 失败：红色结果（含「重试 / 取消」按钮，由 footer 提供） -->
      <div v-else-if="phase === 'error'" class="key-change-test key-change-test--err">{{ message }}</div>
      <!-- 成功：绿色结果（自动关闭） -->
      <div v-else class="key-change-test key-change-test--ok">{{ message }}</div>
    </div>
    <template v-if="phase === 'error'" #footer>
      <div class="key-change-footer">
        <button class="key-change-btn" @click="emit('cancel')">{{ cancelText || $t('modal.cancel') }}</button>
        <button class="key-change-btn key-change-btn--primary" @click="emit('retry')">{{ retryText }}</button>
      </div>
    </template>
  </ModalShell>
</template>

<style scoped>
/* 进行中行：spinner 与文案水平排列 */
.key-change-progress {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 24px;
}
/* 加载圈：CSS 旋转动画，替代 emoji，与项目 lucide 图标规范一致 */
.key-change-spinner {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  border: 2px solid var(--border, rgba(128, 128, 128, 0.3));
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: key-change-spin 0.7s linear infinite;
}
@keyframes key-change-spin {
  to { transform: rotate(360deg); }
}
.key-change-progress-text {
  font-size: 0.929rem;
  line-height: 1.6;
  color: var(--text-secondary);
  word-break: break-word;
}
/* 结果条：与设置页 test-result 同风格（绿色成功 / 红色失败） */
.key-change-test {
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 0.857rem;
  line-height: 1.5;
  word-break: break-word;
}
.key-change-test--ok {
  color: var(--success, #16a34a);
  background: var(--success-glow, rgba(22, 163, 74, 0.1));
}
.key-change-test--err {
  color: var(--coral);
  background: var(--coral-glow, rgba(248, 113, 113, 0.1));
}
.key-change-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
/* 按钮：与项目 ConfirmDialog 按钮同风格（透明底 hover 提升 / accent 主按钮） */
.key-change-btn {
  padding: 6px 16px;
  border: none;
  border-radius: 6px;
  font-size: 0.929rem;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
  background: transparent;
  color: var(--text-secondary);
}
.key-change-btn:hover:not(:disabled) { background: var(--bg-hover); }
.key-change-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.key-change-btn--primary {
  background: var(--accent);
  color: var(--bg-root);
  font-weight: 600;
}
.key-change-btn--primary:hover { opacity: 0.9; background: var(--accent); }
</style>
