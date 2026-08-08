<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted, onUnmounted, inject } from "vue";
import {
  useChatStore,
  FULL_HISTORY_LIMIT,
  buildSubTaskMap,
  SUBTASK_SUMMARY_MAX,
  type AttachedFile,
  type SubTask,
} from "@/stores/chat";
import { useSessionStore } from "@/stores/session";
import { useDebugLog } from "@/composables/useDebugLog";
import {
  sendMessage,
  respondPermission,
  questionReply,
  questionReject,
  forkSession,
  getAutoModeStatus,
  stopSession,
  listMessages,
  writeFile,
  loadSessionLogs,
  readServeLog,
  getAppInfo,
  openDialog,
  saveDialog,
  compactSession,
} from "@/lib/electron-bridge";
import { useFilePreview } from "@/composables/useFilePreview";
import { useSettingsStore } from "@/stores/settings";
import { translateError } from "@/lib/utils";
import ErrorBoundary from "@/components/shared/ErrorBoundary.vue";
import InputBar from "./InputBar.vue";
import MessageBubble from "./MessageBubble.vue";
import ThinkingIndicator from "./ThinkingIndicator.vue";
import ContextUsageModal from "@/components/shared/ContextUsageModal.vue";
import ManagePanel from "@/components/shared/ManagePanel.vue";
import ModalShell from "@/components/shared/ModalShell.vue";
import MarkdownRenderer from "@/components/shared/MarkdownRenderer.vue";
import ChatTimelineNav from "./ChatTimelineNav.vue";
import { useCommandPaletteBus, useChatCommandBus, emitChatCommand } from "@/composables/useCommandPalette";
import TodoPanel from "./TodoPanel.vue";
import SubTaskCard from "./SubTaskCard.vue";
import SubTaskMonitor from "./SubTaskMonitor.vue";
import SubTaskDetail from "./SubTaskDetail.vue";
import { useI18n } from "vue-i18n";
const { t } = useI18n();
import { useCommandRegistry } from "@/composables/useCommandRegistry";
import { useSlashCommands } from "@/composables/useSlashCommands";

const chat = useChatStore();
const session = useSessionStore();
const slashCommands = useSlashCommands();
const settings = useSettingsStore();
const appVersion = __APP_VERSION__;

/** 当前活跃会话（离线占位展示标题用） */
const currentSession = computed(() =>
  session.sessions.find((s) => s.id === session.activeSessionId) || null
);

const debugLog = useDebugLog();
const scrollContainer = ref<HTMLElement | null>(null);
const isNearBottom = ref(true);
const autoScroll = ref(true);
const commandBus = useCommandPaletteBus();
import { isImageFile } from "@/composables/useFilePreview";
const { getThumbnail, thumbnails } = useFilePreview();

// ── InputBar ref（供外部命令设置输入文本）──
const inputBar = ref<InstanceType<typeof InputBar> | null>(null);

// 翻译 CC 工具名（中文环境 Bash→命令行、Write→写入文件，英文保持原名）
function toolLabel(name: string): string {
  const key = `tools.${name}`;
  const translated = t(key);
  return translated !== key ? translated : name;
}

// 当前正在执行且未完成的工具名（用于 ThinkingIndicator）
const activeToolName = computed(() => {
  if (!chat.isProcessing) return undefined;
  const msg = chat.currentAssistantMsg;
  if (!msg?.toolUses.length) return undefined;
  // 最后一个 tool_use 没有 result 说明正在执行中
  const last = msg.toolUses[msg.toolUses.length - 1];
  // executionDurationMs 在下一段思考/文本开始时由 markThinkingStart 赋值
  return last.executionDurationMs === undefined ? toolLabel(last.name) : undefined;
});

// ── 诊断面板（方案 D7：调试面板 → 用户反馈通道「诊断信息」）──

// 复制文本到剪贴板（textarea 兼容法，无 navigator.clipboard 权限问题）
function copyText(text: string) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}

// 复制当前标签页内容（事件日志=会话 debug 行；引擎日志=serve.log 尾部）
function copyDebugLog() {
  const text = debugTab.value === 'events' ? debugLog.lines.value.join('\n') : serveLogLines.value.join('\n');
  copyText(text);
  showStatus(t('chat.copied'));
}

// 复制诊断信息：应用名 + 版本 + serve.log 尾部（用户反馈通道；提示隐私——日志含本地路径）
async function copyDiagnostics() {
  try {
    const [info, lines] = await Promise.all([getAppInfo(), readServeLog(500)]);
    const body = [`${info.name} v${info.version}`, '', ...lines].join('\n');
    copyText(body);
    showStatus(`${t('chat.copied')} — ${t('chat.debugPrivacyHint')}`);
  } catch (e) {
    showStatus(t('status.exportFail', { error: String(e) }));
  }
}

// ── 诊断面板标签页（事件日志 debugLog / 引擎日志 serve.log）──
const debugTab = ref<'events' | 'serve'>('events');
const serveLogLines = ref<string[]>([]);
const serveLogLoading = ref(false);
const serveLogError = ref('');
const serveLogPre = ref<HTMLElement | null>(null);

async function switchDebugTab(tab: 'events' | 'serve') {
  debugTab.value = tab;
  // 进入引擎日志页即拉取尾部 500 行（面板不自动轮询，刷新按钮重读——原型 4.3）
  if (tab === 'serve') await loadServeLog();
}

async function loadServeLog() {
  serveLogLoading.value = true;
  try {
    serveLogLines.value = await readServeLog(500);
    serveLogError.value = '';
  } catch (e) {
    // 读取失败 → 提示错误 + 保留旧内容 + 可再点刷新（原型 4.3）
    serveLogError.value = String(e);
  } finally {
    serveLogLoading.value = false;
    // 超长自动滚到底（原型 3.2：只读代码块超长自动滚动到底部）
    nextTick().then(() => {
      if (serveLogPre.value) serveLogPre.value.scrollTop = serveLogPre.value.scrollHeight;
    });
  }
}

// ── Attached files ──
const attachedFiles = ref<AttachedFile[]>([]);

function removeAttachedFile(index: number) {
  attachedFiles.value.splice(index, 1);
}

// 图片附件加入时预加载缩略图（原 f-attachment-bar 在 chip 挂载时触发，现 chips 在 InputBar 内渲染，改由 watch 驱动）
watch(attachedFiles, (files) => {
  for (const f of files) {
    if (isImageFile(f.name)) getThumbnail(f.path, f.name).catch(() => {});
  }
}, { deep: true });

// ── 选区片段卡片（DOM / Excel / 文本划选 / MD 选区 → 统一 chip）──
interface TextSnippet { content: string; label: string }
const textSnippet = ref<TextSnippet | null>(null);
function removeTextSnippet() { textSnippet.value = null; }

// ── composer chips 组装（InputBar 纯展示，事件按 id 回映射）──
interface ComposerChip {
  id: string;
  label: string;
  imageUrl?: string;
  tone: "accent" | "elevated";
  clickable?: boolean;
  removable?: boolean;
  /** 引用内容（选区片段——优化消息作背景上下文） */
  content?: string;
  /** 引用文件路径（附件——优化消息读文件作背景上下文） */
  path?: string;
}
const composerChips = computed<ComposerChip[]>(() => {
  const chips: ComposerChip[] = [];
  // 选区卡片：accent 底（accent-glow 语义，原型「选中内容自动出现在这里」）；content 供优化消息作背景上下文
  if (textSnippet.value) {
    chips.push({ id: "snippet", label: textSnippet.value.label, tone: "accent", removable: true, content: textSnippet.value.content });
  }
  // 附件 chips：elevated 底 + 缩略图 + 点击打开预览；path 供优化消息读文件作背景上下文
  for (const f of attachedFiles.value) {
    chips.push({
      id: `file:${f.path}`,
      label: f.name,
      imageUrl: thumbnails[f.path] || undefined,
      tone: "elevated",
      clickable: true,
      removable: true,
      path: f.path,
    });
  }
  return chips;
});
function handleRemoveChip(id: string) {
  // 选区卡片与附件按 id 前缀分流；附件按 path 定位移除
  if (id === "snippet") { removeTextSnippet(); return; }
  const idx = attachedFiles.value.findIndex(f => `file:${f.path}` === id);
  if (idx >= 0) removeAttachedFile(idx);
}
function handleChipClick(id: string) {
  const f = attachedFiles.value.find(af => `file:${af.path}` === id);
  if (f) openFileInPanel(f);
}

const openFileInPanel = inject<(f: { name: string; path: string }) => void>("openFileInPanel", () => {});

