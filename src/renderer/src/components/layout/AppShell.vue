<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, provide, nextTick } from "vue";
import { useRouter, useRoute } from "vue-router";
import SessionSidebar from "@/components/session/SessionSidebar.vue";
import FilePanel from "@/components/files/FilePanel.vue";
import FilePreviewPanel from "@/components/shared/FilePreviewPanel.vue";
import CommandPalette from "@/components/shared/CommandPalette.vue";
import ManagePanel from "@/components/shared/ManagePanel.vue";
import ChangelogDialog from "@/components/shared/ChangelogDialog.vue";
import Onboarding from "@/components/onboarding/Onboarding.vue";
import LoadingScreen from "@/components/layout/LoadingScreen.vue";
import { emitChatCommand, useGlobalCommandBus } from "@/composables/useCommandPalette";
import { useNewSession } from "@/composables/useNewSession";
import { useSessionSwitch } from "@/composables/useSessionSwitch";
import { getWorkspaceRoot, openDialog, refreshEngine, listMessages, listSessions, openWorkspaceWindow, onInitWorkspace, revealInExplorer, getEngineStatus, registerWorkspace } from "@/lib/electron-bridge";
import { mergeWorkspaces } from "@/lib/workspace-merge";
import { useSettingsStore } from "@/stores/settings";
import { useSessionStore } from "@/stores/session";
import { useChatStore, FULL_HISTORY_LIMIT } from "@/stores/chat";
import { useI18n } from "vue-i18n";
import { usePanelLayout, PANEL_LAYOUT_KEY } from "@/composables/usePanelLayout";
import { v2Conflict } from "@/composables/useStreamProcessor";
import V2Badge from "@/components/shared/V2Badge.vue";
import ModalShell from "@/components/shared/ModalShell.vue";

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

// 折叠 rail 的悬停 tip：fixed 视口定位（top=圆点当前视口 y），逃出 rail-dots 裁剪
const hoveredRailTip = ref<{ title: string; top: number } | null>(null);
function showRailTip(title: string, e: MouseEvent) {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  hoveredRailTip.value = { title, top: Math.round(rect.top) };
}

// rail 滚动渐变：父子高度对比（scrollHeight vs clientHeight）判断是否显示不全，
// 滚动位置（scrollTop）决定上下哪个方向有遮挡内容——用户建议的方案（2026-08-08）
// 注：直接 querySelector 而非 Vue ref——实测 ref 绑定在折叠/挂载时序下偶发未就绪
const railAtTop = ref(true);
// 初始假设不在底部（启动默认在顶部，底部有内容时应显示底部渐变——若初始 true 则测量前底部渐变缺失，2026-08-08 用户指正）
const railAtBottom = ref(false);
const railScrollable = ref(false);
function updateRailScroll() {
  const dots = document.querySelector(".rail-dots") as HTMLElement | null;
  if (!dots) {
    railScrollable.value = false;
    return;
  }
  // 可滚动判定：内容总高 > 容器可视高 + 4px 容差（临界不显示，避免闪烁）
  railScrollable.value = dots.scrollHeight > dots.clientHeight + 4;
  railAtTop.value = dots.scrollTop <= 4;
  railAtBottom.value = dots.scrollTop + dots.clientHeight >= dots.scrollHeight - 4;
}
// 触发路径：挂载/延迟重查（布局时序兜底）/resize/侧栏 DOM 变化（折叠切换与会话增删）/滚动
let railObserver: MutationObserver | null = null;
// 多次重算兜底：DOM 变化瞬间 rail-dots 高度/内容可能未稳定（瞬态 0 或未挂载），
// 若只算一次可能停在错误值且后续无事件再触发（2026-08-08 实测：observer 触发后 500ms 才算稳定）
function scheduleRailUpdate() {
  requestAnimationFrame(updateRailScroll);
  setTimeout(updateRailScroll, 120);
  setTimeout(updateRailScroll, 500);
}
onMounted(() => {
  scheduleRailUpdate();
  for (const ms of [1000, 3000]) setTimeout(updateRailScroll, ms);
  // 轮询兜底（最可靠）：会话可能在 AppShell 挂载前已加载完（observer 观察时已稳定、无后续触发），
  // onMounted 时 rail-dots 高度可能未就绪——每秒重算直到 10 次覆盖所有时序（2026-08-08 实测自动路径失效）
  const railTimer = setInterval(updateRailScroll, 1000);
  setTimeout(() => clearInterval(railTimer), 10000);
  window.addEventListener("resize", updateRailScroll);
  const aside = document.querySelector(".f-sidebar");
  if (aside && typeof MutationObserver !== "undefined") {
    railObserver = new MutationObserver(scheduleRailUpdate);
    railObserver.observe(aside, { childList: true, subtree: true, attributes: true });
  }
});
onUnmounted(() => {
  window.removeEventListener("resize", updateRailScroll);
  railObserver?.disconnect();
});

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

