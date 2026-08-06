<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, provide } from "vue";
import { useRouter, useRoute } from "vue-router";
import SessionSidebar from "@/components/session/SessionSidebar.vue";
import FilePanel from "@/components/files/FilePanel.vue";
import FilePreviewPanel from "@/components/shared/FilePreviewPanel.vue";
import CommandPalette from "@/components/shared/CommandPalette.vue";
import ManagePanel from "@/components/shared/ManagePanel.vue";
import ChangelogDialog from "@/components/shared/ChangelogDialog.vue";
import { emitChatCommand, useGlobalCommandBus } from "@/composables/useCommandPalette";
import { useNewSession } from "@/composables/useNewSession";
import { useSessionSwitch } from "@/composables/useSessionSwitch";
import { getWorkspaceRoot, openDialog } from "@/lib/electron-bridge";
import { useSettingsStore, PROVIDER_LOGOS } from "@/stores/settings";
import { useSessionStore } from "@/stores/session";
import { useChatStore } from "@/stores/chat";
import { useI18n } from "vue-i18n";
import { usePanelLayout, PANEL_LAYOUT_KEY } from "@/composables/usePanelLayout";

const { t } = useI18n();
const router = useRouter();
const route = useRoute();
const settings = useSettingsStore();
const sessionStore = useSessionStore();
const chatStore = useChatStore();
const { handleNew } = useNewSession();
const { switchTo, zenSwitchTo } = useSessionSwitch();

// 当前模式对应的会话列表（CC 模式只显示 CC 会话，禅模式只显示 Zen 会话）
const railSessions = computed(() =>
  settings.zenMode
    ? sessionStore.sessions.filter(s => s.mode === 'zen')
    : sessionStore.sessions.filter(s => s.mode !== 'zen'),
);
const railActiveId = computed(() =>
  settings.zenMode ? sessionStore.zenActiveId : sessionStore.activeSessionId,
);

async function onRailNewSession() {
  if (settings.zenMode) {
    const id = await sessionStore.createSession(settings.model, undefined, "zen", settings.locale);
    zenSwitchTo(id);
  } else {
    handleCommand("new-session");
  }
}

// 会话标题首字符（英文大写，中文原样）
function sessionChar(title: string): string {
  const first = title.trim().charAt(0);
  if (!first) return '?';
  return /[a-zA-Z]/.test(first) ? first.toUpperCase() : first;
}

const drawerOpen = ref(false);
const showManagePanel = ref(false);
const fileNavCounter = ref(0);
const filePanelForceClose = ref(0);

// 第四列：文件预览/编辑面板
const panelFile = ref<{ name: string; path: string } | null>(null);
// Git diff 面板（与文件编辑器互斥，共用第四列）
const gitDiffFile = ref<{ path: string; diff: string } | null>(null);
// 逐行解析 diff 并标注类型，供模板着色
const diffLines = computed(() => {
  const d = gitDiffFile.value?.diff;
  if (!d) return [];
  return d.split("\n").map(line => {
    const t = line.charAt(0);
    if (t === "+" && !line.startsWith("+++")) return { text: line, type: "add" as const };
    if (t === "-" && !line.startsWith("---")) return { text: line, type: "del" as const };
    if (line.startsWith("@@")) return { text: line, type: "hunk" as const };
    if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) return { text: line, type: "meta" as const };
    return { text: line, type: "context" as const };
  });
});
provide("openFileInPanel", (f: { name: string; path: string }) => { panelFile.value = f; gitDiffFile.value = null; });
provide("openGitDiff", (f: { path: string; diff: string }) => { gitDiffFile.value = f; panelFile.value = null; });
provide("closeGitDiff", () => { gitDiffFile.value = null; });

// 统一的列宽管理（文件预览 + 文件面板的拖拽宽度）
const sbBodyRef = ref<HTMLElement | null>(null);
const panelLayout = usePanelLayout({ containerRef: sbBodyRef, sidebarOpen: drawerOpen });
provide(PANEL_LAYOUT_KEY, panelLayout);
const showWorkspaceMenu = ref(false);

