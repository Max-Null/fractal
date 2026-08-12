<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { useRouter } from "vue-router";
import { useSettingsStore } from "@/stores/settings";
import { useChatStore } from "@/stores/chat";
import { useI18n } from "vue-i18n";
import { testConnection, sendMessage, openDialog, getAppInfo, getBalance, type DeepSeekBalanceResult, type ConnectionTestResult } from "@/lib/electron-bridge";
import { emitChatCommand } from "@/composables/useCommandPalette";
import { useSessionStore } from "@/stores/session";

const appVersion = __APP_VERSION__;
import { translateError } from "@/lib/utils";

import ErrorBoundary from "@/components/shared/ErrorBoundary.vue";
import ModalShell from "@/components/shared/ModalShell.vue";
import MarkdownRenderer from "@/components/shared/MarkdownRenderer.vue";
import SettingsJsonEditor from "./SettingsJsonEditor.vue";
import changelogRaw from "../../../docs/变更记录.md?raw";

// Windows CRLF → LF 归一化，防止 MarkdownRenderer 解析失败
const changelogContent = changelogRaw.replace(/\r\n/g, "\n");

const router = useRouter();
const { t } = useI18n();
const settings = useSettingsStore();
const chat = useChatStore();
const sessionStore = useSessionStore();

// ── 上下文窗口输入（支持 128K / 1M 简写）──
const contextLimitInput = ref("");
watch(() => settings.contextLimit, (v) => {
  if (v > 0 && contextLimitInput.value === "") contextLimitInput.value = formatTokens(v);
}, { immediate: true });

function formatTokens(n: number): string {
  if (n >= 1_000_000 && n % 1_000_000 === 0) return (n / 1_000_000) + "M";
  if (n >= 1_000 && n % 1_000 === 0) return (n / 1_000) + "K";
  return String(n);
}

// 选择工作目录：写 store + 通知会话侧收面板；serve 侧目录切换待阶段 6 配置体系
async function handleWorkspacePick() {
  const selected = await openDialog({ directory: true, title: "选择工作目录" });
  if (!selected) return;
  const p = Array.isArray(selected) ? selected[0] : selected;
  settings.cwd = p;
  settings.addRecentWorkspace(p);
  emitChatCommand(`switch-workspace:${p}`);
}

function parseContextLimit() {
  const raw = contextLimitInput.value.trim().toUpperCase();
  // 空或 0 → 自动检测
  if (!raw || raw === "0") { settings.contextLimit = 0; contextLimitInput.value = ""; return; }
  // 简写格式
  const m = raw.match(/^(\d+(?:\.\d+)?)\s*M$/);
  if (m) { settings.contextLimit = Math.round(parseFloat(m[1]) * 1_000_000); return; }
  const k = raw.match(/^(\d+(?:\.\d+)?)\s*K$/);
  if (k) { settings.contextLimit = Math.round(parseFloat(k[1]) * 1_000); return; }
  // 纯数字
  const n = parseInt(raw, 10);
  if (!isNaN(n)) { settings.contextLimit = Math.max(0, n); return; }
  // 解析失败 → 回退为当前有效值
  contextLimitInput.value = settings.contextLimit > 0 ? formatTokens(settings.contextLimit) : "";
}

// ── 聊天 API 地址静默查询 ──
const isLookingUpUrl = ref(false);

async function startLookupUrl() {
  const prompt = `请联网查询 DeepSeek 服务商的模型 ${settings.model} 的 OpenAI 兼容 chat completions API 完整端点 URL，只输出 URL 不要任何解释`;
  isLookingUpUrl.value = true;
  let sid = sessionStore.activeSessionId;
  if (!sid) {
    // cwd 绑当前工作区：与 ChatPanel 创建会话一致，否则会话列表按工作区过滤后找不到该会话
    sid = await sessionStore.createSession(settings.model, settings.cwd, undefined, settings.locale);
    chat.clearMessages();  // 新建会话时清空旧消息记录
  }
  chat.addUserMessage(prompt);
  // 非中途发送才新建 assistant 消息位
  if (!chat.isProcessing) chat.startAssistantMessage();
  chat.isProcessing = true;
  sendMessage(sid, prompt, {
    planMode: false,
    autoMode: false,
    permissionMode: "bypassPermissions",  // 静默查询不能卡权限弹窗
    variant: settings.modelVariants.includes("low") ? "low" : undefined,
    model: settings.model,
  }).catch((e) => {
    isLookingUpUrl.value = false;
    console.error("URL 查询失败:", e);
  });
}

// 标志位打开时，监听新完成的 assistant 消息，提取 URL 自动填入
watch(() => chat.messages.map(m => m.isStreaming), () => {
  if (!isLookingUpUrl.value) return;
  const msgs = chat.messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === "assistant" && !m.isStreaming && m.content) {
      const match = m.content.match(/https?:\/\/[^\s"'`<>]+/i);
      if (match) {
        const url = match[0].replace(/[.,;!?。，；！？)]+$/, '');
        // 仅接受 https URL，防止幻觉或响应被篡改时注入危险地址
        if (url.startsWith("https://")) {
          settings.optimizeApiUrl = url;
        }
        isLookingUpUrl.value = false;
        return;
      }
    }
  }
});

// ── 权限模式 computed（与工具栏 activeMode 逻辑一致）──
// auto/dontAsk 已从选项移除（CC 遗留）——旧配置值归并到 bypassPermissions（全自动语义）
const activeMode = computed({
  get: () => {
    if (settings.planMode) return "plan";
    if (settings.autoMode) return "bypassPermissions";
    if (settings.permissionMode === "bypassPermissions") return "bypassPermissions";
    if (settings.permissionMode === "dontAsk") return "bypassPermissions";
    if (settings.permissionMode === "acceptEdits") return "acceptEdits";
    return "default";
  },
  set: (v: string) => {
    settings.planMode = v === "plan";
    settings.autoMode = v === "bypassPermissions";
    settings.permissionMode =
      v === "bypassPermissions" ? "bypassPermissions"
      : v === "acceptEdits" ? "acceptEdits"
      : "default";
  },
});

// ── 自定义下拉 ──
type DropdownKind = "lang" | "theme" | "font" | "perm" | "effort" | "model" | "smallModel" | "layout" | "logLevel";
const openDropdown = ref<DropdownKind | null>(null);
function toggleDropdown(k: DropdownKind) {
  openDropdown.value = openDropdown.value === k ? null : k;
}
function closeDropdowns() { openDropdown.value = null; }
function onBodyClick(e: MouseEvent) {
  if (!(e.target as HTMLElement).closest(".settings-dropdown")) closeDropdowns();
}
onMounted(() => document.addEventListener("click", onBodyClick));
onUnmounted(() => document.removeEventListener("click", onBodyClick));

