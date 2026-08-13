<script setup lang="ts">
// SettingsInput：设置页通用文本输入（label + 输入框 + 可选后缀按钮 slot）
// suffix slot 承载"旁路操作"按钮（如聊天 API 地址旁的查询按钮/路径浏览按钮），按钮图标由调用方用 lucide 提供。
defineProps<{
  label: string;
  modelValue: string;
  type?: string;
  placeholder?: string;
  readonly?: boolean;
}>();

const emit = defineEmits<{ (e: "update:modelValue", v: string): void }>();

function onInput(e: Event) {
  emit("update:modelValue", (e.target as HTMLInputElement).value);
}
</script>

<template>
  <div class="settings-field">
    <label class="settings-field__label">{{ label }}</label>
    <div class="settings-input-row">
      <input
        class="settings-input"
        :type="type ?? 'text'"
        :value="modelValue"
        :placeholder="placeholder"
        :readonly="readonly"
        @input="onInput"
      />
      <slot name="suffix" />
    </div>
  </div>
</template>

<style scoped>
.settings-field__label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  margin-bottom: 6px;
  color: var(--text-secondary);
}

.settings-input-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 输入框：统一样式迁移自 SettingsPanel 的 .settings-input（bg-elevated + border-default + caret accent） */
.settings-input {
  flex: 1;
  min-width: 0;
  width: 100%;
  padding: 8px 14px;
  border-radius: 8px;
  font-size: 14px;
  outline: none;
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  color: var(--text-primary);
  caret-color: var(--accent);
}
/* readonly 时降低对比度（展示用，如工作目录路径框） */
.settings-input:read-only {
  color: var(--text-secondary);
}
.settings-input:focus {
  border-color: var(--accent);
}
</style>
