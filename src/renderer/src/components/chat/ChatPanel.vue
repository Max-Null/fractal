<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted, onUnmounted, inject } from "vue";
import { useChatStore, type AttachedFile } from "@/stores/chat";
import { useSessionStore } from "@/stores/session";
import { useDebugLog } from "@/composables/useDebugLog";
import { useStderrLog } from "@/composables/useStderrLog";
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
  openDialog,
  saveDialog,
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
const stderrLog = useStderrLog();
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

// 复制 debug 日志
function copyDebugLog() {
  const text = debugLog.lines.value.join('\n');
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}

// 复制 LLM stderr 日志
function copyStderrLog() {
  const text = stderrLog.lines.value.join('\n');
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}

// ── Attached files ──
const attachedFiles = ref<AttachedFile[]>([]);

function removeAttachedFile(index: number) {
  attachedFiles.value.splice(index, 1);
}

// 图片附件加入时预加载缩略图（原 sb-attachment-bar 在 chip 挂载时触发，现 chips 在 InputBar 内渲染，改由 watch 驱动）
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
}
const composerChips = computed<ComposerChip[]>(() => {
  const chips: ComposerChip[] = [];
  // 选区卡片：accent 底（accent-glow 语义，原型「选中内容自动出现在这里」）
  if (textSnippet.value) {
    chips.push({ id: "snippet", label: textSnippet.value.label, tone: "accent", removable: true });
  }
  // 附件 chips：elevated 底 + 缩略图 + 点击打开预览
  for (const f of attachedFiles.value) {
    chips.push({
      id: `file:${f.path}`,
      label: f.name,
      imageUrl: thumbnails[f.path] || undefined,
      tone: "elevated",
      clickable: true,
      removable: true,
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
// 会话切换时同步 debug 日志到当前会话
watch(() => session.activeSessionId, async (sid) => {
  if (!sid) return;
  debugLog.setSession(sid);
  stderrLog.setSession(sid);
  // 从 DB 恢复持久化的日志
  try {
    const [debugJson, stderrJson] = await loadSessionLogs(sid);
    if (debugJson) {
      try { debugLog.importLines(sid, JSON.parse(debugJson)); } catch {}
    }
    if (stderrJson) {
      try { stderrLog.importLines(sid, JSON.parse(stderrJson)); } catch {}
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
        listMessages(target.id).then(msgs => {
          chat.setHistoryError(false);
          chat.loadMessages(msgs.map(m => ({ id: m.id, role: m.role, content: m.content, created_at: m.created_at })));
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
    case "slash-compact":   handleSend("/compact"); break;
    case "slash-context":   showContextModal.value = true; break;
    case "slash-cost":      handleSend("/cost"); break;
    case "slash-review":    handleSend("/review"); break;
    case "slash-simplify":  handleSend("/simplify"); break;
    case "slash-security":  handleSend("/security-review"); break;
    case "slash-doctor":    handleSend("/doctor"); break;
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

function scrollToUserMsg(index: number) {
  const userEls = scrollContainer.value?.querySelectorAll<HTMLElement>('[data-role="user"]');
  if (userEls && userEls[index]) {
    userEls[index].scrollIntoView({ behavior: "smooth", block: "start" });
  }
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
  if (scrollTimer) return;
  scrollTimer = setTimeout(() => { scrollTimer = null; updateStickyBanner(); }, 100);
}

async function handleSend(text: string) {
  // 记录斜杠命令（仅用户主动发送的，非中途追加）
  if (text.startsWith("/")) slashCommands.recordCommand(text);
  const isMidProcessing = chat.isProcessing;
  // 新消息（非中途追加）才清日志和计划
  if (!isMidProcessing) {
    debugLog.clear();
    stderrLog.clear();
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
      effort: settings.effort,
      ultracode: settings.effort === "ultracode",
      model: settings.model,
      // 主 agent（双星/build/plan）→ 引擎 promptAsync.agent；权限选「计划」时强制 plan agent（无写权限，方案 3.5）
      agent: settings.planMode ? "plan" : settings.currentAgent,
      filePaths: filePaths.length > 0 ? filePaths : undefined,
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
  <div class="sb-chat-panel">
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
          <button @click="runTest(() => emitChatCommand('slash-context'))" class="btn-ghost" style="font-size:11px; padding:0.15rem 0.5rem">ContextUsage</button>
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
        <!-- 离线占位（G3）：serve 未就绪时历史消息不可用，灰显提示 + 当前会话标题正常展示 -->
        <div v-if="chat.historyError" class="welcome-page offline-placeholder">
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
        <TransitionGroup name="msg">
          <MessageBubble
            v-for="msg in chat.messages"
            :key="msg.id"
            :message="msg"
            @edit-save="handleEditSave"
            @resend="handleResend"
            @fork="handleFork"
            @preview-file="(f) => openFileInPanel(f)"
          />
        </TransitionGroup>

        <!-- 处理中指示器：仅在消息还没内容时显示（有内容后时间线底部状态行接管） -->
        <ThinkingIndicator
          v-if="chat.isProcessing && !chat.currentAssistantMsg?.content && !chat.currentAssistantMsg?.thinking"
          :tool-name="activeToolName"
        />
      </div>
    </div>
    <!-- 时间线导航（竖排点，与 scroll 容器同级，不随滚动） -->
    <ChatTimelineNav
      :messages="chat.messages"
      :scrollContainer="scrollContainer"
      @scrollTo="(i) => scrollToUserMsg(i)"
    />
    </div>

    <!-- Debug / LLM 展开内容：绝对定位弹出 + 点击外部关闭 -->
    <Teleport to="body">
      <div
        v-if="debugLog.visible.value || stderrLog.visible.value"
        class="fixed inset-0 z-40"
        @click="debugLog.visible.value = false; stderrLog.visible.value = false"
      >
        <div
          @click.stop
          class="attach-bar"
        >
          <div class="system-msg-bar" style="background: var(--bg-surface); border: 1px solid var(--border-dim); box-shadow: 0 2px 6px rgba(0,0,0,0.15)">
            <span v-if="debugLog.visible.value" class="text-[11px]" :style="{ color: 'var(--text-bright)' }">{{ $t('chat.debugLabel') }} ({{ debugLog.lines.value.length }})</span>
            <span v-if="stderrLog.visible.value" class="text-[11px]" :style="{ color: 'var(--accent)' }">📤 {{ $t('chat.llmRequestLabel') }} ({{ stderrLog.lines.value.length }})</span>
            <button @click="debugLog.visible.value ? copyDebugLog() : copyStderrLog()" class="icon-btn-sm cursor-pointer" :style="{ color: 'var(--text-muted)' }" :title="$t('chat.copy')">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            </button>
          </div>
          <pre v-if="debugLog.visible.value" class="code-block max-h-48 overflow-y-auto" style="background:var(--bg-elevated); border:1px solid var(--border-dim); color:var(--text-muted); box-shadow: 0 4px 12px rgba(0,0,0,0.4)">{{ debugLog.lines.value.join('\n') }}</pre>
          <pre v-if="stderrLog.visible.value" class="code-block max-h-96 overflow-y-auto" style="background:var(--bg-elevated); border:1px solid var(--accent-glow); color:var(--text-muted); box-shadow: 0 4px 12px rgba(0,0,0,0.4)">{{ stderrLog.lines.value.join('\n') }}</pre>
        </div>
      </div>
    </Teleport>

    <!-- ═══ 底部通知区：审批条 + 工作清单 ═══ -->
    <div class="bottom-notices">
      <div v-if="chat.pendingControlRequest && chat.pendingControlRequest.subtype !== 'question'" class="approval-bar">
        <div class="w-0.5 h-5 rounded-full shrink-0" style="background:var(--accent)" />
        <span class="text-xs flex-1" style="color:var(--text-secondary)">
          {{ $t('chat.allowTool', { tool: toolLabel(chat.pendingControlRequest.tool_name || '') }) }}
          <span v-if="alwaysAllowHint" class="block text-[10px] mt-0.5" style="color:var(--text-muted)">{{ alwaysAllowHint }}</span>
        </span>
        <button v-if="alwaysAllowHint" @click="handleAlwaysAllow" class="btn-ghost" style="color:var(--accent); border-color:var(--accent-dim)">{{ $t('chat.alwaysAllow') }}</button>
        <button @click="handleAllow" class="btn-primary">{{ $t('chat.allow') }}</button>
        <button @click="handleDeny" class="btn-ghost" style="color:var(--coral); border-color:var(--coral)">{{ $t('chat.deny') }}</button>
      </div>
      <TodoPanel />
    </div>

    <!-- ═══ 底部区域：滚动按钮 + 状态消息 + 工具栏 + 输入框 ═══ -->
    <div class="shrink-0 relative">
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
          <template v-if="debugLog.lines.value.length > 0 || stderrLog.lines.value.length > 0">
            <button
              v-if="debugLog.lines.value.length > 0"
              @click="debugLog.toggle(); if (debugLog.visible.value) stderrLog.visible.value = false"
              class="debug-btn"
              :style="{ color: debugLog.visible.value ? 'var(--text-bright)' : 'var(--text-muted)' }"
            >
              <span>{{ debugLog.visible.value ? '▾' : '▸' }}</span>
              <span>{{ $t('chat.debugLabel') }} ({{ debugLog.lines.value.length }})</span>
            </button>
            <button
              v-if="stderrLog.lines.value.length > 0"
              @click="stderrLog.toggle(); if (stderrLog.visible.value) debugLog.visible.value = false"
              class="debug-btn"
              :style="{ color: stderrLog.visible.value ? 'var(--accent)' : 'var(--text-muted)' }"
            >
              <span>{{ stderrLog.visible.value ? '▾' : '▸' }}</span>
              <span>📤 {{ $t('chat.llmRequestLabel') }} ({{ stderrLog.lines.value.length }})</span>
            </button>
            <div class="w-px h-4 shrink-0" style="background: var(--border-dim)"></div>
          </template>
        </template>
      </InputBar>

    <!-- File preview modal -->
    <!-- 文件预览统一由 AppShell 第四列处理 -->
    <ContextUsageModal :open="showContextModal" @close="showContextModal = false" @compact="showContextModal = false; handleSend('/compact')" />
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
</style>