// ── 关于区版本信息：OC 引擎版本 + 预置包版本（app:getInfo 异步获取；失败兜底占位符，不影响渲染）──
const engineVersion = ref("—");
const presetVersion = ref("—");
onMounted(async () => {
  try {
    const info = await getAppInfo();
    engineVersion.value = info.engineVersion || "—";
    presetVersion.value = info.presetVersion || "—";
  } catch {
    // 桥未就绪/主进程异常 → 保持兜底 '—'，关于区仍显示分形版本
  }
});

// ── 权限模式选项（对齐操作行 4 模式：全部询问/自动编辑/完全放行/计划；auto/dontAsk 为 CC 遗留已移除——
// 全自动语义由 bypassPermissions 承担（OC --auto 映射）；旧 autoMode 配置兼容读取）──
interface PermOption { value: "plan" | "default" | "acceptEdits" | "bypassPermissions"; icon: string; cliKey: string; labelKey: string; descKey: string }
const permOptions: PermOption[] = [
  { value: "plan",       icon: "📋", cliKey: "plan",             labelKey: "mode.plan",       descKey: "mode.planDesc" },
  { value: "default",    icon: "🔒", cliKey: "default",          labelKey: "mode.askBefore",  descKey: "mode.askBeforeDesc" },
  { value: "acceptEdits",icon: "✏️", cliKey: "acceptEdits",      labelKey: "mode.editAuto",   descKey: "mode.editAutoDesc" },
  { value: "bypassPermissions", icon: "⚡", cliKey: "bypassPermissions", labelKey: "mode.bypass", descKey: "mode.bypassDesc" },
];
const currentPerm = computed(() => permOptions.find(o => o.value === activeMode.value)!);

// ── 思考深度选项（variant 语义：选项 = 当前模型可用 variants 的映射子集，映射表仅 low/high/max 三档）──
interface EffortOption { value: import("@/stores/settings").Effort; icon: string; cliKey: string; labelKey: string; color: string }
const EFFORT_VARIANTS: Record<string, Omit<EffortOption, "value">> = {
  low:  { icon: "🐢", cliKey: "low",    color: "#22c55e", labelKey: "mode.effort.low" },
  high: { icon: "🧠", cliKey: "high",   color: "#f59e0b", labelKey: "mode.effort.high" },
  max:  { icon: "🚀", cliKey: "max",    color: "#ef4444", labelKey: "mode.effort.max" },
};
/** 按 settings.modelVariants 动态过滤（顺序固定 low/high/max）；无 variants 时为空数组（模板 v-if 隐藏下拉） */
const effortOptions = computed<EffortOption[]>(() => {
  const order = ["low", "high", "max"] as const;
  return order
    .filter((v) => settings.modelVariants.includes(v))
    .map((v) => ({ value: v, ...EFFORT_VARIANTS[v] }));
});
/** effort 空（模型无 variants）时回退第一个可用档，避免 find 非空断言崩溃 */
const currentEffort = computed(() => effortOptions.value.find(o => o.value === settings.effort) ?? effortOptions.value[0]);

// ── 轻量模型选项（LOW 槽位：标题生成/会话摘要/消息润色；值=模型全名，空=跟随主模型）──
const smallModelOptions: Array<{ value: string; labelKey: string }> = [
  { value: "", labelKey: "settings.smallModelFollow" },
  { value: "deepseek/deepseek-v4-flash", labelKey: "settings.smallModelFlash" },
  { value: "deepseek/deepseek-v4-pro", labelKey: "settings.smallModelPro" },
];
const currentSmallModel = computed(() => smallModelOptions.find(o => o.value === settings.smallModel) ?? smallModelOptions[0]);

/** 选择轻量模型 → 立即写 settings.json（主进程 saveSettings 引擎联动自动同步 opencode.json small_model，无需重启） */
async function handleSmallModelSelect(v: string) {
  settings.smallModel = v;
  closeDropdowns();
  try {
    await settings.persistSmallModel(v);
  } catch {
    // 写盘失败仅 console 记录（settings.json 不可写仍可运行，仅轻量模型选择重启后不恢复）
    console.error("[settings] 轻量模型保存 settings.json 失败", v);
  }
}

// ── 语言 / 主题选项 ──
interface SimpleOption<V extends string> { value: V; labelKey: string }
const langOptions: SimpleOption<"zh" | "en">[] = [
  { value: "zh", labelKey: "中文" },
  { value: "en", labelKey: "English" },
];
const themeOptions: SimpleOption<"dark" | "light" | "system">[] = [
  { value: "dark", labelKey: "settings.themeDark" },
  { value: "light", labelKey: "settings.themeLight" },
  { value: "system", labelKey: "settings.themeSystem" },
];
const currentLang = computed(() => langOptions.find(o => o.value === settings.locale)!);
const currentTheme = computed(() => themeOptions.find(o => o.value === settings.theme)!);
const fontSizeOptions: SimpleOption<"small" | "medium" | "large">[] = [
  { value: "small", labelKey: "settings.fontSizeSmall" },
  { value: "medium", labelKey: "settings.fontSizeMedium" },
  { value: "large", labelKey: "settings.fontSizeLarge" },
];
const currentFontSize = computed(() => fontSizeOptions.find(o => o.value === settings.fontSize)!);

// ── 消息排布选项（B1：ui.messageLayout，原型 v0.4 文案；split=现状默认）──
const layoutOptions: SimpleOption<"left" | "split">[] = [
  { value: "left", labelKey: "settings.layoutLeft" },
  { value: "split", labelKey: "settings.layoutSplit" },
];
const currentLayout = computed(() => layoutOptions.find(o => o.value === settings.messageLayout)!);

// ── 头像 emoji 快捷选择（B1：ui.avatar，原型 v0.15 avatar-picker 简化版：常用 emoji 点选 + 手动输入）──
const AVATAR_EMOJIS = ["🐱", "🐶", "🦊", "🐼", "🐸", "🐙", "🦋", "🌻", "🚀", "⭐", "🌈", "🍀"];

// ── OC 可执行文件路径浏览（B1：engine.opencodePath；空=内置 sidecar/系统自动解析）──
async function handleOpencodePathPick() {
  const selected = await openDialog({ directory: false, title: t("settings.opencodePathPick") });
  if (!selected) return;
  const p = Array.isArray(selected) ? selected[0] : selected;
  settings.opencodePath = p;
}

// ── 模型预设（DeepSeek 专属，store 已固定）──
const modelPresets = computed(() => settings.models);

// ── 连接测试 ──
const testResult = ref<ConnectionTestResult | null>(null);
const testError = ref<string | null>(null);
const translatedTestError = computed(() => {
  if (!testError.value) return null;
  const { key, params } = translateError(testError.value);
  return t(key, params as Record<string, string>);
});
const isTesting = ref(false);

