<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { useSettingsStore } from "@/stores/settings";
import { useChatStore } from "@/stores/chat";
import { getClaudeDir, readFileContent } from "@/lib/electron-bridge";
import ContextIndicator from "./ContextIndicator.vue";
import { useSlashCommands } from "@/composables/useSlashCommands";
import type { Effort } from "@/stores/settings";

const { t } = useI18n();

// ── Ponytail 插件检测 ──
// null=检测中（不渲染），true=已安装（下拉），false=未安装（安装按钮）
const hasPonytail = ref<boolean | null>(null);
onMounted(async () => {
  try {
    const dir = await getClaudeDir();
    const raw = await readFileContent(`${dir}/settings.json`);
    const plugins: Record<string, boolean> = JSON.parse(raw).enabledPlugins || {};
    hasPonytail.value = Object.keys(plugins).some(k => k.startsWith("ponytail@"));
  } catch { hasPonytail.value = false; }
});

function installPonytail() {
  emit("sendSlash", "请帮我安装 Ponytail 插件（ponytail@claude-plugins-official）");
}

const emit = defineEmits<{ attachFile: []; openCommandMenu: []; sendSlash: [text: string]; showContext: []; }>();

const settings = useSettingsStore();
const chat = useChatStore();
const { favorites, recentCommands } = useSlashCommands();

const modeOptions = [
  { value: "askBefore", label: () => t("mode.askBefore") },
  { value: "editAuto", label: () => t("mode.editAuto") },
  { value: "plan", label: () => t("mode.plan") },
  { value: "auto", label: () => t("mode.auto") },
	  { value: "bypass", label: () => t("mode.bypass") },
	  { value: "dontAsk", label: () => t("mode.dontAsk") },
];

// Effort levels with progressive colors (low → calm, ultracode → intense)
const effortOptions: Array<{ value: Effort; label: () => string; color: string }> = [
  { value: "low", label: () => t("mode.effort.low"), color: "#22c55e" },
  { value: "medium", label: () => t("mode.effort.medium"), color: "#14b8a6" },
  { value: "high", label: () => t("mode.effort.high"), color: "#f59e0b" },
  { value: "xhigh", label: () => t("mode.effort.xhigh"), color: "#f97316" },
  { value: "max", label: () => t("mode.effort.max"), color: "#ef4444" },
  { value: "ultracode", label: () => t("mode.effort.ultracode"), color: "#8b5cf6" },
];

const currentEffortColor = computed(() => {
  return effortOptions.find(o => o.value === settings.effort)?.color || "var(--amber)";
});

// ── Ponytail mode ──
const ponytailOptions: Array<{ value: "off" | "lite" | "full" | "ultra"; icon: string; label: string; color: string }> = [
  { value: "off",   icon: "⬜", label: "关闭", color: "#6b7280" },
  { value: "lite",  icon: "🌱", label: "轻量", color: "#22c55e" },
  { value: "full",  icon: "🎯", label: "标准", color: "#f59e0b" },
  { value: "ultra", icon: "🔥", label: "极致", color: "#ef4444" },
];
const currentPonytail = computed(() => ponytailOptions.find(o => o.value === settings.ponytailMode)!);

function selectPonytail(value: "off" | "lite" | "full" | "ultra") {
  settings.ponytailMode = value;
  openMenu.value = null;
  // /ponytail 命令由 ChatPanel 的 settings.ponytailMode watcher 统一发送
}

// ── Custom dropdowns ──
const openMenu = ref<"mode" | "effort" | "ponytail" | "slash" | null>(null);

function toggleMenu(menu: "mode" | "effort" | "ponytail" | "slash") {
  openMenu.value = openMenu.value === menu ? null : menu;
}

function selectMode(value: string) {
  activeMode.value = value;
  openMenu.value = null;
}

const effortWarning = ref("");
let effortWarnTimer: ReturnType<typeof setTimeout> | null = null;