// V2 API 状态弹窗（badge 点击打开）：纯展示 v2 server 说明/当前状态/建议动作——
// 不内置「重新检测」按钮（顶栏刷新按钮已提供 engine:refresh 重启重判，避免重复）
const v2DialogOpen = ref(false);

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
  unDismissWorkspace(path); // 用户明确使用 → 恢复显示（清除手动移除标记）
  emitChatCommand(`switch-workspace:${path}`);
  filePanelForceClose.value++;  // 切工作区时收起文件面板
  panelFile.value = null;       // 关闭编辑器面板
  // 会话跟随工作区（OC session 绑定 project/directory）：切换后刷新会话列表
  sessionStore.loadSessions(path);
}

// ── ws-pill 工作区管理下拉（最近工作区 + 选择目录）──
const showWsMenu = ref(false);

// ── serve 会话目录聚合（补充本地 recent：userData 迁移/清缓存后本地历史丢失仍可从引擎恢复工作区列表）──
const serveDirs = ref<string[]>([]);

/** 用户手动移除过的工作区（localStorage 持久化）：serve 里有会话时删除本地 recent 后仍会聚合显示，
 *  用户期望「移除即消失」——用排除集合过滤聚合结果；重新打开/使用该目录时清除标记恢复显示 */
const dismissedWorkspaces = ref<string[]>([]);
try {
  const raw = localStorage.getItem("sb-dismissed-workspaces");
  if (raw) dismissedWorkspaces.value = JSON.parse(raw);
} catch { dismissedWorkspaces.value = []; }
function persistDismissed() {
  try { localStorage.setItem("sb-dismissed-workspaces", JSON.stringify(dismissedWorkspaces.value)); } catch {}
}
function unDismissWorkspace(path: string) {
  const next = dismissedWorkspaces.value.filter((p) => p !== path);
  if (next.length !== dismissedWorkspaces.value.length) {
    dismissedWorkspaces.value = next;
    persistDismissed();
  }
}

/** 从 serve 全量会话聚合出去重工作区目录；serve 未就绪时静默（菜单仍显示本地 recent） */
async function loadServeWorkspaces() {
  try {
    const sessions = await listSessions();
    // OC session 的 directory 经主进程 toSessionData 映射为前端 cwd 字段；trim 后过滤空值（未绑定工作区/null）
    serveDirs.value = [...new Set(sessions.map((s) => s.cwd.trim()).filter(Boolean))];
  } catch {
    // serve 未就绪 → 保持现有 serveDirs（首次为空），菜单降级为纯本地 recent
  }
}

/** 工作区菜单合并列表：本地 recent 优先（原序），serve 会话目录补充（去重保序），用户手动移除的过滤掉 */
const mergedWorkspaces = computed(() =>
  mergeWorkspaces(settings.recentWorkspaces, serveDirs.value).filter((p) => !dismissedWorkspaces.value.includes(p))
);