async function handleTest() {
  testResult.value = null; testError.value = null; isTesting.value = true;
  try {
    // 分形主链路：engine:testConnection 写 key 到 serve 隔离配置 + 验证 serve 可达
    const r = await testConnection(settings.apiKey);
    if (r.ok) {
      // 模板按 ✓ 前缀判定绿色（成功）；chat 字段展示写入详情
      testResult.value = { cc: "✓ serve 连接成功", chat: "✓ " + r.message };
      // 用户主动换 key：重启 serve 使新 key 对运行实例生效（主进程对相同 key 跳过重启）
      try { await settings.saveCurrentConfig(true); } catch { /* 后台静默，防抖 watch 兜底 */ }
    } else {
      testError.value = r.message;
    }
  }
  catch (err) { testError.value = String(err); }  // translateError applied in template display
  finally { isTesting.value = false; }
}

// ── DeepSeek 账户余额（计费迭代：API Key 区下方显示，随 key 变化自动刷新）──
const balance = ref<DeepSeekBalanceResult | null>(null);
const balanceLoading = ref(false);

/** 查询余额；无 API Key 或失败时静默降级（不阻断设置面板渲染） */
async function refreshBalance() {
  if (balanceLoading.value) return;
  balanceLoading.value = true;
  try {
    balance.value = await getBalance();
  } catch {
    balance.value = { ok: false, message: "余额查询失败" };
  } finally {
    balanceLoading.value = false;
  }
}

/** 余额展示文本：CNY 总余额；失败/未配置时显示原因 */
const balanceText = computed(() => {
  if (!balance.value) return "";
  if (!balance.value.ok) return balance.value.message ?? "查询失败";
  const cny = balance.value.balanceInfos?.find((b) => b.currency === "CNY")
    ?? balance.value.balanceInfos?.[0];
  return cny ? `¥${Number(cny.totalBalance).toFixed(2)}` : "--";
});

// API Key 变化后自动刷新余额（保存即触发；防抖避免输入过程反复请求）
let balanceTimer: ReturnType<typeof setTimeout> | null = null;
watch(() => settings.apiKey, () => {
  if (balanceTimer) clearTimeout(balanceTimer);
  balanceTimer = setTimeout(() => { refreshBalance(); }, 600);
});
// 路由离开时清理防抖定时器（否则卸载后仍可能触发 refreshBalance 改已卸载 ref）
onUnmounted(() => { if (balanceTimer) clearTimeout(balanceTimer); });
// 挂载即查询一次（设置页打开时直接显示余额，不依赖 key 变化事件）
onMounted(() => { refreshBalance(); });

// ── 多模态模型（制图师 kimi-k3）API Key ──
// password 明文切换（独立 state，与 DeepSeek key 互不干扰——DeepSeek 输入框无切换，沿用 Onboarding 交互模式）
const showKimiKey = ref(false);
// 保存反馈（成功提示，失败静默——saveKimiKey 内部 catch）
const kimiSaveMsg = ref<string | null>(null);
let kimiSaveTimer: ReturnType<typeof setTimeout> | null = null;

/** 保存制图师多模态 key → 重启 serve 使 provider 生效（key 变化才重启，主进程判断） */
async function handleKimiKeySave() {
  kimiSaveMsg.value = null;
  try {
    await settings.saveKimiKey(true);
    kimiSaveMsg.value = t("settings.kimiKeySaved");
    // 成功提示 2s 后消失（不常驻遮挡表单）
    if (kimiSaveTimer) clearTimeout(kimiSaveTimer);
    kimiSaveTimer = setTimeout(() => { kimiSaveMsg.value = null; }, 2000);
  } catch {
    // saveKimiKey 内部已静默，此处不重复报错
  }
}

// ── 更新日志弹窗 ──
const showChangelog = ref(false);

// ── 高级设置（settings.json JSONC 编辑器，阶段 6）──
// 默认折叠：面向高级用户/agent 协作，避免小白误改配置（方案 3.8：高级配置类 VSCode settings.json）
const showAdvanced = ref(false);

// ── 数据模式开关（高级设置：独立会话数据）──
// 切换 → settings store setDataMode（写 settings.json + 重启 serve + 清会话缓存；失败自动回滚）
// 提示条复用 alertText 模式（三种状态：切换中/成功/失败），isRestarting 时开关禁用（防连点）
const dataModeMsg = ref<{ type: "info" | "ok" | "err"; text: string } | null>(null);
async function handleDataModeToggle(v: "shared" | "isolated") {
  dataModeMsg.value = { type: "info", text: t("settings.dataModeRestarting") };
  const r = await settings.setDataMode(v);
  if (r.ok) dataModeMsg.value = { type: "ok", text: t("settings.dataModeDone") };
  else dataModeMsg.value = { type: "err", text: t("settings.dataModeFail") };
}
</script>