function selectEffort(value: Effort) {
  settings.effort = value;
  openMenu.value = null;

  if (value === "xhigh" && settings.model.toLowerCase().includes("deepseek")) {
    effortWarning.value = t("effortWarning");
    if (effortWarnTimer) clearTimeout(effortWarnTimer);
    effortWarnTimer = setTimeout(() => effortWarning.value = "", 5000);
  } else {
    effortWarning.value = "";
  }
}

function closeMenus() {
  openMenu.value = null;
}

// Click outside listener
function onBodyClick(e: MouseEvent) {
  if (!(e.target as HTMLElement).closest(".toolbar-dropdown")) {
    closeMenus();
  }
}
onMounted(() => document.addEventListener("click", onBodyClick));
onUnmounted(() => document.removeEventListener("click", onBodyClick));

const activeMode = computed({
  get: () => {
    if (settings.planMode) return "plan";
    if (settings.autoMode) return "auto";
    if (settings.permissionMode === "bypassPermissions") return "bypass";
	    if (settings.permissionMode === "dontAsk") return "dontAsk";
	    if (settings.permissionMode === "acceptEdits") return "editAuto";
    return "askBefore";
  },
  set: (v: string) => {
    settings.planMode = v === "plan";
    settings.autoMode = v === "auto";
    settings.permissionMode = v === "editAuto" ? "acceptEdits" : v === "bypass" ? "bypassPermissions" : v === "dontAsk" ? "dontAsk" : "default";
  },
});

const currentModeLabel = computed(() => {
  const m = modeOptions.find(o => o.value === activeMode.value);
  return m ? m.label() : activeMode.value;
});

const currentEffortLabel = computed(() => {
  const e = effortOptions.find(o => o.value === settings.effort);
  return e ? e.label() : settings.effort;
});
</script>

