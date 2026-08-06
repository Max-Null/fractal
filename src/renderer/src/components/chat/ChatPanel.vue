<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted, onUnmounted, inject } from "vue";
import { useChatStore, type AttachedFile } from "@/stores/chat";
import { useSessionStore } from "@/stores/session";
import { useDebugLog } from "@/composables/useDebugLog";
import { useStderrLog } from "@/composables/useStderrLog";
import {
  sendMessage,
  sendStdin,
  zenSendMessage,
  getAutoModeStatus,
  stopSession,
  listMessages,
  writeFile,
  loadSessionLogs,
  openDialog,
  saveDialog,
} from "@/lib/electron-bridge";
import { useFilePreview } from "@/composables/useFilePreview";
import { useSettingsStore, PROVIDER_LOGOS } from "@/stores/settings";
import { translateError } from "@/lib/utils";
import ErrorBoundary from "@/components/shared/ErrorBoundary.vue";
import InputBar from "./InputBar.vue";
import InputBarToolbar from "./InputBarToolbar.vue";
import MessageBubble from "./MessageBubble.vue";
import ThinkingIndicator from "./ThinkingIndicator.vue";
import ContextUsageModal from "@/components/shared/ContextUsageModal.vue";
import ManagePanel from "@/components/shared/ManagePanel.vue";
import ModalShell from "@/components/shared/ModalShell.vue";
import MarkdownRenderer from "@/components/shared/MarkdownRenderer.vue";
import ChatTimelineNav from "./ChatTimelineNav.vue";
import { useCommandPaletteBus, useChatCommandBus, emitGlobalCommand, emitChatCommand } from "@/composables/useCommandPalette";
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

// ── 选区片段卡片（DOM / Excel / 文本划选 / MD 选区 → 统一 chip）──
interface TextSnippet { content: string; label: string }
const textSnippet = ref<TextSnippet | null>(null);
function removeTextSnippet() { textSnippet.value = null; }

const openFileInPanel = inject<(f: { name: string; path: string }) => void>("openFileInPanel", () => {});

