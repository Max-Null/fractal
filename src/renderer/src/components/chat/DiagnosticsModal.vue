<script lang="ts">
// 诊断信息弹窗：独立组件，承载事件日志/引擎日志/控制台日志三标签页查看与复制
// 事件日志行分类：❌ 错误、⚠️ 警告，其余普通行（供行级高亮，D7）
// 普通 script 块承载纯函数，允许顶层 export（script setup 不允许 ES module export）
export function classifyLogLine(text: string): "error" | "warn" | "normal" {
  if (text.startsWith("❌")) return "error";
  if (text.startsWith("⚠️")) return "warn";
  return "normal";
}
</script>

<script setup lang="ts">
import { ref, computed, nextTick, watch, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { Copy, ClipboardCopy, RefreshCw } from "lucide-vue-next";
import ModalShell from "@/components/shared/ModalShell.vue";
import { useDebugLog } from "@/composables/useDebugLog";
import { readServeLog, readRendererLog, getAppInfo } from "@/lib/electron-bridge";

// props: open（父级控制显隐）；emit close（ESC / 遮罩 / × 三通道关闭，ModalShell 处理）
const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
// debugLog 全局单例：跨组件写入（useStreamProcessor）与读取（ChatPanel 打开按钮行数）共享
const debugLog = useDebugLog();

// 复制操作的状态提示（组件自包含，不复用 ChatPanel 的 statusMessage）
const statusMessage = ref("");
let statusTimer: ReturnType<typeof setTimeout> | null = null;
function showStatus(msg: string) {
  statusMessage.value = msg;
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { statusMessage.value = ""; }, 5000);
}

// ── 标签页状态（D4：serve/renderer 状态均为组件内部 ref；debugLog 保持全局）──
const debugTab = ref<"events" | "serve" | "renderer">("events");
const serveLogLines = ref<string[]>([]);
const serveLogLoading = ref(false);
const serveLogError = ref("");
const serveLogPre = ref<HTMLElement | null>(null);
const rendererLogLines = ref<string[]>([]);
const rendererLogLoading = ref(false);
const rendererLogError = ref("");
const rendererLogPre = ref<HTMLElement | null>(null);

// 事件日志行 → 行级高亮（D7：❌ error / ⚠️ warn / 其他 normal）
const eventLines = computed(() =>
  debugLog.lines.value.map((text) => ({ text, level: classifyLogLine(text) })),
);
// 当前标签页实际行数（D8：行数与内容对应，显示在标签页栏右侧，消除「标题数字与内容无关」）
const currentLineCount = computed(() =>
  debugTab.value === "events" ? debugLog.lines.value.length
    : debugTab.value === "serve" ? serveLogLines.value.length
    : rendererLogLines.value.length,
);

function switchDebugTab(tab: "events" | "serve" | "renderer") {
  debugTab.value = tab;
  // 进入引擎/控制台页即拉取尾部 500 行（切页立即显示，轮询随后接管持续更新）
  if (tab === "serve") void loadServeLog();
  if (tab === "renderer") void loadRendererLog();
}

// 定时轮询：弹窗打开且当前标签页为 serve/renderer 时每 3s 自动重读日志
// 切到 events 页或关闭弹窗即停——只轮询用户正在查看的页，避免无谓 IPC
let pollTimer: ReturnType<typeof setInterval> | null = null;
watch(
  () => [props.open, debugTab.value] as const,
  ([open, tab]) => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (open && (tab === "serve" || tab === "renderer")) {
      pollTimer = setInterval(() => {
        // 用 debugTab.value 而非闭包 tab：即使 watch 未触发也能读最新值
        if (debugTab.value === "serve") void loadServeLog();
        else void loadRendererLog();
      }, 3000);
    }
  },
  { immediate: true },
);

onUnmounted(() => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (statusTimer) clearTimeout(statusTimer);
});