<template>
  <div class="sb-toolbar">
    <!-- ═══ 左区：操作按钮 ═══ -->
    <div class="toolbar-group">
      <slot name="left" />

      <!-- ➕ Attach File -->
      <button
        @click="emit('attachFile')"
        class="toolbar-btn"
        :title="$t('toolbar.attachTitle')"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>

      <!-- / Slash quick menu -->
      <div class="slash-menu-container">
        <button
          @click.stop="toggleMenu('slash')"
          class="toolbar-btn"
          :title="$t('toolbar.slashTitle')"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="4" x2="6" y2="20"/></svg>
        </button>
        <Transition name="drop">
          <div
            v-if="openMenu === 'slash'"
            class="dropdown-menu slash-dropdown toolbar-dropdown"
          >
            <template v-if="recentCommands.length > 0">
              <div class="slash-section-header">🕐 {{ $t('toolbar.slashRecent') }}</div>
              <button
                v-for="r in recentCommands.slice(0, 5)"
                :key="r"
                @click="emit('sendSlash', '/' + r); openMenu = null"
                class="dropdown-item"
              >{{ r }}</button>
            </template>
            <template v-if="favorites.size > 0">
              <div class="slash-section-header">⭐ {{ $t('toolbar.slashFavorites') }}</div>
              <button
                v-for="f in [...favorites]"
                :key="f"
                @click="emit('sendSlash', '/' + f); openMenu = null"
                class="dropdown-item"
              >{{ f }}</button>
            </template>
            <div v-if="recentCommands.length > 0 || favorites.size > 0" class="slash-section-divider"></div>
            <button
              @click="emit('openCommandMenu'); openMenu = null"
              class="dropdown-item slash-browse-all"
            >📋 {{ $t('toolbar.slashBrowseAll') }}</button>
            <div v-if="favorites.size === 0 && recentCommands.length === 0" class="slash-empty">
              {{ $t('toolbar.slashEmpty') }}
            </div>
          </div>
        </Transition>
      </div>

      <!-- ☰ Command Menu -->
      <button
        @click="emit('openCommandMenu')"
        class="toolbar-btn"
        :title="$t('toolbar.commandsTitle')"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 12h18M3 6h18M3 18h18"/></svg>
      </button>
    </div>

    <!-- ═══ 右区：模式/Effort/Ponytail ═══ -->
    <div class="toolbar-group">
      <!-- Permission Mode dropdown -->
      <div
        class="toolbar-pill"
        @click.stop="toggleMenu('mode')"
      >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="color: var(--accent); opacity: 0.7">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      </svg>
      <span class="font-medium" style="color: var(--accent)">{{ currentModeLabel }}</span>
      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" :style="{ color: 'var(--accent)', opacity: 0.5, transition: 'transform 150ms', transform: openMenu === 'mode' ? 'rotate(180deg)' : '' }"><polyline points="6 9 12 15 18 9"/></svg>

      <!-- Dropdown menu -->
      <Transition name="drop">
        <div
          v-if="openMenu === 'mode'"
          class="dropdown-menu" style="min-width: 140px"
        >
          <button
            v-for="m in modeOptions"
            :key="m.value"
            @click="selectMode(m.value)"
            class="dropdown-item"
            :style="{
              color: activeMode === m.value ? 'var(--accent)' : 'var(--text-secondary)',
              background: activeMode === m.value ? 'var(--accent-glow)' : 'transparent'
            }"
          >{{ m.label() }}</button>
        </div>
      </Transition>
    </div>

    <!-- Effort dropdown -->
    <div
      class="toolbar-pill"
      @click.stop="toggleMenu('effort')"
    >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" :style="{ color: currentEffortColor, opacity: 0.7 }">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
      </svg>
      <span class="font-medium" :style="{ color: currentEffortColor }">{{ currentEffortLabel }}</span>
      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" :style="{ color: currentEffortColor, opacity: 0.5, transition: 'transform 150ms', transform: openMenu === 'effort' ? 'rotate(180deg)' : '' }"><polyline points="6 9 12 15 18 9"/></svg>

      <!-- Dropdown menu -->
      <Transition name="drop">
        <div
          v-if="openMenu === 'effort'"
          class="dropdown-menu" style="min-width: 130px"
        >
          <button
            v-for="e in effortOptions"
            :key="e.value"
            @click="selectEffort(e.value)"
            class="dropdown-item"
            :style="{
              color: settings.effort === e.value ? e.color : 'var(--text-secondary)',
              background: settings.effort === e.value ? e.color + '18' : 'transparent'
            }"
          >{{ e.label() }}</button>
        </div>
      </Transition>
    </div>

    <!-- Ponytail: 检测中不渲染，已安装 → 下拉，未安装 → 安装按钮 -->
    <div
      v-if="hasPonytail === true"
      class="toolbar-pill"
      @click.stop="toggleMenu('ponytail')"
      :title="$t('toolbar.ponytailTitle')"
    >
      <span class="font-medium" :style="{ color: currentPonytail.color }">{{ currentPonytail.label }}</span>
      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" :style="{ color: currentPonytail.color, opacity: 0.5, transition: 'transform 150ms', transform: openMenu === 'ponytail' ? 'rotate(180deg)' : '' }"><polyline points="6 9 12 15 18 9"/></svg>

      <Transition name="drop">
        <div
          v-if="openMenu === 'ponytail'"
          class="dropdown-menu" style="min-width: 110px"
        >
          <button
            v-for="p in ponytailOptions"
            :key="p.value"
            @click="selectPonytail(p.value)"
            class="dropdown-item"
            :style="{
              color: settings.ponytailMode === p.value ? p.color : 'var(--text-secondary)',
              background: settings.ponytailMode === p.value ? p.color + '18' : 'transparent'
            }"
          >{{ p.label }}</button>
        </div>
      </Transition>
    </div>
    <button
      v-else-if="hasPonytail === false"
      @click="installPonytail"
      class="toolbar-pill"
      :title="$t('toolbar.ponytailInstall')"
    >
      <span class="opacity-60">⬇</span>
      <span class="font-medium">{{ $t('toolbar.ponytailInstall') }}</span>
    </button>

    <!-- Mini divider + context indicator — 有消息时才显示 -->
    <template v-if="chat.messages.length > 0">
      <div class="w-px h-4 shrink-0" style="background: var(--border-dim)"></div>
      <ContextIndicator @click="emit('showContext')" />
    </template>
    </div>
  </div>

  <!-- Effort warning -->
  <div v-if="effortWarning" class="effort-warning">
    <div class="effort-warning-banner">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
      {{ effortWarning }}
    </div>
  </div>