// ── 🧪 测试（Dev）──
const showTestPanel = ref(false);
function runTest(fn: () => void) { showTestPanel.value = false; fn(); }
function testQuestion() { chat.pendingControlRequests.splice(0); chat.pendingControlRequests.push({ subtype: "approval", tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "选择方案？", header: "Q", multiSelect: false, options: [{ label: "A", description: "desc" }] }] } }); }
function testPlan() { chat.pendingControlRequests.splice(0); chat.pendingControlRequests.push({ subtype: "approval", tool_name: "ExitPlanMode", tool_input: { plan: "# 测试计划\n\n## 步骤 1\n实现\n## 步骤 2\n测试", planFilePath: "/tmp/test-plan.md" } }); }
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
// Ponytail 模式变更（设置面板或工具栏）→ 发送 /ponytail 命令给 CC
let ponytailInit = true;
watch(() => settings.ponytailMode, (v) => {
  if (ponytailInit) { ponytailInit = false; return; }  // 跳过初始值
  handleSend(`/ponytail ${v}`).catch(() => {});
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
          chat.loadMessages(msgs.map(m => ({ id: m.id, role: m.role, content: m.content, created_at: m.created_at })));
          showStatus(t('session.switchSuccess', { title: target.title }));
        }).catch(() => showStatus(t('session.loadFailed')));
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
    case "install-ponytail": handleSend("请帮我安装 Ponytail 插件（ponytail@claude-plugins-official）"); break;
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
        // 先停止当前会话的 CC 进程（避免旧 cwd 的进程继续 emit 事件到新会话）
        const sid = session.activeSessionId;
        if (sid) {
          try {
            await sendStdin(sid, JSON.stringify({
              type: "control_request",
              request_id: `interrupt_${Date.now()}`,
              request: { subtype: "interrupt" },
            }));
          } catch {}
          // 给 CC 1 秒优雅退出，超时则强杀
          await new Promise(r => setTimeout(r, 1000));
          try { await stopSession(sid); } catch {}
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
    // ponytail: 此处需遍历两次获取 el（text 和 element 分别取），O(n) 可接受
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
    savedPlan.value = { plan: "", planFilePath: "" };
  }
  let sid: string;
  if (settings.zenMode) {
    // 禅模式：用 Zen 会话 ID（持久化到 DB，mode='zen'）
    sid = session.zenActiveId;
    if (!sid) {
      chat.clearMessages();
      sid = await session.createSession(settings.model, undefined, "zen", settings.locale);
      session.zenActiveId = sid;
    }
  } else {
    sid = session.activeSessionId;
    if (!sid) {
      chat.clearMessages();  // 新建会话时清空旧消息记录
      sid = await session.createSession(settings.model, undefined, undefined, settings.locale);
    }
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
    if (settings.zenMode) {
      // 禅模式：直接调 LLM chat/completions（SSE 流式），绕过 CC CLI
      const chatUrl = settings.optimizeApiUrl;
      if (!chatUrl) {
        throw new Error("未配置聊天 API 地址，请在设置中填写 LLM API 地址（含完整路径，如 https://api.deepseek.com/v1/chat/completions）");
      }
      // 用 model 字段（用户当前选择的模型），禅模式下通常应为 OpenAI-format 模型名（如 deepseek-chat）
      await zenSendMessage(sid, fullText, settings.apiKey, chatUrl, settings.model);
    } else {
      // 分叉会话首条消息：加前缀告知 CC 忽略分叉点之后的内容
      let finalText = fullText;
      let resumeId: string | undefined;
      let forkSession = false;
      if (forkedFrom.value && sid === forkedFrom.value.sessionId) {
        finalText = `[会话分叉] 以下对话从用户消息 "${forkedFrom.value.msgSnippet}" 之后分叉。请忽略该消息之后的所有对话内容，从现在起继续。\n\n${fullText}`;
        resumeId = forkedFrom.value.claudeSessionId;
        forkSession = !!resumeId;
        forkedFrom.value = null; // 仅首条消息注入
      }
      await sendMessage(sid, finalText, {
        planMode: settings.planMode,
        autoMode: settings.autoMode,
        permissionMode: settings.permissionMode,
        effort: settings.effort,
        ultracode: settings.effort === "ultracode",
        model: settings.model,
        filePaths: filePaths.length > 0 ? filePaths : undefined,
        claudePath: settings.claudePath || undefined,
        cwd: settings.cwd || undefined,
        resumeId,
        forkSession,
      });
    }
    // 侧栏统计在 useStreamProcessor result 事件后刷新（token 已入库）
  } catch (err) {
    debugLog.add(`>>> Error: ${err}`);
    debugLog.visible.value = true;
    const { key, params } = translateError(err);
    chat.appendText(`\n\n> ❌ ${t(key, params as any)}`);
    chat.finishAssistantMessage();
  }
}

// control_response 格式（cli-agent-protocol skill 确认 + 实测通过）:
// 嵌套：response.subtype/request_id/response.behavior/updatedInput/message
async function handleAllow() {
  const cr = chat.pendingControlRequest; if (!cr) return;
  const payload = {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: cr.request_id || "",
      response: {
        behavior: "allow",
        updatedInput: cr.tool_input,  // 必须原样回传工具输入
      },
    },
  };
  debugLog.add(`📤 control_response allow: ${JSON.stringify(payload)}`);
  await sendStdin(session.activeSessionId, JSON.stringify(payload));
  chat.resolveControlRequest("allow");
}
async function handleDeny() {
  const cr = chat.pendingControlRequest; if (!cr) return;
  // 先清队列关闭弹窗，再通知 CC（sendStdin 可能因无活跃会话失败，不影响关闭）
  chat.resolveControlRequest("deny");
  const payload = {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: cr.request_id || "",
      response: {
        behavior: "deny",
        message: "User denied this action",
      },
    },
  };
  debugLog.add(`📤 control_response deny: ${JSON.stringify(payload)}`);
  try { await sendStdin(session.activeSessionId, JSON.stringify(payload)); } catch { /* 无活跃 CC 会话时静默 */ }
}

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