// 目录选择提示条（对话框不置前/失败时的可见反馈，3s 自动消失）
const alertText = ref("");
watch(alertText, (v) => {
  if (v) setTimeout(() => { alertText.value = ""; }, 3000);
});
// 时序竞态补偿（2026-08-10）：冲突检测广播可能晚于进入主界面（实测 1.8s）——载入时检查必然错过，
// 监听 v2Conflict 变化补触发；sessionStorage 标记保证一次会话只提示一次。
// 注册在顶层而非载入链 finally：mount 同步执行，immediate 触发时序确定（测试稳定）；广播到达也触发
watch(
  v2Conflict,
  (v) => {
    if (v && !sessionStorage.getItem('sb-v2-hint-shown')) {
      sessionStorage.setItem('sb-v2-hint-shown', '1');
      alertText.value = t('v2.v2HintBar');
    }
  },
  { immediate: true }
);
async function onWsPillClick() {
  // 点击胶囊切换下拉，不再直接弹选择框——最近工作区列表是主入口
  showWsMenu.value = !showWsMenu.value;
  // 打开时刷新 serve 会话目录聚合（serve 未就绪静默降级，不阻塞菜单展示）
  if (showWsMenu.value) await loadServeWorkspaces();
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
  if (path === cwd.value) {
    // 点击当前工作区项：无切换动作，给可见反馈避免「点了没反应」
    alertText.value = "已在该工作区";
    return;
  }
  // 交互模式变更（用户需求）：非当前工作区项 → 新开窗口并切到目标工作区，不再当前窗口内切换。
  // 主进程 createWindow(path) 创建新窗口，did-finish-load 后下发 init-workspace → 新窗口切 cwd + 按工作区加载会话。
  unDismissWorkspace(path); // 用户明确使用该工作区（新开窗口）→ 恢复显示
  openWorkspaceWindow(path).then(() => {
    // 新窗口已创建：可见反馈（取目录名展示，路径分隔符兼容 Windows/Linux）
    alertText.value = `已在新窗口打开 ${path.split(/[\\/]/).pop()}`;
  }).catch(() => {
    // invoke reject：提示用户（异常不应无声）
    alertText.value = "打开新窗口失败，请重试";
  });
}
function onWsRemoveRecent(path: string) {
  // 工作区管理：移除记录 + 排除集合（serve 会话聚合仍会显示该目录，用户期望「移除即消失」——
  // dismissed 过滤聚合结果；重新打开/使用该目录时 unDismiss 恢复）
  settings.removeRecentWorkspace(path);
  if (!dismissedWorkspaces.value.includes(path)) {
    dismissedWorkspaces.value.push(path);
    persistDismissed();
  }
  alertText.value = `已从最近使用移除 ${path.split(/[\\/]/).pop()}`;
}
function onWsReveal(path: string) {
  // 工作区管理：在资源管理器中打开该目录（fs:revealInExplorer）
  revealInExplorer(path).catch(() => {});
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

// ── 引擎就绪门禁（2026-08-09 串行初始化重构）──
// 启动链路：serve 刚启动 1s 未稳时立即发引擎请求会 ECONNRESET 并把 serve 打崩（win:2 实测），
// 因此 loadSessions 等引擎请求必须等 running 确认后才发出。
// 实现：首查 + 500ms 轮询 getEngineStatus（主进程本地状态，不碰 serve 端口，安全）+ engine:status
// 事件监听，任一先到 running 即返回 true；15s 超时返回 false（不抛错）——转圈最久 15s，超时降级进主界面。
const ENGINE_READY_TIMEOUT_MS = 15_000;
const ENGINE_POLL_INTERVAL_MS = 500;
/** 引擎等待超时标记：转圈界面显示「引擎未就绪」提示（超时降级路径），并短暂停留让用户看到 */
const engineReadyTimedOut = ref(false);
// 启动画面数据（LoadingScreen 赛博载入页）：阶段/进度/日志行由下方串行链逐步推进
const bootStage = ref<'local' | 'engine' | 'sessions' | 'done' | 'timeout'>('local');
const bootPercent = ref(0);
const bootLogs = ref<Array<{ text: string; decor?: boolean }>>([]);
function pushBootLog(text: string, decor = false) {
  // 终端区固定高度（150px ≈ 7 行）：超出丢弃最早行，保持滚动错觉
  if (bootLogs.value.length >= 7) bootLogs.value.shift();
  bootLogs.value.push({ text, decor });
}

function waitEngineReady(): Promise<boolean> {
  return new Promise((resolve) => {
    // 已有 serving=true 状态（engine:status 早于本组件挂载）直接放行，不再重复等待
    if (sessionStore.serving) { resolve(true); return; }
    let settled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let unlistenStatus: (() => void) | null = null;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
      unlistenStatus?.();
      unlistenStatus = null;
      resolve(ok);
    };
    // 事件监听：serve 就绪会广播 engine:status（useStreamProcessor 也监听同一事件，二者互补不冲突）。
    // 测试环境无 window.electronBridge → 跳过事件路径，走纯轮询
    const bridge = (window as { electronBridge?: { on?: (ch: string, cb: (p: unknown) => void) => () => void } }).electronBridge;
    if (bridge?.on) {
      unlistenStatus = bridge.on("engine:status", (payload) => {
        const info = payload as { running?: boolean };
        if (info?.running) done(true);
      });
    }
    // 首查立即执行：主进程本地状态在窗口加载后通常已稳定，比等第一个轮询 tick 更快放行
    getEngineStatus()
      .then((info) => { if (info?.running) done(true); })
      .catch(() => { /* 主进程暂不可达（窗口极早期）：转入轮询等待 */ });
    // 轮询兜底：serve 未就绪期间继续探测（不碰 serve 端口，安全）
    pollTimer = setInterval(async () => {
      try {
        const info = await getEngineStatus();
        if (info?.running) done(true);
      } catch {
        // 主进程暂不可达——继续下一轮，不在此处终止
      }
    }, ENGINE_POLL_INTERVAL_MS);
    // 超时兜底：15s 未就绪返回 false（不抛错），降级进主界面（引擎离线态：列表空 + 离线占位）
    timeoutTimer = setTimeout(() => {
      engineReadyTimedOut.value = true;
      done(false);
    }, ENGINE_READY_TIMEOUT_MS);
  });
}

