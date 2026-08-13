<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";

const props = withDefaults(defineProps<{
  open: boolean;
  /** 垂直位置：center 居中，top 靠上 */
  position?: "center" | "top";
  /** 宽度预设 */
  size?: "sm" | "md" | "lg" | "xl";
  /** 自定义宽度（CSS 值，如 "60vw"）——覆盖 size 预设（size 保留为回退） */
  width?: string;
  /** 是否允许关闭（ESC / 点遮罩 / × 三通道）。false 时全部禁用——用于自动流程进行中禁止打断 */
  closable?: boolean;
}>(), {
  closable: true,
});
const emit = defineEmits<{ close: [] }>();

function onKeydown(e: KeyboardEvent) {
  // 自动流程进行中（closable=false）禁止 ESC 关闭，避免「看似取消实则后台仍在执行」
  if (e.key === "Escape" && props.closable) emit("close");
}
onMounted(() => document.addEventListener("keydown", onKeydown));
onUnmounted(() => document.removeEventListener("keydown", onKeydown));
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="modal-shell-overlay"
      :class="{ 'modal-shell-overlay--top': position === 'top' }"
      @click.self="closable && emit('close')"
    >
      <div
        class="modal-shell-panel"
        :class="[
          position === 'top' ? 'modal-shell-panel--top' : 'modal-shell-panel--center',
          {
            'modal-shell-panel--sm': size === 'sm',
            'modal-shell-panel--md': !size || size === 'md',
            'modal-shell-panel--lg': size === 'lg',
            'modal-shell-panel--xl': size === 'xl',
          },
        ]"
        :style="props.width ? { width: props.width } : undefined"
      >
        <div class="modal-shell-header">
          <slot name="header" />
          <button
            v-if="closable"
            @click="emit('close')"
            class="modal-shell-close"
            :title="$t('modal.close')"
          >&times;</button>
        </div>

        <div class="modal-shell-body">
          <slot />
        </div>

        <div v-if="$slots.footer" class="modal-shell-footer">
          <slot name="footer" />
        </div>
      </div>
    </div>
  </Teleport>
</template>