</template>

<style scoped>
/* ── Toolbar container ── */
.sb-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.375rem;
  row-gap: 0.25rem;
  max-width: 48rem;
  margin-inline: auto;
  padding-bottom: 0.25rem;
  user-select: none;
}

/* ── 工具栏分组（左/右），宽度不足时按组换行 ── */
.toolbar-group {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.375rem;
}

/* ── Tool buttons (attach, command menu) ── */
.toolbar-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border-radius: 0.5rem;
  font-size: 11px;
  flex-shrink: 0;
  color: var(--text-secondary);
  background: transparent;
  border: 1px solid var(--border-dim);
  transition: all 150ms ease;
}
.toolbar-btn:hover {
  color: var(--text-secondary);
  background: var(--bg-elevated);
  border-color: var(--accent);
}

/* ── Pill dropdowns (mode, effort, ponytail) ── */
.toolbar-pill {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 11px;
  flex-shrink: 0;
  border-radius: 0.5rem;
  position: relative;
  cursor: pointer;
  background: var(--bg-elevated);
  border: 1px solid var(--border-dim);
  padding: 3px 8px;
  transition: border-color 150ms;
  outline: none;
  user-select: none;
}
.toolbar-pill:hover {
  border-color: var(--border-bright);
}

/* ── Dropdown menu ── */
.dropdown-menu {
  position: absolute;
  bottom: 100%;
  right: 0;
  margin-bottom: 0.25rem;
  padding-block: 0.25rem;
  border-radius: 0.5rem;
  z-index: 30;
  overflow: hidden;
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  box-shadow: 0 8px 24px rgba(0,0,0,0.4);
}

/* ── Dropdown item ── */
.dropdown-item {
  width: 100%;
  text-align: left;
  padding: 0.375rem 0.75rem;
  font-size: 11px;
  transition: background-color 150ms;
}
.dropdown-item:hover {
  background: var(--bg-hover);
}

/* ── Slash quick menu ── */
.slash-menu-container {
  position: relative;
}
.slash-icon {
  font-size: 14px;
  font-weight: 700;
  line-height: 1;
}
.slash-dropdown {
  right: auto;
  left: 0;
  min-width: 180px;
  max-height: 320px;
  overflow-y: auto;
}
.slash-section-header {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 0.375rem 0.75rem 0.125rem;
  color: var(--text-muted);
}
.slash-section-divider {
  height: 1px;
  margin: 0.25rem 0.5rem;
  background: var(--border-dim);
}
.slash-browse-all {
  color: var(--accent);
  font-weight: 500;
}
.slash-empty {
  font-size: 11px;
  padding: 0.75rem;
  text-align: center;
  color: var(--text-muted);
}

/* Dropdown animation */
.drop-enter-active { transition: all 120ms ease-out; }
.drop-leave-active { transition: all 100ms ease-in; }
.drop-enter-from { opacity: 0; transform: translateY(4px) scale(0.96); }
.drop-leave-to { opacity: 0; transform: translateY(2px) scale(0.98); }

/* ── Effort warning ── */
.effort-warning {
  max-width: 48rem;
  margin-inline: auto;
  padding-bottom: 0.25rem;
}
.effort-warning-banner {
  font-size: 10px;
  padding: 0.25rem 0.5rem;
  border-radius: 0.375rem;
  display: flex;
  align-items: center;
  gap: 0.375rem;
  background: var(--amber-glow);
  color: var(--amber);
  border: 1px solid rgba(245,166,35,0.2);
}
</style>