// 分叉状态：当前会话是否从另一个会话分叉而来
const forkedFrom = ref<{ sessionId: string; claudeSessionId: string | undefined; msgSnippet: string } | null>(null);

async function handleFork(msgId: string) {
  const msg = chat.messages.find(m => m.id === msgId);
  if (!msg) return;
  const originalSession = session.sessions.find(s => s.id === session.activeSessionId);
  const claudeId = originalSession?.claudeSessionId;
  const snippet = msg.content?.slice(0, 80) || "(消息内容)";
  // 分叉会话标题与普通新建区分
  const title = t("session.forkedTitle", { snippet: snippet.slice(0, 30) });
  // 创建新前端会话（复用当前工作区）
  const newId = await session.createSession(settings.model, settings.cwd, undefined, settings.locale, title);
  // 仅当原会话有 CC 会话 ID 时才尝试分叉
  // （不检查磁盘文件——CC 运行时可能未落盘，实际有效性由 CC --resume 决定；
  //   若失效则在发送首条消息时通过进程异常退出提示反馈）
  forkedFrom.value = claudeId
    ? { sessionId: newId, claudeSessionId: claudeId, msgSnippet: snippet }
    : null;
  session.setActiveSession(newId);
  chat.clearMessages();
  showStatus(claudeId ? t("session.forked") : t("session.forkedFallback"));
}

// ── AskUserQuestion 问答状态 ──
interface Question { question: string; header: string; options: { label: string; description: string }[]; multiSelect: boolean }
const questionAnswers = ref<Map<string, string | string[]>>(new Map());
const questionOther = ref<Map<string, string>>(new Map());

function getQuestions(): Question[] {
  const input = chat.pendingControlRequest?.tool_input as Record<string, unknown> | undefined;
  if (!input || !Array.isArray(input.questions)) return [];
  return input.questions as Question[];
}

function toggleAnswer(question: string, label: string, multi: boolean) {
  const cur = questionAnswers.value.get(question);
  if (multi) {
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

async function submitAnswers() {
  const cr = chat.pendingControlRequest; if (!cr) return;
  const answers: Record<string, string | string[]> = {};
  const questions = getQuestions();
  for (const q of questions) {
    const other = questionOther.value.get(q.question);
    if (other !== undefined) { answers[q.question] = other; continue; }
    const ans = questionAnswers.value.get(q.question);
    if (ans) answers[q.question] = ans;
  }
  const payload = {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: cr.request_id || "",
      response: {
        behavior: "allow",
        updatedInput: { questions: cr.tool_input.questions, answers },
      },
    },
  };
  debugLog.add(`📤 AskUserQuestion answers: ${JSON.stringify(payload)}`);
  await sendStdin(session.activeSessionId, JSON.stringify(payload));
  questionAnswers.value.clear();
  questionOther.value.clear();
  chat.resolveControlRequest("allow");
}

function skipQuestions() {
  handleDeny(); // fire-and-forget，resolveControlRequest 已在 handleDeny 首行执行
  questionAnswers.value.clear();
  questionOther.value.clear();
}

// ── ExitPlanMode 计划审核 ──
const planFeedback = ref("");
// 保存最近一次计划，关闭弹窗后可重新打开查看
const savedPlan = ref<{ plan: string; planFilePath: string }>({ plan: "", planFilePath: "" });
const showPlanModal = ref(false);

function getPlan(): { plan: string; planFilePath: string } {
  const input = chat.pendingControlRequest?.tool_input as Record<string, unknown> | undefined;
  // 优先取当前审批中的计划，否则取已保存的
  if (input?.plan) return { plan: input.plan as string, planFilePath: (input.planFilePath as string) || "" };
  return savedPlan.value;
}

function savePlan() {
  const input = chat.pendingControlRequest?.tool_input as Record<string, unknown> | undefined;
  if (input?.plan) {
    savedPlan.value = { plan: input.plan as string, planFilePath: (input.planFilePath as string) || "" };
  }
}

function isPlanPending() {
  return chat.pendingControlRequest?.tool_name === "ExitPlanMode";
}

async function approvePlan() {
  const cr = chat.pendingControlRequest; if (!cr) return;
  const sid = session.activeSessionId;
  if (!sid) return;
  savePlan();
  try {
    // 批准 ExitPlanMode
    await sendStdin(sid, JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: cr.request_id || "",
        response: { behavior: "allow", updatedInput: cr.tool_input },
      },
    }));
    // 切换到 acceptEdits 模式执行计划（绕过 CC SDK 已知 bug：plan→acceptEdits 无限循环）
    await sendStdin(sid, JSON.stringify({
      type: "control_request",
      request_id: `setmode_${Date.now()}`,
      request: { subtype: "set_permission_mode", mode: "acceptEdits" },
    }));
    settings.planMode = false;
    settings.permissionMode = "acceptEdits";
    planFeedback.value = "";
    chat.resolveControlRequest("allow");
  } catch (e) {
    console.error("Plan approval failed:", e);
    showStatus(t("chat.planError") || "计划执行失败，请重试");
    chat.resolveControlRequest("deny");
  }
}

