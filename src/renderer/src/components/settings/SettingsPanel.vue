<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, type Component } from "vue";
import { useRouter } from "vue-router";
import { useSettingsStore } from "@/stores/settings";
import { useChatStore } from "@/stores/chat";
import { useI18n } from "vue-i18n";
import { testConnection, sendMessage, openDialog, getAppInfo, getBalance, type DeepSeekBalanceResult, type ConnectionTestResult } from "@/lib/electron-bridge";
import { emitChatCommand } from "@/composables/useCommandPalette";
import { useSessionStore } from "@/stores/session";
import { ArrowLeft, Settings as SettingsIcon, Palette, Bot, Bell, Wrench, Info, FolderOpen, ImagePlus, Trash2, RefreshCw, Eye, EyeOff, Search } from "lucide-vue-next";

const appVersion = __APP_VERSION__;
import { translateError } from "@/lib/utils";

import ErrorBoundary from "@/components/shared/ErrorBoundary.vue";
import ModalShell from "@/components/shared/ModalShell.vue";
import MarkdownRenderer from "@/components/shared/MarkdownRenderer.vue";
import SettingsJsonEditor from "./SettingsJsonEditor.vue";
import SettingsSelect from "./SettingsSelect.vue";
import SettingsInput from "./SettingsInput.vue";
import SettingsToggle from "./SettingsToggle.vue";
import SettingsSection from "./SettingsSection.vue";
import changelogRaw from "../../../docs/变更记录.md?raw";

// Windows CRLF → LF 归一化，防止 MarkdownRenderer 解析失败
const changelogContent = changelogRaw.replace(/\r\n/g, "\n");

const router = useRouter();
const { t } = useI18n();
const settings = useSettingsStore();
const chat = useChatStore();
const sessionStore = useSessionStore();

// ── 布局：左侧导航 tab（6 项，lucide 图标）──
// 路由离开设置页 → 重置到第一个 tab（下次进入从通用开始）
type TabId = "general" | "model" | "behavior" | "notify" | "advanced" | "about";
const activeTab = ref<TabId>("general");
watch(() => router.currentRoute.value.path, (p) => {
  if (p !== "/settings") activeTab.value = "general";
});
// tab 文案经 i18n（settings.tabs.*）；图标一律 lucide（Settings/Palette/Bot/Bell/Wrench/Info）
const TABS: Array<{ id: TabId; labelKey: string; icon: Component }> = [
  { id: "general", labelKey: "settings.tabs.general", icon: SettingsIcon },
  { id: "model", labelKey: "settings.tabs.model", icon: Palette },
  { id: "behavior", labelKey: "settings.tabs.behavior", icon: Bot },
  { id: "notify", labelKey: "settings.tabs.notify", icon: Bell },
  { id: "advanced", labelKey: "settings.tabs.advanced", icon: Wrench },
  { id: "about", labelKey: "settings.tabs.about", icon: Info },
];

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
  const selected = await openDialog({ directory: true, title: t("settings.workspacePickTitle") });
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
  const prompt = t("settings.urlLookupPrompt", { model: settings.model });
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

// ── 权限模式选项（对齐操作行 4 模式：全部询问/自动编辑/完全放行/计划；auto/dontAsk 为 CC 遗留已移除——
// 全自动语义由 bypassPermissions 承担（OC --auto 映射）；旧 autoMode 配置兼容读取）──
interface PermOption { value: "plan" | "default" | "acceptEdits" | "bypassPermissions"; cliKey: string; labelKey: string; descKey: string }
const permOptions: PermOption[] = [
  { value: "plan",       cliKey: "plan",             labelKey: "mode.plan",       descKey: "mode.planDesc" },
  { value: "default",    cliKey: "default",          labelKey: "mode.askBefore",  descKey: "mode.askBeforeDesc" },
  { value: "acceptEdits",cliKey: "acceptEdits",      labelKey: "mode.editAuto",   descKey: "mode.editAutoDesc" },
  { value: "bypassPermissions", cliKey: "bypassPermissions", labelKey: "mode.bypass", descKey: "mode.bypassDesc" },
];
// SettingsSelect 消费 {value,label,desc}：i18n key 即时翻译
const permSelectOptions = computed(() =>
  permOptions.map((o) => ({ value: o.value, label: t(o.labelKey), desc: t(o.descKey) })),
);

