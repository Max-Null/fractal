<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";

const props = defineProps<{
  open: boolean;
  /** 垂直位置：center 居中，top 靠上 */
  position?: "center" | "top";
  /** 宽度预设 */
  size?: "sm" | "md" | "lg" | "xl";
}>();
const emit = defineEmits<{ close: [] }>();

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
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
      @click.self="emit('close')"
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
      >
        <div class="modal-shell-header">
          <slot name="header" />
          <button
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