// ── 工作区（状态由 settings store 管理，SQLite 持久化）──
const cwd = computed(() => settings.cwd);

function switchToWorkspace(path: string) {
  settings.cwd = path;
  settings.addRecentWorkspace(path);
  emitChatCommand(`switch-workspace:${path}`);
  showWorkspaceMenu.value = false;
  filePanelForceClose.value++;  // 切工作区时收起文件面板
  panelFile.value = null;       // 关闭编辑器面板
}

function onBodyClickForWs(e: MouseEvent) {
  if (!(e.target as HTMLElement).closest(".workspace-menu")) showWorkspaceMenu.value = false;
}
onMounted(() => document.addEventListener("click", onBodyClickForWs));
onUnmounted(() => document.removeEventListener("click", onBodyClickForWs));

const commandPalette = ref<InstanceType<typeof CommandPalette> | null>(null);

async function handleCommand(action: string) {
  switch (action) {
    // ── 💬 会话 ──
    case "new-session": {
      const result = await handleNew();
      if (result === "current-empty") {
        emitChatCommand("show-status:" + t("session.alreadyNew"));
      } else if (result !== "created") {
        // result 是最新空会话的 id → 直接切换，无需新建
        switchTo(result);
      }
      break;
    }
    case "continue-session":
    case "rename-session":
    case "delete-session":
    case "export-session":
    case "attach-file":
      emitChatCommand(action);
      break;

    // ── 🖥 视图 ──
    case "toggle-sidebar": drawerOpen.value = !drawerOpen.value; break;
    case "toggle-files": fileNavCounter.value++; break;
    case "zen-mode":
      if (!settings.zenMode) {
        // 进入禅模式
        settings.zenMode = true;
        drawerOpen.value = false;
        filePanelForceClose.value++;
        // 保存当前 CC 会话消息，切换到禅模式会话
        if (sessionStore.activeSessionId) {
          chatStore.saveSessionCache(sessionStore.activeSessionId);
        }
        if (sessionStore.zenActiveId) {
          zenSwitchTo(sessionStore.zenActiveId);
        } else {
          // 无禅模式会话则新建
          sessionStore.createSession(settings.model, undefined, "zen", settings.locale).then(id => {
            zenSwitchTo(id);
          });
        }
      } else {
        // 退出禅模式，恢复 CC 会话
        settings.zenMode = false;
        if (sessionStore.zenActiveId) {
          chatStore.saveSessionCache(sessionStore.zenActiveId);
        }
        if (sessionStore.activeSessionId) {
          switchTo(sessionStore.activeSessionId);
        }
      }
      break;

    // ── 🛡 权限与模式 ──
    case "perm-default":
      settings.permissionMode = "default";
      settings.planMode = false;
      settings.autoMode = false;
      break;
    case "perm-plan":
      settings.planMode = true;
      settings.autoMode = false;
      break;
    case "perm-edit-auto":
      settings.permissionMode = "acceptEdits";
      settings.planMode = false;
      settings.autoMode = false;
      break;
    case "perm-auto":
      settings.autoMode = true;
      settings.planMode = false;
      break;
    case "perm-bypass":
      settings.permissionMode = "bypassPermissions";
      settings.planMode = false;
      settings.autoMode = false;
      break;
    case "perm-dontask":
      settings.permissionMode = "dontAsk";
      settings.planMode = false;
      settings.autoMode = false;
      break;

    // ── 🧠 思考深度 ──
    case "effort-low": settings.effort = "low"; break;
    case "effort-medium": settings.effort = "medium"; break;
    case "effort-high": settings.effort = "high"; break;
    case "effort-xhigh": settings.effort = "xhigh"; break;
    case "effort-max": settings.effort = "max"; break;
    case "effort-ultracode": settings.effort = "ultracode"; break;

    // ── 🔌 工具 ──
    case "open-explorer": openFilePanelTo(cwd.value || "."); break;
    case "slash-compact":
    case "slash-context":
    case "slash-cost":
    case "slash-clear":
    case "slash-review":
    case "slash-simplify":
    case "slash-security":
    case "slash-doctor":
    case "slash-init":
    case "manage-plugins":
    case "manage-mcp":
    case "manage-skills":
    case "manage-agents":
    case "manage-hooks":
    case "manage-memory":
    case "manage-permissions":
    case "manage-styles":
      emitChatCommand(action);
      break;

    // ── ⚙ 设置 ──
    case "settings": router.push("/settings"); break;
    case "theme-dark": settings.theme = "dark"; break;
    case "theme-light": settings.theme = "light"; break;
    case "theme-system": settings.theme = "system"; break;
    case "about": /* ChatPanel 弹窗处理 */ emitChatCommand(action); break;

    // ── 兼容旧 action id ──
    case "plan-mode": settings.planMode = true; settings.autoMode = false; break;
    case "auto-mode": settings.autoMode = true; settings.planMode = false; break;
    case "accept-edits": settings.permissionMode = "acceptEdits"; break;
    case "bypass": settings.permissionMode = "bypassPermissions"; break;
    case "toggle-files-legacy": fileNavCounter.value++; break;
  }
}