// ── 思考深度选项（variant 语义：选项 = 当前模型可用 variants 的映射子集，映射表仅 low/high/max 三档）──
interface EffortOption { value: import("@/stores/settings").Effort; cliKey: string; labelKey: string; color: string }
const EFFORT_VARIANTS: Record<string, Omit<EffortOption, "value">> = {
  low:  { cliKey: "low",    color: "#22c55e", labelKey: "mode.effort.low" },
  high: { cliKey: "high",   color: "#f59e0b", labelKey: "mode.effort.high" },
  max:  { cliKey: "max",    color: "#ef4444", labelKey: "mode.effort.max" },
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
// SettingsSelect 消费 {value,label,desc}：cliKey 展示为 desc（对齐旧下拉的 CLI 参数小字）
const effortSelectOptions = computed(() =>
  effortOptions.value.map((o) => ({ value: o.value, label: t(o.labelKey), desc: o.cliKey })),
);

// ── 轻量模型选项（LOW 槽位：标题生成/会话摘要/消息润色；值=模型全名，空=跟随主模型）──
const smallModelOptions = computed(() => [
  { value: "", label: t("settings.smallModelFollow") },
  { value: "deepseek/deepseek-v4-flash", label: t("settings.smallModelFlash") },
  { value: "deepseek/deepseek-v4-pro", label: t("settings.smallModelPro") },
]);
const currentSmallModel = computed(() => smallModelOptions.value.find(o => o.value === settings.smallModel) ?? smallModelOptions.value[0]);

/** 选择轻量模型 → 立即写 settings.json（主进程 saveSettings 引擎联动自动同步 opencode.json small_model，无需重启） */
async function handleSmallModelSelect(v: string) {
  settings.smallModel = v;
  try {
    await settings.persistSmallModel(v);
  } catch {
    // 写盘失败仅 console 记录（settings.json 不可写仍可运行，仅轻量模型选择重启后不恢复）
    console.error("[settings] 轻量模型保存 settings.json 失败", v);
  }
}

// ── 默认主 Agent 选项（7 agent，写 store.currentAgent）──
const agentOptions = computed(() => SUBAGENT_ORDER.map((name) => ({ value: name, label: name })));

// ── 语言 / 主题 / 字号 / 排布选项（SettingsSelect 直接消费 {value,label}；i18n key 即时翻译）──
// 语言名显示原生名（zh 界面也是"中文"），与语言选择器惯例一致
const langOptions = computed(() => [
  { value: "zh", label: t("settings.langZh") },
  { value: "en", label: t("settings.langEn") },
]);
const themeOptions = computed(() => [
  { value: "dark", label: t("settings.themeDark") },
  { value: "light", label: t("settings.themeLight") },
  { value: "system", label: t("settings.themeSystem") },
]);
const currentLang = computed(() => langOptions.value.find(o => o.value === settings.locale)!);
const currentTheme = computed(() => themeOptions.value.find(o => o.value === settings.theme)!);
const fontSizeOptions = computed(() => [
  { value: "small", label: t("settings.fontSizeSmall") },
  { value: "medium", label: t("settings.fontSizeMedium") },
  { value: "large", label: t("settings.fontSizeLarge") },
]);
const currentFontSize = computed(() => fontSizeOptions.value.find(o => o.value === settings.fontSize)!);

// ── 消息排布选项（B1：ui.messageLayout，原型 v0.4 文案；split=现状默认）──
const layoutOptions = computed(() => [
  { value: "left", label: t("settings.layoutLeft") },
  { value: "split", label: t("settings.layoutSplit") },
]);
const currentLayout = computed(() => layoutOptions.value.find(o => o.value === settings.messageLayout)!);

// ── 头像 emoji 快捷选择（B1：ui.avatar，原型 v0.15 avatar-picker 简化版：常用 emoji 点选 + 手动输入）──
const AVATAR_EMOJIS = ["🐱", "🐶", "🦊", "🐼", "🐸", "🐙", "🦋", "🌻", "🚀", "⭐", "🌈", "🍀"];

// 选择 emoji 头像：写入 store（图片头像优先于 emoji——选择 emoji 时同时清除已存图片，避免显示歧义）
async function handleAvatarEmoji(e: string) {
  settings.avatar = e;
  if (settings.avatarImage) await settings.clearAvatar();
}

// 上传图片头像：调 store.pickAvatar（bridge 弹系统文件选择框，成功写 avatarImage）
async function handleAvatarPick() {
  const r = await settings.pickAvatar();
  if (!r.ok) console.error("[settings] 头像图片选择失败", r);
}

// ── OC 可执行文件路径浏览（B1：engine.opencodePath；空=内置 sidecar/系统自动解析）──
async function handleOpencodePathPick() {
  const selected = await openDialog({ directory: false, title: t("settings.opencodePathPick") });
  if (!selected) return;
  const p = Array.isArray(selected) ? selected[0] : selected;
  settings.opencodePath = p;
}

// ── 模型预设（DeepSeek 专属，store 已固定）──
// SettingsSelect 消费 {value,label}；label 直接显示模型名（store 的 models 是显示名数组）
const modelPresets = computed(() => settings.models.map((m) => ({ value: m, label: m })));

// ── 子 agent 模型（AI行为 tab）：槽位映射与后端 applyModelAliases 精确对齐 ──
// 后端 preset.ts slotValues：high=主模型、low=轻量模型(空→SMALL_MODEL flash 兜底)、
// vision=moonshotai-cn/kimi-k3、anthropic=ds-anthropic/deepseek-v4-flash、inherit=继承主模型
// 白名单与 preset.ts AGENT_MODEL_WHITELIST 一致：按 agent 能力限定候选模型
const AGENT_MODEL_WHITELIST: Record<string, string[]> = {
  双星: ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro"],
  工匠: ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro"],
  助理: ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro"],
  参谋: ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro"],
  军师: ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro"],
  侦查兵: ["ds-anthropic/deepseek-v4-flash", "ds-anthropic/deepseek-v4-pro"],
  制图师: ["moonshotai-cn/kimi-k3"],
};

// 槽位映射：7 agent → slot（与 agents-manifest.json 契约一致）
const AGENT_SLOTS: Record<string, "high" | "low" | "vision" | "anthropic" | "inherit"> = {
  双星: "high",
  工匠: "low",
  助理: "low",
  参谋: "inherit",
  军师: "inherit",
  侦查兵: "anthropic",
  制图师: "vision",
};

// 子 agent 模型下拉顺序（设计文档 5.4.2 表格顺序）
const SUBAGENT_ORDER = ["双星", "工匠", "助理", "参谋", "军师", "侦查兵", "制图师"];

/**
 * 「跟随默认」显示值：与后端 slotValues 精确对齐，随主模型/轻量模型切换实时变化（computed）。
 * - high/inherit → 主模型（settings.model 显示名，inherit 不写 model 行=继承主模型）
 * - low → 轻量模型（settings.smallModel 空 → SMALL_MODEL 'deepseek/deepseek-v4-flash' 兜底）
 * - vision → moonshotai-cn/kimi-k3（固定）；anthropic → ds-anthropic/deepseek-v4-flash（固定）
 */
function agentSlotDefault(name: string): string {
  const slot = AGENT_SLOTS[name];
  if (slot === "low") return settings.smallModel || "deepseek/deepseek-v4-flash";
  if (slot === "vision") return "moonshotai-cn/kimi-k3";
  if (slot === "anthropic") return "ds-anthropic/deepseek-v4-flash";
  return settings.model;
}

/** 子 agent 模型下拉选项：「跟随默认（当前值）」 + 白名单候选（label 用短名，value 用全名） */
function subagentModelOptions(name: string): Array<{ value: string; label: string }> {
  return [
    { value: "", label: t("settings.followDefault", { model: agentSlotDefault(name) }) },
    ...AGENT_MODEL_WHITELIST[name].map((m) => ({
      value: m,
      label: m.replace(/^[^/]+\//, ""),  // 去 provider 前缀：deepseek-v4-flash / kimi-k3
    })),
  ];
}

/** 子 agent 模型当前值：overrides 无条目 = 跟随默认（空串） */
function subagentModelValue(name: string): string {
  return settings.agentModelOverrides[name] ?? "";
}

/** 选择子 agent 模型：跟随默认 → setAgentModelOverride(name, null) 删条目；具体模型 → 写全名 */
function handleSubagentModelChange(name: string, v: string) {
  settings.setAgentModelOverride(name, v ? v : null);
}

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
      testResult.value = { cc: t("settings.testConnectionOk"), chat: "✓ " + r.message };
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
    balance.value = { ok: false, message: t("settings.balanceQueryFailed") };
  } finally {
    balanceLoading.value = false;
  }
}