// ── 🧪 测试（Dev）──
const showTestPanel = ref(false);
function runTest(fn: () => void) { showTestPanel.value = false; fn(); }
function testQuestion() { chat.pendingControlRequests.splice(0); chat.pendingControlRequests.push({ subtype: "question", tool_name: "AskUserQuestion", request_id: "que_test", tool_input: {}, questions: [{ question: "选择方案？", header: "Q", multiple: false, options: [{ label: "A", description: "desc A" }, { label: "B", description: "desc B" }] }] }); }
function testApprove() { chat.pendingControlRequests.splice(0); chat.pendingControlRequests.push({ subtype: "approval", tool_name: "Bash", tool_input: { command: "echo test", description: "测试命令" } }); }
function testTodos() { chat.todos = [{ status: "completed" as const, content: "已完成", activeForm: "已完成" }, { status: "in_progress" as const, content: "进行中", activeForm: "进行中…" }, { status: "pending" as const, content: "待处理 A", activeForm: "待处理 A" }, { status: "pending" as const, content: "待处理 B", activeForm: "待处理 B" }]; }
function testStatusOk() { showStatus("✅ 文件保存成功 — report.md"); }
function testStatusWarn() { showStatus("⚠️ 连接超时，正在重试…"); }
function testStatusErr() { showStatus("❌ 导出失败：权限不足"); }

// ── 状态消息（临时横幅，不挤占消息区域）──
const statusMessage = ref("");
const showContextModal = ref(false);
const showRenameModal = ref(false);
const renameTitle = ref("");
const showExportPreview = ref(false);
const showAbout = ref(false);
const showManage = ref(false);
const manageTab = ref<string>("plugins");
const exportContent = ref("");
const exportFileName = ref("");

// ── 子任务可视化（卡片 + 监视/详情弹窗）──
/** 行内展开摘要全文的子任务 id（点已完成卡片切换；再点收起） */
const expandSubTaskId = ref<string | null>(null);
/** 正在实时监视的子任务 id（运行中卡片点击 → SubTaskMonitor） */
const monitorSubTaskId = ref<string | null>(null);
/** 查看完整详情的子任务 id（「查看会话详情」→ SubTaskDetail） */
const detailSubTaskId = ref<string | null>(null);
/** 详情弹窗 agent 名（历史场景 chat.subTasks 无记录，从卡片数据传入——标题用真实名字而非「子智能体」） */
const detailSubTaskAgent = ref<string>("");
/** 打开子任务详情（实时/历史卡片共用）：记录 subId + agent（历史场景 agent 从卡片拿） */
function openSubTaskDetail(sub: { id: string; agent?: string }) {
  detailSubTaskId.value = sub.id;
  detailSubTaskAgent.value = sub.agent || "";
}

/** 子任务卡片排序：按 startedAt 升序（保持出现顺序稳定） */
const sortedSubTasks = computed(() =>
  Object.values(chat.subTasks).sort((a, b) => a.startedAt - b.startedAt)
);

// ── 历史子任务（D1-D6）：已完成子会话在消息级可见 ──
/** 当前活跃会话的子会话列表（serve 会话列表 parentId 匹配；历史子任务归属的 children 数据源） */
const childSessions = computed(() =>
  session.childSessions.filter((s) => s.parentId === session.activeSessionId)
);

/**
 * 消息 → 历史子任务卡片映射（平铺渲染，复用 SubTaskCard）。
 * 历史条目映射为 SubTask 形状：status 恒 'done'（已完成），summary 取预拉结果（historySummaries 注入；
 * 未预拉/预拉失败为空 → SubTaskCard 展开时经 summaryLoader 兜底懒加载）。
 * 互斥过滤（D3）：只保留「不在实时 subTasks」的任务——运行中/本 app 内已见由实时 SubTaskCard 管理，
 * 避免同一子会话双卡片重复显示。
 */
const subTaskMap = computed(() => {
  const map = buildSubTaskMap(chat.messages, childSessions.value);
  const result = new Map<string, SubTask[]>();
  for (const [msgId, list] of map) {
    // 实时 subTasks 仍存在的 id（running 或本 app 已见）从历史卡片剔除
    const filtered = list.filter((s) => !chat.subTasks[s.id]);
    if (filtered.length === 0) continue;
    result.set(
      msgId,
      filtered.map((s) => ({
        id: s.id,
        agent: s.agent,
        status: "done" as const,
        startedAt: s.createdAt,
        endedAt: s.endedAt,
        deltaText: "",
        parts: [],
        // 预拉摘要注入；空 → 展开时 summaryLoader 兜底（瞬态，不写 store）
        summary: historySummaries.value[s.id] ?? "",
      }))
    );
  }
  return result;
});

// ── 历史摘要预拉（用户反馈：完成时卡片直接显示结果梗概，替代展开懒加载）──
/** 子会话摘要缓存（本地瞬态；预拉失败留空不重试——消息数据不变，防抖防重复拉取） */
const historySummaries = ref<Record<string, string>>({});
/** 已尝试预拉的子会话 id（含失败——失败不重试，避免 watch 反复触发空跑） */
const prefetchedIds = new Set<string>();
/** 预拉并发上限：serve 子会话消息随时可查，但避免切回旧会话时瞬间打爆 */
const PREFETCH_CONCURRENCY = 4;

/** 预拉调度：防抖 300ms（消息流式期间跳过中间态），只对 subTaskMap 中「已完成且不在实时」的子会话并行拉摘要 */
let prefetchTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  subTaskMap,
  () => {
    if (prefetchTimer) clearTimeout(prefetchTimer);
    prefetchTimer = setTimeout(() => {
      void prefetchHistorySummaries();
    }, 300);
  },
  { immediate: true }
);

// 切会话清空预拉缓存与失败标记：子会话归属不同会话，旧数据无意义且避免
// prefetchedIds 常驻增长（审查项；切回时数据未变会重拉一次，无害）
watch(
  () => session.activeSessionId,
  () => {
    prefetchedIds.clear();
    historySummaries.value = {};
  }
);

/**
 * 并行预拉：对未尝试过的子会话并发拉摘要（上限 PREFETCH_CONCURRENCY）。
 * 结果写入 historySummaries → subTaskMap 重算注入卡片 summary；失败留空（不重试）。
 */
async function prefetchHistorySummaries(): Promise<void> {
  // Set 去重：同一子会话 id 可能跨消息重复出现（防抖窗口内消息重排/测试构造），避免并发池重复拉取
  const pendingSet = new Set<string>();
  for (const list of subTaskMap.value.values()) {
    for (const sub of list) {
      if (!prefetchedIds.has(sub.id)) pendingSet.add(sub.id);
    }
  }
  const pending = [...pendingSet];
  if (pending.length === 0) return;
  let cursor = 0;
  // 并发池：固定 worker 数逐个取任务，任一失败不影响其他（loadSubTaskSummary 内部已 catch）
  const workers = Array.from({ length: Math.min(PREFETCH_CONCURRENCY, pending.length) }, async () => {
    while (cursor < pending.length) {
      const id = pending[cursor++];
      const text = await loadSubTaskSummary(id);
      historySummaries.value[id] = text ?? "";
      prefetchedIds.add(id);
    }
  });
  await Promise.all(workers);
}

/**
 * 历史子任务摘要拉取：子会话消息取最后一条 assistant 文本（截断 SUBTASK_SUMMARY_MAX，与实时 idle 摘要一致）。
 * 返回 undefined = 无 assistant 文本产出；异常同样返回 undefined（降级，不阻塞交互）。
 */
async function loadSubTaskSummary(subId: string): Promise<string | undefined> {
  try {
    const msgs = await listMessages(subId);
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role !== "assistant") continue;
      const text = extractAssistantText(m.content);
      if (text) return text.slice(0, SUBTASK_SUMMARY_MAX);
    }
    return undefined;
  } catch (e) {
    return undefined;
  }
}

/** 从消息原始 content 提取 assistant 文本：JSON blob（{text,...}）取 text；纯文本旧格式原样 */
function extractAssistantText(content: string): string | undefined {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object") {
      const text = (parsed as { text?: unknown }).text;
      return typeof text === "string" && text.trim() ? text : undefined;
    }
  } catch {
    // 非 JSON → 纯文本旧格式
  }
  const trimmed = content.trim();
  return trimmed || undefined;
}

function toggleExpandSubTask(id: string) {
  expandSubTaskId.value = expandSubTaskId.value === id ? null : id;
}

/** 详情弹窗「返回主会话」：切回父会话并关闭详情（父会话不存在时静默） */
function backToParentSubTask(parentId: string) {
  detailSubTaskId.value = null;
  monitorSubTaskId.value = null;
  if (session.activeSessionId !== parentId && session.sessions.some(s => s.id === parentId)) {
    session.setActiveSession(parentId);
  }
}

function prepareExport() {
  const sid = session.activeSessionId;
  if (!sid || chat.messages.length === 0) return;
  const active = session.sessions.find(s => s.id === sid);
  const title = active?.title || "Chat Export";
  exportFileName.value = `${title.replace(/[^a-zA-Z0-9一-鿿_-]/g, "_")}.md`;
  exportContent.value = chat.exportMarkdown(title);
  showExportPreview.value = true;
}