async function rejectPlan(message: string) {
  const cr = chat.pendingControlRequest; if (!cr) return;
  const sid = session.activeSessionId;
  if (!sid) return;
  savePlan();
  try {
    await sendStdin(sid, JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: cr.request_id || "",
        response: { behavior: "deny", message: message || "Plan rejected" },
      },
    }));
  } catch (e) {
    console.error("Plan rejection failed:", e);
  } finally {
    planFeedback.value = "";
    chat.resolveControlRequest("deny");
  }
}

async function exportPlan() {
  const { plan } = getPlan();
  if (!plan) return;
  const blob = new Blob([plan], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "plan.md";
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Stop processing ──
async function handleStop() {
  const sid = settings.zenMode ? session.zenActiveId : session.activeSessionId;
  if (!sid) return;
  // 禅模式：无 CC 进程可终止，直接标记停止
  if (settings.zenMode) {
    chat.markStopped();
    chat.finishAssistantMessage();
    return;
  }
  // 先标记停止（必须在 interrupt 之前，否则 CC 的 result 事件会先触发 finish 清掉 currentAssistantMsg）
  chat.markStopped();
  // 发 interrupt 控制请求，让 CC 优雅中断
  try {
    await sendStdin(sid, JSON.stringify({
      type: "control_request",
      request_id: `interrupt_${Date.now()}`,
      request: { subtype: "interrupt" },
    }));
  } catch {}
  // 等待 3 秒让 CC 优雅退出，超时再强杀
  await new Promise(r => setTimeout(r, 3000));
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
      <details v-if="showTestPanel" class="mx-auto mb-3 text-[11px]" style="color:var(--text-muted); max-width:48rem; position:sticky; top:0; z-index:5; background:var(--bg-root)">
        <summary class="cursor-pointer py-1 hover:text-[var(--accent)]">🧪 测试弹窗</summary>
        <div class="flex flex-wrap gap-1.5 mt-2 ml-2">
          <button @click="runTest(testQuestion)" class="btn-ghost" style="font-size:11px; padding:0.15rem 0.5rem">AskUserQuestion</button>
          <button @click="runTest(testPlan)" class="btn-ghost" style="font-size:11px; padding:0.15rem 0.5rem">PlanReview</button>
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
        <div class="welcome-page">
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
      <div v-if="chat.pendingControlRequest && chat.pendingControlRequest.tool_name !== 'AskUserQuestion' && chat.pendingControlRequest.tool_name !== 'ExitPlanMode'" class="approval-bar">
        <div class="w-0.5 h-5 rounded-full shrink-0" style="background:var(--accent)" />
        <span class="text-xs flex-1" style="color:var(--text-secondary)">{{ $t('chat.allowTool', { tool: toolLabel(chat.pendingControlRequest.tool_name || '') }) }}</span>
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


      <!-- Toolbar（禅模式下隐藏——模式/effort/Ponytail 对直接 LLM 无意义） -->
      <InputBarToolbar
      v-if="!settings.zenMode"
      @attach-file="handleAttachFile"
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
    </InputBarToolbar>

    <!-- 禅模式指示器 — 点击退出禅模式 -->
    <div
      v-if="settings.zenMode"
      class="sb-toolbar"
    >
      <button
        @click="emitGlobalCommand('zen-mode')"
        class="text-[11px] px-1.5 py-0.5 rounded font-medium shrink-0 cursor-pointer transition-colors hover:opacity-80"
        :style="{ color: 'var(--accent)', background: 'var(--accent-glow)' }"
        :title="$t('header.exitZenMode')"
      >
        <img
          v-if="PROVIDER_LOGOS[settings.providerId]"
          :src="PROVIDER_LOGOS[settings.providerId]"
          class="w-3.5 h-3.5 shrink-0 inline-block align-middle"
          alt=""
        />
        <span v-else>🤖</span>
        {{ $t('chat.zenActive') }} · {{ $t('header.exitZenMode') }}
      </button>
    </div>

    <!-- 已保存计划的快捷入口 + 附件 chips — 无内容时不占高度 -->
    <div v-if="(savedPlan.plan && !isPlanPending()) || attachedFiles.length > 0 || textSnippet" class="sb-attachment-bar">
      <button
        v-if="savedPlan.plan && !isPlanPending()"
        @click="showPlanModal = true"
        class="attach-chip chip--clickable"
        :style="{ color: 'var(--text-muted)', border: '1px dashed var(--border-dim)' }"
      >📋 {{ $t('chat.viewPlan') }}</button>
      <!-- 统一选区卡片（DOM / Excel / 文本划选 / MD） -->
      <div
        v-if="textSnippet"
        class="attach-chip"
        :style="{ background: 'var(--accent-glow)', border: '1px solid var(--accent-dim)', color: 'var(--accent)' }"
      >
        <span class="attach-chip-name">{{ textSnippet.label }}</span>
        <button @click="removeTextSnippet" class="icon-btn-sm shrink-0">×</button>
      </div>
      <!-- Attached files chips -->
      <div
        v-for="(file, i) in attachedFiles"
        :key="file.path"
        class="attach-chip chip--clickable max-w-[220px]"
        :style="{ background: 'var(--bg-elevated)', border: '1px solid var(--border-dim)', color: 'var(--text-secondary)' }"
        @click="openFileInPanel(file)"
      >
        <!-- File thumbnail / icon -->
        <img
          v-if="isImageFile(file.name)"
          :src="thumbnails[file.path] || ''"
          @vue:mounted="getThumbnail(file.path, file.name)"
          class="w-5 h-5 rounded object-cover shrink-0"
          style="border: 1px solid var(--border-dim)"
          v-show="thumbnails[file.path]"
        />
        <svg v-else width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" class="shrink-0"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
        <span class="attach-chip-name" :title="file.path">{{ file.name }}</span>
        <button
          @click.stop="removeAttachedFile(i)"
          class="w-4 h-4 flex items-center justify-center rounded transition-colors hover:bg-[var(--bg-hover)] shrink-0 opacity-50 group-hover:opacity-100"
          style="color: var(--text-secondary)"
          :title="$t('chat.remove')"
        >&times;</button>
      </div>
    </div>

    <!-- File preview modal -->
    <!-- 文件预览统一由 AppShell 第四列处理 -->
    <ContextUsageModal :open="showContextModal" @close="showContextModal = false" @compact="showContextModal = false; handleSend('/compact')" />
    <ManagePanel :open="showManage" :initialTab="manageTab" @close="showManage = false" @send-slash="(t) => handleSend(t)" />

    <!-- AskUserQuestion 问答弹窗 -->
    <ModalShell :open="chat.pendingControlRequest?.tool_name === 'AskUserQuestion'" size="md" position="top" @close="skipQuestions">
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
                :type="q.multiSelect ? 'checkbox' : 'radio'"
                :name="`q_${qi}`"
                :checked="q.multiSelect
                  ? (Array.isArray(questionAnswers.get(q.question)) && (questionAnswers.get(q.question) as string[]).includes(opt.label))
                  : questionAnswers.get(q.question) === opt.label"
                @change="toggleAnswer(q.question, opt.label, q.multiSelect)"
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
                :type="q.multiSelect ? 'checkbox' : 'radio'"
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

    <!-- ExitPlanMode 计划审核弹窗（审批中或已保存重新打开）-->
    <ModalShell :open="isPlanPending() || showPlanModal" size="xl" position="top" @close="isPlanPending() ? rejectPlan('Plan review cancelled') : (showPlanModal = false)">
      <template #header>
        <div class="flex items-center gap-2">
          <span class="text-sm font-semibold" :style="{ color: 'var(--text-bright)' }">{{ $t('chat.planReview') }}</span>
          <span class="text-[10px] font-mono opacity-50" :style="{ color: 'var(--text-muted)' }">{{ getPlan().planFilePath }}</span>
        </div>
      </template>
      <!-- 计划内容 -->
      <div class="max-h-[55vh] overflow-y-auto">
        <MarkdownRenderer v-if="getPlan().plan" :content="getPlan().plan" />
        <div v-else class="text-xs py-8 text-center" :style="{ color: 'var(--text-muted)' }">{{ $t('chat.noPlanContent') }}</div>
      </div>
      <!-- 反馈输入 -->
      <div class="mt-3">
        <input
          v-model="planFeedback"
          :placeholder="$t('chat.planFeedbackPlaceholder')"
          class="input-plain"
          :style="{ background: 'var(--bg-elevated)', border: '1px solid var(--border-dim)', color: 'var(--text-primary)', caretColor: 'var(--accent)' }"
          @keydown.enter="rejectPlan(planFeedback)"
        />
      </div>
      <template #footer>
        <div v-if="isPlanPending()" class="action-bar action-bar--start flex-wrap">
          <button @click="approvePlan()" class="px-3 py-1.5 rounded text-xs font-medium transition-colors hover:brightness-110" :style="{ background: 'var(--accent)', color: 'var(--bg-root)' }">✅ {{ $t('chat.planExecute') }}</button>
          <button @click="rejectPlan('继续优化计划设计')" class="btn-ghost" :style="{ color: 'var(--text-secondary)', border: '1px solid var(--border-dim)' }">✏️ {{ $t('chat.planContinueDesign') }}</button>
          <button @click="rejectPlan('停止计划')" class="btn-ghost" :style="{ color: 'var(--text-secondary)', border: '1px solid var(--border-dim)' }">⏹ {{ $t('chat.planStop') }}</button>
          <button @click="exportPlan()" class="btn-ghost" :style="{ color: 'var(--text-muted)', border: '1px dashed var(--border-dim)' }">📤 {{ $t('chat.planExport') }}</button>
          <button
            v-if="planFeedback"
            @click="rejectPlan(planFeedback)"
            class="px-3 py-1.5 rounded text-xs font-medium transition-colors hover:bg-[var(--bg-hover)] ml-auto"
            :style="{ color: 'var(--text-secondary)', border: '1px solid var(--border-dim)' }"
          >💬 {{ $t('chat.planOther') }}</button>
        </div>
        <div v-else class="flex items-center justify-end">
          <button @click="exportPlan()" class="btn-ghost" :style="{ color: 'var(--text-muted)', border: '1px dashed var(--border-dim)' }">📤 {{ $t('chat.planExport') }}</button>
          <button @click="showPlanModal = false" class="px-3 py-1.5 rounded text-xs transition-colors hover:bg-[var(--bg-hover)] ml-2" :style="{ color: 'var(--text-muted)' }">{{ $t('chat.close') }}</button>
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
          © 2026 Super Bazooka contributors · MIT
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

    <!-- Input -->
    <InputBar ref="inputBar" :disabled="chat.isProcessing" :auto-mode="autoModeActive" :api-key="settings.apiKey" :base-url="settings.baseUrl" @send="handleSend" @stop="handleStop" @files="(fs) => { for (const f of fs) { if (!attachedFiles.some(af => af.path === f.path)) attachedFiles.push(f); } }" />
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
</style>