// ── Global keyboard shortcuts ──
function onGlobalKeydown(e: KeyboardEvent) {
  if (!(e.ctrlKey || e.metaKey)) return;
  // Skip when focused on input/textarea/contenteditable
  const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
  const isEditable = (e.target as HTMLElement)?.isContentEditable;
  if (tag === "input" || tag === "textarea" || tag === "select" || isEditable) return;

  switch (e.key.toLowerCase()) {
    case "n": e.preventDefault(); handleCommand("new-session"); break;
    case "b": e.preventDefault(); handleCommand("toggle-sidebar"); break;
    case "e": e.preventDefault(); handleCommand("toggle-files"); break;
    case ",": e.preventDefault(); handleCommand("settings"); break;
  }
}

// 监听子组件发出的全局命令
const { globalCommand } = useGlobalCommandBus();
watch(() => globalCommand.value.ts, () => {
  if (globalCommand.value.action) handleCommand(globalCommand.value.action);
});

const initializing = ref(true);

onMounted(async () => {
  // 并行初始化所有持久化数据：会话列表 + settings + 工作区
  try {
    await Promise.all([
      sessionStore.loadSessions(),
      settings.initFromDb(),
      (async () => {
        if (!settings.cwd) {
          try { settings.cwd = await getWorkspaceRoot(); } catch {}
        }
      })(),
    ]);
  } catch {
    // 所有子任务已有独立 catch，此处仅兜底——不会到达，但确保 initializing 必然复位
  } finally {
    initializing.value = false;
    document.addEventListener("keydown", onGlobalKeydown);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    panelLayout.setupObserver(); // ResizeObserver 监听容器宽度变化，自动 clamp 右侧面板
  }
});

onUnmounted(() => {
  document.removeEventListener("keydown", onGlobalKeydown);
  document.removeEventListener("fullscreenchange", onFullscreenChange);
});

function isActive(path: string): boolean {
  return route.path === path;
}

const isFullscreen = ref(false);
function onFullscreenChange() { isFullscreen.value = !!document.fullscreenElement; }

function toggleFullscreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen();
  else document.exitFullscreen();
}

async function switchWorkspace() {
  const selected = await openDialog({ directory: true, title: t('header.selectWorkspace') });
  if (!selected) return;
  const newPath = Array.isArray(selected) ? selected[0] : selected;
  switchToWorkspace(newPath);
}

function openFilePanelTo(_path: string) {
  // ponytail: path 参数保留兼容旧调用方，实际导航由 FilePanel 的 navPath prop (= cwd) 控制
  fileNavCounter.value++;
}
</script>

