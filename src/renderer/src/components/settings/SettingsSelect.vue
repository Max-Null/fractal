<script setup lang="ts">
import { ref, computed } from "vue";
import { ChevronDown } from "lucide-vue-next";

// SettingsSelect：设置页通用下拉（自定义样式，非原生 select）
// 职责：label + 触发器 + Transition drop-settings 弹出选项；选中项 accent 高亮；desc 副文案。
// 样式迁移自 SettingsPanel 的 .settings-dropdown（120ms/100ms 动画、accent-glow 选中、滚动条）。
interface SelectOption {
  value: string;
  label: string;
  desc?: string;
}

const props = defineProps<{
  label: string;
  modelValue: string;
  options: SelectOption[];
  disabled?: boolean;
  /** 字段级描述：label 下方副文案（如轻量模型作用说明），样式对齐 SettingsToggle 的 desc */
  desc?: string;
}>();

const emit = defineEmits<{ (e: "update:modelValue", v: string): void }>();

// 展开态独立维护：与 SettingsPanel 的 openDropdown 单例不同，抽离后各组件自己开合互不影响
const open = ref(false);

// 当前选中项文案：无匹配时显示原值兜底（如非法历史值，保证触发器不空）
const currentLabel = computed(
  () => props.options.find((o) => o.value === props.modelValue)?.label ?? props.modelValue,
);

function toggle() {
  // disabled 守卫：CSS pointer-events 之外的第二道防线（happy-dom 直接派发事件不模拟命中测试）
  if (props.disabled) return;
  open.value = !open.value;
}

function pick(v: string) {
  emit("update:modelValue", v);
  open.value = false;
}
</script>

<template>
  <div class="settings-field">
    <label class="settings-field__label">{{ label }}</label>
    <!-- 字段级描述（可选）：label 下方副文案 -->
    <p v-if="desc" class="settings-field__desc">{{ desc }}</p>
    <div
      class="settings-select__trigger"
      :class="{ 'settings-select__trigger--open': open, 'settings-select__trigger--disabled': disabled }"
      role="button"
      :aria-expanded="open"
      @click="toggle"
    >
      <span class="settings-select__value">{{ currentLabel }}</span>
      <!-- chevron 图标（lucide）：打开时旋转 180°，对齐 SettingsPanel 原 svg polyline 行为 -->
      <ChevronDown
        class="settings-select__chevron"
        :class="{ 'settings-select__chevron--open': open }"
        :size="14"
        stroke-width="3"
      />
      <Transition name="drop-settings">
        <div v-if="open" class="settings-select__menu">
          <button
            v-for="o in options"
            :key="o.value"
            type="button"
            class="settings-select__item"
            :class="{ 'settings-select__item--selected': modelValue === o.value }"
            @click.stop="pick(o.value)"
          >
            <span class="settings-select__item-label">{{ o.label }}</span>
            <span v-if="o.desc" class="settings-select__item-desc">{{ o.desc }}</span>
          </button>
        </div>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
/* 字段容器：label 行 + 控件 */
.settings-field__label {
  display: block;
  font-size: 0.857rem;
  font-weight: 500;
  margin-bottom: 6px;
  color: var(--text-secondary);
}
/* 字段级描述：label 下方（label 自带 6px 下边距，负 margin 拉近为视觉 3px，对齐 SettingsToggle desc 风格） */
.settings-field__desc {
  display: block;
  margin: -3px 0 8px;
  font-size: 0.714rem;
  color: var(--text-muted);
}

.settings-select__trigger {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border-radius: 8px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  color: var(--text-primary);
  cursor: pointer;
  user-select: none;
  transition: border-color 150ms;
}
/* 打开态：accent 边框（迁移自 SettingsPanel 触发器 open 态的 inline style） */
.settings-select__trigger--open {
  border-color: var(--accent);
}
/* 禁用态：半透明 + 禁指针（设置项不可用时整块不响应） */
.settings-select__trigger--disabled {
  opacity: 0.5;
  cursor: default;
  pointer-events: none;
}

.settings-select__value {
  flex: 1;
  font-size: 1rem;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.settings-select__chevron {
  flex-shrink: 0;
  opacity: 0.4;
  transition: transform 150ms;
}
/* chevron 打开时旋转 180°（对齐 SettingsPanel 原 svg polyline 行为） */
.settings-select__chevron--open {
  transform: rotate(180deg);
}

/* 弹出菜单：定位在触发器正下方，max-height + 滚动（选项多时如 agent 模型候选列表） */
.settings-select__menu {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  width: 100%;
  max-height: 240px;
  overflow-y: auto;
  padding: 4px 0;
  border-radius: 8px;
  z-index: 30;
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
}

.settings-select__item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 8px 12px;
  font-size: 1rem;
  border: none;
  background: transparent;
  cursor: pointer;
  transition: background 150ms;
}
.settings-select__item:hover {
  background: var(--bg-hover);
}
/* 选中高亮：accent-glow 背景 + accent 文字（迁移自 SettingsPanel 选项 inline style） */
.settings-select__item--selected {
  background: var(--accent-glow);
}

.settings-select__item-label {
  color: var(--text-primary);
}
.settings-select__item--selected .settings-select__item-label {
  color: var(--accent);
}
.settings-select__item-desc {
  display: block;
  margin-top: 2px;
  font-size: 0.714rem;
  color: var(--text-secondary);
}

/* 下拉动画（迁移自 SettingsPanel：展开 120ms ease-out / 收起 100ms ease-in） */
.drop-settings-enter-active {
  transition: all 120ms ease-out;
}
.drop-settings-leave-active {
  transition: all 100ms ease-in;
}
.drop-settings-enter-from {
  opacity: 0;
  transform: translateY(4px) scale(0.96);
}
.drop-settings-leave-to {
  opacity: 0;
  transform: translateY(2px) scale(0.98);
}
</style>
