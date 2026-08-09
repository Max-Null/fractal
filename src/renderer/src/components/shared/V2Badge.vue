<script setup lang="ts">
// V2 API 状态胶囊：顶栏指示 v2 server 是否可用（8800 被官方桌面端占用时 coral 色，点击弹详情）
import { useI18n } from "vue-i18n";

defineProps<{ conflict: boolean }>();
defineEmits<{ open: [] }>();

const { t } = useI18n();
</script>

<template>
  <button
    class="v2-badge"
    :class="{ 'v2-badge--conflict': conflict }"
    :title="conflict ? t('v2.v2Conflict') : t('v2.v2Available')"
    @click="$emit('open')"
  >
    V2
  </button>
</template>

<style scoped>
.v2-badge {
  /* 顶栏文本按钮：与 icon-btn 兄弟样式一致（无边框、hover 底色），仅文字颜色表达状态语义 */
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 4px 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  font-size: 12px;
  font-weight: 600;
  color: var(--accent);
  cursor: pointer;
  transition: background 0.15s ease;
}
.v2-badge:hover {
  background: var(--accent-glow);
}
/* 冲突态：8800 被占用（官方桌面端/TUI）——coral 警示色文字 */
.v2-badge--conflict {
  color: var(--coral);
}
.v2-badge--conflict:hover {
  background: var(--coral-glow);
}
</style>