async function doExport() {
  try {
    const filePath = await saveDialog({
      defaultPath: exportFileName.value,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!filePath) return;
    await writeFile(filePath, exportContent.value);
    showExportPreview.value = false;
    showStatus(t('status.exportDone'));
  } catch (e) {
    showStatus(t('status.exportFail', { error: String(e) }));
  }
}

function confirmRename() {
  const title = renameTitle.value.trim();
  if (title && session.activeSessionId) {
    session.renameSession(session.activeSessionId, title);
    showStatus(t('status.renamed', { title }));
  }
  showRenameModal.value = false;
}
let statusTimer: ReturnType<typeof setTimeout> | null = null;
function showStatus(msg: string) {
  statusMessage.value = msg;
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { statusMessage.value = ""; }, 5000);
}

// ── Auto mode detection ──
// Primary: frontend store (instant UI feedback when user switches)
// Calibration: on mount, verify actual settings.json (catches external modifications)
const autoModeActive = ref(settings.autoMode);

// 右键菜单「添加到会话」→ CustomEvent
function onAttachFiles(e: Event) {
  const files = (e as CustomEvent).detail as { name: string; path: string }[];
  for (const f of files) {
    if (!attachedFiles.value.some(af => af.path === f.path)) {
      attachedFiles.value.push(f);
    }
  }
}

onMounted(async () => {
  try { autoModeActive.value = await getAutoModeStatus(); }
  catch { autoModeActive.value = settings.autoMode; }
  window.addEventListener("session-switched", scrollToBottomInstant);
  window.addEventListener("keydown", onTestKey);
  window.addEventListener("attach-files", onAttachFiles);
});

onUnmounted(() => {
  window.removeEventListener("session-switched", scrollToBottomInstant);
  window.removeEventListener("keydown", onTestKey);
  window.removeEventListener("attach-files", onAttachFiles);
  // 清理历史摘要预拉防抖定时器（卸载后不再触发空跑）
  if (prefetchTimer) clearTimeout(prefetchTimer);
});
function onTestKey(e: KeyboardEvent) {
  if (e.ctrlKey && e.shiftKey && e.key === "T") { e.preventDefault(); showTestPanel.value = !showTestPanel.value; }
}

// Sync on store change
watch(() => settings.autoMode, (v) => { autoModeActive.value = v; });
// 审批队列清空 → blocked 降级为 processing
watch(() => chat.pendingControlRequest, (cr) => {
  if (!cr && session.activeSessionId) {
    if (session.sessionActivity[session.activeSessionId] === 'blocked') {
      session.setSessionActivity(session.activeSessionId, 'processing');
    }
  }
});
// 会话切换时同步 debug 日志到当前会话（stderr 槽位已移除——CC 遗留机制废除，方案 D4）
watch(() => session.activeSessionId, async (sid) => {
  if (!sid) return;
  debugLog.setSession(sid);
  // 从 DB 恢复持久化的日志
  try {
    const [debugJson] = await loadSessionLogs(sid);
    if (debugJson) {
      try { debugLog.importLines(sid, JSON.parse(debugJson)); } catch {}
    }
  } catch { /* 静默，DB 加载失败不影响功能 */ }
}, { immediate: true });

// ── 命令面板聊天命令监听 ──
const { chatCommand } = useChatCommandBus();
const { register } = useCommandRegistry();