<template>
  <!-- 启动画面：数据加载完成前显示 -->
  <div v-if="initializing" class="h-screen flex flex-col items-center justify-center gap-4" style="background:var(--bg-root)">
    <img src="/logo.svg" alt="90火" class="w-24 h-24" />
    <span class="text-xs animate-pulse" style="color:var(--text-muted)">{{ $t('chat.loading') }}</span>
  </div>

  <div v-else class="sb-shell">
    <!-- Navbar -->
    <header class="sb-header">
      <!-- Logo group -->
      <div class="header-logo-group">
        <span class="text-sm font-semibold tracking-tight leading-none" style="color:var(--text-bright)">{{ $t('app.title') }}</span>

        <!-- 禅模式 -->
        <button
          @click="handleCommand('zen-mode')"
          class="w-6 h-6 flex items-center justify-center rounded-md transition-colors shrink-0"
          :style="{ background: settings.zenMode ? 'var(--accent-glow)' : 'transparent', color: settings.zenMode ? 'var(--accent)' : 'var(--text-secondary)' }"
          :class="settings.zenMode ? '' : 'hover:bg-[var(--bg-hover)]'"
          :title="settings.zenMode ? $t('header.exitZenMode') : $t('header.zenMode')"
        >
          <img
            v-if="PROVIDER_LOGOS[settings.providerId]"
            :src="PROVIDER_LOGOS[settings.providerId]"
            class="w-4 h-4 shrink-0"
            alt=""
          />
          <span v-else>🤖</span>
        </button>

        <!-- CWD + 工作区管理 -->
        <div v-if="cwd" class="workspace-menu flex items-center gap-0 ml-1 relative">
          <button
            @click="openFilePanelTo(cwd)"
            class="text-[10px] font-mono truncate px-2 py-0.5 rounded-l leading-none cursor-pointer transition-colors hover:border-[var(--accent)]"
            :style="{ background: 'var(--bg-root)', color: 'var(--accent)', border: '1px solid var(--accent-dim)', borderRight: 'none' }"
            :title="cwd + $t('header.cwdTitle')"
          >{{ cwd }}</button>
          <button
            @click.stop="showWorkspaceMenu = !showWorkspaceMenu"
            class="shrink-0 w-5 py-0.5 rounded-r flex items-center justify-center cursor-pointer transition-colors hover:text-[var(--accent)]"
            :style="{ background: 'var(--bg-root)', color: 'var(--accent-dim)', border: '1px solid var(--accent-dim)', lineHeight: 1 }"
            :title="$t('header.switchWorkspace')"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
          </button>
          <!-- 下拉菜单：最近工作区 + 浏览 -->
          <Transition name="drop">
            <div
              v-if="showWorkspaceMenu"
              class="absolute top-full left-0 mt-1 py-1 rounded-lg z-30 min-w-[280px]"
              style="background: var(--bg-elevated); border: 1px solid var(--border-default); box-shadow: 0 8px 24px rgba(0,0,0,0.4)"
            >
              <div class="px-3 py-1.5 text-[10px] font-medium" style="color: var(--text-muted)">{{ $t('header.recentWorkspaces') }}</div>
              <button
                v-for="ws in settings.recentWorkspaces"
                :key="ws"
                @click="switchToWorkspace(ws)"
                class="w-full text-left px-3 py-1.5 text-[11px] font-mono transition-colors hover:bg-[var(--bg-hover)] flex items-center gap-2"
                :style="{ color: ws === cwd ? 'var(--accent)' : 'var(--text-secondary)' }"
              >
                <span class="text-[10px] shrink-0" :style="{ color: ws === cwd ? 'var(--accent)' : 'var(--text-muted)' }">{{ ws === cwd ? '●' : '○' }}</span>
                <span class="truncate">{{ ws }}</span>
              </button>
              <div v-if="settings.recentWorkspaces.length === 0" class="px-3 py-2 text-[11px]" style="color: var(--text-muted); opacity: 0.6">{{ $t('header.noRecentWorkspaces') }}</div>
              <div class="mx-3 my-1" style="border-top: 1px solid var(--border-dim)"></div>
              <button
                @click="switchWorkspace(); showWorkspaceMenu = false"
                class="w-full text-left px-3 py-1.5 text-[11px] transition-colors hover:bg-[var(--bg-hover)] flex items-center gap-2"
                style="color: var(--accent)"
              >
                <span>📂</span><span>{{ $t('header.browseFolder') }}</span>
              </button>
            </div>
          </Transition>
        </div>
      </div>

      <!-- Actions group -->
      <div class="flex items-center gap-1">
        <!-- New session -->
        <button
          @click="handleCommand('new-session')"
          class="w-7 h-7 flex items-center justify-center rounded-md transition-colors hover:bg-[var(--bg-hover)]"
          style="color:var(--text-secondary)"
          :title="$t('header.newSession')"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>

        <!-- Theme toggle -->
        <button
          @click="settings.theme = settings.theme === 'dark' ? 'light' : 'dark'"
          class="w-7 h-7 flex items-center justify-center rounded-md transition-colors hover:bg-[var(--bg-hover)]"
          style="color:var(--text-secondary)"
          :title="settings.theme === 'dark' ? $t('header.lightMode') : $t('header.darkMode')"
        >
          <!-- Sun icon (light mode indicator) -->
          <svg v-if="settings.theme === 'dark'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="5" />
            <line x1="12" y1="1" x2="12" y2="3" />
            <line x1="12" y1="21" x2="12" y2="23" />
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
            <line x1="1" y1="12" x2="3" y2="12" />
            <line x1="21" y1="12" x2="23" y2="12" />
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
          </svg>
          <!-- Moon icon (dark mode indicator) -->
          <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
        </button>

        <!-- Locale toggle -->
        <button
          @click="settings.locale = settings.locale === 'zh' ? 'en' : 'zh'"
          class="w-7 h-7 flex items-center justify-center rounded-md transition-colors hover:bg-[var(--bg-hover)] text-[11px] font-semibold"
          style="color:var(--text-secondary)"
          :title="$t('settings.language')"
        >{{ settings.locale === 'zh' ? 'EN' : '中' }}</button>

        <!-- 全屏 -->
        <button
          @click="toggleFullscreen"
          class="w-7 h-7 flex items-center justify-center rounded-md transition-colors hover:bg-[var(--bg-hover)]"
          style="color:var(--text-secondary)"
          :title="isFullscreen ? $t('header.exitFullscreen') : $t('header.fullscreen')"
        >
          <!-- 进入全屏：展开图标 -->
          <svg v-if="!isFullscreen" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" />
          </svg>
          <!-- 退出全屏：收缩图标 -->
          <svg v-else width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="4 8 4 3 9 3" /><polyline points="20 16 20 21 15 21" /><line x1="4" y1="3" x2="10" y2="9" /><line x1="20" y1="21" x2="14" y2="15" />
          </svg>
        </button>

        <!-- Refresh -->
        <button
          @click="router.go(0)"
          class="w-7 h-7 flex items-center justify-center rounded-md transition-colors hover:bg-[var(--bg-hover)]"
          style="color:var(--text-secondary)"
          :title="$t('header.refresh')"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
            <path d="M21 3v5h-5" />
            <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
            <path d="M3 21v-5h5" />
          </svg>
        </button>

        <!-- Manage -->
        <button
          @click="showManagePanel = true"
          class="w-7 h-7 flex items-center justify-center rounded-md transition-colors hover:bg-[var(--bg-hover)]"
          style="color:var(--text-secondary)"
          :title="$t('manage.title')"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
          </svg>
        </button>

        <!-- Settings -->
        <button
          @click="router.push(isActive('/settings') ? '/chat' : '/settings')"
          class="w-7 h-7 flex items-center justify-center rounded-md transition-colors"
          :style="{
            background: isActive('/settings') ? 'var(--accent-glow)' : 'transparent',
            color: isActive('/settings') ? 'var(--accent)' : 'var(--text-secondary)'
          }"
          :class="isActive('/settings') ? '' : 'hover:bg-[var(--bg-hover)]'"
          :title="$t('header.settings')"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
      </div>
    </header>

    <!-- Body -->
    <div ref="sbBodyRef" class="sb-body">
      <!-- 左侧会话栏：rail + 展开面板 -->
      <div class="sb-sidebar">
        <!-- 窄 rail（收起时显示） -->
        <nav v-show="!drawerOpen" class="sb-session-rail">
          <!-- 展开/收起 -->
          <button
            @click="drawerOpen = !drawerOpen"
            class="rail-btn"
            :style="{ color: drawerOpen ? 'var(--accent)' : 'var(--text-muted)' }"
            :title="$t('header.toggleSidebar')"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M3 12h18M3 6h18M3 18h18" />
            </svg>
          </button>

          <!-- 分隔 -->
          <div class="rail-divider" />

          <!-- 新建会话 -->
          <button
            @click="onRailNewSession"
            class="rail-btn"
            style="color: var(--text-muted)"
            :title="$t('session.new')"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>

          <!-- 分隔 -->
          <div class="rail-divider" />

          <!-- 会话历史（首字符按钮 + 活动指示点） -->
          <button
            v-for="s in railSessions"
            :key="s.id"
            @click="settings.zenMode ? zenSwitchTo(s.id) : switchTo(s.id)"
            class="rail-session-btn relative"
            :style="{
              color: s.id === railActiveId ? 'var(--accent)' : 'var(--text-muted)',
              background: s.id === railActiveId ? 'var(--accent-glow)' : 'transparent',
            }"
            :title="s.title"
          >
            {{ sessionChar(s.title) }}
            <span
              v-if="sessionStore.sessionActivity[s.id]"
              class="rail-dot"
              :class="'dot-' + sessionStore.sessionActivity[s.id]"
            />
          </button>
        </nav>

        <!-- 展开面板 -->
        <aside
          :class="['sb-session-panel',
            drawerOpen ? 'sb-session-panel--open' : 'sb-session-panel--closed']"
        >
          <div class="w-[260px] h-full">
            <SessionSidebar @navigate="drawerOpen = false" @collapse="drawerOpen = false" />
          </div>
        </aside>
      </div>

      <!-- Main -->
      <main class="sb-main">
        <div class="sb-main-content">
          <router-view />
        </div>
      </main>

      <!-- 第四列：Git diff 面板（与文件编辑器互斥） -->
      <div v-if="gitDiffFile" class="git-diff-panel-col">
        <div class="git-diff-panel-col-header">
          <span class="git-diff-panel-col-filename">{{ gitDiffFile.path }}</span>
          <button @click="gitDiffFile = null" class="git-diff-panel-col-close">×</button>
        </div>
        <div class="git-diff-panel-col-content">
          <template v-for="(line, i) in diffLines" :key="i">
            <div
              v-if="line.type === 'hunk'"
              class="diff-line diff-line--hunk"
            >{{ line.text }}</div>
            <div
              v-else-if="line.type === 'add'"
              class="diff-line diff-line--add"
            >{{ line.text }}</div>
            <div
              v-else-if="line.type === 'del'"
              class="diff-line diff-line--del"
            >{{ line.text }}</div>
            <div
              v-else-if="line.type === 'meta'"
              class="diff-line diff-line--meta"
            >{{ line.text }}</div>
            <div
              v-else
              class="diff-line diff-line--ctx"
            >{{ line.text }}</div>
          </template>
        </div>
      </div>

      <!-- 第四列：文件预览/编辑面板 -->
      <FilePreviewPanel
        v-else-if="panelFile"
        :file="panelFile"
        @close="panelFile = null"
      />

      <!-- File panel (right side) -->
      <FilePanel :navCounter="fileNavCounter" :navPath="cwd" :forceClose="filePanelForceClose" />
    </div>

    <CommandPalette @command="handleCommand" />
    <ChangelogDialog />
    <ManagePanel :open="showManagePanel" @close="showManagePanel = false" />
  </div>
