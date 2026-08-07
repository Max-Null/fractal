<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, provide } from "vue";
import { useRouter, useRoute } from "vue-router";
import SessionSidebar from "@/components/session/SessionSidebar.vue";
import FilePanel from "@/components/files/FilePanel.vue";
import FilePreviewPanel from "@/components/shared/FilePreviewPanel.vue";
import CommandPalette from "@/components/shared/CommandPalette.vue";
import ManagePanel from "@/components/shared/ManagePanel.vue";
import ChangelogDialog from "@/components/shared/ChangelogDialog.vue";
import Onboarding from "@/components/onboarding/Onboarding.vue";
import { emitChatCommand, useGlobalCommandBus } from "@/composables/useCommandPalette";
import { useNewSession } from "@/composables/useNewSession";
import { useSessionSwitch } from "@/composables/useSessionSwitch";
import { getWorkspaceRoot, openDialog, refreshEngine, listMessages } from "@/lib/electron-bridge";
import { useSettingsStore } from "@/stores/settings";
import { useSessionStore } from "@/stores/session";
import { useChatStore, FULL_HISTORY_LIMIT } from "@/stores/chat";
import { useI18n } from "vue-i18n";
import { usePanelLayout, PANEL_LAYOUT_KEY } from "@/composables/usePanelLayout";

const { t } = useI18n();
const router = useRouter();
const route = useRoute();
const settings = useSettingsStore();
const sessionStore = useSessionStore();
const chat = useChatStore();
const { handleNew } = useNewSession();
const { switchTo } = useSessionSwitch();

// 会话列表（全部会话，无模式区分）
const railSessions = computed(() => sessionStore.sessions);
const railActiveId = computed(() => sessionStore.activeSessionId);