// 向命令面板注册聊天相关命令
register({ id: "continue-session", group: "session", labelKey: "command.continueSession", cliKey: "--continue", icon: "📋" });
register({ id: "rename-session", group: "session", labelKey: "command.renameSession", keys: "F2", icon: "✏️" });
register({ id: "delete-session", group: "session", labelKey: "command.deleteSession", keys: "Del", icon: "🗑️" });
register({ id: "export-session", group: "session", labelKey: "command.exportSession", descKey: "command.exportSessionDesc", icon: "📤" });
register({ id: "attach-file", group: "tools", labelKey: "command.attachFile", descKey: "command.attachFileDesc", icon: "📎" });
watch(() => chatCommand.value.ts, async (ts) => {
  if (!ts) return;
  const action = chatCommand.value.action;
  switch (action) {
    case "continue-session": {
      const others = session.sessions.filter(s => s.id !== session.activeSessionId);
      if (others.length > 0) {
        const target = others[0];
        session.setActiveSession(target.id);
        // 与 useSessionSwitch 一致的加载路径：全量拉取缓存 + DOM 分页渲染（时间线目录完整）
        listMessages(target.id, { limit: FULL_HISTORY_LIMIT }).then(msgs => {
          chat.setHistoryError(false);
          chat.loadFullHistory(msgs);
          showStatus(t('session.switchSuccess', { title: target.title }));
        }).catch(() => {
          // 加载失败（serve 未就绪）→ 置离线标记，消息区灰显占位（G3）
          chat.setHistoryError(true);
          showStatus(t('session.loadFailed'));
        });
      }
      break;
    }
    case "rename-session": {
      const active = session.sessions.find(s => s.id === session.activeSessionId);
      if (active) {
        renameTitle.value = active.title;
        showRenameModal.value = true;
      }
      break;
    }
    case "delete-session": {
      const sid = session.activeSessionId;
      const active = session.sessions.find(s => s.id === sid);
      if (active && confirm(t('session.confirmDelete', { title: active.title }))) {
        // 先终止 CC 进程，防止后台残留
        try { await stopSession(sid); } catch { /* 无进程 */ }
        await session.deleteSession(sid);
        chat.clearMessages();
        showStatus(t('status.sessionDeleted'));
      }
      break;
    }
    case "slash-clear": handleSend("/clear"); break;
    case "git-init": handleSend(t("git.initMessage")); break;
    default:
      if (action.startsWith("md-convert:")) {
        // MD → docx fallback：通过 CC /docx skill 转换
        const msg = action.slice("md-convert:".length);
        if (chat.isProcessing) {
          inputBar.value?.setText(msg);
        } else {
          handleSend(msg);
        }
      } else if (action.startsWith("attach-dom:")) {
        // 来自 FilePreview DOM 选择器 — 存为卡片，随下次消息一起发送
        const data = action.slice("attach-dom:".length);
        const lines = data.split("\n");
        // 格式：我在 `full/path` 中选中了这个元素，请修改其内容：
        const fileMatch = lines[0]?.match(/`([^`]+)`/);
        const fullPath = fileMatch?.[1] || "";
        const htmlLines = lines.slice(1).join("\n");
        textSnippet.value = {
          content: data,
          label: `[D] ${fullPath.split(/[\\/]/).pop() || fullPath} · <${htmlLines.match(/<(\w+)/)?.[1] || "element"}>`,
        };
      } else if (action.startsWith("switch-workspace:")) {
        const newPath = action.slice("switch-workspace:".length);
        // 先停止当前会话的引擎进程（避免旧 cwd 的进程继续 emit 事件到新会话）
        const sid = session.activeSessionId;
        if (sid) {
          try { await stopSession(sid); } catch { /* 无进程 */ }
        }
        chat.clearMessages();
        isNearBottom.value = true;
        autoScroll.value = true;
        // 最新会话若是空会话则复用，避免堆积"新会话"
        const sorted = [...session.sessions].sort((a, b) => b.createdAt - a.createdAt);
        const latestEmpty = sorted.find(s => s.messageCount === 0 && s.id !== session.activeSessionId);
        if (latestEmpty) {
          session.setActiveSession(latestEmpty.id);
          showStatus(t('status.workspaceSwitched', { path: newPath }));
        } else {
          try {
            await session.createSession(settings.model, newPath, undefined, settings.locale);
            showStatus(t('status.workspaceSwitched', { path: newPath }));
          } catch {
            showStatus(t('status.sessionCreateFailed'));
          }
        }
      } else if (action.startsWith("show-status:")) {
        showStatus(action.slice("show-status:".length));
      } else if (action.startsWith("excel-selection:") || action.startsWith("selection:") || action.startsWith("md-selection:")) {
        // 格式: prefix:文件名|内容
        const colonIdx = action.indexOf(":");
        const pipeIdx = action.indexOf("|");
        const fileName = action.slice(colonIdx + 1, pipeIdx);
        const content = action.slice(pipeIdx + 1);
        const suffixes: Record<string, string> = { "excel-selection": "[E]", "selection": "[T]", "md-selection": "[M]" };
        const prefix = action.slice(0, colonIdx);
        textSnippet.value = { content, label: `${fileName} · ${suffixes[prefix] || ""}` };
      } else {
        // 通用文本 → 作为普通消息发送给 CC
        handleSend(action);
      }
      break;
    case "export-session":
      if (!session.activeSessionId || chat.messages.length === 0) {
        showStatus(t('status.exportEmpty'));
      } else {
        prepareExport();
      }
      break;
    case "slash-compact":   await compactNow(); break;
    case "slash-init":      handleSend("/init"); break;
    case "manage-plugins":    manageTab.value = "plugins"; showManage.value = true; break;
    case "manage-memory":     manageTab.value = "memory"; showManage.value = true; break;
    case "manage-mcp":        manageTab.value = "mcp"; showManage.value = true; break;
    case "manage-skills":     manageTab.value = "skills"; showManage.value = true; break;
    case "manage-agents":     manageTab.value = "agents"; showManage.value = true; break;
    case "manage-hooks":      manageTab.value = "hooks"; showManage.value = true; break;
    case "manage-permissions": manageTab.value = "permissions"; showManage.value = true; break;
    case "manage-styles":     manageTab.value = "styles"; showManage.value = true; break;
    case "attach-file":
      handleAttachFile();
      break;
    case "about":
      showAbout.value = true;
      break;
  }
});

// ── Sticky question banner ──
const stickyQuestion = ref("");
const showSticky = ref(false);
const stickyTargetEl = ref<HTMLElement | null>(null);

function scrollToSticky() {
  stickyTargetEl.value?.scrollIntoView({ behavior: "smooth", block: "start" });
}

// 消息清空（新建会话 / clear）时同步隐藏置顶问题横幅
watch(() => chat.messages.length, (len) => {
  if (len === 0) {
    stickyQuestion.value = "";
    showSticky.value = false;
  }
});

// 自动滚动检测：必须立即响应，不能节流。否则在 50ms 节流窗口内，
// 新的 token 到达时 autoScroll 还没变成 false，会把用户拽回底部。
function updateAutoScroll() {
  const container = scrollContainer.value;
  if (!container) return;
  const threshold = 60;
  const distFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
  const near = distFromBottom < threshold;
  isNearBottom.value = near;
  autoScroll.value = near;
}

// 置顶问题横幅：DOM 查询开销大，节流处理
function updateStickyBanner() {
  const container = scrollContainer.value;
  if (!container) return;
  const containerRect = container.getBoundingClientRect();
  const userMsgs = container.querySelectorAll<HTMLElement>('[data-role="user"]');
  let lastAbove = "";
  for (const el of userMsgs) {
    const r = el.getBoundingClientRect();
    if (r.bottom < containerRect.top + 4) {
      lastAbove = el.querySelector('.user-text')?.textContent || "";
    }
  }
  if (lastAbove) {
    stickyQuestion.value = lastAbove.length > 100 ? lastAbove.slice(0, 100) + "…" : lastAbove;
    showSticky.value = true;
    // 记录目标元素，点击时滚动到该消息
    // 此处需遍历两次获取 el（text 和 element 分别取），O(n) 可接受
    let foundEl: HTMLElement | null = null;
    for (const el of userMsgs) {
      if ((el.querySelector('.user-text')?.textContent || "").includes(lastAbove.slice(0, 20))) {
        foundEl = el; break;
      }
    }
    stickyTargetEl.value = foundEl;
  } else {
    showSticky.value = false;
    stickyTargetEl.value = null;
  }
}

let scrollTimer: ReturnType<typeof setTimeout> | null = null;
function onScrollThrottled() {
  updateAutoScroll(); // 立即处理，防止 autoScroll 滞后
  checkLoadMore(); // 滚动到顶加载更早：不能节流（同步内存切片，无网络延迟无重入问题）
  if (scrollTimer) return;
  scrollTimer = setTimeout(() => { scrollTimer = null; updateStickyBanner(); }, 100);
}

/** 滚动到顶加载更早：距顶 < 80px 且还有更早且消息非空（同步内存切片，无需 loading 标记防重入） */
function checkLoadMore() {
  const container = scrollContainer.value;
  if (!container) return;
  if (container.scrollTop < 80 && chat.hasMoreHistory && chat.messages.length > 0) {
    loadMoreHistory();
  }
}

/** 加载更早消息（从 fullHistory 内存切片，同步无网络）——prepend 到头部并滚动补偿保持视口位置 */
function loadMoreHistory() {
  const container = scrollContainer.value;
  // 记录 prepend 前高度与滚动位置，prepend 后补偿保持视口内容不动
  const prevHeight = container ? container.scrollHeight : 0;
  const prevScrollTop = container ? container.scrollTop : 0;
  if (chat.prependFromFullHistory()) {
    // 滚动补偿：新内容高度差 = 新 scrollHeight - 旧 scrollHeight，加回原 scrollTop 即视口位置不变
    if (container) {
      nextTick().then(() => {
        container.scrollTop = (container.scrollHeight - prevHeight) + prevScrollTop;
      });
    }
  } else {
    // 已到顶（内存切片耗尽）→ 关闭「还有更早」标记，避免滚动反复触发
    chat.setHasMoreHistory(false);
  }
}

/**
 * 时间线跳转：ChatTimelineNav 点击 dot/ellipsis 时按全局锚点索引定位。
 * globalIndex 为「timeline 过滤 user 后」的锚点索引 → 先在 timelineIndex（全量含 assistant）中换算目标消息 id，
 * 目标未渲染时从 fullHistory 内存循环切片（上限 10 次防死循环），再滚动到对应 DOM 元素。
 */
async function scrollToTimelineIndex(globalIndex: number) {
  if (globalIndex < 0) return;
  // 换算：timelineIndex 中第 globalIndex 个 user 锚点（timelineIndex 是全量索引，需过滤 assistant）
  let target: { id: string; created: number; role: string } | undefined;
  let userCount = 0;
  for (const item of chat.timelineIndex) {
    if (item.role === "user") {
      if (userCount === globalIndex) { target = item; break; }
      userCount++;
    }
  }
  if (!target) return;
  const id = target.id;
  // 目标消息未渲染 → 循环 prepend 直到包含或切片耗尽（上限 10 次防死循环）
  if (!chat.messages.some(m => m.id === id)) {
    for (let i = 0; i < 10; i++) {
      if (!chat.prependFromFullHistory()) break;
      if (chat.messages.some(m => m.id === id)) break;
    }
  }
  await nextTick();
  // 滚动到目标消息 DOM 元素（MessageBubble 根节点带 data-message-id）
  const el = scrollContainer.value?.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
  el?.scrollIntoView({ block: "start" });
}

async function handleSend(text: string) {
  // 记录斜杠命令（仅用户主动发送的，非中途追加）
  if (text.startsWith("/")) slashCommands.recordCommand(text);
  const isMidProcessing = chat.isProcessing;
  // 新消息（非中途追加）才清日志和计划
  if (!isMidProcessing) {
    debugLog.clear();
  }
  let sid: string;
  sid = session.activeSessionId;
  if (!sid) {
    chat.clearMessages();  // 新建会话时清空旧消息记录
    sid = await session.createSession(settings.model, undefined, undefined, settings.locale);
  }

  // Collect attached file paths + DOM snippet before clearing
  const filePaths = attachedFiles.value.map(f => f.path);
  attachedFiles.value = [];

  // 选区片段卡片：拼到消息文本前面（显示 + 发送都包含）
  const snippetText = textSnippet.value ? `${textSnippet.value.content}\n\n` : "";
  textSnippet.value = null;
  const fullText = snippetText + text;

  const attachments = filePaths.length > 0 ? filePaths.map(p => ({ name: p.split(/[/\\]/).pop() || p, path: p })) : undefined;
  chat.addUserMessage(fullText, attachments);

  // 用户消息由 Rust 后端在 send_message 中统一保存，
  // 前端不再重复保存，避免历史回显时出现双份用户消息。

  // isMidProcessing 已在函数开头捕获
  if (!isMidProcessing) {
    chat.startAssistantMessage();
  }
  chat.isProcessing = true;
  // 发送即设绿点（不等第一条 assistant 事件）
  session.setSessionActivity(sid, 'processing');
  autoScroll.value = true;
  isNearBottom.value = true;
  await scrollToBottomInstant();
  try {
    await sendMessage(sid, fullText, {
      planMode: settings.planMode,
      autoMode: settings.autoMode,
      permissionMode: settings.permissionMode,
      // variant 思考强度：仅当前模型 variants 列表包含时才传（防残留旧档/模型无 variants 时误传）
      variant: settings.modelVariants.includes(settings.effort) ? settings.effort : undefined,
      model: settings.model,
      // 主 agent（双星/build/plan）→ 引擎 promptAsync.agent；权限选「计划」时强制 plan agent（无写权限，方案 3.5）
      agent: settings.planMode ? "plan" : settings.currentAgent,
      filePaths: filePaths.length > 0 ? filePaths : undefined,
      // 附件（P6 FilePart 链路）：与 addUserMessage 展示用的 attachments 同构，IPC 转 file part 发给引擎
      attachments,
      cwd: settings.cwd || undefined,
    });
    // 侧栏统计在 useStreamProcessor result 事件后刷新（token 已入库）
  } catch (err) {
    debugLog.add(`>>> Error: ${err}`);
    debugLog.visible.value = true;
    const { key, params } = translateError(err);
    chat.appendText(`\n\n> ❌ ${t(key, params as any)}`);
    chat.finishAssistantMessage();
  }
}

// 审批响应：OC serve 权限事件 permission.updated → control_request.request_id 即 permission id
// （events.ts 映射 request_id: p.id），respond 三选一：once（本次允许）/ always（会话记住）/ reject
async function handleAllow() {
  const cr = chat.pendingControlRequest; if (!cr) return;
  const sid = session.activeSessionId;
  if (!sid || !cr.request_id) return;
  debugLog.add(`🔐 respondPermission allow: ${cr.request_id}`);
  try { await respondPermission(sid, cr.request_id, "once"); } catch (e) { console.error("Permission allow failed:", e); }
  chat.resolveControlRequest("allow");
}
async function handleDeny() {
  const cr = chat.pendingControlRequest; if (!cr) return;
  // 先清队列关闭弹窗，再通知 serve（respondPermission 可能因无活跃会话失败，不影响关闭）
  chat.resolveControlRequest("deny");
  if (!cr.request_id) return;
  try { await respondPermission(session.activeSessionId, cr.request_id, "reject"); } catch { /* 无活跃会话时静默 */ }
}

/** 「总是允许」：respondPermission always（会话记住），仅 control_request.always 有值（serve 免审批建议）时可用 */
async function handleAlwaysAllow() {
  const cr = chat.pendingControlRequest; if (!cr) return;
  const sid = session.activeSessionId;
  if (!sid || !cr.request_id) return;
  debugLog.add(`🔐 respondPermission always: ${cr.request_id}`);
  try { await respondPermission(sid, cr.request_id, "always"); } catch (e) { console.error("Permission always-allow failed:", e); }
  chat.resolveControlRequest("always");
}

/** 审批条的「总是允许」建议文案（如「允许所有 echo *」）；无 always 建议时为空串不显示按钮 */
const alwaysAllowHint = computed(() => {
  const cr = chat.pendingControlRequest;
  if (!cr || cr.subtype !== "approval" || !cr.always?.length) return "";
  return t("chat.alwaysAllowHint", { patterns: cr.always.join("、") });
});

// ── Edit + Resend: 保留原消息不动，新消息追加到末尾 ──

/** 从消息文本中提取 DOM 片段，恢复为卡片并返回去掉片段的文本 */
function extractDomSnippet(content: string): string {
  const match = content.match(/^我在 `(.+?)` 中选中了这个元素，请修改其内容：\n```html\n([\s\S]+?)\n```\n\n/);
  if (!match) return content;
  const filePath = match[1];
  const html = match[2];
  const tagMatch = html.match(/<(\w+)/);
  textSnippet.value = {
    content: match[0].slice(0, -2), // 去掉末尾 \n\n
    label: `[D] ${filePath.split(/[\\/]/).pop() || filePath} · <${tagMatch?.[1] || "element"}>`,
  };
  return content.slice(match[0].length);
}

async function handleEditSave(id: string, newContent: string) {
  const originalMsg = chat.messages.find(m => m.id === id);

  // 恢复原始附件
  if (originalMsg?.attachments?.length) {
    attachedFiles.value = originalMsg.attachments.map(a => ({
      name: a.name,
      path: a.path,
    }));
  }

  const cleanContent = extractDomSnippet(newContent);
  await handleSend(cleanContent);
}

async function handleResend(id: string, content: string) {
  const originalMsg = chat.messages.find(m => m.id === id);
  if (originalMsg?.attachments?.length) {
    attachedFiles.value = originalMsg.attachments.map(a => ({
      name: a.name,
      path: a.path,
    }));
  }
  const cleanContent = extractDomSnippet(content);
  await handleSend(cleanContent);
}

async function handleFork(msgId: string) {
  const msg = chat.messages.find(m => m.id === msgId);
  if (!msg) return;
  const originalId = session.activeSessionId;
  void msg; // 前端消息 id 是本地 genId 非 OC messageID，仅用作触发入口
  try {
    // OC serve 分叉：服务端 fork 生成新会话（继承上下文，标题自动追加 fork #N），
    // 替代 CC 的「新建会话 + --resume 注入前缀」方案。不传 messageID——前端消息 id 是本地 genId，
    // 非 OC 消息 id（msg_xxx），缺省从当前末尾分叉。
    const forked = await forkSession(originalId);
    session.insertSession(forked);
    session.setActiveSession(forked.id);
    chat.clearMessages();
    showStatus(t("session.forked"));
  } catch {
    showStatus(t("session.forkedFallback") || "分叉失败");
  }
}

// ── AskUserQuestion 问答状态（serve question.asked → control_request{subtype:'question', questions}）──
interface QuestionOption { label: string; description?: string }
interface Question { question: string; header?: string; options?: QuestionOption[]; multiple?: boolean }
const questionAnswers = ref<Map<string, string | string[]>>(new Map());
const questionOther = ref<Map<string, string>>(new Map());

function getQuestions(): Question[] {
  const qs = chat.pendingControlRequest?.questions;
  if (!Array.isArray(qs)) return [];
  return qs as Question[];
}

function toggleAnswer(question: string, label: string, multiple?: boolean) {
  const cur = questionAnswers.value.get(question);
  if (multiple) {
    const arr = (Array.isArray(cur) ? [...cur] : []) as string[];
    const idx = arr.indexOf(label);
    idx >= 0 ? arr.splice(idx, 1) : arr.push(label);
    questionAnswers.value.set(question, arr);
  } else {
    questionAnswers.value.set(question, cur === label ? '' : label);
  }
  questionOther.value.delete(question);
}

function setOther(question: string, text: string) {
  questionAnswers.value.delete(question);
  questionOther.value.set(question, text);
}

/** 提交答案：按 questions 顺序收集 string[][]（每项为该问题选中的 label 数组，单选也是单元素数组） */
async function submitAnswers() {
  const cr = chat.pendingControlRequest; if (!cr) return;
  const sid = session.activeSessionId;
  const questions = getQuestions();
  const answers: string[][] = questions.map(q => {
    const other = questionOther.value.get(q.question);
    if (other !== undefined) return [other];
    const ans = questionAnswers.value.get(q.question);
    if (!ans) return [];
    return Array.isArray(ans) ? ans : [ans];
  });
  // 先清队列关闭弹窗，再回传 serve（reply 失败不阻断关闭，答案已在本地记录）
  chat.resolveControlRequest("allow");
  questionAnswers.value.clear();
  questionOther.value.clear();
  if (!cr.request_id) return;
  debugLog.add(`📤 question:reply request=${cr.request_id} answers=${JSON.stringify(answers)}`);
  try { await questionReply(sid, cr.request_id, answers); } catch (e) { console.error("question:reply failed:", e); }
}

/** 拒绝提问：先清队列关闭弹窗，再通知 serve 取消（reject 失败不影响关闭） */
async function skipQuestions() {
  const cr = chat.pendingControlRequest;
  chat.resolveControlRequest("deny");
  questionAnswers.value.clear();
  questionOther.value.clear();
  if (!cr?.request_id) return;
  try { await questionReject(session.activeSessionId, cr.request_id); } catch { /* 无活跃会话时静默 */ }
}

// ── Stop processing ──
async function handleStop() {
  const sid = session.activeSessionId;
  if (!sid) return;
  // 先标记停止（必须在 abort 之前，否则 result 事件会先触发 finish 清掉 currentAssistantMsg）
  chat.markStopped();
  // OC serve 无 stdin interrupt 通道，直接 abort 引擎会话（主进程已容错）
  try { await stopSession(sid); } catch {}
  chat.finishAssistantMessage();
}

/**
 * 压缩上下文：调 serve v2 compact 端点（替代发 /compact 文本——OC 模型不认该斜杠）+ 重载消息。
 * 命令菜单「压缩上下文」与 ContextUsageModal 的压缩按钮共用。
 */
async function compactNow() {
  const sid = session.activeSessionId;
  if (!sid) { showStatus(t('status.compactEmpty')); return; }
  try {
    await compactSession(sid);
    showStatus(t('status.compactDone'));
    // compact 后消息历史变化 → 重载当前会话消息（与 useSessionSwitch 一致：全量拉取 + DOM 分页）
    listMessages(sid, { limit: FULL_HISTORY_LIMIT }).then(msgs => {
      chat.setHistoryError(false);
      chat.loadFullHistory(msgs);
    }).catch(() => {
      // 重载失败（serve 未就绪）→ 置离线标记，消息区灰显占位（G3）
      chat.setHistoryError(true);
      showStatus(t('session.loadFailed'));
    });
  } catch (e) {
    console.error("compact 失败:", e);
    showStatus(t('status.compactFailed'));
  }
}

// ── Session Export ──

// ── Attach file ──
async function handleAttachFile() {
  const selected = await openDialog({
    multiple: true,
    title: "Attach Files",
  });
  if (!selected) return;
  const paths = Array.isArray(selected) ? selected : [selected];
  for (const p of paths) {
    const name = p.split(/[/\\]/).pop() || p;
    if (!attachedFiles.value.some(af => af.path === p)) {
      attachedFiles.value.push({ name, path: p });
    }
  }
}

// 即时滚动：流式输出每来一个 token 就触发，不能用 smooth，否则一直抖
async function scrollToBottomInstant() {
  await nextTick();
  if (scrollContainer.value) scrollContainer.value.scrollTop = scrollContainer.value.scrollHeight;
}
// 平滑滚动：用户点击"滚动到底部"按钮时用，有动画过渡
function scrollToBottomSmooth() {
  if (scrollContainer.value) {
    scrollContainer.value.scrollTo({ top: scrollContainer.value.scrollHeight, behavior: "smooth" });
  }
}
function scrollToBottomAndResume() {
  autoScroll.value = true;
  isNearBottom.value = true;
  scrollToBottomSmooth();
}
function scrollToBottomIfAuto() {
  if (autoScroll.value) scrollToBottomInstant();
}
watch(
  () => [
    chat.messages.length,
    chat.currentAssistantMsg?.content,
    chat.currentAssistantMsg?.thinking,
    chat.currentAssistantMsg?.toolUses.length,
  ],
  () => scrollToBottomIfAuto(),
);
</script>

<template>
  <ErrorBoundary name="ChatPanel">
  <div class="f-chat-panel">
    <!-- Sticky question banner -->
    <div
      v-if="showSticky"
      class="sticky-question-bar"
      @click="scrollToSticky"
    >
      <span class="font-medium" style="color:var(--text-secondary)">↳ </span>{{ stickyQuestion }}
    </div>

    <!-- Messages + 时间线导航 -->
    <div class="chat-area">
      <!-- 状态消息浮层——会话区顶部居中，不遮挡底部通知区 -->
      <Transition name="status-float">
        <div v-if="statusMessage" class="status-toast"><span class="status-pill">{{ statusMessage }}</span></div>
      </Transition>
      <div ref="scrollContainer" class="chat-messages" @scroll="onScrollThrottled">
      <!-- 🧪 Ctrl+Shift+T -->
      <details v-if="showTestPanel" class="mx-auto mb-3 text-[11px]" style="color:var(--text-muted); max-width:760px; position:sticky; top:0; z-index:5; background:var(--bg-root)">
        <summary class="cursor-pointer py-1 hover:text-[var(--accent)]">🧪 测试弹窗</summary>
        <div class="flex flex-wrap gap-1.5 mt-2 ml-2">
          <button @click="runTest(testQuestion)" class="btn-ghost" style="font-size:11px; padding:0.15rem 0.5rem">AskUserQuestion</button>
          <button @click="runTest(testApprove)" class="btn-ghost" style="font-size:11px; padding:0.15rem 0.5rem">ApprovalBar</button>
          <button @click="runTest(() => { showContextModal = true; })" class="btn-ghost" style="font-size:11px; padding:0.15rem 0.5rem">ContextUsage</button>
          <button @click="runTest(() => emitChatCommand('export-session'))" class="btn-ghost" style="font-size:11px; padding:0.15rem 0.5rem">ExportPreview</button>
          <button @click="runTest(() => emitChatCommand('rename-session'))" class="btn-ghost" style="font-size:11px; padding:0.15rem 0.5rem">RenameSession</button>
          <button @click="runTest(() => emitChatCommand('about'))" class="btn-ghost" style="font-size:11px; padding:0.15rem 0.5rem">About</button>
          <button @click="runTest(() => emitChatCommand('manage-plugins'))" class="btn-ghost" style="font-size:11px; padding:0.15rem 0.5rem">ManagePanel</button>
          <button @click="runTest(testTodos)" class="btn-ghost" style="font-size:11px; padding:0.15rem 0.5rem">TodoWrite</button>
          <button @click="runTest(testStatusOk)" class="btn-ghost" style="font-size:11px; padding:0.15rem 0.5rem">Notify OK</button>
          <button @click="runTest(testStatusWarn)" class="btn-ghost" style="font-size:11px; padding:0.15rem 0.5rem">Notify Warn</button>
          <button @click="runTest(testStatusErr)" class="btn-ghost" style="font-size:11px; padding:0.15rem 0.5rem">Notify Err</button>
        </div>
      </details>
      <!-- Welcome -->
      <div v-if="chat.messages.length === 0" class="welcome-container">
        <!-- 历史加载中（切会话全量拉取）→ 转圈占位，避免白屏等待误判 -->
        <div v-if="chat.historyLoading" class="welcome-page">
          <div class="welcome-logo" style="background:var(--accent-glow); animation: pulse 1.2s ease-in-out infinite">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" class="animate-spin" style="animation-duration:1.1s">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
          </div>
          <h2 class="welcome-title">{{ $t('chat.historyLoadingTitle') }}</h2>
          <p class="text-sm leading-relaxed mb-6" style="color:var(--text-muted)">{{ $t('chat.historyLoadingSubtitle') }}</p>
        </div>
        <!-- 离线占位（G3）：serve 未就绪时历史消息不可用，灰显提示 + 当前会话标题正常展示 -->
        <div v-else-if="chat.historyError" class="welcome-page offline-placeholder">
          <div class="welcome-logo offline-logo" style="background:var(--bg-elevated)">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
            </svg>
          </div>
          <h2 class="welcome-title" style="color:var(--text-secondary)">{{ $t('chat.historyOfflineTitle') }}</h2>
          <p class="text-sm leading-relaxed mb-6" style="color:var(--text-muted)">{{ $t('chat.historyOfflineSubtitle') }}</p>
          <!-- 当前会话标题/时间正常展示（离线不影响会话信息） -->
          <div v-if="session.activeSessionId" class="text-xs" style="color:var(--text-muted)">
            <span v-if="currentSession">{{ currentSession.title }}</span>
          </div>
        </div>
        <div v-else class="welcome-page">
          <!-- Icon: terminal cursor -->
          <div class="welcome-logo" style="background:var(--accent-glow)">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
          </div>
          <h2 class="welcome-title" style="color:var(--text-bright)">{{ $t('chat.welcomeTitle') }}</h2>
          <p class="text-sm leading-relaxed mb-6" style="color:var(--text-secondary)">{{ $t('chat.welcomeSubtitle') }}</p>
          <div class="welcome-keywords" style="color:var(--text-muted)">
            <kbd class="badge" style="background:var(--bg-elevated); border:1px solid var(--border-dim)">Enter</kbd>
            <span>{{ $t('chat.welcomeSend') }}</span>
            <span style="color:var(--border-default)">·</span>
            <kbd class="badge" style="background:var(--bg-elevated); border:1px solid var(--border-dim)">Shift</kbd>
            <span>+</span>
            <kbd class="badge" style="background:var(--bg-elevated); border:1px solid var(--border-dim)">Enter</kbd>
            <span>{{ $t('chat.welcomeNewline') }}</span>
          </div>
        </div>
      </div>

      <!-- Message list -->
      <div v-if="chat.messages.length > 0" class="chat-messages-inner">
        <!-- Export bar (when messages exist) -->
        <div class="flex items-center justify-end">
          <button
            @click="prepareExport"
            class="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] transition-colors hover:bg-[var(--bg-hover)]"
            style="color: var(--text-secondary)"
            :title="$t('chat.exportTitle')"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            <span>{{ $t('chat.export') }}</span>
          </button>
        </div>
        <!-- 加载更早为同步内存切片（瞬时无感），不再需要顶部加载提示 -->
        <TransitionGroup name="msg">
          <!-- 消息 + 历史子任务卡片包在单一根 div（TransitionGroup 子元素需唯一 key；data-message-id 仍在内部可定位） -->
          <div v-for="msg in chat.messages" :key="msg.id" class="msg-entry">
            <MessageBubble
              :message="msg"
              @edit-save="handleEditSave"
              @resend="handleResend"
              @fork="handleFork"
              @preview-file="(f) => openFileInPanel(f)"
            />
            <!-- 历史子任务卡片（平铺，复用 SubTaskCard）：已完成子会话在消息块下方；点击展开 → summaryLoader 懒加载摘要；
                 运行中/本 app 已见已在 subTaskMap 互斥过滤（D3）剔除，不重复显示 -->
            <SubTaskCard
              v-for="sub in subTaskMap.get(msg.id) ?? []"
              :key="sub.id"
              :subtask="sub"
              :expanded="expandSubTaskId === sub.id"
              :summary-loader="loadSubTaskSummary"
              @expand="toggleExpandSubTask(sub.id)"
              @detail="openSubTaskDetail(sub)"
            />
          </div>
        </TransitionGroup>

        <!-- 子任务卡片（消息流内，参与滚动）：运行中点击→实时监视；已完成点击→展开摘要 -->
        <SubTaskCard
          v-for="sub in sortedSubTasks"
          :key="sub.id"
          :subtask="sub"
          :expanded="expandSubTaskId === sub.id"
          @monitor="monitorSubTaskId = sub.id"
          @expand="toggleExpandSubTask(sub.id)"
          @detail="openSubTaskDetail(sub)"
        />

        <!-- 处理中指示器：仅在消息还没内容时显示（有内容后时间线底部状态行接管） -->
        <ThinkingIndicator
          v-if="chat.isProcessing && !chat.currentAssistantMsg?.content && !chat.currentAssistantMsg?.thinking"
          :tool-name="activeToolName"
        />
      </div>
    </div>
    <!-- 时间线导航（竖排点，与 scroll 容器同级，不随滚动）：
         timeline 传全量索引（完整目录），跳转由 scrollToTimelineIndex 处理（目标未渲染时先切片再滚动） -->
    <ChatTimelineNav
      :messages="chat.messages"
      :timeline="chat.timelineIndex"
      :scrollContainer="scrollContainer"
      @jump="scrollToTimelineIndex"
    />
    </div>

    <!-- 诊断面板（方案 D7：调试 → 用户反馈通道「诊断信息」；两标签页 事件日志/引擎日志，绝对定位弹出 + 点击外部关闭） -->
    <Teleport to="body">
      <div
        v-if="debugLog.visible.value"
        class="fixed inset-0 z-40"
        @click="debugLog.visible.value = false"
      >
        <div
          @click.stop
          class="attach-bar"
        >
          <div class="system-msg-bar" style="background: var(--bg-surface); border: 1px solid var(--border-dim); box-shadow: 0 2px 6px rgba(0,0,0,0.15)">
            <span class="text-[11px]" :style="{ color: 'var(--text-bright)' }">{{ $t('chat.debugTitle') }} ({{ debugLog.lines.value.length }})</span>
            <span class="flex-1"></span>
            <!-- 复制诊断信息：应用名 + 版本 + serve.log 尾部打包（用户反馈通道，含隐私提示） -->
            <button @click="copyDiagnostics" class="icon-btn-sm cursor-pointer" :style="{ color: 'var(--text-muted)' }" :title="$t('chat.debugCopyDiag')">
              <span class="text-[11px]">{{ $t('chat.debugCopyDiag') }}</span>
            </button>
            <!-- 复制当前标签页内容 -->
            <button @click="copyDebugLog" class="icon-btn-sm cursor-pointer" :style="{ color: 'var(--text-muted)' }" :title="$t('chat.copy')">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            </button>
            <button @click="debugLog.visible.value = false" class="icon-btn-sm cursor-pointer" :style="{ color: 'var(--text-muted)' }" :title="$t('chat.close')">✕</button>
          </div>
          <!-- 标签页：事件日志（当前会话）/ 引擎日志（全局 serve.log） -->
          <div class="flex items-center gap-1 px-3 pt-2" style="border-bottom: 1px solid var(--border-dim)">
            <button
              @click="switchDebugTab('events')"
              class="text-[11px] px-2 py-0.5 rounded transition-colors"
              :style="debugTab === 'events' ? { color: 'var(--text-bright)', background: 'var(--bg-hover)' } : { color: 'var(--text-muted)' }"
            >{{ $t('chat.debugLabel') }}</button>
            <button
              @click="switchDebugTab('serve')"
              class="text-[11px] px-2 py-0.5 rounded transition-colors"
              :style="debugTab === 'serve' ? { color: 'var(--text-bright)', background: 'var(--bg-hover)' } : { color: 'var(--text-muted)' }"
            >{{ $t('chat.debugServeTab') }}</button>
            <span class="flex-1"></span>
            <!-- 引擎日志页：刷新重读 serve.log 尾部（面板不自动轮询，原型 4.3） -->
            <button v-if="debugTab === 'serve'" @click="loadServeLog" class="icon-btn-sm cursor-pointer" :style="{ color: 'var(--text-muted)' }" :title="$t('chat.debugRefresh')">🔄</button>
          </div>
          <!-- 内容区：事件日志 = debugLog 行；引擎日志 = serve.log 尾部只读（超长自动滚到底） -->
          <pre v-if="debugTab === 'events'" class="code-block max-h-48 overflow-y-auto" style="background:var(--bg-elevated); border:1px solid var(--border-dim); color:var(--text-muted); box-shadow: 0 4px 12px rgba(0,0,0,0.4); border-radius:0">{{ debugLog.lines.value.join('\n') }}</pre>
          <div v-else class="code-block max-h-48 overflow-y-auto" style="background:var(--bg-elevated); border:1px solid var(--border-dim); box-shadow: 0 4px 12px rgba(0,0,0,0.4); border-radius:0">
            <pre v-if="serveLogLines.length > 0" ref="serveLogPre" class="code-block" style="margin:0; color:var(--text-muted)">{{ serveLogLines.join('\n') }}</pre>
            <div v-else class="px-3 py-3 text-[11px]" style="color:var(--text-muted)">
              <span v-if="serveLogLoading">{{ $t('chat.loading') }}</span>
              <span v-else-if="serveLogError">{{ serveLogError }}</span>
              <span v-else>{{ $t('chat.debugNoServeLog') }}</span>
            </div>
          </div>
          <!-- 底部提示：日志用于排查，可复制发给开发者 -->
          <div class="px-3 py-1.5 text-[10px]" style="color:var(--text-muted)">{{ $t('chat.debugFooter') }}</div>
        </div>
      </div>
    </Teleport>

    <!-- ═══ 底部通知区：审批条 + 工作清单 ═══ -->
    <div class="bottom-notices">
      <div v-if="chat.pendingControlRequest && chat.pendingControlRequest.subtype !== 'question'" class="approval-bar">
        <div class="approval-accent" />
        <span class="approval-msg">
          {{ $t('chat.allowTool', { tool: toolLabel(chat.pendingControlRequest.tool_name || '') }) }}
          <span v-if="alwaysAllowHint" class="approval-hint">{{ alwaysAllowHint }}</span>
        </span>
        <button v-if="alwaysAllowHint" @click="handleAlwaysAllow" class="btn-ghost" style="color:var(--accent); border-color:var(--accent-dim)">{{ $t('chat.alwaysAllow') }}</button>
        <button @click="handleAllow" class="btn-primary">{{ $t('chat.allow') }}</button>
        <button @click="handleDeny" class="btn-ghost" style="color:var(--coral); border-color:var(--coral)">{{ $t('chat.deny') }}</button>
      </div>
      <TodoPanel />
    </div>

    <!-- ═══ 底部区域：滚动按钮 + 状态消息 + 工具栏 + 输入框（语义类 composer-area：不收缩 + 定位参照）═══ -->
    <div class="composer-area">
      <!-- 滚动到底按钮 — 悬浮在底部区域上方 -->
      <Transition name="scroll-btn">
        <button
          v-if="!isNearBottom && chat.messages.length > 0"
          @click="scrollToBottomAndResume"
          class="scroll-to-bottom-btn"
          :title="$t('chat.scrollToBottom')"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      </Transition>


      <!-- composer 输入区（InputBar 卡片内含 chips 行 + foot 操作行；debug 按钮走 left 插槽） -->
      <InputBar
        ref="inputBar"
        :disabled="chat.isProcessing"
        :auto-mode="autoModeActive"
        :api-key="settings.apiKey"
        :base-url="settings.baseUrl"
        :chips="composerChips"
        :chip-hint="$t('composer.chipHint')"
        @send="handleSend"
        @stop="handleStop"
        @files="(fs) => { for (const f of fs) { if (!attachedFiles.some(af => af.path === f.path)) attachedFiles.push(f); } }"
        @attach="handleAttachFile"
        @remove-chip="handleRemoveChip"
        @chip-click="handleChipClick"
        @open-command-menu="commandBus.open()"
        @send-slash="(t: string) => handleSend(t)"
        @show-context="showContextModal = true"
      >
        <template #left>
          <!-- 诊断按钮显示条件：只看事件日志非空（引擎日志有无渲染层无从得知，引擎页空态兜底——方案 4.5） -->
          <template v-if="debugLog.lines.value.length > 0">
            <button
              @click="debugLog.toggle()"
              class="debug-btn"
              :style="{ color: debugLog.visible.value ? 'var(--text-bright)' : 'var(--text-muted)' }"
            >
              <span>{{ debugLog.visible.value ? '▾' : '▸' }}</span>
              <span>{{ $t('chat.debugTitle') }} ({{ debugLog.lines.value.length }})</span>
            </button>
            <div class="debug-divider"></div>
          </template>
        </template>
      </InputBar>

    <!-- File preview modal -->
    <!-- 文件预览统一由 AppShell 第四列处理 -->
    <ContextUsageModal :open="showContextModal" @close="showContextModal = false" @compact="showContextModal = false; compactNow()" />
    <ManagePanel :open="showManage" :initialTab="manageTab" @close="showManage = false" @send-slash="(t) => handleSend(t)" />

    <!-- AskUserQuestion 问答弹窗（serve question.asked → subtype='question'） -->
    <ModalShell :open="chat.pendingControlRequest?.subtype === 'question'" size="md" position="top" @close="skipQuestions">
      <template #header>
        <span class="text-sm font-semibold" :style="{ color: 'var(--text-bright)' }">{{ $t('chat.askUserQuestion') }}</span>
      </template>
      <div class="space-y-4 px-1">
        <div v-for="(q, qi) in getQuestions()" :key="qi" class="space-y-2">
          <div class="flex items-center gap-1.5">
            <span v-if="q.header" class="badge font-medium whitespace-nowrap shrink-0" :style="{ background: 'var(--accent-glow)', color: 'var(--accent)' }">{{ q.header }}</span>
            <span class="text-xs font-medium" :style="{ color: 'var(--text-primary)' }">{{ q.question }}</span>
          </div>
          <div class="space-y-1 ml-1">
            <label
              v-for="opt in q.options"
              :key="opt.label"
              class="flex items-start gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors hover:bg-[var(--bg-hover)]"
            >
              <input
                :type="q.multiple ? 'checkbox' : 'radio'"
                :name="`q_${qi}`"
                :checked="q.multiple
                  ? (Array.isArray(questionAnswers.get(q.question)) && (questionAnswers.get(q.question) as string[]).includes(opt.label))
                  : questionAnswers.get(q.question) === opt.label"
                @change="toggleAnswer(q.question, opt.label, q.multiple)"
                class="mt-0.5 shrink-0"
              />
              <div class="min-w-0">
                <div class="text-xs font-medium" :style="{ color: 'var(--text-secondary)' }">{{ opt.label }}</div>
                <div class="text-[11px] leading-relaxed" :style="{ color: 'var(--text-muted)' }">{{ opt.description }}</div>
              </div>
            </label>
            <!-- Other 自由输入 -->
            <label class="flex items-start gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors hover:bg-[var(--bg-hover)]">
              <input
                :type="q.multiple ? 'checkbox' : 'radio'"
                :name="`q_${qi}`"
                :checked="questionOther.has(q.question)"
                @change="questionOther.set(q.question, '')"
                class="mt-0.5 shrink-0"
              />
              <div class="flex-1 min-w-0">
                <div class="text-xs font-medium" :style="{ color: 'var(--text-secondary)' }">Other</div>
                <input
                  v-if="questionOther.has(q.question)"
                  :value="questionOther.get(q.question) || ''"
                  @input="(e) => setOther(q.question, (e.target as HTMLInputElement).value)"
                  placeholder="输入自定义答案..."
                  class="input-plain mt-1"
                  :style="{ background: 'var(--bg-elevated)', border: '1px solid var(--border-dim)', color: 'var(--text-primary)', caretColor: 'var(--accent)' }"
                />
              </div>
            </label>
          </div>
        </div>
      </div>
      <template #footer>
        <div class="flex items-center justify-end gap-2">
          <button @click="skipQuestions" class="text-xs px-3 py-1.5 rounded transition-colors hover:bg-[var(--bg-hover)]" :style="{ color: 'var(--text-muted)' }">{{ $t('chat.skip') }}</button>
          <button @click="submitAnswers" class="px-4 py-1.5 rounded text-xs font-medium transition-colors" :style="{ background: 'var(--accent)', color: 'var(--bg-root)' }">{{ $t('chat.submit') }}</button>
        </div>
      </template>
    </ModalShell>

    <!-- 关于弹窗 -->
    <ModalShell :open="showAbout" size="sm" @close="showAbout = false">
      <template #header>
        <span class="text-sm font-semibold" :style="{ color: 'var(--text-bright)' }">{{ $t('chat.aboutTitle') }}</span>
      </template>
      <div class="text-center py-4 space-y-3">
        <div class="text-lg font-bold" :style="{ color: 'var(--text-bright)' }">{{ $t('app.title') }}</div>
        <div class="text-xs" :style="{ color: 'var(--text-secondary)' }">{{ $t('chat.aboutSubtitle') }}</div>
        <div class="text-[11px] font-mono" :style="{ color: 'var(--text-muted)' }">v{{ appVersion }}</div>
        <div class="text-[11px]" :style="{ color: 'var(--text-muted)' }">
          Tauri 2 + Vue 3 + TypeScript<br/>
          Rust 后端 · SQLite 持久化<br/>
          多厂商 API 兼容
        </div>
        <div class="text-[10px] pt-2" :style="{ color: 'var(--text-muted)' }">
          © 2026 分形 contributors · MIT
        </div>
      </div>
    </ModalShell>

    <!-- 导出预览弹窗 -->
    <ModalShell :open="showExportPreview" size="lg" @close="showExportPreview = false">
      <template #header>
        <span class="text-sm font-semibold" :style="{ color: 'var(--text-bright)' }">导出预览 — {{ exportFileName }}</span>
      </template>
      <div class="overflow-y-auto p-1 min-w-0" style="max-height: 60vh">
        <div class="overflow-x-auto">
          <MarkdownRenderer :content="exportContent" />
        </div>
      </div>
      <div class="flex justify-end gap-2 mt-3">
        <button @click="showExportPreview = false" class="btn-ghost" :style="{ color: 'var(--text-muted)' }">取消</button>
        <button @click="doExport" class="px-4 py-1.5 rounded-md text-xs font-medium transition-colors" :style="{ background: 'var(--accent)', color: 'var(--bg-root)' }">选择目录并导出</button>
      </div>
    </ModalShell>
    <!-- 重命名弹窗 -->
    <ModalShell :open="showRenameModal" size="sm" @close="showRenameModal = false">
      <template #header>
        <span class="text-sm font-semibold" :style="{ color: 'var(--text-bright)' }">重命名会话</span>
      </template>
      <input
        v-model="renameTitle"
        @keydown.enter="confirmRename"
        @keydown.escape="showRenameModal = false"
        class="w-full bg-transparent text-sm px-3 py-2 rounded-md border outline-none"
        :style="{ color: 'var(--text-bright)', borderColor: 'var(--border-default)', background: 'var(--bg-elevated)' }"
        autofocus
      />
      <div class="flex justify-end gap-2 mt-3">
        <button @click="showRenameModal = false" class="btn-ghost" :style="{ color: 'var(--text-muted)' }">取消</button>
        <button @click="confirmRename" class="px-3 py-1.5 rounded-md text-xs font-medium transition-colors" :style="{ background: 'var(--accent)', color: 'var(--bg-root)' }">确认</button>
      </div>
    </ModalShell>

    <!-- 子任务实时监视弹窗（运行中卡片点击；数据源 chat store 响应式实时） -->
    <SubTaskMonitor
      v-if="monitorSubTaskId"
      :sub-id="monitorSubTaskId"
      @close="monitorSubTaskId = null"
    />

    <!-- 子任务详情弹窗（「查看会话详情」点击；onMounted 拉全量消息） -->
    <SubTaskDetail
      v-if="detailSubTaskId"
      :sub-id="detailSubTaskId"
      :agent="detailSubTaskAgent"
      @close="detailSubTaskId = null"
      @back-to-parent="backToParentSubTask"
    />

    </div>
  </div>
  </ErrorBoundary>
</template>

<style scoped>
/* Scroll-to-bottom button transition */
.scroll-btn-enter-active { transition: all 200ms ease-out; }
.scroll-btn-leave-active { transition: all 150ms ease-in; }
.scroll-btn-enter-from { opacity: 0; transform: translateY(8px) scale(0.9); }
.scroll-btn-leave-to { opacity: 0; transform: translateY(4px) scale(0.95); }

.sticky-question-bar {
  flex-shrink: 0;
  padding: 0.375rem 1rem;
  cursor: pointer;
  font-size: 0.75rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  z-index: 10;
  background: var(--bg-elevated);
  border-bottom: 1px solid var(--border-dim);
  color: var(--text-muted);
  backdrop-filter: blur(8px);
}

/* 离线占位（G3）：serve 未就绪时历史消息不可用，整体灰显弱化 */
.offline-placeholder {
  opacity: 0.85;
}
.offline-logo {
  border: 1px solid var(--border-dim);
}

/* ═══ 输入区语义类（原原子 class 收敛：shrink-0/relative → 语义名，用户反馈整理）═══ */
/* 底部区域容器：不收缩（flex 布局下输入区固定）+ 滚动按钮绝对定位参照 */
.composer-area {
  flex-shrink: 0;
  position: relative;
}
/* 审批条 accent 装饰竖线（原 w-0.5 h-5 rounded-full shrink-0） */
.approval-accent {
  width: 2px;
  height: 20px;
  border-radius: 9999px;
  flex-shrink: 0;
  background: var(--accent);
}
/* 审批条主文本（原 text-xs flex-1） */
.approval-msg {
  flex: 1;
  font-size: 12px;
  color: var(--text-secondary);
}
/* 审批条「总是允许」建议文案（原 block text-[10px] mt-0.5） */
.approval-hint {
  display: block;
  font-size: 10px;
  margin-top: 2px;
  color: var(--text-muted);
}
/* debug 按钮分隔线（原 w-px h-4 shrink-0） */
.debug-divider {
  width: 1px;
  height: 16px;
  flex-shrink: 0;
  background: var(--border-dim);
}
</style>