/** 余额展示文本：CNY 总余额；失败/未配置时显示原因 */
const balanceText = computed(() => {
  if (!balance.value) return "";
  if (!balance.value.ok) return balance.value.message ?? t("settings.balanceQueryFailedShort");
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
</script>

<template>
  <ErrorBoundary name="SettingsPanel">
    <div class="f-settings-panel">
      <!-- Header（固定顶部）：返回按钮 + 标题 -->
      <header class="f-settings-header">
        <button
          class="f-settings-back"
          :aria-label="$t('settings.backToChat')"
          @click="router.push('/chat')"
        >
          <ArrowLeft :size="16" />
        </button>
        <h2 class="f-settings-title">{{ $t('settings.title') }}</h2>
      </header>

      <!-- 主体：左侧导航 + 右侧滚动内容区 -->
      <div class="f-settings-body">
        <nav class="f-settings-nav">
          <button
            v-for="tab in TABS"
            :key="tab.id"
            type="button"
            class="f-settings-nav-item"
            :class="{ 'f-settings-nav-item--active': activeTab === tab.id }"
            :aria-current="activeTab === tab.id ? 'page' : undefined"
            @click="activeTab = tab.id"
          >
            <component :is="tab.icon" :size="16" />
            <span>{{ $t(tab.labelKey) }}</span>
          </button>
        </nav>

        <main class="f-settings-content">
          <!-- 通用：语言/主题/字号/消息排布/昵称/头像/工作目录 -->
          <section v-if="activeTab === 'general'" data-tab="general" class="f-settings-tab">
            <SettingsSection :title="$t('settings.tabs.general')">
              <div class="f-settings-fields">
                <SettingsSelect v-model="settings.locale" :label="$t('settings.language')" :options="langOptions" />
                <SettingsSelect v-model="settings.theme" :label="$t('settings.theme')" :options="themeOptions" />
                <SettingsSelect v-model="settings.fontSize" :label="$t('settings.fontSize')" :options="fontSizeOptions" />
                <SettingsSelect v-model="settings.messageLayout" :label="$t('settings.messageLayout')" :options="layoutOptions" />
              </div>
            </SettingsSection>

            <SettingsSection :title="$t('settings.section.profile')">
              <div class="f-settings-fields">
                <SettingsInput
                  v-model="settings.nickname"
                  :label="$t('settings.nickname')"
                  :placeholder="$t('settings.nicknamePlaceholder')"
                />
                <!-- 头像：emoji 快捷选择 + 手动输入 + 图片上传/清除（avatarImage 图片优先于 emoji 显示） -->
                <div class="settings-field">
                  <label class="settings-field__label">{{ $t('settings.avatar') }}</label>
                  <div class="avatar-emoji-grid">
                    <button
                      v-for="e in AVATAR_EMOJIS"
                      :key="e"
                      type="button"
                      class="avatar-emoji-item"
                      :class="{ 'avatar-emoji-item--active': settings.avatar === e && !settings.avatarImage }"
                      @click="handleAvatarEmoji(e)"
                    >
                      {{ e }}
                    </button>
                  </div>
                  <SettingsInput
                    v-model="settings.avatar"
                    :label="$t('settings.avatarEmojiLabel')"
                    :placeholder="$t('settings.avatarPlaceholder')"
                  />
                  <div class="avatar-image-row">
                    <span v-if="settings.avatarImage" class="avatar-image-status">
                      {{ $t('settings.avatarImageSet', { path: settings.avatarImage }) }}
                    </span>
                    <span v-else class="avatar-image-status avatar-image-status--empty">
                      {{ $t('settings.avatarImageEmpty', { value: settings.avatar.trim() || $t('settings.defaultMe') }) }}
                    </span>
                    <button type="button" class="f-settings-btn" @click="handleAvatarPick">
                      <ImagePlus :size="14" /> {{ $t('settings.upload') }}
                    </button>
                    <button
                      v-if="settings.avatarImage"
                      type="button"
                      class="f-settings-btn f-settings-btn--danger"
                      @click="settings.clearAvatar()"
                    >
                      <Trash2 :size="14" /> {{ $t('settings.clearAvatar') }}
                    </button>
                  </div>
                </div>
              </div>
            </SettingsSection>

            <SettingsSection :title="$t('settings.workspaceTitle')">
              <div class="f-settings-fields">
                <SettingsInput
                  :model-value="settings.cwd"
                  :label="$t('settings.workspaceLabel')"
                  :placeholder="$t('settings.workspacePlaceholder')"
                  readonly
                >
                  <template #suffix>
                    <button type="button" class="f-settings-btn f-settings-btn--suffix" @click="handleWorkspacePick">
                      <FolderOpen :size="14" />
                    </button>
                  </template>
                </SettingsInput>
                <p class="f-settings-hint">{{ $t('settings.workspaceHint') }}</p>
              </div>
            </SettingsSection>
          </section>

          <!-- 模型与API：API Key 含余额/kimi Key/baseUrl/主模型/测试连接/聊天 API 地址/上下文窗口 -->
          <section v-else-if="activeTab === 'model'" data-tab="model" class="f-settings-tab">
            <SettingsSection :title="$t('settings.engineTitle')">
              <div class="f-settings-fields">
                <!-- API Key：password 输入 + 余额状态行（刷新按钮旁路调用） -->
                <SettingsInput
                  v-model="settings.apiKey"
                  :label="$t('settings.apiKey')"
                  type="password"
                  :placeholder="$t('settings.keyPlaceholder')"
                >
                  <template #suffix>
                    <button
                      type="button"
                      class="f-settings-btn f-settings-btn--suffix"
                      :disabled="balanceLoading"
                      :aria-label="$t('settings.refreshBalance')"
                      @click="refreshBalance"
                    >
                      <RefreshCw :size="14" />
                    </button>
                  </template>
                </SettingsInput>
                <!-- 余额展示：CNY 总余额或失败原因；无 key 时显示 -- -->
                <div class="balance-row">
                  <span class="balance-label">{{ $t('settings.balance') }}</span>
                  <span class="balance-value">{{ balanceText }}</span>
                </div>

                <!-- kimi Key：多模态模型专用，独立明文切换 + 保存按钮（saveKimiKey 重启 serve） -->
                <SettingsInput
                  v-model="settings.kimiApiKey"
                  :label="$t('settings.kimiApiKey')"
                  :type="showKimiKey ? 'text' : 'password'"
                  :placeholder="$t('settings.keyPlaceholder')"
                >
                  <template #suffix>
                    <button
                      type="button"
                      class="f-settings-btn f-settings-btn--suffix"
                      :aria-label="showKimiKey ? $t('settings.hideKey') : $t('settings.showKey')"
                      @click="showKimiKey = !showKimiKey"
                    >
                      <Eye v-if="!showKimiKey" :size="14" />
                      <EyeOff v-else :size="14" />
                    </button>
                    <button type="button" class="f-settings-btn f-settings-btn--suffix" @click="handleKimiKeySave">
                      {{ $t('settings.save') }}
                    </button>
                  </template>
                </SettingsInput>
                <p v-if="kimiSaveMsg" class="f-settings-hint">{{ kimiSaveMsg }}</p>

                <SettingsInput
                  v-model="settings.baseUrl"
                  :label="$t('settings.baseUrl')"
                  placeholder="https://api.deepseek.com"
                />

                <SettingsSelect v-model="settings.model" :label="$t('settings.model')" :options="modelPresets" />

                <!-- 测试连接：调 engine:testConnection；成功显示 ✓ + chat 详情，失败显示 translateError -->
                <button
                  type="button"
                  class="f-settings-btn f-settings-btn--test"
                  :disabled="isTesting"
                  @click="handleTest"
                >
                  <span v-if="!isTesting">{{ $t('settings.test') }}</span>
                  <span v-else>{{ $t('settings.testing') }}</span>
                </button>
                <div v-if="testResult" class="test-result test-result--ok">{{ testResult.chat }}</div>
                <div v-else-if="translatedTestError" class="test-result test-result--err">{{ translatedTestError }}</div>
              </div>
            </SettingsSection>

            <SettingsSection :title="$t('settings.section.session')">
              <div class="f-settings-fields">
                <!-- 聊天 API 地址：optimizeApiUrl 语义（旧 llmApiUrl）；🔍 按钮自动查询 URL（阶段 3 已有逻辑） -->
                <SettingsInput
                  v-model="settings.optimizeApiUrl"
                  :label="$t('settings.llmApiUrl')"
                  :placeholder="$t('settings.llmApiUrlPlaceholder')"
                >
                  <template #suffix>
                    <button
                      type="button"
                      class="f-settings-btn f-settings-btn--suffix"
                      :disabled="isLookingUpUrl"
                      :aria-label="$t('settings.llmApiUrlLookup')"
                      @click="startLookupUrl"
                    >
                      <Search :size="14" />
                    </button>
                  </template>
                </SettingsInput>

                <!-- 上下文窗口：blur 时解析简写（128K/1M），输入由本地 ref 缓冲 -->
                <SettingsInput
                  v-model="contextLimitInput"
                  :label="$t('settings.contextLimit')"
                  :placeholder="$t('settings.contextLimitPlaceholder')"
                  @blur="parseContextLimit"
                />
              </div>
            </SettingsSection>
          </section>

          <!-- AI行为：默认主 Agent/子 agent 模型/权限模式/思考深度/思考节点/轻量模型 -->
          <section v-else-if="activeTab === 'behavior'" data-tab="behavior" class="f-settings-tab">
            <SettingsSection :title="$t('settings.section.agent')">
              <div class="f-settings-fields">
                <!-- 默认主 Agent：7 agent 选择，写 store.currentAgent -->
                <SettingsSelect v-model="settings.currentAgent" :label="$t('settings.defaultMainAgent')" :options="agentOptions" />
              </div>
            </SettingsSection>

            <!-- 子 agent 模型：7 行，每行「跟随默认（当前值）」+ 白名单候选（与后端 applyModelAliases 对齐） -->
            <SettingsSection :title="$t('settings.section.subagentModels')">
              <div class="f-settings-fields">
                <SettingsSelect
                  v-for="name in SUBAGENT_ORDER"
                  :key="name"
                  :model-value="subagentModelValue(name)"
                  :label="$t('settings.subagentModelLabel', { name, slot: AGENT_SLOTS[name] })"
                  :options="subagentModelOptions(name)"
                  @update:model-value="(v: string) => handleSubagentModelChange(name, v)"
                />
              </div>
            </SettingsSection>

            <SettingsSection :title="$t('settings.defaultMode')">
              <div class="f-settings-fields">
                <!-- 权限模式：activeMode computed 双向绑定（plan/auto 与 permissionMode 三联动） -->
                <SettingsSelect v-model="activeMode" :label="$t('settings.defaultMode')" :options="permSelectOptions" />
                <!-- 思考深度：仅当前模型支持 variants 时显示（modelVariants 为空 → 隐藏下拉） -->
                <SettingsSelect
                  v-if="effortSelectOptions.length > 0"
                  v-model="settings.effort"
                  :label="$t('settings.defaultEffort')"
                  :options="effortSelectOptions"
                />
                <!-- 思考节点开关：控制时间线节点显隐（v-show，数据不删） -->
                <SettingsToggle
                  v-model="settings.showThinking"
                  :label="$t('settings.thinkingNode')"
                  :desc="$t('settings.thinkingNodeDesc')"
                />
                <!-- 轻量模型：LOW 槽位默认值来源（标题/摘要/润色等轻任务），选完立即写 settings.json -->
                <SettingsSelect
                  :model-value="currentSmallModel.value"
                  :label="$t('settings.smallModel')"
                  :options="smallModelOptions"
                  @update:model-value="handleSmallModelSelect"
                />
              </div>
            </SettingsSection>
          </section>

          <!-- 通知：全局开关 + 4 场景（全局关时场景禁用；D15 默认关，开全局后 replyDone 默认开） -->
          <section v-else-if="activeTab === 'notify'" data-tab="notify" class="f-settings-tab">
            <SettingsSection :title="$t('settings.tabs.notify')">
              <div class="f-settings-fields">
                <SettingsToggle
                  v-model="settings.notifications.enabled"
                  :label="$t('settings.notifyGlobal')"
                  :desc="$t('settings.notifyGlobalDesc')"
                />
                <div class="f-settings-divider" />
                <SettingsToggle
                  v-model="settings.notifications.replyDone"
                  :label="$t('settings.notifyReplyDone')"
                  :desc="$t('settings.notifyReplyDoneDesc')"
                  :disabled="!settings.notifications.enabled"
                />
                <SettingsToggle
                  v-model="settings.notifications.engineError"
                  :label="$t('settings.notifyEngineError')"
                  :desc="$t('settings.notifyEngineErrorDesc')"
                  :disabled="!settings.notifications.enabled"
                />
                <SettingsToggle
                  v-model="settings.notifications.permissionPending"
                  :label="$t('settings.notifyPermissionPending')"
                  :desc="$t('settings.notifyPermissionPendingDesc')"
                  :disabled="!settings.notifications.enabled"
                />
                <SettingsToggle
                  v-model="settings.notifications.subtaskDone"
                  :label="$t('settings.notifySubtaskDone')"
                  :desc="$t('settings.notifySubtaskDoneDesc')"
                  :disabled="!settings.notifications.enabled"
                />
              </div>
            </SettingsSection>
          </section>

          <!-- 高级：数据模式/OC路径/日志级别/预置技能/JSON编辑器/重开引导 -->
          <section v-else-if="activeTab === 'advanced'" data-tab="advanced" class="f-settings-tab">
            <SettingsSection :title="$t('settings.advanced')">
              <div class="f-settings-fields">
                <!-- 数据模式：独立会话数据开关（切换 → setDataMode 重启 serve + 清缓存；isRestarting 禁用防连点） -->
                <SettingsToggle
                  :model-value="settings.dataMode === 'isolated'"
                  :label="$t('settings.dataModeLabel')"
                  :desc="$t('settings.dataModeDesc')"
                  :disabled="settings.isRestarting"
                  @update:model-value="handleDataModeToggle($event ? 'isolated' : 'shared')"
                />
                <p v-if="dataModeMsg" class="f-settings-hint" :class="{ 'f-settings-hint--ok': dataModeMsg.type === 'ok', 'f-settings-hint--err': dataModeMsg.type === 'err' }">
                  {{ dataModeMsg.text }}
                </p>

                <!-- OC 可执行文件路径：空=内置 sidecar/系统自动解析 -->
                <SettingsInput
                  v-model="settings.opencodePath"
                  :label="$t('settings.opencodePath')"
                  :placeholder="$t('settings.opencodePathPlaceholder')"
                >
                  <template #suffix>
                    <button type="button" class="f-settings-btn f-settings-btn--suffix" @click="handleOpencodePathPick">
                      <FolderOpen :size="14" />
                    </button>
                  </template>
                </SettingsInput>
                <p class="f-settings-hint">{{ $t('settings.opencodePathDesc') }}</p>

                <!-- 引擎日志级别：spawn serve 时 --log-level -->
                <SettingsSelect
                  v-model="settings.logLevel"
                  :label="$t('settings.logLevel')"
                  :options="settings.LOG_LEVEL_OPTIONS.map((l) => ({ value: l, label: l }))"
                />
                <p class="f-settings-hint">{{ $t('settings.logLevelDesc') }}</p>

                <!-- 预置技能包：关闭后下次启动不加载预设 skills -->
                <SettingsToggle
                  v-model="settings.presetSkillsEnabled"
                  :label="$t('settings.presetSkills')"
                  :desc="$t('settings.presetSkillsDesc')"
                />
              </div>
            </SettingsSection>

            <!-- JSON 编辑器：VSCode 风格 JSONC 配置（高级来源，B1 兜底） -->
            <SettingsSection :title="$t('settings.section.configFile')">
              <SettingsJsonEditor />
            </SettingsSection>

            <!-- 重开引导：清除 onboardingDismissed，下次启动重新显示引导页 -->
            <SettingsSection :title="$t('settings.section.onboarding')">
              <div class="f-settings-fields">
                <button type="button" class="f-settings-btn" @click="settings.resetOnboarding()">
                  {{ $t('settings.reopenOnboarding') }}
                </button>
              </div>
            </SettingsSection>
          </section>

          <!-- 关于：版本/引擎版本/预置版本/变更记录（迁移自旧 footer 关于栏） -->
          <section v-else data-tab="about" class="f-settings-tab">
            <SettingsSection :title="$t('settings.tabs.about')">
              <div class="about-row">
                <span class="about-label">{{ $t('app.title') }}</span>
                <span class="about-value">by MaxNull · v{{ appVersion }}</span>
              </div>
              <div class="about-row">
                <span class="about-label">{{ $t('settings.engineVersion') }}</span>
                <span class="about-value">{{ engineVersion }}</span>
              </div>
              <div class="about-row">
                <span class="about-label">{{ $t('settings.presetVersion') }}</span>
                <span class="about-value">{{ presetVersion }}</span>
              </div>
              <button type="button" class="f-settings-btn" @click="showChangelog = true">
                {{ $t('settings.changelog') }}
              </button>
            </SettingsSection>
          </section>
        </main>
      </div>
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
/* ── 设置页骨架：header + 左侧导航 + 右侧滚动区 ── */
.f-settings-panel {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.f-settings-header {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 20px 8px;
}

/* 返回按钮：图标式，hover 反馈（迁移自旧 header svg 按钮） */
.f-settings-back {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  transition: background 150ms;
  color: var(--text-secondary);
  cursor: pointer;
}
.f-settings-back:hover {
  background: var(--bg-hover);
}

.f-settings-title {
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--text-bright);
}

/* 主体：左侧导航固定宽，右侧内容独立滚动 */
.f-settings-body {
  flex: 1;
  min-height: 0;
  display: flex;
}

.f-settings-nav {
  flex-shrink: 0;
  width: 160px;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-right: 1px solid var(--border-dim);
}

/* 导航项：图标 + 文字；选中态 accent 高亮（与全局交互色一致） */
.f-settings-nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background 150ms, color 150ms;
  text-align: left;
}
.f-settings-nav-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.f-settings-nav-item--active {
  background: var(--accent-glow);
  color: var(--accent);
}

/* 右侧内容：单列滚动 */
.f-settings-content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 16px 24px 24px;
}