async function loadServeLog() {
  // 轮询/手动刷新共用入口：上次请求未完成时跳过本次（防 3s 轮询堆积）
  if (serveLogLoading.value) return;
  serveLogLoading.value = true;
  try {
    serveLogLines.value = await readServeLog(500);
    serveLogError.value = "";
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

async function loadRendererLog() {
  // 轮询/手动刷新共用入口：上次请求未完成时跳过本次（防 3s 轮询堆积）
  if (rendererLogLoading.value) return;
  rendererLogLoading.value = true;
  try {
    rendererLogLines.value = await readRendererLog(500);
    rendererLogError.value = "";
  } catch (e) {
    rendererLogError.value = String(e);
  } finally {
    rendererLogLoading.value = false;
    nextTick().then(() => {
      if (rendererLogPre.value) rendererLogPre.value.scrollTop = rendererLogPre.value.scrollHeight;
    });
  }
}

// 复制文本到剪贴板（textarea 兼容法，无 navigator.clipboard 权限问题）
function copyText(text: string) {
  const ta = document.createElement("textarea");
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
}

// 复制当前标签页内容（事件日志=会话 debug 行；引擎日志=serve.log 尾部；控制台=renderer.log 尾部）
function copyDebugLog() {
  const text = debugTab.value === "events" ? debugLog.lines.value.join("\n")
    : debugTab.value === "serve" ? serveLogLines.value.join("\n")
    : rendererLogLines.value.join("\n");
  copyText(text);
  showStatus(t("chat.copied"));
}

// 复制诊断信息（全量包，用户反馈通道）：应用名 + 版本 + 事件日志 + serve.log + renderer.log
// serve/renderer 读取失败不阻断——降级为空段，避免一个失败整包不可用（readRendererLog 在非调试启动可能无日志）
async function copyDiagnostics() {
  try {
    const info = await getAppInfo();
    const [serveRes, rendererRes] = await Promise.allSettled([readServeLog(500), readRendererLog(500)]);
    const serveLines = serveRes.status === "fulfilled" ? serveRes.value : [];
    const rendererLines = rendererRes.status === "fulfilled" ? rendererRes.value : [];
    const body = [
      `${info.name} v${info.version}`,
      "",
      `[${t("chat.debugLabel")}]`,
      ...debugLog.lines.value,
      "",
      `[${t("chat.debugServeTab")}]`,
      ...serveLines,
      "",
      `[${t("chat.debugRendererTab")}]`,
      ...rendererLines,
    ].join("\n");
    copyText(body);
    showStatus(`${t("chat.copied")} — ${t("chat.debugPrivacyHint")}`);
  } catch (e) {
    showStatus(t("status.exportFail", { error: String(e) }));
  }
}
</script>

<template>
  <ModalShell :open="open" size="xl" @close="emit('close')">
    <!-- header：固定标题（D8 不显示行数）+ 复制诊断信息主按钮（ModalShell 自带 × 关闭） -->
    <template #header>
      <span class="diag-title">{{ t("chat.debugTitle") }}</span>
      <span class="flex-1" />
      <button class="diag-header-btn" :title="t('chat.debugCopyDiag')" @click="copyDiagnostics">
        <ClipboardCopy :size="13" />
        <span>{{ t("chat.debugCopyDiag") }}</span>
      </button>
    </template>

    <!-- body：标签页栏（含当前行数 D8）+ 日志内容区 -->
    <div class="diag-tabs">
      <button
        class="diag-tab"
        :class="{ 'diag-tab--active': debugTab === 'events' }"
        @click="switchDebugTab('events')"
      >{{ t("chat.debugLabel") }}</button>
      <button
        class="diag-tab"
        :class="{ 'diag-tab--active': debugTab === 'serve' }"
        @click="switchDebugTab('serve')"
      >{{ t("chat.debugServeTab") }}</button>
      <button
        class="diag-tab"
        :class="{ 'diag-tab--active': debugTab === 'renderer' }"
        @click="switchDebugTab('renderer')"
      >{{ t("chat.debugRendererTab") }}</button>
      <span class="flex-1" />
      <!-- D8：当前标签页实际行数 -->
      <span class="diag-count">{{ currentLineCount }}</span>
      <!-- 复制当前标签页（与标签页绑定，放标签页栏；header 只留复制诊断信息主按钮） -->
      <button class="diag-tab-btn diag-tab-btn--copy" :title="t('chat.debugCopyTab')" @click="copyDebugLog">
        <Copy :size="12" />
        <span>{{ t("chat.debugCopyTab") }}</span>
      </button>
      <!-- 引擎/控制台页刷新（面板不自动轮询，原型 4.3） -->
      <button
        v-if="debugTab === 'serve' || debugTab === 'renderer'"
        class="diag-tab-btn"
        :title="t('chat.debugRefresh')"
        @click="debugTab === 'serve' ? loadServeLog() : loadRendererLog()"
      >
        <RefreshCw :size="12" />
      </button>
    </div>

    <div class="diag-log">
      <!-- 事件日志：逐行渲染 + 行级高亮（D7：pre 整块无法按行着色，逐行是必要改造） -->
      <template v-if="debugTab === 'events'">
        <div
          v-for="(line, i) in eventLines"
          :key="i"
          class="diag-log-line"
          :class="`diag-log-line--${line.level}`"
        >{{ line.text }}</div>
      </template>

      <!-- 引擎日志：serve.log 尾部只读（超长自动滚到底） -->
      <div v-else-if="debugTab === 'serve'" ref="serveLogPre" class="diag-log-body">
        <template v-if="serveLogLines.length > 0">
          <div v-for="(line, i) in serveLogLines" :key="i" class="diag-log-line">{{ line }}</div>
        </template>
        <div v-else class="diag-log-empty">
          <span v-if="serveLogLoading">{{ t("chat.loading") }}</span>
          <span v-else-if="serveLogError">{{ serveLogError }}</span>
          <span v-else>{{ t("chat.debugNoServeLog") }}</span>
        </div>
      </div>

      <!-- 控制台日志：渲染层 console 桥落盘（仅调试模式有内容——--debug 启动后 renderer.log） -->
      <div v-else-if="debugTab === 'renderer'" ref="rendererLogPre" class="diag-log-body">
        <template v-if="rendererLogLines.length > 0">
          <div v-for="(line, i) in rendererLogLines" :key="i" class="diag-log-line">{{ line }}</div>
        </template>
        <div v-else class="diag-log-empty">
          <span v-if="rendererLogLoading">{{ t("chat.loading") }}</span>
          <span v-else-if="rendererLogError">{{ rendererLogError }}</span>
          <span v-else>{{ t("chat.debugNoRendererLog") }}</span>
        </div>
      </div>
    </div>

    <!-- footer：复制状态反馈 + 隐私提示（D9） -->
    <template #footer>
      <div class="diag-footer">
        <span v-if="statusMessage" class="diag-footer-status">{{ statusMessage }}</span>
        <span class="flex-1" />
        <span class="diag-footer-hint">{{ t("chat.debugFooter") }}</span>
      </div>
    </template>
  </ModalShell>
</template>

<style scoped>
/* 诊断弹窗样式：语义化 .diag-*（替代原 attach-bar/system-msg-bar 借用 + 内联 style） */
/* 属性排序：定位 → 盒模型 → 排版 → 视觉 */

.diag-title {
  color: var(--text-bright);
  font-size: 0.786rem;
  font-weight: 500;
}

/* header 操作按钮：图标 + 文本（复制诊断信息），hover 提亮 */
.diag-header-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.25rem 0.5rem;
  border-radius: 0.25rem;
  color: var(--text-muted);
  font-size: 0.786rem;
  cursor: pointer;
  transition: color 0.15s, background-color 0.15s;
}

.diag-header-btn:hover {
  color: var(--text-bright);
  background: var(--bg-hover);
}

/* 标签页栏：与内容区同行顶部，底部边框分隔 */
.diag-tabs {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0 0 0.5rem;
  border-bottom: 1px solid var(--border-dim);
}

.diag-tab {
  padding: 0.25rem 0.5rem;
  border-radius: 0.25rem;
  color: var(--text-muted);
  font-size: 0.786rem;
  cursor: pointer;
  transition: color 0.15s, background-color 0.15s;
}

.diag-tab:hover {
  background: var(--bg-hover);
}

/* 激活态：提亮 + 底色，标识当前标签页 */
.diag-tab--active {
  color: var(--text-bright);
  background: var(--bg-hover);
}

/* 当前标签页行数（D8：与内容对应，消除「标题数字与内容无关」混乱） */
.diag-count {
  color: var(--text-muted);
  font-size: 0.714rem;
}

/* 刷新按钮：仅引擎/控制台页显示 */
.diag-tab-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.25rem;
  border-radius: 0.25rem;
  color: var(--text-muted);
  cursor: pointer;
  transition: color 0.15s, background-color 0.15s;
}

