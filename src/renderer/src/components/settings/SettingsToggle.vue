<script setup lang="ts">
// SettingsToggle：设置页通用开关（label + desc + 滑动开关）
// 样式迁移自 SettingsPanel 的 .data-mode-switch（36×20 轨道、accent 开启态、滑块右移）。
const props = defineProps<{
  label: string;
  desc?: string;
  modelValue: boolean;
  disabled?: boolean;
}>();

const emit = defineEmits<{ (e: "update:modelValue", v: boolean): void }>();

function toggle() {
  // disabled 守卫：CSS pointer-events 之外的第二道防线（防连点锁场景）
  if (props.disabled) return;
  emit("update:modelValue", !props.modelValue);
}
</script>

<template>
  <div class="settings-toggle" :class="{ 'settings-toggle--disabled': disabled }">
    <div class="settings-toggle__text">
      <div class="settings-toggle__label">{{ label }}</div>
      <div v-if="desc" class="settings-toggle__desc">{{ desc }}</div>
    </div>
    <button
      type="button"
      class="settings-toggle__switch"
      :class="{ 'settings-toggle__switch--on': modelValue }"
      :aria-pressed="modelValue"
      :disabled="disabled"
      @click="toggle"
    >
      <span class="settings-toggle__knob"></span>
    </button>
  </div>
</template>

<style scoped>
.settings-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
/* 禁用态：半透明 + 禁指针（迁移自 .data-mode-row--disabled） */
.settings-toggle--disabled {
  opacity: 0.55;
  pointer-events: none;
}

.settings-toggle__text {
  min-width: 0;
}
.settings-toggle__label {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary);
}
.settings-toggle__desc {
  margin-top: 2px;
  font-size: 10px;
  color: var(--text-muted);
}

.settings-toggle__switch {
  position: relative;
  flex-shrink: 0;
  width: 36px;
  height: 20px;
  border-radius: 999px;
  padding: 0;
  background: var(--bg-active);
  border: 1px solid var(--border-default);
  cursor: pointer;
  transition: background 150ms, border-color 150ms;
}
/* 开启态：accent（唯一"成功/开启"语义色，与全局一致） */
.settings-toggle__switch--on {
  background: var(--accent-dim);
  border-color: var(--accent-line);
}
.settings-toggle__switch:disabled {
  cursor: default;
}

.settings-toggle__knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 999px;
  background: var(--text-secondary);
  transition: transform 150ms, background 150ms;
}
.settings-toggle__switch--on .settings-toggle__knob {
  transform: translateX(16px);
  background: var(--accent);
}
</style>