<template>
  <ErrorBoundary name="SettingsPanel">
    <div class="f-settings-panel flex flex-col" style="flex:1;min-height:0">
      <!-- Header（固定顶部） -->
      <div class="flex items-center gap-3 shrink-0 px-5 pt-3 pb-2">
        <button @click="router.push('/chat')" class="w-7 h-7 flex items-center justify-center rounded-md transition-colors hover:bg-[var(--bg-hover)]" style="color:var(--text-secondary)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m15 18-6-6 6-6"/></svg>
        </button>
        <h2 class="text-lg font-semibold tracking-tight" style="color:var(--text-bright)">{{ $t('settings.title') }}</h2>
      </div>

      <!-- 两区平铺（可滚动） -->
      <div class="flex flex-wrap gap-8 flex-1 overflow-y-auto px-5 pb-4">

        <!-- 引擎设置（DeepSeek 专属） -->
        <section class="space-y-4 w-[300px] shrink-0">
          <h3 class="text-[10px] font-semibold uppercase tracking-widest" :style="{ color: 'var(--text-muted)' }">{{ $t('settings.engineTitle') }}</h3>

          <!-- API Key -->
          <div>
            <label class="block text-xs font-medium mb-1.5" style="color:var(--text-secondary)">{{ $t('settings.apiKey') }}</label>
            <input v-model="settings.apiKey" type="password" placeholder="sk-…"
              class="settings-input w-full rounded-lg px-3.5 py-2 text-sm outline-none" />
            <!-- 账户余额（计费迭代：实时查询 DeepSeek /user/balance；无 key 不显示） -->
            <div v-if="balance" class="flex items-center gap-2 mt-1.5 text-[11px]" style="color:var(--text-secondary)">
              <span>账户余额</span>
              <span class="font-medium" :style="{ color: balance.ok ? 'var(--accent)' : 'var(--coral)' }">{{ balanceText }}</span>
              <button @click="refreshBalance" :disabled="balanceLoading"
                class="text-[10px] px-1.5 py-0.5 rounded transition-colors hover:bg-[var(--bg-hover)]"
                style="color:var(--text-muted)">{{ balanceLoading ? "…" : "刷新" }}</button>
            </div>
          </div>

          <!-- 多模态模型（制图师）API Key：明文切换 + 保存按钮（保存即重启 serve 使 provider 生效） -->
          <div>
            <label class="block text-xs font-medium mb-1.5" style="color:var(--text-secondary)">{{ $t('settings.kimiApiKey') }}</label>
            <div class="flex items-center gap-2">
              <div class="relative flex-1">
                <input v-model="settings.kimiApiKey" :type="showKimiKey ? 'text' : 'password'" placeholder="kimi-k3…"
                  spellcheck="false" autocomplete="off"
                  class="settings-input w-full rounded-lg px-3.5 py-2 text-sm outline-none pr-9" />
                <!-- 眼睛按钮：明文切换（复用 Onboarding 交互模式，独立 showKimiKey state） -->
                <button
                  class="absolute right-1 top-1/2 -translate-y-1/2 w-7 h-7 flex items-center justify-center rounded-md transition-colors hover:bg-[var(--bg-hover)]"
                  style="color:var(--text-secondary)"
                  :title="showKimiKey ? $t('settings.hideKey') : $t('settings.showKey')"
                  @click="showKimiKey = !showKimiKey"
                >
                  <svg v-if="showKimiKey" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/>
                  </svg>
                  <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>
                  </svg>
                </button>
              </div>
              <button
                @click="handleKimiKeySave"
                :disabled="!settings.kimiApiKey.trim()"
                class="shrink-0 px-3 py-2 rounded-lg text-xs font-medium transition-all duration-150"
                :style="{ background: settings.kimiApiKey.trim() ? 'var(--accent)' : 'var(--bg-elevated)', color: settings.kimiApiKey.trim() ? 'var(--bg-root)' : 'var(--text-muted)', opacity: settings.kimiApiKey.trim() ? 1 : 0.5 }"
              >{{ $t('settings.save') }}</button>
            </div>
            <div class="text-[11px] mt-1" style="color:var(--text-muted)">{{ $t('settings.kimiApiKeyDesc') }}</div>
            <div v-if="kimiSaveMsg" class="text-[11px] mt-0.5" style="color:var(--accent)">{{ kimiSaveMsg }}</div>
          </div>

          <!-- API 地址 -->
          <div>
            <label class="block text-xs font-medium mb-1.5" style="color:var(--text-secondary)">{{ $t('settings.baseUrl') }}</label>
            <input v-model="settings.baseUrl" type="text" placeholder="https://api.deepseek.com"
              class="settings-input w-full rounded-lg px-3.5 py-2 text-sm outline-none" />
          </div>

          <!-- 模型（DeepSeek 列表） -->
          <div>
            <label class="block text-xs font-medium mb-1.5" style="color:var(--text-secondary)">{{ $t('settings.model') }}</label>
            <div
              class="settings-dropdown relative cursor-pointer rounded-lg px-3.5 py-2 text-sm flex items-center select-none transition-colors"
              :style="{
                background: 'var(--bg-elevated)',
                border: openDropdown === 'model' ? '1px solid var(--accent)' : '1px solid var(--border-default)'
              }"
              @click.stop="toggleDropdown('model')"
            >
              <span class="font-medium truncate flex-1">{{ settings.model || 'deepseek-v4-pro[1M]' }}</span>
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"
                :style="{ opacity: 0.4, transition: 'transform 150ms', transform: openDropdown === 'model' ? 'rotate(180deg)' : '' }">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
              <Transition name="drop-settings">
                <div
                  v-if="openDropdown === 'model'"
                  class="absolute right-0 top-full mt-1 py-1 rounded-lg z-30 w-full"
                  style="background: var(--bg-elevated); border: 1px solid var(--border-default); box-shadow: 0 8px 24px rgba(0,0,0,0.35)"
                >
                  <button
                    v-for="m in modelPresets"
                    :key="m"
                    @click="settings.model = m; closeDropdowns()"
                    class="w-full text-left px-3 py-2 text-sm font-mono transition-colors hover:bg-[var(--bg-hover)]"
                    :style="{ background: settings.model === m ? 'var(--accent-glow)' : 'transparent', color: settings.model === m ? 'var(--accent)' : 'var(--text-primary)' }"
                  >{{ m }}</button>
                </div>
              </Transition>
            </div>
          </div>

          <!-- 测试连接 -->
          <button @click="handleTest" :disabled="isTesting || !settings.apiKey"
            class="w-full py-2.5 rounded-lg text-sm font-medium transition-all duration-150"
            :style="{ background: isTesting ? 'var(--bg-elevated)' : 'var(--accent)', color: isTesting ? 'var(--text-muted)' : 'var(--bg-root)', opacity: (!settings.apiKey) ? 0.3 : 1 }">
            {{ isTesting ? $t('settings.testing') : $t('settings.test') }}
          </button>
          <div v-if="testResult" class="space-y-1">
            <div class="p-3 rounded-lg text-xs break-all" :style="{ background: testResult.cc.startsWith('✓') ? 'var(--accent-glow)' : 'var(--coral-glow)', color: testResult.cc.startsWith('✓') ? 'var(--accent)' : 'var(--coral)' }">{{ testResult.cc }}</div>
            <div v-if="testResult.chat" class="p-3 rounded-lg text-xs break-all" :style="{ background: testResult.chat.startsWith('✓') ? 'var(--accent-glow)' : testResult.chat.startsWith('⚠') ? 'var(--amber-glow)' : 'var(--coral-glow)', color: testResult.chat.startsWith('✓') ? 'var(--accent)' : testResult.chat.startsWith('⚠') ? 'var(--amber)' : 'var(--coral)' }">{{ $t('settings.chatApi') }} {{ testResult.chat }}</div>
          </div>
          <div v-if="translatedTestError" class="p-3 rounded-lg text-xs break-all" style="background:var(--coral-glow); color:var(--coral); border:1px solid var(--coral); --tw-border-opacity:0.3">✕ {{ translatedTestError }}</div>

          <!-- 上下文窗口 -->
          <div>
            <label class="block text-xs font-medium mb-1.5" style="color:var(--text-secondary)">{{ $t('settings.contextLimit') }}</label>
            <input v-model="contextLimitInput" type="text"
              :placeholder="$t('settings.contextLimitPlaceholder')"
              class="settings-input w-full rounded-lg px-3.5 py-2 text-sm outline-none"
              @blur="parseContextLimit" />
          </div>

          <!-- 聊天 API 地址 -->
          <div>
            <div class="flex items-center justify-between mb-1.5">
              <label class="text-xs font-medium" style="color:var(--text-secondary)">{{ $t('settings.llmApiUrl') }}</label>
              <button
                @click="startLookupUrl"
                :disabled="isLookingUpUrl"
                class="text-[10px] px-2 py-0.5 rounded-full transition-colors hover:underline"
                :style="{ color: isLookingUpUrl ? 'var(--text-muted)' : 'var(--accent)' }"
                :title="$t('settings.llmApiUrlLookup')"
              >{{ isLookingUpUrl ? '⏳' : '🔍' }} {{ $t('settings.llmApiUrlLookup') }}</button>
            </div>
            <input v-model="settings.optimizeApiUrl" type="text" :placeholder="$t('settings.llmApiUrlPlaceholder')"
              class="settings-input w-full rounded-lg px-3.5 py-2 text-sm outline-none" />
          </div>
        </section>

        <!-- 工作目录（serve 的工作区；顶栏无菜单，入口在此） -->
        <section class="space-y-4 w-[300px] shrink-0">
          <h3 class="text-[10px] font-semibold uppercase tracking-widest" :style="{ color: 'var(--text-muted)' }">{{ $t('settings.workspaceTitle') }}</h3>
          <div>
            <label class="block text-xs font-medium mb-1.5" style="color:var(--text-secondary)">{{ $t('settings.workspaceLabel') }}</label>
            <div class="flex items-center gap-2">
              <input
                :value="settings.cwd"
                readonly
                class="flex-1 rounded-lg px-3 py-2 text-xs font-mono truncate outline-none"
                style="background: var(--bg-elevated); border: 1px solid var(--border-default); color: var(--text-secondary)"
                :placeholder="$t('settings.workspacePlaceholder')"
              />
              <button
                @click="handleWorkspacePick"
                class="shrink-0 px-3 py-2 rounded-lg text-xs font-medium transition-colors hover:brightness-110"
                style="background: var(--accent-glow); color: var(--accent); border: 1px solid var(--accent-dim)"
              >{{ $t('settings.browseFolder') }}</button>
            </div>
            <p class="mt-1 text-[10px]" style="color: var(--text-muted); opacity: 0.7">{{ $t('settings.workspaceHint') }}</p>
          </div>
        </section>

        <!-- 界面设置 -->
        <section class="space-y-4 w-[300px] shrink-0">
          <h3 class="text-[10px] font-semibold uppercase tracking-widest" :style="{ color: 'var(--text-muted)' }">{{ $t('settings.uiTitle') }}</h3>

          <!-- 语言 -->
          <div>
            <label class="block text-xs font-medium mb-1.5" style="color:var(--text-secondary)">{{ $t('settings.language') }}</label>
            <div
              class="settings-dropdown relative cursor-pointer rounded-lg px-3.5 py-2 text-sm flex items-center gap-1.5 select-none transition-colors"
              :style="{
                background: 'var(--bg-elevated)',
                border: openDropdown === 'lang' ? '1px solid var(--accent)' : '1px solid var(--border-default)'
              }"
              @click.stop="toggleDropdown('lang')"
            >
              <span class="font-medium truncate flex-1">{{ currentLang.labelKey }}</span>
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"
                :style="{ opacity: 0.4, transition: 'transform 150ms', transform: openDropdown === 'lang' ? 'rotate(180deg)' : '' }">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
              <Transition name="drop-settings">
                <div
                  v-if="openDropdown === 'lang'"
                  class="absolute right-0 top-full mt-1 py-1 rounded-lg z-30 w-full"
                  style="background: var(--bg-elevated); border: 1px solid var(--border-default); box-shadow: 0 8px 24px rgba(0,0,0,0.35)"
                >
                  <button
                    v-for="o in langOptions"
                    :key="o.value"
                    @click="settings.locale = o.value; closeDropdowns()"
                    class="w-full text-left px-3 py-2 text-sm transition-colors hover:bg-[var(--bg-hover)]"
                    :style="{ background: settings.locale === o.value ? 'var(--accent-glow)' : 'transparent', color: settings.locale === o.value ? 'var(--accent)' : 'var(--text-primary)' }"
                  >{{ o.labelKey }}</button>
                </div>
              </Transition>
            </div>
          </div>

          <!-- 主题 -->
          <div>
            <label class="block text-xs font-medium mb-1.5" style="color:var(--text-secondary)">{{ $t('settings.theme') }}</label>
            <div
              class="settings-dropdown relative cursor-pointer rounded-lg px-3.5 py-2 text-sm flex items-center gap-1.5 select-none transition-colors"
              :style="{
                background: 'var(--bg-elevated)',
                border: openDropdown === 'theme' ? '1px solid var(--accent)' : '1px solid var(--border-default)'
              }"
              @click.stop="toggleDropdown('theme')"
            >
              <span class="font-medium truncate flex-1">{{ $t(currentTheme.labelKey) }}</span>
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"
                :style="{ opacity: 0.4, transition: 'transform 150ms', transform: openDropdown === 'theme' ? 'rotate(180deg)' : '' }">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
              <Transition name="drop-settings">
                <div
                  v-if="openDropdown === 'theme'"
                  class="absolute right-0 top-full mt-1 py-1 rounded-lg z-30 w-full"
                  style="background: var(--bg-elevated); border: 1px solid var(--border-default); box-shadow: 0 8px 24px rgba(0,0,0,0.35)"
                >
                  <button
                    v-for="o in themeOptions"
                    :key="o.value"
                    @click="settings.theme = o.value; closeDropdowns()"
                    class="w-full text-left px-3 py-2 text-sm transition-colors hover:bg-[var(--bg-hover)]"
                    :style="{ background: settings.theme === o.value ? 'var(--accent-glow)' : 'transparent', color: settings.theme === o.value ? 'var(--accent)' : 'var(--text-primary)' }"
                  >{{ $t(o.labelKey) }}</button>
                </div>
              </Transition>
            </div>
          </div>

          <!-- 字号 -->
          <div>
            <label class="block text-xs font-medium mb-1.5" style="color:var(--text-secondary)">{{ $t('settings.fontSize') }}</label>
            <div
              class="settings-dropdown relative cursor-pointer rounded-lg px-3.5 py-2 text-sm flex items-center gap-1.5 select-none transition-colors"
              :style="{
                background: 'var(--bg-elevated)',
                border: openDropdown === 'font' ? '1px solid var(--accent)' : '1px solid var(--border-default)'
              }"
              @click.stop="toggleDropdown('font')"
            >
              <span class="font-medium truncate flex-1">{{ $t(currentFontSize.labelKey) }}</span>
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"
                :style="{ opacity: 0.4, transition: 'transform 150ms', transform: openDropdown === 'font' ? 'rotate(180deg)' : '' }">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
              <Transition name="drop-settings">
                <div
                  v-if="openDropdown === 'font'"
                  class="absolute top-full left-0 right-0 mt-1 rounded-lg py-1 z-20 shadow-lg border"
                  :style="{ background: 'var(--bg-elevated)', borderColor: 'var(--border-default)' }"
                >
                  <div
                    v-for="o in fontSizeOptions"
                    :key="o.value"
                    class="px-3.5 py-2 text-sm cursor-pointer transition-colors hover:bg-[var(--bg-hover)]"
                    @click="settings.fontSize = o.value; closeDropdowns()"
                    :style="{ background: settings.fontSize === o.value ? 'var(--accent-glow)' : 'transparent', color: settings.fontSize === o.value ? 'var(--accent)' : 'var(--text-primary)' }"
                  >{{ $t(o.labelKey) }}</div>
                </div>
              </Transition>
            </div>
          </div>

          <!-- 权限模式 -->
          <div>
            <label class="block text-xs font-medium mb-1.5" style="color:var(--text-secondary)">{{ $t('settings.defaultMode') }}</label>
            <div
              class="settings-dropdown relative cursor-pointer rounded-lg px-3.5 py-2 text-sm flex items-center gap-1.5 select-none transition-colors"
              :style="{
                background: 'var(--bg-elevated)',
                border: openDropdown === 'perm' ? '1px solid var(--accent)' : '1px solid var(--border-default)'
              }"
              @click.stop="toggleDropdown('perm')"
            >
              <span class="text-[13px]">{{ currentPerm.icon }}</span>
              <span class="font-medium truncate flex-1">{{ $t(currentPerm.labelKey) }}</span>
              <span class="italic text-[10px] opacity-50 hidden sm:inline" style="color:var(--text-secondary)">{{ currentPerm.cliKey }}</span>
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"
                :style="{ opacity: 0.4, transition: 'transform 150ms', transform: openDropdown === 'perm' ? 'rotate(180deg)' : '' }">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
              <Transition name="drop-settings">
                <div
                  v-if="openDropdown === 'perm'"
                  class="absolute right-0 top-full mt-1 py-1 rounded-lg z-30 min-w-[260px]"
                  style="background: var(--bg-elevated); border: 1px solid var(--border-default); box-shadow: 0 8px 24px rgba(0,0,0,0.35)"
                >
                  <button
                    v-for="o in permOptions"
                    :key="o.value"
                    @click="activeMode = o.value; closeDropdowns()"
                    class="w-full text-left px-3 py-2 transition-colors hover:bg-[var(--bg-hover)]"
                    :style="{ background: activeMode === o.value ? 'var(--accent-glow)' : 'transparent' }"
                  >
                    <div class="flex items-center gap-1.5">
                      <span class="text-[13px]">{{ o.icon }}</span>
                      <span class="text-xs font-medium" :style="{ color: activeMode === o.value ? 'var(--accent)' : 'var(--text-primary)' }">{{ $t(o.labelKey) }}</span>
                      <span class="italic text-[10px] ml-auto" style="color:var(--text-secondary)">{{ o.cliKey }}</span>
                    </div>
                    <div class="text-[10px] mt-0.5 ml-5" style="color:var(--text-secondary)">{{ $t(o.descKey) }}</div>
                  </button>
                </div>
              </Transition>
            </div>
          </div>

          <!-- 思考深度（仅当前模型有 variants 时显示；无 variants 模型不渲染下拉） -->
          <div v-if="effortOptions.length > 0">
            <label class="block text-xs font-medium mb-1.5" style="color:var(--text-secondary)">{{ $t('settings.defaultEffort') }}</label>
            <div
              class="settings-dropdown relative cursor-pointer rounded-lg px-3.5 py-2 text-sm flex items-center gap-1.5 select-none transition-colors"
              :style="{
                background: 'var(--bg-elevated)',
                border: openDropdown === 'effort' ? '1px solid var(--accent)' : '1px solid var(--border-default)',
                color: currentEffort.color
              }"
              @click.stop="toggleDropdown('effort')"
            >
              <span class="text-[13px]">{{ currentEffort.icon }}</span>
              <span class="font-medium truncate flex-1">{{ $t(currentEffort.labelKey) }}</span>
              <span class="italic text-[10px] opacity-50 hidden sm:inline" style="color:var(--text-secondary)">{{ currentEffort.cliKey }}</span>
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"
                :style="{ opacity: 0.4, transition: 'transform 150ms', transform: openDropdown === 'effort' ? 'rotate(180deg)' : '' }">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
              <Transition name="drop-settings">
                <div
                  v-if="openDropdown === 'effort'"
                  class="absolute right-0 top-full mt-1 py-1 rounded-lg z-30 w-[300px] shrink-0 max-w-[420px]"
                  style="background: var(--bg-elevated); border: 1px solid var(--border-default); box-shadow: 0 8px 24px rgba(0,0,0,0.35)"
                >
                  <button
                    v-for="o in effortOptions"
                    :key="o.value"
                    @click="settings.effort = o.value; closeDropdowns()"
                    class="w-full text-left px-3 py-2 transition-colors hover:bg-[var(--bg-hover)]"
                    :style="{ background: settings.effort === o.value ? o.color + '18' : 'transparent' }"
                  >
                    <div class="flex items-center gap-1.5">
                      <span class="text-[13px]">{{ o.icon }}</span>
                      <span class="text-xs font-medium" :style="{ color: settings.effort === o.value ? o.color : 'var(--text-primary)' }">{{ $t(o.labelKey) }}</span>
                      <span class="italic text-[10px] ml-auto" style="color:var(--text-secondary)">{{ o.cliKey }}</span>
                    </div>
                  </button>
                </div>
              </Transition>
            </div>
          </div>

          <!-- 消息排布（B1：split=左右分列默认 / left=全部靠左，实时生效） -->
          <div>
            <label class="block text-xs font-medium mb-1.5" style="color:var(--text-secondary)">{{ $t('settings.messageLayout') }}</label>
            <div
              class="settings-dropdown relative cursor-pointer rounded-lg px-3.5 py-2 text-sm flex items-center gap-1.5 select-none transition-colors"
              :style="{
                background: 'var(--bg-elevated)',
                border: openDropdown === 'layout' ? '1px solid var(--accent)' : '1px solid var(--border-default)'
              }"
              @click.stop="toggleDropdown('layout')"
            >
              <span class="font-medium truncate flex-1">{{ $t(currentLayout.labelKey) }}</span>
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"
                :style="{ opacity: 0.4, transition: 'transform 150ms', transform: openDropdown === 'layout' ? 'rotate(180deg)' : '' }">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
              <Transition name="drop-settings">
                <div
                  v-if="openDropdown === 'layout'"
                  class="absolute right-0 top-full mt-1 py-1 rounded-lg z-30 w-full"
                  style="background: var(--bg-elevated); border: 1px solid var(--border-default); box-shadow: 0 8px 24px rgba(0,0,0,0.35)"
                >
                  <button
                    v-for="o in layoutOptions"
                    :key="o.value"
                    @click="settings.messageLayout = o.value; closeDropdowns()"
                    class="w-full text-left px-3 py-2 text-sm transition-colors hover:bg-[var(--bg-hover)]"
                    :style="{ background: settings.messageLayout === o.value ? 'var(--accent-glow)' : 'transparent', color: settings.messageLayout === o.value ? 'var(--accent)' : 'var(--text-primary)' }"
                  >{{ $t(o.labelKey) }}</button>
                </div>
              </Transition>
            </div>
          </div>

          <!-- 昵称（B1：消息区用户名显示，空=「我」兜底，即时生效） -->
          <div>
            <label class="block text-xs font-medium mb-1.5" style="color:var(--text-secondary)">{{ $t('settings.nickname') }}</label>
            <input v-model="settings.nickname" type="text" maxlength="20"
              :placeholder="$t('settings.nicknamePlaceholder')"
              class="settings-input w-full rounded-lg px-3.5 py-2 text-sm outline-none" />
          </div>

          <!-- 头像（B1：emoji 快捷点选 + 手动输入；空=「我」字兜底，即时生效） -->
          <div>
            <label class="block text-xs font-medium mb-1.5" style="color:var(--text-secondary)">{{ $t('settings.avatar') }}</label>
            <div class="flex flex-wrap gap-1.5 mb-1.5">
              <button
                v-for="e in AVATAR_EMOJIS"
                :key="e"
                @click="settings.avatar = e"
                class="w-8 h-8 rounded-lg text-base flex items-center justify-center transition-colors"
                :style="{
                  background: settings.avatar === e ? 'var(--accent-glow)' : 'var(--bg-elevated)',
                  border: settings.avatar === e ? '1px solid var(--accent)' : '1px solid var(--border-default)'
                }"
              >{{ e }}</button>
            </div>
            <input v-model="settings.avatar" type="text" maxlength="4"
              :placeholder="$t('settings.avatarPlaceholder')"
              class="settings-input w-full rounded-lg px-3.5 py-2 text-sm outline-none" />
          </div>

          <!-- 重新显示引导页：重置 dismissed 标记，AppShell 检测到 dismissed 复位即切回 onboarding 全屏（仅未配置 key 时弹引导） -->
          <button
            @click="settings.resetOnboarding()"
            class="w-full py-2 rounded-lg text-xs font-medium transition-colors"
            style="background: var(--accent-glow); color: var(--accent); border: 1px solid var(--accent-dim)"
          >{{ $t('settings.reopenOnboarding') }}</button>
        </section>

        <!-- 高级设置（settings.json JSONC 编辑器，默认折叠，阶段 6 方案 3.8） -->
        <section class="w-full shrink-0">
          <button
            @click="showAdvanced = !showAdvanced"
            class="w-full flex items-center justify-between px-3.5 py-2.5 rounded-lg text-xs font-medium transition-colors"
            style="background: var(--bg-elevated); border: 1px solid var(--border-default); color: var(--text-primary)"
          >
            <span>{{ $t('settings.advanced') }}</span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"
              :style="{ transition: 'transform 150ms', transform: showAdvanced ? 'rotate(180deg)' : '' }">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>
          <div v-if="showAdvanced" class="mt-2 p-3 rounded-lg" style="background: var(--bg-elevated); border: 1px solid var(--border-default)">
            <p class="mb-2 text-[10px]" style="color: var(--text-muted)">{{ $t('settings.advancedDesc') }}</p>

            <!-- 轻量模型下拉（LOW 槽位）：写 settings.json smallModel → 主进程引擎联动同步 opencode.json small_model -->
            <div class="mb-3">
              <label class="block text-xs font-medium mb-1.5" style="color:var(--text-secondary)">{{ $t('settings.smallModel') }}</label>
              <div
                class="settings-dropdown relative cursor-pointer rounded-lg px-3.5 py-2 text-sm flex items-center select-none transition-colors"
                :style="{
                  background: 'var(--bg-elevated)',
                  border: openDropdown === 'smallModel' ? '1px solid var(--accent)' : '1px solid var(--border-default)'
                }"
                @click.stop="toggleDropdown('smallModel')"
              >
                <span class="font-medium truncate flex-1">{{ $t(currentSmallModel.labelKey) }}</span>
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"
                  :style="{ opacity: 0.4, transition: 'transform 150ms', transform: openDropdown === 'smallModel' ? 'rotate(180deg)' : '' }">
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
                <Transition name="drop-settings">
                  <div
                    v-if="openDropdown === 'smallModel'"
                    class="absolute right-0 top-full mt-1 py-1 rounded-lg z-30 w-full"
                    style="background: var(--bg-elevated); border: 1px solid var(--border-default); box-shadow: 0 8px 24px rgba(0,0,0,0.35)"
                  >
                    <button
                      v-for="opt in smallModelOptions"
                      :key="opt.value"
                      @click="handleSmallModelSelect(opt.value)"
                      class="w-full text-left px-3 py-2 text-sm transition-colors hover:bg-[var(--bg-hover)]"
                      :style="{ background: settings.smallModel === opt.value ? 'var(--accent-glow)' : 'transparent', color: settings.smallModel === opt.value ? 'var(--accent)' : 'var(--text-primary)' }"
                    >{{ $t(opt.labelKey) }}</button>
                  </div>
                </Transition>
              </div>
              <div class="text-[10px] mt-1" style="color: var(--text-muted)">{{ $t('settings.smallModelDesc') }}</div>
            </div>

            <!-- 独立会话数据开关：切换 dataMode（写 settings.json → 重启 serve 生效）；isRestarting 时禁用 -->
            <div
              class="data-mode-row flex items-center justify-between gap-3 mb-2"
              :class="{ 'data-mode-row--disabled': settings.isRestarting }"
            >
              <div class="min-w-0">
                <div class="text-xs font-medium" style="color: var(--text-primary)">{{ $t('settings.dataModeLabel') }}</div>
                <div class="text-[10px] mt-0.5" style="color: var(--text-muted)">{{ $t('settings.dataModeDesc') }}</div>
              </div>
              <button
                class="data-mode-switch shrink-0"
                :class="{ 'data-mode-switch--on': settings.dataMode === 'isolated' }"
                :disabled="settings.isRestarting"
                :aria-pressed="settings.dataMode === 'isolated'"
                :title="settings.isRestarting ? $t('settings.dataModeRestarting') : ''"
                @click="handleDataModeToggle(settings.dataMode === 'isolated' ? 'shared' : 'isolated')"
              >
                <span class="data-mode-switch__knob"></span>
              </button>
            </div>

            <!-- 切换状态提示条：切换中 / 成功 / 失败（失败含回滚成功场景，文案统一 dataModeFail） -->
            <div
              v-if="dataModeMsg"
              class="data-mode-msg mb-2 px-3 py-1.5 rounded-lg text-[10px]"
              :style="{
                color: dataModeMsg.type === 'ok' ? 'var(--accent)' : dataModeMsg.type === 'err' ? 'var(--coral)' : 'var(--text-secondary)',
                background: dataModeMsg.type === 'ok' ? 'var(--accent-glow)' : dataModeMsg.type === 'err' ? 'var(--coral-glow)' : 'var(--bg-hover)',
                border: '1px solid ' + (dataModeMsg.type === 'ok' ? 'var(--accent-line)' : dataModeMsg.type === 'err' ? 'var(--coral)' : 'var(--border-default)'),
              }"
            >
              <template v-if="dataModeMsg.type === 'ok'">✓ </template>
              <template v-else-if="dataModeMsg.type === 'err'">✕ </template>
              {{ dataModeMsg.text }}
            </div>

            <!-- OC 可执行文件路径（B1：engine.opencodePath；空=内置 sidecar/系统安装自动解析；下次引擎启动生效） -->
            <div class="mb-3">
              <label class="block text-xs font-medium mb-1.5" style="color:var(--text-secondary)">{{ $t('settings.opencodePath') }}</label>
              <div class="flex items-center gap-2">
                <input
                  v-model="settings.opencodePath"
                  type="text"
                  spellcheck="false"
                  class="settings-input flex-1 rounded-lg px-3 py-2 text-xs font-mono truncate outline-none"
                  :placeholder="$t('settings.opencodePathPlaceholder')"
                />
                <button
                  @click="handleOpencodePathPick"
                  class="shrink-0 px-3 py-2 rounded-lg text-xs font-medium transition-colors hover:brightness-110"
                  style="background: var(--accent-glow); color: var(--accent); border: 1px solid var(--accent-dim)"
                >{{ $t('settings.browseFile') }}</button>
              </div>
              <div class="text-[10px] mt-1" style="color: var(--text-muted)">{{ $t('settings.opencodePathDesc') }}</div>
            </div>

            <!-- 引擎日志级别（B1：engine.logLevel；spawn serve 传 --log-level；下次引擎启动生效） -->
            <div class="mb-3">
              <label class="block text-xs font-medium mb-1.5" style="color:var(--text-secondary)">{{ $t('settings.logLevel') }}</label>
              <div
                class="settings-dropdown relative cursor-pointer rounded-lg px-3.5 py-2 text-sm flex items-center select-none transition-colors"
                :style="{
                  background: 'var(--bg-elevated)',
                  border: openDropdown === 'logLevel' ? '1px solid var(--accent)' : '1px solid var(--border-default)'
                }"
                @click.stop="toggleDropdown('logLevel')"
              >
                <span class="font-medium font-mono truncate flex-1">{{ settings.logLevel }}</span>
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"
                  :style="{ opacity: 0.4, transition: 'transform 150ms', transform: openDropdown === 'logLevel' ? 'rotate(180deg)' : '' }">
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
                <Transition name="drop-settings">
                  <div
                    v-if="openDropdown === 'logLevel'"
                    class="absolute right-0 top-full mt-1 py-1 rounded-lg z-30 w-full"
                    style="background: var(--bg-elevated); border: 1px solid var(--border-default); box-shadow: 0 8px 24px rgba(0,0,0,0.35)"
                  >
                    <button
                      v-for="lv in settings.LOG_LEVEL_OPTIONS"
                      :key="lv"
                      @click="settings.logLevel = lv; closeDropdowns()"
                      class="w-full text-left px-3 py-2 text-sm font-mono transition-colors hover:bg-[var(--bg-hover)]"
                      :style="{ background: settings.logLevel === lv ? 'var(--accent-glow)' : 'transparent', color: settings.logLevel === lv ? 'var(--accent)' : 'var(--text-primary)' }"
                    >{{ lv }}</button>
                  </div>
                </Transition>
              </div>
              <div class="text-[10px] mt-1" style="color: var(--text-muted)">{{ $t('settings.logLevelDesc') }}</div>
            </div>

            <!-- 预置技能包开关（B1：preset.skills.enabled；关闭=下次启动不加载预置 skills，用户自定义技能保留） -->
            <div class="flex items-center justify-between gap-3 mb-2">
              <div class="min-w-0">
                <div class="text-xs font-medium" style="color: var(--text-primary)">{{ $t('settings.presetSkills') }}</div>
                <div class="text-[10px] mt-0.5" style="color: var(--text-muted)">{{ $t('settings.presetSkillsDesc') }}</div>
              </div>
              <button
                class="data-mode-switch preset-switch shrink-0"
                :class="{ 'data-mode-switch--on': settings.presetSkillsEnabled }"
                :aria-pressed="settings.presetSkillsEnabled"
                @click="settings.presetSkillsEnabled = !settings.presetSkillsEnabled"
              >
                <span class="data-mode-switch__knob"></span>
              </button>
            </div>

            <SettingsJsonEditor />
          </div>
        </section>
      </div>

      <!-- Footer：关于（固定底部） -->
      <footer class="shrink-0 px-5 py-2.5" style="border-top:1px solid var(--border-dim)">
        <div class="flex items-center justify-between text-[10px]" :style="{ color: 'var(--text-muted)' }">
          <div class="flex items-center gap-2">
            <span>{{ $t('app.title') }}</span>
            <span style="opacity:0.4">by MaxNull</span>
          </div>
          <div class="flex items-center gap-3">
            <button
              class="hover:underline transition-colors"
              @click="showChangelog = true"
            >{{ $t('settings.changelog') }}</button>
            <span class="font-mono">v{{ appVersion }}</span>
          </div>
        </div>
        <!-- 关于第二行：OC 引擎版本 + 预置包版本（对齐上行样式） -->
        <div class="mt-1 flex items-center justify-end gap-3 text-[10px]" :style="{ color: 'var(--text-muted)' }">
          <span class="font-mono">{{ $t('settings.engineVersion') }} {{ engineVersion }}</span>
          <span class="font-mono">{{ $t('settings.presetVersion') }} {{ presetVersion }}</span>
        </div>
      </footer>
    </div>
  <!-- 更新日志弹窗 -->
  <ModalShell :open="showChangelog" size="lg" position="top" @close="showChangelog = false">
    <template #header>
      <span class="text-sm font-semibold" :style="{ color: 'var(--text-bright)' }">{{ $t('settings.changelog') }}</span>
    </template>
    <MarkdownRenderer :content="changelogContent" />
  </ModalShell>
  </ErrorBoundary>
