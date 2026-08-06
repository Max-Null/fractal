<script setup lang="ts">
/** 更新日志弹窗——版本号变化时自动弹出，对比 localStorage 中的 lastSeenVersion 与当前 APP_VERSION 决定是否显示 */
import { ref, computed } from "vue";
import { useI18n } from "vue-i18n";
import ModalShell from "./ModalShell.vue";
import { findEntry, getLastSeenVersion, markVersionSeen, APP_VERSION, localizedSections } from "@/data/changelog";

const { t, locale } = useI18n();

const emit = defineEmits<{ close: [] }>();

// 查找当前版本的更新日志条目
const entry = findEntry(APP_VERSION);
// 从 localStorage 读取上次查看的版本号
const lastSeen = ref(getLastSeenVersion());
// 仅当有 changelog 条目且用户未查看过当前版本时显示
const show = computed(() => !!entry && lastSeen.value !== APP_VERSION);
// 按当前语言本地化条目内容
const sections = computed(() => entry ? localizedSections(entry, locale.value) : []);

/** 关闭时将当前版本写入 localStorage，下次启动不再弹出 */
function onClose() {
  markVersionSeen(APP_VERSION);
  lastSeen.value = APP_VERSION;
  emit("close");
}
</script>

<template>
  <ModalShell :open="show" size="lg" position="top" @close="onClose">
    <template #header>
      <span class="text-base font-semibold" :style="{ color: 'var(--text-bright)' }">
        🎉 {{ $t('app.title') }} v{{ APP_VERSION }}
      </span>
    </template>

    <div class="text-[11px] mb-4" :style="{ color: 'var(--text-muted)' }">
      {{ entry?.date }}
    </div>

    <div v-if="sections.length" class="space-y-4">
      <div v-for="(section, si) in sections" :key="si">
        <h4 class="text-sm font-semibold mb-1.5" :style="{ color: 'var(--text-primary)' }">
          {{ section.title }}
        </h4>
        <ul
          class="text-[13px] leading-relaxed space-y-1 ml-1"
          :style="{ color: 'var(--text-secondary)' }"
        >
          <li v-for="(item, ii) in section.items" :key="ii" class="flex gap-2">
            <span
              class="shrink-0 select-none mt-1 w-1.5 h-1.5 rounded-full inline-block"
              style="background: var(--accent-dim)"
            ></span>
            <span>{{ item }}</span>
          </li>
        </ul>
      </div>
    </div>

    <template #footer>
      <div class="flex justify-end">
        <button
          @click="onClose"
          class="px-4 py-1.5 rounded-lg text-sm font-medium transition-colors"
          :style="{ background: 'var(--accent)', color: 'var(--bg-root)' }"
        >
          {{ $t('chat.close') }}
        </button>
      </div>
    </template>
  </ModalShell>
</template>