.f-settings-tab {
  max-width: 560px;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

/* tab 占位（后续任务填充，阶段 4 骨架期展示） */
.f-settings-tab-placeholder {
  font-size: 12px;
  color: var(--text-muted);
}

/* ── 通用 tab 字段 ── */
/* 字段容器：统一纵向排布（SettingsSelect/Input 根部 .settings-field 已自带 label） */
.f-settings-fields {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* 通用按钮：lucide 图标 + 文字（上传/清除/后缀按钮共用） */
.f-settings-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid var(--border-default);
  background: var(--bg-elevated);
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: border-color 150ms, color 150ms;
}
.f-settings-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
/* 危险操作（清除头像）：hover 红色提示 */
.f-settings-btn--danger:hover {
  border-color: var(--danger, #ef4444);
  color: var(--danger, #ef4444);
}

/* 头像 emoji 快捷选择：12 宫格，选中项 accent-glow 高亮 */
.avatar-emoji-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 4px;
  margin-bottom: 12px;
}
.avatar-emoji-item {
  aspect-ratio: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  border: 1px solid var(--border-dim);
  background: transparent;
  font-size: 16px;
  cursor: pointer;
  transition: border-color 150ms, background 150ms;
}
.avatar-emoji-item:hover {
  border-color: var(--border-default);
  background: var(--bg-hover);
}
.avatar-emoji-item--active {
  background: var(--accent-glow);
  border-color: var(--accent);
}

/* 图片头像状态行：文件名 + 上传/清除按钮 */
.avatar-image-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}
.avatar-image-status {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.avatar-image-status--empty {
  color: var(--text-muted);
}

/* 提示文案（工作目录说明等）：12px 次级色 */
.f-settings-hint {
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-muted);
}

/* ── 模型与API tab ── */
/* 余额行：label 12px 次级 + 值 14px 加粗；与 API Key 输入框间距由 fields 容器控制 */
.balance-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.balance-label {
  color: var(--text-secondary);
}
.balance-value {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-bright);
}

