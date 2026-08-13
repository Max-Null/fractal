<script setup lang="ts">
// SettingsSection：设置页区块容器（标题 + 内容）
// 导航重构后右侧单列分区：每个 tab 由多个 SettingsSection 组成，标题统一小号大写间距样式。
defineProps<{ title: string }>();
</script>

<template>
  <section class="settings-section">
    <h3 class="settings-section__title">{{ title }}</h3>
    <div class="settings-section__body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.settings-section__title {
  margin-bottom: 16px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-muted);
}
/* 内容容器：子项间距由调用方布局（space-y 等），组件不预设 */
.settings-section__body {
  min-width: 0;
}
</style>