</template>

<style scoped>
/* 统一样式：input / 自定义下拉 */
.settings-input,
.settings-dropdown {
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  color: var(--text-primary);
  caret-color: var(--accent);
}
.settings-input:focus {
  border-color: var(--accent);
}

/* 下拉动画 */
.drop-settings-enter-active { transition: all 120ms ease-out; }
.drop-settings-leave-active { transition: all 100ms ease-in; }
.drop-settings-enter-from { opacity: 0; transform: translateY(4px) scale(0.96); }
.drop-settings-leave-to { opacity: 0; transform: translateY(2px) scale(0.98); }

/* ── 数据模式开关（accent 开启态；禁用时半透明 + 禁指针）── */
.data-mode-row--disabled {
  opacity: 0.55;
  pointer-events: none; /* 重启期间不可再点（防连点锁的第二道防线） */
}
.data-mode-switch {
  position: relative;
  width: 36px;
  height: 20px;
  border-radius: 999px;
  background: var(--bg-active);
  border: 1px solid var(--border-default);
  cursor: pointer;
  transition: background 150ms, border-color 150ms;
  padding: 0;
}
/* 轨道：关闭态灰色；开启态 accent（accent 是唯一「成功/开启」语义色，与全局一致） */
.data-mode-switch--on {
  background: var(--accent-dim);
  border-color: var(--accent-line);
}
/* 滑块：关闭态靠左，开启态右移 */
.data-mode-switch__knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 999px;
  background: var(--text-secondary);
  transition: transform 150ms, background 150ms;
}
.data-mode-switch--on .data-mode-switch__knob {
  transform: translateX(16px);
  background: var(--accent);
}
.data-mode-switch:disabled {
  cursor: default;
}

</style>
