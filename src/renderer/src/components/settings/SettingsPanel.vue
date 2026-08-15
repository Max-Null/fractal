<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, type Component } from "vue";
import { useRouter } from "vue-router";
import { useSettingsStore } from "@/stores/settings";
import { useI18n } from "vue-i18n";
import { testConnection, testKimiConnection, openDialog, getAppInfo, getBalance, getKimiBalance, checkForUpdates, downloadUpdate, quitAndInstall, onUpdaterStatus, type UpdaterStatus, type DeepSeekBalanceResult } from "@/lib/electron-bridge";
import { useAvatarImageUrl } from "@/composables/useAvatarImageUrl";
import { AVATAR_ICONS } from "@/lib/avatar-icons";
import { ArrowLeft, Settings as SettingsIcon, Palette, Bot, Bell, Wrench, Info, FolderOpen, ImagePlus, Trash2, RefreshCw, Eye, EyeOff, ScrollText } from "lucide-vue-next";

const appVersion = __APP_VERSION__;

import ErrorBoundary from "@/components/shared/ErrorBoundary.vue";
import ModalShell from "@/components/shared/ModalShell.vue";
import KeyChangeDialog from "@/components/shared/KeyChangeDialog.vue";
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
/** 图片头像预览 URL（与消息区共用 composable）；空 = 未设置/路径获取失败 → 不渲染预览 */
const { avatarImageUrl } = useAvatarImageUrl();

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

// ── 轻量模型选项（LOW 槽位：标题生成/会话摘要/消息润色；值=模型全名，默认 flash，''=跟随主模型）──
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

// ── 默认主 Agent 选项（仅主 agent：双星/build/plan，与输入框 agent pill 的 AGENT_OPTIONS 对齐）──
// 子 agent（工匠/军师等）是 subagent，不可作主 agent；SUBAGENT_ORDER 仅用于下方「子 agent 模型」配置
const PRIMARY_AGENTS = ["双星", "build", "plan"];
const agentOptions = computed(() => PRIMARY_AGENTS.map((name) => ({ value: name, label: name })));

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

// ── 繁忙时 Enter 行为选项（ui.busyEnterBehavior；insert=打断当前回答，queue=serve 排队）──
const busyEnterOptions = computed(() => [
  { value: "insert", label: t("settings.busyEnterInsert") },
  { value: "queue", label: t("settings.busyEnterQueue") },
]);