</template>

<style scoped>
/* ── Shell ── */
.sb-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg-root);
}

/* ── Header ── */
.sb-header {
  display: flex;
  align-items: center;
  height: 2.75rem;
  padding: 0 1rem;
  flex-shrink: 0;
  user-select: none;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-dim);
}

/* ── Body ── */
.sb-body {
  flex: 1;
  display: flex;
  overflow: hidden;
}

.sb-sidebar {
  display: flex;
  flex-shrink: 0;
}

.sb-main {
  flex: 1;
  display: flex;
  overflow: hidden;
  min-width: 300px;  /* 保护聊天区不被右侧面板挤扁 */
}

.sb-main-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.header-logo-group {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  flex: 1;
  min-width: 0;
}

/* ── 会话 rail（左侧窄栏）── */
.sb-session-rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 8px 0;
  width: 40px;
  background: var(--bg-surface);
  border-right: 1px solid var(--border-dim);
  overflow-y: auto;
  /* ponytail: 不显示滚动条，40px 宽放不下；会话多了展开面板即可 */
  scrollbar-width: none;
}
.sb-session-rail::-webkit-scrollbar {
  display: none;
}

.rail-btn {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  transition: background 150ms, color 150ms;
}
.rail-btn:hover {
  background: var(--bg-hover);
}