async function onRailNewSession() {
  handleCommand("new-session");
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

// 刷新引擎：重启 serve + 重载会话列表 + 当前会话消息（右上角刷新按钮；转圈防连点）
const isRefreshing = ref(false);
async function handleRefresh() {
  if (isRefreshing.value) return;
  isRefreshing.value = true;
  // 刷新状态提示：复用目录选择提示条（ws-alert）——开始显示「正在重启引擎…」，结束后清除
  alertText.value = t("header.refreshHint");
  try {
    await refreshEngine();
    await sessionStore.loadSessions(settings.cwd || undefined);
    // 当前活跃会话消息重载（引擎重启后历史从 serve 重拉；无活跃会话跳过）
    const sid = sessionStore.activeSessionId;
    if (sid) {
      try {
        const msgs = await listMessages(sid, { limit: FULL_HISTORY_LIMIT });
        chat.setHistoryError(false);
        chat.loadFullHistory(msgs);
      } catch {
        // 重载失败（serve 未就绪）→ 置离线标记，消息区灰显占位（G3）
        chat.setHistoryError(true);
      }
    }
  } catch {
    // 刷新失败静默：serve 状态由 engine:status 事件自行上报，UI 不额外弹错
  } finally {
    isRefreshing.value = false;
    alertText.value = "";
  }
}

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

// ── 工作区（状态由 settings store 管理，SQLite 持久化）──
const cwd = computed(() => settings.cwd);

function switchToWorkspace(path: string) {
  settings.cwd = path;
  settings.addRecentWorkspace(path);
  emitChatCommand(`switch-workspace:${path}`);
  filePanelForceClose.value++;  // 切工作区时收起文件面板
  panelFile.value = null;       // 关闭编辑器面板
  // 会话跟随工作区（OC session 绑定 project/directory）：切换后刷新会话列表
  sessionStore.loadSessions(path);
}

// ── ws-pill 工作区管理下拉（最近工作区 + 选择目录）──
const showWsMenu = ref(false);
// 目录选择提示条（对话框不置前/失败时的可见反馈，3s 自动消失）
const alertText = ref("");
watch(alertText, (v) => {
  if (v) setTimeout(() => { alertText.value = ""; }, 3000);
});
async function onWsPillClick() {
  // 点击胶囊切换下拉，不再直接弹选择框——最近工作区列表是主入口
  showWsMenu.value = !showWsMenu.value;
}
function onWsPickDirectory() {
  showWsMenu.value = false;
  // 对话框默认定位到当前工作区（Windows 默认是「下载」——用户要求跟随当前工作区）
  openDialog({ directory: true, defaultPath: cwd.value || undefined }).then((picked) => {
    if (!picked) return;
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (path) switchToWorkspace(path);
  }).catch(() => {
    // invoke reject：提示用户（异常不应无声）
    alertText.value = "打开目录选择器失败，请重试";
  });
}
function onWsPickRecent(path: string) {
  showWsMenu.value = false;
  switchToWorkspace(path);
}
function onBodyClickForWs(e: MouseEvent) {
  // 点击菜单外部区域时收起工作区下拉（ws-pill-wrap 内点击不收起）
  if (!(e.target as HTMLElement).closest(".ws-pill-wrap, .ws-menu")) showWsMenu.value = false;
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

    // ── 🔌 工具 ──
    case "open-explorer": openFilePanelTo(cwd.value || "."); break;
    case "slash-compact":
    case "slash-clear":
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

// ── Onboarding 首屏引导：初始化完成后若仍无 API Key 且未跳过/完成过，则全屏展示引导 ──
const showOnboarding = computed(() => !settings.apiKey && !settings.onboardingDismissed);
function dismissOnboarding() { settings.markOnboardingDismissed(); }

onMounted(async () => {
  // 并行初始化所有持久化数据：会话列表 + settings + 工作区
  try {
    await Promise.all([
      // cwd 已持久化时按工作区加载会话（会话跟随工作区）；无 cwd 时全量
      sessionStore.loadSessions(settings.cwd || undefined),
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
    panelLayout.setupObserver(); // ResizeObserver 监听容器宽度变化，自动 clamp 右侧面板
  }
});

onUnmounted(() => {
  document.removeEventListener("keydown", onGlobalKeydown);
});

function isActive(path: string): boolean {
  return route.path === path;
}

async function openFilePanelTo(_path: string) {
  // path 参数保留兼容旧调用方，实际导航由 FilePanel 的 navPath prop (= cwd) 控制
  fileNavCounter.value++;
}
</script>

<template>
  <!-- 启动画面：数据加载完成前显示 -->
  <div v-if="initializing" class="h-screen flex flex-col items-center justify-center gap-4" style="background:var(--bg-root)">
    <img src="/logo.svg" alt="分形" class="w-24 h-24" />
    <span class="text-xs animate-pulse" style="color:var(--text-muted)">{{ $t('chat.loading') }}</span>
  </div>

  <!-- Onboarding 首屏引导：无 API Key 且未跳过时替代主界面 -->
  <Onboarding v-else-if="showOnboarding" @finish="dismissOnboarding" @skip="dismissOnboarding" />

  <div v-else class="sb-shell">
    <!-- Navbar（原型 app-bar：52px 半透明毛玻璃） -->
    <header class="sb-header">
      <!-- app-bar-left：brand + ws-pill -->
      <div class="header-logo-group">
        <div class="brand">
          <div class="brand-mark">
            <img src="/logo.svg" alt="分形" class="brand-mark-img" />
          </div>
          <span class="brand-name">{{ $t('app.title') }}</span>
        </div>

        <!-- 工作区胶囊：点击展开管理下拉（最近工作区 + 选择目录） -->
        <div class="ws-wrap" style="position:relative">
          <!-- ws-pill：本体点击 = 直接弹目录选择（原型行为，对话框链路已实测可用）；小箭头 = 打开最近工作区菜单 -->
          <div class="ws-pill-wrap">
            <button class="ws-pill" :title="$t('header.cwdTitle')" @click="onWsPickDirectory">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="ws-pill-folder">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              <span class="ws-pill-path">{{ cwd || $t('header.selectWorkspace') }}</span>
            </button>
            <button class="ws-pill-arrow" :title="$t('header.recentWorkspaces')" @click="onWsPillClick">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
          </div>
          <!-- 工作区管理下拉：仅最近工作区（选择目录走胶囊本体点击） -->
          <div v-if="showWsMenu" class="ws-menu">
            <div class="ws-menu-head">{{ $t('header.recentWorkspaces') }}</div>
            <template v-if="settings.recentWorkspaces.length">
              <button v-for="p in settings.recentWorkspaces" :key="p" class="ws-menu-item" :class="{ 'ws-menu-item-active': p === cwd }" @click="onWsPickRecent(p)">
                <span class="ws-menu-item-path">{{ p }}</span>
              </button>
            </template>
            <div v-else class="ws-menu-empty">{{ $t('header.noRecentWorkspaces') }}</div>
          </div>
        </div>
      </div>

      <!-- app-bar-right：4 个 icon-btn -->
      <div class="app-bar-right">
        <!-- 新会话 -->
        <button
          @click="handleCommand('new-session')"
          class="icon-btn"
          :title="$t('header.newSession')"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>

        <!-- 主题切换 -->
        <button
          @click="settings.theme = settings.theme === 'dark' ? 'light' : 'dark'"
          class="icon-btn"
          :title="settings.theme === 'dark' ? $t('header.lightMode') : $t('header.darkMode')"
        >
          <!-- 暗色 → 显示太阳（点按切亮色）；亮色 → 显示月亮 -->
          <svg v-if="settings.theme === 'dark'" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="4.5" />
            <line x1="12" y1="2" x2="12" y2="4" />
            <line x1="12" y1="20" x2="12" y2="22" />
            <line x1="4.9" y1="4.9" x2="6.3" y2="6.3" />
            <line x1="17.7" y1="17.7" x2="19.1" y2="19.1" />
            <line x1="2" y1="12" x2="4" y2="12" />
            <line x1="20" y1="12" x2="22" y2="12" />
            <line x1="4.9" y1="19.1" x2="6.3" y2="17.7" />
            <line x1="17.7" y1="6.3" x2="19.1" y2="4.9" />
          </svg>
          <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
        </button>

        <!-- 刷新引擎（重启 serve，配置/预置变更生效） -->
        <button
          @click="handleRefresh"
          class="icon-btn"
          :title="$t('header.refresh')"
          :disabled="isRefreshing"
        >
          <svg :class="{ 'icon-btn--spin': isRefreshing }" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <polyline points="21 3 21 9 15 9" />
          </svg>
        </button>

        <!-- 管理面板（Agent/技能/MCP/插件/权限/记忆） -->
        <button
          @click="showManagePanel = true"
          class="icon-btn"
          :title="$t('manage.title')"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
          </svg>
        </button>

        <!-- 设置（当前页为设置时高亮） -->
        <button
          @click="router.push(isActive('/settings') ? '/chat' : '/settings')"
          class="icon-btn"
          :style="{
            background: isActive('/settings') ? 'var(--accent-glow)' : 'transparent',
            color: isActive('/settings') ? 'var(--accent)' : 'var(--text-secondary)'
          }"
          :class="isActive('/settings') ? '' : 'icon-btn--hover'"
          :title="$t('header.settings')"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
      </div>
    </header>

    <!-- 目录选择提示条（对话框未置前/失败时可见反馈） -->
    <div v-if="alertText" class="ws-alert">{{ alertText }}</div>

    <!-- Body -->
    <div ref="sbBodyRef" class="sb-body">
      <!-- 会话侧栏：可折叠（展开列表 232px / 收起 rail 56px 双态） -->
      <aside class="sb-sidebar" :class="{ 'sb-sidebar--collapsed': !drawerOpen }">
        <!-- 展开态：会话列表（搜索 + 列表 + 底部） -->
        <div v-if="drawerOpen" class="sb-expanded">
          <SessionSidebar @navigate="drawerOpen = false" @collapse="drawerOpen = false" />
        </div>

        <!-- 折叠态：rail 圆点导航（展开 → 新建 → 会话圆点，tip 悬停显示标题） -->
        <nav v-else class="sidebar-rail">
          <button
            @click="drawerOpen = true"
            class="rail-expand-btn"
            :title="$t('header.toggleSidebar')"
          >»</button>

          <div class="rail-sep" />

          <button
            @click="onRailNewSession"
            class="rail-new-btn"
            :title="$t('session.new')"
          >＋</button>

          <div class="rail-sep" />

          <div class="rail-dots">
            <button
              v-for="s in railSessions"
              :key="s.id"
              class="rail-dot"
              :class="{ active: s.id === railActiveId }"
              @click="switchTo(s.id)"
            >
              {{ sessionChar(s.title) }}
              <!-- 悬停 tip：显示完整标题 -->
              <span class="tip">{{ s.title }}</span>
              <!-- 活动状态角标（处理中/未读/阻塞） -->
              <span
                v-if="sessionStore.sessionActivity[s.id]"
                class="rail-activity"
                :class="'dot-' + sessionStore.sessionActivity[s.id]"
              />
            </button>
          </div>
        </nav>
      </aside>

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

/* ── Header（原型 app-bar：52px 半透明 + 毛玻璃）── */
.sb-header {
  display: flex;
  align-items: center;
  height: 52px;
  padding: 0 20px;
  flex-shrink: 0;
  user-select: none;
  background: color-mix(in srgb, var(--bg-surface) 80%, transparent);
  border-bottom: 1px solid var(--border-dim);
  backdrop-filter: blur(12px);
}

/* ── Body ── */
.sb-body {
  flex: 1;
  display: flex;
  overflow: hidden;
}

/* ── 顶栏左区（原型 app-bar-left）：brand + ws-pill ── */
.header-logo-group {
  display: flex;
  align-items: center;
  gap: 16px;
  flex: 1;
  min-width: 0;
}

/* brand：28px 圆角方块徽标 + 品牌名（原型 .brand / .brand-mark / .brand-name） */
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
.brand-mark {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: var(--accent-soft);
  display: flex;
  align-items: center;
  justify-content: center;
  /* position: relative 兜底——img 尺寸异常时防止撑破 28px 方块 */
  overflow: hidden;
}
.brand-mark-img {
  width: 16px;
  height: 16px;
}
.brand-name {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--text-hi);
}

/* ws-pill-wrap：本体（选目录）+ 小箭头（最近工作区菜单）组合 */
.ws-pill-wrap {
  display: flex;
  align-items: center;
  gap: 2px;
  background: var(--bg-card);
  border: 1px solid var(--border-dim);
  border-radius: 999px;
  padding: 3px 4px 3px 3px;
  max-width: 340px;
  min-width: 0;
  transition: border-color 0.2s, background 0.2s;
}
.ws-pill-wrap:hover {
  border-color: var(--border-strong);
  background: var(--bg-hover);
}
/* ws-pill：工作区胶囊（点击选择目录），路径 mono 截断 */
.ws-pill {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px 4px 10px;
  border-radius: 999px;
  border: none;
  background: transparent;
  font-size: 12px;
  color: var(--text-secondary);
  max-width: 300px;
  min-width: 0;
  transition: color 0.2s;
}
.ws-pill:hover {
  color: var(--text-bright);
}
/* 小箭头按钮：打开最近工作区菜单 */
.ws-pill-arrow {
  width: 22px;
  height: 22px;
  border-radius: 999px;
  border: none;
  background: transparent;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  flex-shrink: 0;
  transition: background 0.18s, color 0.18s;
}
.ws-pill-arrow:hover {
  background: var(--bg-hover);
  color: var(--text-bright);
}
.ws-pill-folder {
  color: var(--text-muted);
  flex-shrink: 0;
}
.ws-pill-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 11.5px;
}

/* ── 顶栏右区（原型 app-bar-right）：icon-btn 32px 圆角 8px ── */
.app-bar-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.icon-btn {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  transition: all 0.18s;
}
.icon-btn--hover:hover {
  background: var(--bg-hover);
}

/* 刷新按钮转圈动画（点击期间） */
.icon-btn--spin {
  animation: icon-btn-spin 0.9s linear infinite;
}
@keyframes icon-btn-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* 目录选择提示条：吸顶显示，accent 底白字，3s 自动消失 */
.ws-alert {
  position: fixed;
  top: 60px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 300;
  background: var(--accent);
  color: #fff;
  font-size: 12.5px;
  padding: 7px 16px;
  border-radius: 9px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
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

/* ── 会话侧栏：自身折叠（展开列表 232px / 收起 rail 56px，原型 .sidebar）── */
.sb-sidebar {
  width: 232px;
  flex-shrink: 0;
  border-right: 1px solid var(--border-dim);
  background: var(--bg-soft);
  display: flex;
  flex-direction: column;
  min-height: 0;
  /* 折叠动画：宽度 0.22s 平滑过渡（原型 cubic-bezier） */
  transition: width 0.22s cubic-bezier(0.4, 0, 0.2, 1);
  overflow: hidden;
}
.sb-sidebar--collapsed {
  width: 56px;
}

/* 展开内容区（会话列表占满，SessionSidebar 自适应） */
.sb-expanded {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}

/* ── 收起态 rail（原型 sidebar-rail：展开 → 新建 → 会话圆点）── */
.sidebar-rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 12px 0 14px;
  gap: 6px;
  height: 100%;
}
.rail-expand-btn {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  font-size: 13px;
  transition: all 0.15s;
}
.rail-expand-btn:hover {
  background: var(--bg-hover);
  color: var(--text-bright);
}
.rail-sep {
  width: 22px;
  height: 1px;
  background: var(--border-dim);
  flex-shrink: 0;
  margin: 2px 0;
}
/* 新建按钮：品牌色描边 + 浅底（原型 rail-new-btn，hover 实底） */
.rail-new-btn {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--accent);
  font-size: 15px;
  border: 1px solid var(--accent-line);
  background: var(--accent-soft);
  flex-shrink: 0;
  transition: all 0.15s;
}
.rail-new-btn:hover {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}
.rail-dots {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  overflow-y: auto;
  width: 100%;
  padding: 4px 0;
}
/* 会话圆点：首字符按钮，active 高亮（原型 rail-dot） */
.rail-dot {
  position: relative;
  width: 34px;
  height: 34px;
  border-radius: 11px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-low);
  cursor: pointer;
  transition: all 0.18s;
  border: 1px solid transparent;
}
.rail-dot:hover {
  background: var(--bg-hover);
  color: var(--text-hi);
}
.rail-dot.active {
  background: var(--accent-soft);
  color: var(--accent);
  border-color: var(--accent-line);
}
/* tip：左外侧气泡，hover 显示完整标题（原型 .rail-dot .tip） */
.rail-dot .tip {
  position: absolute;
  left: 46px;
  padding: 4px 10px;
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  font-size: 11px;
  color: var(--text-secondary);
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  transform: translateX(-4px);
  transition: all 0.18s;
  z-index: 50;
  font-weight: 400;
  /* 兜底：标题超长时截断，避免撑出屏幕 */
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rail-dot:hover .tip {
  opacity: 1;
  transform: none;
}

/* ── Activity dot（rail 圆点角标：处理中/未读/阻塞）── */
.rail-activity {
  position: absolute;
  top: -1px;
  right: -1px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  border: 1px solid var(--bg-soft);
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
  background: rgba(52, 211, 153, 0.08);
  color: var(--accent);
}
.diff-line--del {
  background: rgba(248, 113, 113, 0.08);
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