// 新窗口工作区下发监听（多窗口支持）：注销函数存模块作用域，onUnmounted 时清理。
// AppShell 是单例根组件，onMounted 仅执行一次——不会重复注册
let stopInitWorkspace: (() => void) | null = null;

// ── Onboarding 首屏引导：初始化完成后若仍无 API Key 且未跳过/完成过，则全屏展示引导 ──
const showOnboarding = computed(() => !settings.apiKey && !settings.onboardingDismissed);
function dismissOnboarding() { settings.markOnboardingDismissed(); }

onMounted(async () => {
  // 新窗口初始化链路（多窗口支持）：主进程 createWindow(workspace) 把目标工作区放 URL query
  // （location.search 读取——零时序依赖），IPC window:init-workspace 作为兜底（e2e/兼容路径）。
  // 先切 cwd 再并行初始化，保证 loadSessions 用目标工作区而非旧值
  const wsFromUrl = new URLSearchParams(window.location.search).get('workspace')
  console.log('[ws-init] URL workspace =', wsFromUrl, '| 当前 cwd =', settings.cwd)
  if (wsFromUrl && wsFromUrl !== settings.cwd) {
    settings.windowInitCwd = wsFromUrl;
    settings.cwd = wsFromUrl;
    unDismissWorkspace(wsFromUrl);
  }
  stopInitWorkspace = onInitWorkspace((path) => {
    // 先写竞态标记再切 cwd：initFromDb 的异步 cwd 恢复可能晚于本回调，标记让恢复逻辑以下发值为准
    settings.windowInitCwd = path;
    settings.cwd = path;
    unDismissWorkspace(path); // 新窗口明确切到该工作区 → 恢复显示（若之前被手动移除）
    sessionStore.loadSessions(path);
  });
  // 串行初始化链（2026-08-09 重构）：本地初始化 → 引擎就绪门禁 → 会话列表 → 解除门禁。
  // 严禁在引擎就绪前发引擎请求：实测 serve 启动 1s 内并发请求 → ECONNRESET → serve 崩溃（win:2）。
  try {
    // ① 本地初始化（SQLite/配置，快，不碰 serve）
    bootStage.value = 'local'; bootPercent.value = 12; pushBootLog(t('boot.local'));
    await settings.initFromDb();
    // ② 无 cwd 时兜底取工作区根（本地磁盘，不碰 serve）
    if (!settings.cwd) {
      try { settings.cwd = await getWorkspaceRoot(); } catch {}
    }
    // 上报当前窗口工作区（窗口去重需要）：主窗口创建时未登记 winWorkspaces，不报则切回初始
    // 工作区会新开窗口（2026-08-09 用户实测）；URL 窗口的 cwd 已在 L460 切换，此处统一覆盖
    try { await registerWorkspace(settings.cwd || ''); } catch { /* 主进程暂不可达：去重降级为开新窗口 */ }
    bootPercent.value = 30; pushBootLog(t('boot.localOk'));
    // ③ 引擎就绪门禁：getEngineStatus 首查 + 轮询 + engine:status 事件，任一先到 running 即放行
    bootStage.value = 'engine'; bootPercent.value = 45; pushBootLog(t('boot.engine'));
    const engineReady = await waitEngineReady();
    // ④ 引擎就绪才加载会话列表（串行 await）——serve 未就绪期间绝不下发 session:list
    if (engineReady) {
      bootStage.value = 'sessions'; bootPercent.value = 70; pushBootLog(t('boot.engineOk'));
      await sessionStore.loadSessions(settings.cwd || undefined);
      bootPercent.value = 92;
    } else {
      // 超时降级：引擎 15s 未就绪（崩溃/未启动），展示「引擎未就绪」提示片刻再进主界面，
      // 避免用户无感知进入离线态（转圈最久 15s + 1s 提示 + 0 列表 ≈ 16s，仍在 20s 上限内）
      bootStage.value = 'timeout'; pushBootLog(t('boot.timeout'));
      await new Promise((r) => setTimeout(r, 1_000));
    }
    // ⑤ modelVariants 补拉由 useStreamProcessor 的挂载即查 / engine:status running 分支负责，
    //    此处不重复（settings watch(model) immediate 已有兜底）
  } catch {
    // 各子步骤已有独立 catch，此处仅兜底——不会到达，但确保 initializing 必然复位
  } finally {
    bootStage.value = 'done'; bootPercent.value = 100; pushBootLog(t('boot.done'));
    // 让用户看到 100% + 淡出动画：解除前停留片刻（否则同帧切换，进度停在 92% 一闪而过，2026-08-09）
    await new Promise((r) => setTimeout(r, 400));
    // D3 载入提示条：进入主界面时 v2 冲突且本次会话未提示过 → 顶部提示一次（sessionStorage 记忆，
    // 3s 自动消失走 alertText watch；不打断首次进入——轻量提示而非弹窗）
    // （v2Conflict 变化补偿 watch 已在顶层注册——此处只处理「载入时已冲突」的即时检查）
    if (v2Conflict.value && !sessionStorage.getItem('sb-v2-hint-shown')) {
      sessionStorage.setItem('sb-v2-hint-shown', '1');
      alertText.value = t('v2.v2HintBar');
    }
    initializing.value = false;
    document.addEventListener("keydown", onGlobalKeydown);
    panelLayout.setupObserver(); // ResizeObserver 监听容器宽度变化，自动 clamp 右侧面板
  }
});