/* 测试连接按钮：accent 描边，突出主操作（与输入框旁 suffix 按钮区分） */
.f-settings-btn--test {
  align-self: flex-start;
  padding: 8px 18px;
  font-size: 13px;
  font-weight: 500;
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-glow);
}
.f-settings-btn--test:disabled {
  opacity: 0.5;
  cursor: default;
}

/* 测试结果：成功 accent 绿 / 失败红色（迁移自旧 inline style + class 判定） */
.test-result {
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.5;
}
.test-result--ok {
  color: #22c55e;
  background: rgba(34, 197, 94, 0.08);
}
.test-result--err {
  color: #ef4444;
  background: rgba(239, 68, 68, 0.08);
}

/* ── 通知 tab ── */
/* 全局开关与场景列表的分隔线：次级色细线，视觉分组 */
.f-settings-divider {
  height: 1px;
  background: var(--border-dim);
  margin: 2px 0;
}

/* ── 高级 / 关于 tab ── */
/* 数据模式提示条：成功绿 / 失败红（复用测试结果语义色） */
.f-settings-hint--ok {
  color: #22c55e;
}
.f-settings-hint--err {
  color: #ef4444;
}

/* 关于信息行：label 12px 次级 + 值 14px 主色 */
.about-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  padding: 6px 0;
}
.about-label {
  font-size: 12px;
  color: var(--text-secondary);
}
.about-value {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-bright);
}
</style>