.rail-session-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 600;
  transition: background 150ms, color 150ms;
}
.rail-session-btn:hover {
  background: var(--bg-hover);
}

.rail-divider {
  width: 20px;
  height: 1px;
  margin: 2px 0;
  background: var(--border-dim);
}

.sb-session-panel {
  overflow: hidden;
  transition: width 200ms ease-in-out, border 200ms ease-in-out;
  background: var(--bg-surface);
}
.sb-session-panel--open {
  width: 260px;
  border-right: 1px solid var(--border-dim);
}
.sb-session-panel--closed {
  width: 0;
  border-right: none;
}

/* ── Activity dot（rail 角标）── */
.rail-dot {
  position: absolute;
  top: -1px;
  right: -1px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  border: 1px solid var(--bg-surface);
}
.dot-processing {
  background: var(--accent);
  animation: dot-blink 1s ease-in-out infinite;
}
.dot-unread {
  background: var(--blue);
}
.dot-blocked {
  background: var(--coral);
  animation: dot-blink 0.6s ease-in-out infinite;
}
@keyframes dot-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.15; }
}

/* ── 第四列 Git diff 面板 ── */
.git-diff-panel-col {
  display: flex;
  flex-direction: column;
  width: 360px;
  flex-shrink: 0;
  background: var(--bg-surface);
  border-left: 1px solid var(--border-dim);
  overflow: hidden;
}
.git-diff-panel-col-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  flex-shrink: 0;
  background: var(--bg-elevated);
  border-bottom: 1px solid var(--border-dim);
}
.git-diff-panel-col-filename {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary);
}
.git-diff-panel-col-close {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  font-size: 16px;
  color: var(--text-muted);
  cursor: pointer;
  transition: background 150ms;
}
.git-diff-panel-col-close:hover { background: var(--bg-hover); }
.git-diff-panel-col-content {
  flex: 1;
  overflow-y: auto;
  font-size: 11px;
  font-family: ui-monospace, monospace;
  line-height: 1.6;
}
.diff-line {
  padding: 0 12px;
  white-space: pre-wrap;
  word-break: break-all;
  min-height: 1.3em;
}
.diff-line--add {
  background: rgba(6, 214, 160, 0.08);
  color: var(--accent);
}
.diff-line--del {
  background: rgba(255, 94, 91, 0.08);
  color: var(--coral);
}
.diff-line--hunk {
  color: var(--violet);
  font-weight: 500;
  padding-top: 4px;
}
.diff-line--meta {
  color: var(--text-muted);
  font-weight: 600;
}
.diff-line--ctx {
  color: var(--text-secondary);
}
</style>