onUnmounted(() => {
  document.removeEventListener("keydown", onGlobalKeydown);
  stopInitWorkspace?.();
  stopInitWorkspace = null;
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
  <!-- 启动画面：赛博载入页（数据串行加载中）——stage/percent/logs 由 onMounted 串行链驱动 -->
  <!-- Transition boot-fade：载入完成淡出（用户反馈一闪而过很突兀，2026-08-09） -->
  <Transition name="boot-fade">
    <LoadingScreen
      v-if="initializing"
      :stage="bootStage"
      :percent="bootPercent"
      :timed-out="engineReadyTimedOut"
      :logs="bootLogs"
    />
  </Transition>

  <!-- Onboarding 首屏引导：无 API Key 且未跳过时替代主界面（独立 v-if——LoadingScreen 被 Transition 包裹后 v-else-if 无法相邻） -->
  <Onboarding v-if="!initializing && showOnboarding" @finish="dismissOnboarding" @skip="dismissOnboarding" />

  <div v-if="!initializing && !showOnboarding" class="f-shell">
    <!-- Navbar（原型 app-bar：52px 半透明毛玻璃） -->
    <header class="f-header">
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
            <template v-if="mergedWorkspaces.length">
              <div v-for="p in mergedWorkspaces" :key="p" class="ws-menu-item" :class="{ 'ws-menu-item-active': p === cwd }">
                <!-- 路径文本：点击 = 新开窗口并切到目标工作区（多窗口模式，用户需求） -->
                <button class="ws-menu-item-path" @click="onWsPickRecent(p)">{{ p }}</button>
                <!-- hover 操作区：📂 打开位置 / × 从最近使用移除（click.stop 防冒泡触发新开窗口） -->
                <span class="ws-menu-item-actions">
                  <button class="ws-menu-item-act" :title="$t('header.revealInExplorer')" @click.stop="onWsReveal(p)">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
                  </button>
                  <button class="ws-menu-item-act ws-menu-item-act-danger" :title="$t('header.removeWorkspace')" @click.stop="onWsRemoveRecent(p)">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                  </button>
                </span>
              </div>
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

        <!-- V2 API 状态胶囊（D4：主题按钮旁；冲突时 coral 色，点击弹详情） -->
        <V2Badge :conflict="v2Conflict" @open="v2DialogOpen = true" />

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
    <div ref="sbBodyRef" class="f-body">
      <!-- 会话侧栏：可折叠（展开列表 232px / 收起 rail 56px 双态） -->
      <aside class="f-sidebar" :class="{ 'f-sidebar--collapsed': !drawerOpen }">
        <!-- 展开态：会话列表（搜索 + 列表 + 底部） -->
        <div v-if="drawerOpen" class="f-expanded">
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

          <div class="rail-dots" @scroll.passive="updateRailScroll">
            <div class="rail-inner">
              <!-- 顶部渐变（内容流最前，sticky top 粘住可视区顶部；淡入淡出——用户反馈①） -->
              <Transition name="rail-fade">
                <div v-if="railScrollable && !railAtTop" class="rail-fade rail-fade--top" />
              </Transition>
              <button
                v-for="s in railSessions"
                :key="s.id"
                class="rail-dot"
                :class="{ active: s.id === railActiveId }"
                @click="switchTo(s.id)"
                @mouseenter="showRailTip(s.title, $event)"
                @mouseleave="hoveredRailTip = null"
              >
                {{ sessionChar(s.title) }}
                <!-- 活动状态角标（处理中/未读/阻塞） -->
                <span
                  v-if="sessionStore.sessionActivity[s.id]"
                  class="rail-activity"
                  :class="'dot-' + sessionStore.sessionActivity[s.id]"
                />
              </button>
              <!-- 底部渐变（内容流末尾，sticky bottom 粘住可视区底部；淡入淡出——用户反馈①） -->
              <Transition name="rail-fade">
                <div v-if="railScrollable && !railAtBottom" class="rail-fade rail-fade--bottom" />
              </Transition>
            </div>
          </div>
        </nav>
      </aside>

      <!-- 悬停 tip（fixed 视口定位，逃出 rail-dots 的 overflow 裁剪——绝对定位子元素会撑出 x 滚动条，2026-08-08 实测 77 会话 rail 出现 xy 双滚动条） -->
      <div v-if="hoveredRailTip" class="rail-tip" :style="{ top: hoveredRailTip.top + 'px' }">{{ hoveredRailTip.title }}</div>

      <!-- Main -->
      <main class="f-main">
        <div class="f-main-content">
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

    <!-- V2 API 状态弹窗（badge 点击打开；ModalShell 自带关闭） -->
    <ModalShell :open="v2DialogOpen" size="md" position="center" @close="v2DialogOpen = false">
      <template #header>{{ t('v2.v2DialogTitle') }}</template>
      <div class="v2-dialog">
        <p class="v2-dialog-section">{{ t('v2.v2What') }}</p>
        <div class="v2-dialog-section">
          <!-- 当前状态：可用（accent 绿）/ 不可用（coral 红 + 原因） -->
          <div v-if="!v2Conflict" class="v2-dialog-status v2-dialog-status--ok">
            <span class="v2-dialog-dot" />{{ t('v2.v2StatusOk') }}
          </div>
          <template v-else>
            <div class="v2-dialog-status v2-dialog-status--conflict">
              <span class="v2-dialog-dot" />{{ t('v2.v2StatusConflict') }}
            </div>
            <p class="v2-dialog-reason">{{ t('v2.v2StatusReason') }}</p>
          </template>
        </div>
        <!-- 仅不可用时：建议动作（重新检测走顶栏刷新按钮，弹窗不重复提供） -->
        <div v-if="v2Conflict" class="v2-dialog-section v2-dialog-actions">
          {{ t('v2.v2Action') }}
        </div>
      </div>
    </ModalShell>
  </div>
</template>

<style scoped>
/* ── Shell ── */
.f-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg-root);
}

