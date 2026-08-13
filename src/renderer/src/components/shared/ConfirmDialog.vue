<script setup lang="ts">
// ConfirmDialog：项目级确认弹窗（替代原生 confirm()）
// 基于 ModalShell（统一遮罩/布局/ESC/点遮罩关闭），带确认/取消按钮。
// 用法：父组件持 `confirmState` ref（{title,message,confirmText?,cancelText?,danger?}），
//       open=true 时显示，confirm/cancel 事件后由父组件关闭。
import ModalShell from "./ModalShell.vue";

const props = withDefaults(defineProps<{
  open: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  /** 危险操作（删除等）：确认按钮用 coral 危险色 */
  danger?: boolean;
}>(), {
  confirmText: "",
  cancelText: "",
  danger: false,
});

const emit = defineEmits<{ confirm: []; cancel: [] }>();
</script>

<template>
  <ModalShell :open="open" size="sm" @close="emit('cancel')">
    <template #header>{{ title }}</template>
    <p class="confirm-dialog-message">{{ message }}</p>
    <template #footer>
      <div class="confirm-dialog-footer">
        <button class="confirm-dialog-btn" @click="emit('cancel')">{{ cancelText || $t('modal.cancel') }}</button>
        <button
          class="confirm-dialog-btn confirm-dialog-btn--primary"
          :class="{ 'confirm-dialog-btn--danger': danger }"
          @click="emit('confirm')"
        >{{ confirmText || $t('modal.confirm') }}</button>
      </div>
    </template>
  </ModalShell>
</template>

<style scoped>
/* 确认弹窗正文：muted 文字，居中布局由 ModalShell footer 提供 */
.confirm-dialog-message {
  margin: 0;
  font-size: 0.929rem;
  line-height: 1.6;
  color: var(--text-secondary);
  word-break: break-word;
}
.confirm-dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
/* 确认弹窗按钮：与项目操作按钮同风格（透明底 hover 提升 / accent 主按钮 / coral 危险） */
.confirm-dialog-btn {
  padding: 6px 16px;
  border: none;
  border-radius: 6px;
  font-size: 0.929rem;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
  background: transparent;
  color: var(--text-secondary);
}
.confirm-dialog-btn:hover { background: var(--bg-hover); }
.confirm-dialog-btn--primary {
  background: var(--accent);
  color: var(--bg-root);
  font-weight: 600;
}
.confirm-dialog-btn--primary:hover { opacity: 0.9; background: var(--accent); }
/* 危险操作确认：coral 文字 + 边框（btn-ghost 风格，对齐项目 ChatPanel deny 按钮先例）——
 * 实底 coral 在深浅主题色值差异大（#f87171 / #dc2626），单一文字色无法保证对比度 */
.confirm-dialog-btn--danger {
  background: transparent;
  color: var(--coral);
  border: 1px solid var(--coral);
}
.confirm-dialog-btn--danger:hover { background: var(--coral-glow); }
</style>