/* 复制当前标签页：带文字，需要稍大内边距 + 图标文字间距 */
.diag-tab-btn--copy {
  gap: 0.25rem;
  padding: 0.25rem 0.5rem;
  font-size: 0.75rem;
}

.diag-tab-btn:hover {
  color: var(--text-bright);
  background: var(--bg-hover);
}

/* 日志内容区：只读代码块观感，超长滚动 */
.diag-log {
  max-height: 55vh;
  overflow-y: auto;
  margin-top: 0.5rem;
  border: 1px solid var(--border-dim);
  border-radius: 0;
  background: var(--bg-elevated);
}

/* serve/renderer 页滚动容器（ref 挂载点，供超长自动滚底） */
.diag-log-body {
  padding: 0.25rem 0;
}

/* 日志行：保留换行语义（pre-wrap），超长断行 */
.diag-log-line {
  padding: 0.125rem 0.75rem;
  color: var(--text-muted);
  font-size: 0.786rem;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
}

/* 错误行（D7：❌ 前缀，danger 色） */
.diag-log-line--error {
  color: var(--danger, #f87171);
}

/* 警告行（D7：⚠️ 前缀，warning 色） */
.diag-log-line--warn {
  color: var(--warning, #fbbf24);
}

/* 空态 / 加载中 / 读取失败提示 */
.diag-log-empty {
  padding: 0.75rem;
  color: var(--text-muted);
  font-size: 0.786rem;
}

.diag-footer {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

/* 复制操作反馈：短暂显示后消失（5s） */
.diag-footer-status {
  color: var(--accent, #60a5fa);
  font-size: 0.714rem;
}

.diag-footer-hint {
  color: var(--text-muted);
  font-size: 0.714rem;
}
</style>