/* ── Header（原型 app-bar：52px 半透明 + 毛玻璃）── */
.f-header {
  display: flex;
  align-items: center;
  height: 52px;
  padding: 0 20px;
  flex-shrink: 0;
  user-select: none;
  background: color-mix(in srgb, var(--bg-surface) 80%, transparent);
  border-bottom: 1px solid var(--border-dim);
  backdrop-filter: blur(12px);
  /* 层叠提升：backdrop-filter 创建层叠上下文（z-index auto）→ 内部 absolute 菜单（.ws-menu z-index 60）
     被困在 header 上下文内，与 main 的 static 内容比较时按 DOM 顺序被欢迎容器覆盖（菜单点不中）。
     position:relative + z-index 把 header 整体提到内容之上，保证工作区菜单可点击（2026-08-08 实测拦截） */
  position: relative;
  z-index: 70;
}

/* ── Body ── */
.f-body {
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

/* ── V2 API 状态弹窗（ModalShell body 内容）── */
.v2-dialog {
  display: flex;
  flex-direction: column;
  gap: 14px;
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.7;
}
.v2-dialog-section {
  margin: 0;
}
.v2-dialog-status {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}
.v2-dialog-status--ok {
  color: var(--accent);
}
.v2-dialog-status--conflict {
  color: var(--coral);
}
.v2-dialog-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
}
.v2-dialog-reason {
  margin: 4px 0 0;
  font-size: 12.5px;
  color: var(--text-muted);
}
.v2-dialog-actions {
  /* 建议动作区：顶部分隔线与正文区分；无按钮（重新检测复用顶栏刷新） */
  border-top: 1px solid var(--border);
  padding-top: 12px;
  font-size: 12.5px;
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

.f-main {
  flex: 1;
  display: flex;
  overflow: hidden;
  min-width: 300px;  /* 保护聊天区不被右侧面板挤扁 */
}

.f-main-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ── 会话侧栏：自身折叠（展开列表 232px / 收起 rail 56px，原型 .sidebar）── */
.f-sidebar {
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
.f-sidebar--collapsed {
  width: 56px;
}

/* 展开内容区（会话列表占满，SessionSidebar 自适应） */
.f-expanded {
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
  overflow-y: auto;
  /* x 滚动条消除：overflow-y:auto 会让 overflow-x 计算为 auto（绝对定位子元素撑出 scrollWidth 时出现横条） */
  overflow-x: hidden;
  /* 滚动条视觉全隐藏（XY 均不显示），保留 overflow-y:auto 的滚轮/键盘滚动能力——56px 窄条不该有滚动条占位（2026-08-08 用户要求） */
  scrollbar-width: none;
  -ms-overflow-style: none;
  /* 不强制 width:100%：flex 列 + align-items:center 下自动按内容收缩（34px 圆点），
     避免滚动条占位参与宽度计算导致窄条挤压/横向溢出（用户复现 X 滚动条，2026-08-08） */
  width: auto;
  max-width: 100%;
  min-width: 0;
}
.rail-dots::-webkit-scrollbar {
  display: none;
}
/* 滚动渐变提示：position:sticky 在滚动容器内粘住可视区边缘（absolute 的包含块=滚动内容会随滚动，
   套 box/height:100% 均无效——sticky 是标准解法，2026-08-08 三方案实测）；
   pointer-events:none 不挡滚轮/点击 */
.rail-inner {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
}
.rail-fade {
  position: sticky;
  left: 0;
  right: 0;
  width: 100%;
  height: 30px;
  flex-shrink: 0;
  pointer-events: none;
  z-index: 2;
}
.rail-fade--bottom {
  bottom: 0;
  background: linear-gradient(to bottom, transparent, color-mix(in srgb, var(--accent) 30%, transparent));
}
.rail-fade--top {
  top: 0;
  background: linear-gradient(to bottom, color-mix(in srgb, var(--accent) 30%, transparent), transparent);
}
/* rail 渐变淡入淡出（300ms——用户反馈①） */
.rail-fade-enter-active, .rail-fade-leave-active { transition: opacity 300ms ease; }
.rail-fade-enter-from, .rail-fade-leave-to { opacity: 0; }
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
/* 悬停 tip（AppShell 根层 fixed 渲染：rail 56px + 16px 间距；超长标题截断） */
.rail-tip {
  position: fixed;
  left: 72px;
  padding: 4px 10px;
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  font-size: 11px;
  color: var(--text-secondary);
  white-space: nowrap;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
  z-index: 60;
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