// ── 头像 lucide 图标快捷选择（ui.avatar 存图标 id；候选表见 lib/avatar-icons，消息区渲染共用同一映射）──
// 选择图标头像：写入 store（图片头像优先于图标——选择图标时同时清除已存图片，避免显示歧义）
async function handleAvatarIcon(id: string) {
  settings.avatar = id;
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

// ── 主模型（DeepSeek）key 明文切换（测试/保存逻辑已移至 blur 引导弹窗）──
const showDeepSeekKey = ref(false);

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

// ── Kimi 多模态账户余额（计费迭代：与 DeepSeek 余额对称，多模态区显示；未配置不展示文案）──
const kimiBalance = ref<DeepSeekBalanceResult | null>(null);
const kimiBalanceLoading = ref(false);

/** 查询 Kimi 余额；无 API Key 或失败时静默降级（不阻断设置面板渲染） */
async function refreshKimiBalance() {
  if (kimiBalanceLoading.value) return;
  kimiBalanceLoading.value = true;
  try {
    kimiBalance.value = await getKimiBalance();
  } catch {
    kimiBalance.value = { ok: false, message: t("settings.balanceQueryFailed") };
  } finally {
    kimiBalanceLoading.value = false;
  }
}

/** Kimi 余额展示文本：CNY 可用余额；失败显示原因；未配置 key 显示空（常态，不展示告警） */
const kimiBalanceText = computed(() => {
  if (!settings.kimiApiKey.trim()) return "";
  if (!kimiBalance.value) return "";
  if (!kimiBalance.value.ok) return kimiBalance.value.message ?? t("settings.balanceQueryFailedShort");
  const cny = kimiBalance.value.balanceInfos?.find((b) => b.currency === "CNY")
    ?? kimiBalance.value.balanceInfos?.[0];
  return cny ? `¥${Number(cny.totalBalance).toFixed(2)}` : "--";
});

// Kimi key 变化后自动刷新余额（保存即触发；防抖避免输入过程反复请求；key 清空 → 直接清空展示不请求）
let kimiBalanceTimer: ReturnType<typeof setTimeout> | null = null;
watch(() => settings.kimiApiKey, () => {
  if (kimiBalanceTimer) clearTimeout(kimiBalanceTimer);
  if (!settings.kimiApiKey.trim()) {
    kimiBalance.value = null;
    return;
  }
  kimiBalanceTimer = setTimeout(() => { refreshKimiBalance(); }, 600);
});

// 路由离开时清理定时器（否则卸载后仍可能触发改已卸载 ref）
onUnmounted(() => {
  if (balanceTimer) clearTimeout(balanceTimer);
  if (kimiBalanceTimer) clearTimeout(kimiBalanceTimer);
});
// 挂载即查询一次（设置页打开时直接显示余额，不依赖 key 变化事件）
onMounted(() => {
  refreshBalance();
  // Kimi 仅配置了 key 才查（未配置不请求，避免无意义网络调用）
  if (settings.kimiApiKey.trim()) refreshKimiBalance();
});

// ── 多模态模型（制图师 kimi-k3）API Key ──
// password 明文切换（独立 state，与 DeepSeek key 互不干扰——DeepSeek 输入框无切换，沿用 Onboarding 交互模式）
const showKimiKey = ref(false);

// ── API Key 变更引导弹窗（key 输入框 blur 检测到变化 → 自动「测试连接 → 保存并重启引擎」）──
// 背景：key 改了但 serve 不重启就不生效（serve 启动时读 key），小白不懂「重启引擎」——
// blur 后自动串行执行测试→保存重启，弹窗只做进度/结果反馈，无需手动点任何按钮。
type KeyChangeTarget = "deepseek" | "kimi";
type KeyChangePhase = "testing" | "saving" | "success" | "error";
const keyChangeTarget = ref<KeyChangeTarget | null>(null);
const keyChangeOpen = computed(() => keyChangeTarget.value !== null);
// 已生效 key 快照（serve 正在用的值）：挂载时同步，保存重启成功后更新
const servedApiKeySnapshot = ref(settings.apiKey);
const servedKimiKeySnapshot = ref(settings.kimiApiKey);
// 自动流程状态：阶段 + 动态文案（进度/结果）
const dialogPhase = ref<KeyChangePhase>("testing");
const dialogMessage = ref("");
// 成功态自动关闭定时器（1.2s 后关），取消时清理避免误关
const successCloseTimer = ref<ReturnType<typeof setTimeout> | null>(null);

/** DeepSeek key 失去焦点：值变化（非空且 ≠ 已生效快照）→ 弹窗并自动跑「测试→保存重启」流程 */
function onApiKeyBlur() {
  const cur = settings.apiKey.trim();
  if (cur && cur !== servedApiKeySnapshot.value.trim()) {
    keyChangeTarget.value = "deepseek";
    void runKeyChangeFlow();
  }
}

/** Kimi key 失去焦点：同上 */
function onKimiKeyBlur() {
  const cur = settings.kimiApiKey.trim();
  if (cur && cur !== servedKimiKeySnapshot.value.trim()) {
    keyChangeTarget.value = "kimi";
    void runKeyChangeFlow();
  }
}

/** 关闭弹窗：清 target + 清成功态自动关闭定时器（幂等，可重复调用） */
function handleDialogCancel() {
  keyChangeTarget.value = null;
  if (successCloseTimer.value) {
    clearTimeout(successCloseTimer.value);
    successCloseTimer.value = null;
  }
}

/** 「重试」：失败态重新跑完整自动流程（测试→保存重启） */
function handleDialogRetry() {
  void runKeyChangeFlow();
}

/** 自动流程：测试连接 →（通过）保存并重启引擎 → 成功自动关闭；测试/保存失败停住显示错误 */
async function runKeyChangeFlow() {
  const target = keyChangeTarget.value;
  if (!target) return;
  dialogPhase.value = "testing";
  dialogMessage.value = t("settings.keyChangeTesting");
  try {
    // 第一步：测试连接（纯校验 key 有效性，不保存不重启）
    const r = target === "deepseek" ? await testConnection(settings.apiKey) : await testKimiConnection(settings.kimiApiKey);
    if (!r.ok) {
      // 测试失败说明 key 无效：停下不保存不重启（避免用坏 key 重启引擎），显示错误供重试/取消
      dialogPhase.value = "error";
      dialogMessage.value = r.message;
      return;
    }
    // 第二步：保存并重启引擎（使新 key 生效）
    dialogPhase.value = "saving";
    dialogMessage.value = t("settings.keyChangeSaving");
    if (target === "deepseek") {
      await settings.saveCurrentConfig(true);
      servedApiKeySnapshot.value = settings.apiKey;
    } else {
      await settings.saveKimiKey(true);
      servedKimiKeySnapshot.value = settings.kimiApiKey;
    }
    // 第三步：成功 → 1.2s 后自动关闭
    dialogPhase.value = "success";
    dialogMessage.value = t("settings.keyChangeSuccess");
    successCloseTimer.value = setTimeout(() => {
      if (keyChangeTarget.value === target) handleDialogCancel();
    }, 1200);
  } catch (err) {
    dialogPhase.value = "error";
    dialogMessage.value = String(err);
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

// ── 自动更新：订阅主进程 updater:status，驱动检查按钮/状态区/确认弹窗（2026-08-14）──
// 状态单例存本地 ref（不引入全局 store）；available 自动弹确认窗，downloaded 自动关窗
const updaterState = ref<UpdaterStatus | null>(null);
const updaterBusy = ref(false);
const updaterConfirmOpen = ref(false);
let updaterOff: (() => void) | null = null;

onMounted(() => {
  updaterOff = onUpdaterStatus((s) => {
    updaterState.value = s;
    if (s.type === "available") updaterConfirmOpen.value = true;
    if (s.type === "downloaded") updaterConfirmOpen.value = false;
  });
});
onUnmounted(() => {
  updaterOff?.();
});

// 手动检查：busy 期间禁点防重复触发；dev 模式主进程抛 DEV_MODE（占位 handler），catch 显示「开发模式不可用」；
// 2026-08-15 修复：仅 DEV_MODE 显示 devMode 文案，其他异常透传真实信息——此前安装版真实错误（网络/发布配置）
// 被统一吞成 devMode 误报
async function handleCheckUpdates(): Promise<void> {
  if (updaterBusy.value) return;
  updaterBusy.value = true;
  try {
    await checkForUpdates();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    updaterState.value = {
      type: "error",
      message: msg.includes("DEV_MODE_UPDATER_UNAVAILABLE") ? t("settings.update.devMode") : msg,
    };
  } finally {
    updaterBusy.value = false;
  }
}
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
                <SettingsSelect v-model="settings.busyEnterBehavior" :label="$t('settings.busyEnter')" :options="busyEnterOptions" />
              </div>
            </SettingsSection>

            <SettingsSection :title="$t('settings.section.profile')">
              <div class="f-settings-fields">
                <SettingsInput
                  v-model="settings.nickname"
                  :label="$t('settings.nickname')"
                  :placeholder="$t('settings.nicknamePlaceholder')"
                />
                <!-- 头像：图片上传/清除 + lucide 图标候选（avatarImage 图片优先于图标显示） -->
                <div class="settings-field">
                  <label class="settings-field__label">{{ $t('settings.avatar') }}</label>
                  <!-- 头像上传器：无图片=虚线占位框（点击上传）；有图片=预览图（点击更换 + 右上角清除） -->
                  <div class="avatar-uploader">
                    <button v-if="!avatarImageUrl" type="button" class="avatar-uploader__empty" @click="handleAvatarPick">
                      <ImagePlus :size="20" />
                      <span>{{ $t('settings.upload') }}</span>
                    </button>
                    <div v-else class="avatar-uploader__preview">
                      <img class="avatar-uploader__img" :src="avatarImageUrl" alt="" />
                      <div class="avatar-uploader__overlay">
                        <button type="button" class="avatar-uploader__change" :title="$t('settings.changeAvatar')" @click.stop="handleAvatarPick">
                          <ImagePlus :size="18" />
                        </button>
                        <button type="button" class="avatar-uploader__clear" :title="$t('settings.clearAvatar')" @click.stop="settings.clearAvatar()">
                          <Trash2 :size="18" />
                        </button>
                      </div>
                    </div>
                  </div>
                  <div class="avatar-icon-grid">
                    <button
                      v-for="item in AVATAR_ICONS"
                      :key="item.id"
                      type="button"
                      class="avatar-icon-item"
                      :class="{ 'avatar-icon-item--active': settings.avatar === item.id && !settings.avatarImage }"
                      @click="handleAvatarIcon(item.id)"
                    >
                      <component :is="item.icon" :size="24" />
                    </button>
                  </div>
                </div>
              </div>
            </SettingsSection>
          </section>

          <!-- 模型与API：主模型 API（DeepSeek）/ 多模态 API（制图师）/ 会话（上下文窗口）三分组 -->
          <section v-else-if="activeTab === 'model'" data-tab="model" class="f-settings-tab">
            <!-- 主模型 API（DeepSeek）：API Key + 余额 + baseUrl + 模型 + 测试连接 -->
            <SettingsSection :title="$t('settings.mainModelApi')">
              <div class="f-settings-fields">
                <!-- API Key：password 输入 + 明文切换（Eye/EyeOff） -->
                <SettingsInput
                  v-model="settings.apiKey"
                  :label="$t('settings.apiKey')"
                  :type="showDeepSeekKey ? 'text' : 'password'"
                  :placeholder="$t('settings.keyPlaceholder')"
                  @blur="onApiKeyBlur"
                >
                  <template #suffix>
                    <button
                      type="button"
                      class="f-settings-btn f-settings-btn--suffix"
                      :aria-label="showDeepSeekKey ? $t('settings.hideKey') : $t('settings.showKey')"
                      @click="showDeepSeekKey = !showDeepSeekKey"
                    >
                      <Eye v-if="!showDeepSeekKey" :size="14" />
                      <EyeOff v-else :size="14" />
                    </button>
                  </template>
                </SettingsInput>
                <p class="f-settings-hint">{{ $t('settings.apiKeyDesc') }}</p>
                <!-- 余额展示：CNY 总余额或失败原因；无 key 时显示 --；刷新按钮跟随余额行 -->
                <div class="balance-row">
                  <span class="balance-label">{{ $t('settings.balance') }}</span>
                  <span class="balance-value">{{ balanceText }}</span>
                  <button
                    type="button"
                    class="f-settings-btn f-settings-btn--suffix"
                    :disabled="balanceLoading"
                    :aria-label="$t('settings.refreshBalance')"
                    @click="refreshBalance"
                  >
                    <RefreshCw :size="14" />
                  </button>
                </div>

                <SettingsInput
                  v-model="settings.baseUrl"
                  :label="$t('settings.baseUrl')"
                  placeholder="https://api.deepseek.com"
                />

                <SettingsSelect v-model="settings.model" :label="$t('settings.model')" :options="modelPresets" />
              </div>
            </SettingsSection>

            <!-- 多模态 API（制图师）：Kimi Key + 保存（saveKimiKey 重启 serve）+ 说明 -->
            <SettingsSection :title="$t('settings.multimodalApi')">
              <div class="f-settings-fields">
                <!-- kimi Key：多模态模型专用，独立明文切换 + 保存按钮（saveKimiKey 重启 serve） -->
                <SettingsInput
                  v-model="settings.kimiApiKey"
                  :label="$t('settings.kimiApiKey')"
                  :type="showKimiKey ? 'text' : 'password'"
                  :placeholder="$t('settings.keyPlaceholder')"
                  @blur="onKimiKeyBlur"
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
                  </template>
                </SettingsInput>
                <p class="f-settings-hint">{{ $t('settings.kimiApiKeyDesc') }}</p>
                <!-- Kimi 余额展示：CNY 可用余额或失败原因；未配置 key 显示空；刷新按钮跟随余额行 -->
                <div class="balance-row">
                  <span class="balance-label">{{ $t('settings.balance') }}</span>
                  <span class="balance-value">{{ kimiBalanceText }}</span>
                  <button
                    type="button"
                    class="f-settings-btn f-settings-btn--suffix"
                    :disabled="kimiBalanceLoading"
                    :aria-label="$t('settings.refreshBalance')"
                    @click="refreshKimiBalance"
                  >
                    <RefreshCw :size="14" />
                  </button>
                </div>
              </div>
            </SettingsSection>

            <!-- 会话：上下文窗口（聊天 API 地址已移除） -->
            <SettingsSection :title="$t('settings.section.session')">
              <div class="f-settings-fields">
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
                <!-- 默认主 Agent：仅主 agent（双星/build/plan），写 store.currentAgent -->
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
                <!-- 思考节点开关：控制时间线节点显隐（v-show，数据不删）；右对齐样式与通知 tab 开关一致 -->
                <SettingsToggle
                  v-model="settings.showThinking"
                  :label="$t('settings.thinkingNode')"
                  :desc="$t('settings.thinkingNodeDesc')"
                />
                <!-- 轻量模型：LOW 槽位默认值来源（标题/摘要/润色等轻任务），选完立即写 settings.json -->
                <SettingsSelect
                  :model-value="currentSmallModel.value"
                  :label="$t('settings.smallModel')"
                  :desc="$t('settings.smallModelDesc')"
                  :options="smallModelOptions"
                  @update:model-value="handleSmallModelSelect"
                />
              </div>
            </SettingsSection>
          </section>

          <!-- 通知：全局开关 + 4 场景（全局关时场景禁用；2026-08-14 定案：默认开 3 场景——回答完成/引擎异常/权限请求，子任务完成默认关） -->
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
              <!-- 关于操作行：更新日志 + 检查更新并排（2026-08-14 用户反馈：两按钮一左一右错位，改为同排统一左对齐） -->
              <div class="about-updater">
                <div class="about-updater-actions">
                  <button type="button" class="f-settings-btn" @click="showChangelog = true">
                    <ScrollText :size="14" />
                    {{ $t('settings.changelog') }}
                  </button>
                  <button
                    type="button"
                    class="f-settings-btn about-updater-check"
                    :disabled="updaterBusy"
                    @click="handleCheckUpdates"
                  >
                    <RefreshCw :size="14" :class="{ 'is-spinning': updaterBusy }" />
                    {{ $t('settings.update.check') }}
                  </button>
                </div>
                <div v-if="updaterState" class="about-updater-status">
                  <span v-if="updaterState.type === 'checking'">{{ $t('settings.update.checking') }}</span>
                  <span v-else-if="updaterState.type === 'not-available'" class="about-updater-ok">
                    {{ $t('settings.update.latest') }} (v{{ updaterState.version }})
                  </span>
                  <span v-else-if="updaterState.type === 'progress'">
                    {{ $t('settings.update.downloading') }} {{ Math.round(updaterState.percent ?? 0) }}%
                  </span>
                  <span v-else-if="updaterState.type === 'downloaded'">
                    <span class="about-updater-ok">v{{ updaterState.version }} · {{ $t('settings.update.restart') }}</span>
                    <button
                      type="button"
                      class="f-settings-btn about-updater-restart"
                      @click="quitAndInstall()"
                    >
                      {{ $t('settings.update.restart') }}
                    </button>
                  </span>
                  <span v-else-if="updaterState.type === 'error'" class="about-updater-error">
                    {{ $t('settings.update.error') }}：{{ updaterState.message }}
                  </span>
                </div>
              </div>
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
  <!-- 自动更新确认弹窗：发现新版 → 展示版本与变更摘要 → 立即更新/稍后（自动更新 2026-08-14） -->
  <ModalShell :open="updaterConfirmOpen" size="sm" @close="updaterConfirmOpen = false">
    <template #header>
      <span class="text-sm font-semibold" :style="{ color: 'var(--text-bright)' }">
        {{ $t('settings.update.confirmTitle') }} v{{ updaterState?.version }}
      </span>
    </template>
    <div class="about-updater-notes">
      {{ updaterState?.releaseNotes || $t('settings.update.noNotes') }}
    </div>
    <template #footer>
      <button type="button" class="f-settings-btn" @click="updaterConfirmOpen = false">
        {{ $t('modal.cancel') }}
      </button>
      <button
        type="button"
        class="f-settings-btn about-updater-confirm-btn"
        @click="downloadUpdate(); updaterConfirmOpen = false"
      >
        {{ $t('settings.update.download') }}
      </button>
    </template>
  </ModalShell>
  <!-- API Key 变更引导弹窗：blur 检测变化后自动「测试连接 → 保存并重启引擎」，弹窗只做进度/结果反馈 -->
  <KeyChangeDialog
    :open="keyChangeOpen"
    :title="$t('settings.keyChangeTitle')"
    :message="dialogMessage"
    :phase="dialogPhase"
    :retry-text="$t('settings.keyChangeRetry')"
    @retry="handleDialogRetry"
    @cancel="handleDialogCancel"
  />
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
  font-size: 1.286rem;
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
  font-size: 0.929rem;
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
  font-size: 0.857rem;
  color: var(--text-muted);
}

/* ── 通用 tab 字段 ── */
/* 字段容器：统一纵向排布（SettingsSelect/Input 根部 .settings-field 已自带 label） */
.f-settings-fields {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* 字段标签：与 SettingsInput/SettingsSelect 内 scoped 的 .settings-field__label 保持一致（头像等直接写在 SettingsPanel 的字段复用此样式，避免裸 label 样式不一致） */
.settings-field__label {
  display: block;
  font-size: 0.857rem;
  font-weight: 500;
  margin-bottom: 6px;
  color: var(--text-secondary);
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
  font-size: 0.857rem;
  cursor: pointer;
  transition: border-color 150ms, color 150ms;
}
.f-settings-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
/* 更新区块：按钮行 + 状态区纵向排列（自动更新 2026-08-14；按钮并排左对齐，状态区显示在按钮下方不挤压版本行） */
.about-updater {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}
/* 关于操作行：更新日志 + 检查更新同排（2026-08-14 用户反馈：原来一左一右错位，统一左对齐并排） */
.about-updater-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.about-updater-status {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-secondary);
}
/* 更新状态文案：成功/失败语义色（状态行级，非按钮色） */
.about-updater-ok { color: var(--el-color-success); }
.about-updater-error { color: var(--el-color-danger); }
/* 变更摘要：保留换行，长文本可滚动（不撑爆弹窗） */
.about-updater-notes {
  white-space: pre-wrap;
  font-size: 13px;
  color: var(--text-secondary);
  max-height: 240px;
  overflow: auto;
}
/* 检查中图标旋转：busy 态视觉反馈（无动画时保持静态图标） */
.is-spinning { animation: about-updater-spin 1s linear infinite; }
@keyframes about-updater-spin { to { transform: rotate(360deg); } }
/* 危险操作（清除头像）：hover 红色提示 */
.f-settings-btn--danger:hover {
  border-color: var(--danger, #ef4444);
  color: var(--danger, #ef4444);
}

/* 头像 lucide 图标快捷选择：24 宫格（56px 圆形与预览框一致），选中项 accent-glow 高亮 */
.avatar-icon-grid {
  display: grid;
  grid-template-columns: repeat(8, 56px);
  gap: 6px;
}
.avatar-icon-item {
  aspect-ratio: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  border: 1px solid var(--border-dim);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: border-color 150ms, background 150ms;
}
.avatar-icon-item:hover {
  border-color: var(--border-default);
  background: var(--bg-hover);
}
.avatar-icon-item--active {
  background: var(--accent-glow);
  border-color: var(--accent);
  color: var(--accent);
}

/* 头像上传器：无图片=虚线占位框，有图片=预览图 + hover 覆盖操作（点击更换 + 右上角清除） */
.avatar-uploader {
  margin-bottom: 12px;
}
/* 无图片：虚线圆形占位框，点击上传 */
.avatar-uploader__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  border: 1px dashed var(--border-default);
  background: transparent;
  color: var(--text-muted);
  font-size: 0.714rem;
  cursor: pointer;
  transition: border-color 150ms, color 150ms;
}
.avatar-uploader__empty:hover {
  border-color: var(--accent);
  color: var(--accent);
}
/* 有图片：圆形预览容器（relative 承载 hover 覆盖层与清除按钮） */
.avatar-uploader__preview {
  position: relative;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  cursor: pointer;
  overflow: hidden;
}
.avatar-uploader__img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 50%;
}
/* hover 覆盖层：左右分两半操作（更换/清除），各占一半大热区，易点击 */
.avatar-uploader__overlay {
  position: absolute;
  inset: 0;
  display: flex;
  opacity: 0;
  transition: opacity 150ms;
}
.avatar-uploader__preview:hover .avatar-uploader__overlay {
  opacity: 1;
}
.avatar-uploader__change,
.avatar-uploader__clear {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  cursor: pointer;
  color: #fff;
  background: rgba(0, 0, 0, 0.55);
  transition: background 150ms;
}
.avatar-uploader__change:hover {
  background: rgba(0, 0, 0, 0.78);
}
/* 清除用红色系遮罩，与「更换」区分（危险操作） */
.avatar-uploader__clear {
  background: rgba(220, 38, 38, 0.55);
}
.avatar-uploader__clear:hover {
  background: rgba(220, 38, 38, 0.8);
}

/* 提示文案（工作目录说明等）：12px 次级色 */
.f-settings-hint {
  font-size: 0.857rem;
  line-height: 1.5;
  color: var(--text-muted);
}

/* ── 模型与API tab ── */
/* 操作行：测试连接 + 保存并重启 并排（测试按钮 accent 描边突出主操作，保存按钮常规样式） */
.f-settings-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 余额行：label 12px 次级 + 值 14px 加粗；与 API Key 输入框间距由 fields 容器控制 */
.balance-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.857rem;
}
.balance-label {
  color: var(--text-secondary);
}
.balance-value {
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-bright);
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
  font-size: 0.857rem;
  color: var(--text-secondary);
}
.about-value {
  font-size: 1rem;
  font-weight: 500;
  color: var(--text-bright);
}
</style>
