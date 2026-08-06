<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import AppShell from "./components/layout/AppShell.vue";
import { useStreamProcessor } from "./composables/useStreamProcessor";
import { useSettingsStore } from "./stores/settings";
import { onMounted, onUnmounted, watch } from "vue";

const { startListening, stopListening } = useStreamProcessor();
const settings = useSettingsStore();
const { locale } = useI18n();

const themeAttr = computed(() => settings.theme);

onMounted(() => {
  startListening();
  // Apply theme, font size & locale from stored preference
  document.documentElement.setAttribute("data-theme", settings.theme);
  document.documentElement.setAttribute("data-font-size", settings.fontSize);
  locale.value = settings.locale;
});

onUnmounted(() => {
  stopListening();
});

// Watch theme & font changes and apply to root
watch(() => settings.theme, (t) => {
  document.documentElement.setAttribute("data-theme", t);
});
watch(() => settings.fontSize, (s) => {
  document.documentElement.setAttribute("data-font-size", s);
});

// Watch locale changes and sync to i18n
watch(() => settings.locale, (l) => {
  locale.value = l;
});
</script>

<template>
  <div :data-theme="themeAttr" class="h-full">
    <AppShell />
  </div>
</template>
