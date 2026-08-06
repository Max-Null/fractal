<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { useRouter } from "vue-router";
import { useSettingsStore, type PonytailMode } from "@/stores/settings";
import { useChatStore } from "@/stores/chat";
import { useI18n } from "vue-i18n";
import { connectLLM, readFileContent, writeFile, getClaudeDir, installClaudeCode, resolveClaudePath, sendMessage, type ConnectionTestResult } from "@/lib/electron-bridge";
import { emitChatCommand } from "@/composables/useCommandPalette";
import { useSessionStore } from "@/stores/session";

const appVersion = __APP_VERSION__;
import { translateError } from "@/lib/utils";
// ── Ponytail 插件检测 ──
const hasPonytail = ref<boolean | null>(null);
onMounted(async () => {
  try {
    const dir = await getClaudeDir();
    const raw = await readFileContent(`${dir}/settings.json`);
    const plugins: Record<string, boolean> = JSON.parse(raw).enabledPlugins || {};
    hasPonytail.value = Object.keys(plugins).some(k => k.startsWith("ponytail@"));
  } catch { hasPonytail.value = false; }
});

// ── 一键安装 Claude Code CLI ──
const isInstallingCC = ref(false);
const ccInstallResult = ref<"ok" | "fail" | null>(null);

async function handleInstallCC() {
  isInstallingCC.value = true;
  ccInstallResult.value = null;
  try {
    const exitCode = await installClaudeCode();
    if (exitCode === 0) {
      ccInstallResult.value = "ok";
      // 重新检测 claude 路径
      try { settings.resolvedClaudePath = await resolveClaudePath(); } catch { /* ignore */ }
    } else {
      ccInstallResult.value = "fail";
    }
  } catch {
    ccInstallResult.value = "fail";
  } finally {
    isInstallingCC.value = false;
  }
}

import ErrorBoundary from "@/components/shared/ErrorBoundary.vue";
import ModalShell from "@/components/shared/ModalShell.vue";
import ManagePanel from "@/components/shared/ManagePanel.vue";
import MarkdownRenderer from "@/components/shared/MarkdownRenderer.vue";
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
  const prompt = `请联网查询 ${settings.providerId} 服务商的模型 ${settings.model} 的 OpenAI 兼容 chat completions API 完整端点 URL，只输出 URL 不要任何解释`;
  isLookingUpUrl.value = true;
  let sid = sessionStore.activeSessionId;
  if (!sid) {
    sid = await sessionStore.createSession(settings.model, undefined, undefined, settings.locale);
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
    effort: "low",
    ultracode: false,
    model: settings.model,
    claudePath: settings.claudePath || undefined,
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
        // 仅接受 https URL，防止 CC 幻觉或响应被篡改时注入危险地址
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
const activeMode = computed({
  get: () => {
    if (settings.planMode) return "plan";
    if (settings.autoMode) return "auto";
    if (settings.permissionMode === "bypassPermissions") return "bypassPermissions";
    if (settings.permissionMode === "dontAsk") return "dontAsk";
    if (settings.permissionMode === "acceptEdits") return "acceptEdits";
    return "default";
  },
  set: (v: string) => {
    settings.planMode = v === "plan";
    settings.autoMode = v === "auto";
    settings.permissionMode =
      v === "bypassPermissions" ? "bypassPermissions"
      : v === "dontAsk" ? "dontAsk"
      : v === "acceptEdits" ? "acceptEdits"
      : "default";
  },
});

// ── 自定义下拉 ──
type DropdownKind = "lang" | "theme" | "font" | "ponytail" | "perm" | "effort" | "model" | "provider";
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

// ── 权限模式选项（图标 + 中文 + 英文 CLI key + 描述）──
interface PermOption { value: "auto" | "plan" | "default" | "acceptEdits" | "bypassPermissions" | "dontAsk"; icon: string; cliKey: string; labelKey: string; descKey: string }
const permOptions: PermOption[] = [
  { value: "auto",       icon: "🤖", cliKey: "auto",             labelKey: "mode.auto",       descKey: "mode.autoDesc" },
  { value: "plan",       icon: "📋", cliKey: "plan",             labelKey: "mode.plan",       descKey: "mode.planDesc" },
  { value: "default",    icon: "🔒", cliKey: "default",          labelKey: "mode.askBefore",  descKey: "mode.askBeforeDesc" },
  { value: "acceptEdits",icon: "✏️", cliKey: "acceptEdits",      labelKey: "mode.editAuto",   descKey: "mode.editAutoDesc" },
  { value: "bypassPermissions", icon: "⚡", cliKey: "bypassPermissions", labelKey: "mode.bypass", descKey: "mode.bypassDesc" },
  { value: "dontAsk",    icon: "✅", cliKey: "dontAsk",           labelKey: "mode.dontAsk",    descKey: "mode.dontAskDesc" },
];
const currentPerm = computed(() => permOptions.find(o => o.value === activeMode.value)!);

// ── 思考深度选项 ──
interface EffortOption { value: import("@/stores/settings").Effort; icon: string; cliKey: string; labelKey: string; color: string }
const effortOptions: EffortOption[] = [
  { value: "low",       icon: "🐢", cliKey: "low",    color: "#22c55e", labelKey: "mode.effort.low" },
  { value: "medium",    icon: "🐇", cliKey: "medium", color: "#14b8a6", labelKey: "mode.effort.medium" },
  { value: "high",      icon: "🧠", cliKey: "high",   color: "#f59e0b", labelKey: "mode.effort.high" },
  { value: "xhigh",     icon: "🔬", cliKey: "xhigh",  color: "#f97316", labelKey: "mode.effort.xhigh" },
  { value: "max",       icon: "🚀", cliKey: "max",    color: "#ef4444", labelKey: "mode.effort.max" },
  { value: "ultracode", icon: "⚡", cliKey: "xhigh",  color: "#8b5cf6", labelKey: "mode.effort.ultracode" },
];
const currentEffort = computed(() => effortOptions.find(o => o.value === settings.effort)!);

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
interface PonytailOption { value: PonytailMode; icon: string; cliKey: string; labelKey: string; color: string }
const ponytailOptions: PonytailOption[] = [
  { value: "off",   icon: "⬜", cliKey: "off",   color: "#6b7280", labelKey: "settings.ponytailOff" },
  { value: "lite",  icon: "🌱", cliKey: "lite",  color: "#22c55e", labelKey: "settings.ponytailLite" },
  { value: "full",  icon: "🎯", cliKey: "full",  color: "#f59e0b", labelKey: "settings.ponytailFull" },
  { value: "ultra", icon: "🔥", cliKey: "ultra", color: "#ef4444", labelKey: "settings.ponytailUltra" },
];
const currentPonytail = computed(() => ponytailOptions.find(o => o.value === settings.ponytailMode)!);

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
  // 去掉 [1M] 等上下文窗口标注，API 不接受
  const model = settings.model.replace(/\[.*\]/, '').trim();
  try { testResult.value = await connectLLM(settings.apiKey, settings.baseUrl, model, settings.providerId, settings.optimizeApiUrl || undefined); }
  catch (err) { testError.value = String(err); }  /* ponytail: translateError applied in template display */
  finally { isTesting.value = false; }
}

// ── Provider 选择（logo 来自 lobe-icons CDN）──
interface ProviderOption { id: string; logoUrl: string }
const providerOptions: ProviderOption[] = [
  { id: "anthropic", logoUrl: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/anthropic.svg" },
  { id: "deepseek", logoUrl: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/deepseek-color.svg" },
  { id: "openrouter", logoUrl: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/openrouter.svg" },
  { id: "siliconflow", logoUrl: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/siliconcloud-color.svg" },
  { id: "zhipu", logoUrl: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/zhipu-color.svg" },
  { id: "kimi", logoUrl: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/kimi-color.svg" },
  { id: "minimax", logoUrl: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/minimax-color.svg" },
  { id: "custom", logoUrl: "" },
];
function providerLabel(id: string): string {
  return t(`provider.${id}`) || id;
}
function providerLogo(id: string): string {
  return providerOptions.find(o => o.id === id)?.logoUrl || "";
}
const currentProvider = computed(() => providerOptions.find(o => o.id === settings.providerId)!);

// 前端 provider 模型列表镜像（与 Rust provider.rs 同步）
const PROVIDER_MODELS: Record<string, string[]> = {
  anthropic: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001", "claude-fable-5"],
  deepseek: ["deepseek-v4-pro[1M]", "deepseek-v4-flash", "deepseek-v4"],
  openrouter: ["anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-8", "anthropic/claude-haiku-4-5-20251001"],
  siliconflow: ["deepseek-ai/DeepSeek-V3", "deepseek-ai/DeepSeek-R1", "Pro/zai-org/GLM-5", "Qwen/Qwen3-235B-A22B"],
  zhipu: ["glm-5", "glm-5.1", "glm-4.7"],
  kimi: ["kimi-k2.5", "kimi-k2.6"],
  minimax: ["minimax-m2.7"],
  custom: [],
};

function switchProvider(id: string) {
  // 1. 保存当前 provider 配置到 SQLite（providerId 仍是旧值）
  settings.saveCurrentConfig();
  // 2. 先恢复目标 provider 的 apiKey/baseUrl/model（同步从内存读取，无记录则用默认值）
  settings.restoreConfig(id);
  // 3. 最后切 providerId（watcher 拿到完整正确值，不会出现旧 apiKey+新 providerId 的中间态）
  settings.providerId = id;
  const newModels = PROVIDER_MODELS[id] || [];
  settings.models = newModels;
  // 4. 校验恢复的 model 在目标列表中，不在则 fallback 第一个
  if (!newModels.includes(settings.model) && newModels.length > 0) {
    settings.model = newModels[0];
  }
}

const modelPresets = computed(() => settings.models);

// ── settings.json 编辑器弹窗 ──
const showJsonEditor = ref(false);
const showChangelog = ref(false);
const showManagePanel = ref(false);
const manageInitialTab = ref("");

function openManageTo(tab: string) {
  manageInitialTab.value = tab;
  showManagePanel.value = true;
}
const jsonEditorContent = ref("");
const jsonEditorSaved = ref(false);
const jsonEditorError = ref("");

async function openSettingsJson() {
  jsonEditorError.value = "";
  try {
    const dir = await getClaudeDir();
    const path = `${dir}/settings.json`;
    jsonEditorContent.value = await readFileContent(path);
    showJsonEditor.value = true;
  } catch {
    jsonEditorError.value = "settingsJsonReadError";
  }
}

async function saveSettingsJson() {
  try {
    const dir = await getClaudeDir();
    const path = `${dir}/settings.json`;
    await writeFile(path, jsonEditorContent.value);
    jsonEditorSaved.value = true;
    setTimeout(() => (jsonEditorSaved.value = false), 2000);
  } catch (e) {
    const { key, params } = translateError(e);
    jsonEditorError.value = t(key, params as any);
  }
}

</script>

<template>
  <ErrorBoundary name="SettingsPanel">
    <div class="sb-settings-panel flex flex-col" style="flex:1;min-height:0">
      <!-- Header（固定顶部） -->
      <div class="flex items-center gap-3 shrink-0 px-5 pt-3 pb-2">
        <button @click="router.push('/chat')" class="w-7 h-7 flex items-center justify-center rounded-md transition-colors hover:bg-[var(--bg-hover)]" style="color:var(--text-secondary)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m15 18-6-6 6-6"/></svg>
        </button>
        <h2 class="text-lg font-semibold tracking-tight" style="color:var(--text-bright)">{{ $t('settings.title') }}</h2>
      </div>

      <!-- 三区平铺（可滚动） -->
      <div class="flex flex-wrap gap-8 flex-1 overflow-y-auto px-5 pb-4">

        <!-- CC 配置 -->
        <section class="space-y-4 w-[300px] shrink-0">
          <div class="flex items-center gap-2 mb-1">
            <h3 class="text-[10px] font-semibold uppercase tracking-widest" :style="{ color: 'var(--text-muted)' }">{{ $t('settings.ccConfig') }}</h3>
            <button @click="openSettingsJson" class="text-[9px] px-1.5 py-0.5 rounded-full font-medium transition-colors hover:underline" :style="{ background: 'var(--accent-glow)', color: 'var(--accent)', cursor: 'pointer' }">{{ $t('settings.fromSettingsJson') }} ↗</button>
          </div>
          <!-- Provider 选择 -->
          <div>
            <label class="block text-xs font-medium mb-1.5" style="color:var(--text-secondary)">{{ $t('settings.provider') }}</label>
            <div
              class="settings-dropdown relative cursor-pointer rounded-lg px-3.5 py-2 text-sm flex items-center gap-1.5 select-none transition-colors"
              :style="{
                background: 'var(--bg-elevated)',
                border: openDropdown === 'provider' ? '1px solid var(--accent)' : '1px solid var(--border-default)'
              }"
              @click.stop="toggleDropdown('provider' as DropdownKind)"
            >
              <img v-if="providerLogo(settings.providerId)" :src="providerLogo(settings.providerId)" class="w-4 h-4 shrink-0" />
              <span class="font-medium truncate flex-1">{{ providerLabel(settings.providerId) }}</span>
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"
                :style="{ opacity: 0.4, transition: 'transform 150ms', transform: openDropdown === 'provider' ? 'rotate(180deg)' : '' }">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
              <Transition name="drop-settings">
                <div
                  v-if="openDropdown === 'provider'"
                  class="absolute right-0 top-full mt-1 py-1 rounded-lg z-30 w-full"
                  style="background: var(--bg-elevated); border: 1px solid var(--border-default); box-shadow: 0 8px 24px rgba(0,0,0,0.35)"
                >
                  <button
                    v-for="o in providerOptions"
                    :key="o.id"
                    @click.stop="switchProvider(o.id); closeDropdowns()"
                    class="w-full text-left px-3 py-2 text-sm transition-colors hover:bg-[var(--bg-hover)]"
                    :style="{ background: settings.providerId === o.id ? 'var(--accent-glow)' : 'transparent', color: settings.providerId === o.id ? 'var(--accent)' : 'var(--text-primary)' }"
                  >
                    <img v-if="o.logoUrl" :src="o.logoUrl" class="w-4 h-4 shrink-0 inline-block align-middle" />
                    <span class="ml-1.5">{{ providerLabel(o.id) }}</span>
                  </button>
                </div>
              </Transition>
            </div>
          </div>
          <div>
            <label class="block text-xs font-medium mb-1.5" style="color:var(--text-secondary)">{{ $t('settings.baseUrl') }}</label>
            <input v-model="settings.baseUrl" type="text" placeholder="https://api.deepseek.com"
              class="settings-input w-full rounded-lg px-3.5 py-2 text-sm outline-none" />
          </div>
          <div>
            <label class="block text-xs font-medium mb-1.5" style="color:var(--text-secondary)">{{ $t('settings.apiKey') }}</label>
            <input v-model="settings.apiKey" type="password" placeholder="sk-…"
              class="settings-input w-full rounded-lg px-3.5 py-2 text-sm outline-none" />
          </div>
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
          <div>
            <label class="block text-xs font-medium mb-1.5" style="color:var(--text-secondary)">{{ $t('settings.contextLimit') }}</label>
            <input v-model="contextLimitInput" type="text"
              :placeholder="$t('settings.contextLimitPlaceholder')"
              class="settings-input w-full rounded-lg px-3.5 py-2 text-sm outline-none"
              @blur="parseContextLimit" />
          </div>
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
          <button @click="handleTest" :disabled="isTesting || !settings.apiKey"
            class="w-full py-2.5 rounded-lg text-sm font-medium transition-all duration-150"
            :style="{ background: isTesting ? 'var(--bg-elevated)' : 'var(--accent)', color: isTesting ? 'var(--text-muted)' : 'var(--bg-root)', opacity: (!settings.apiKey) ? 0.3 : 1 }">
            {{ isTesting ? $t('settings.testing') : $t('settings.test') }}
          </button>
          <div v-if="testResult" class="space-y-1">
            <div class="p-3 rounded-lg text-xs break-all" :style="{ background: testResult.cc.startsWith('✓') ? 'var(--accent-glow)' : 'var(--coral-glow)', color: testResult.cc.startsWith('✓') ? 'var(--accent)' : 'var(--coral)' }">CC {{ testResult.cc }}</div>
            <div v-if="testResult.chat" class="p-3 rounded-lg text-xs break-all" :style="{ background: testResult.chat.startsWith('✓') ? 'var(--accent-glow)' : testResult.chat.startsWith('⚠') ? 'var(--amber-glow)' : 'var(--coral-glow)', color: testResult.chat.startsWith('✓') ? 'var(--accent)' : testResult.chat.startsWith('⚠') ? 'var(--amber)' : 'var(--coral)' }">{{ $t('settings.chatApi') }} {{ testResult.chat }}</div>
          </div>
          <div v-if="translatedTestError" class="p-3 rounded-lg text-xs break-all" style="background:var(--coral-glow); color:var(--coral); border:1px solid var(--coral); --tw-border-opacity:0.3">✕ {{ translatedTestError }}</div>
          <div class="pt-2" style="border-top:1px solid var(--border-dim)">
            <label class="block text-xs font-medium mb-1.5" style="color:var(--text-secondary)">{{ $t('settings.claudePath') }}</label>
            <div v-if="settings.resolvedClaudePath && settings.resolvedClaudePath !== 'claude'" class="text-[11px] font-mono py-1.5 truncate" :style="{ color: 'var(--accent)' }" :title="settings.resolvedClaudePath">
              {{ $t('settings.claudePathDetected', { path: settings.resolvedClaudePath }) }}
            </div>
            <div v-else class="text-[11px] py-1.5 space-y-1.5">
              <div :style="{ color: 'var(--coral)' }">{{ $t('settings.claudePathNotFound') }}</div>
              <button
                @click="handleInstallCC"
                :disabled="isInstallingCC"
                class="w-full py-2 rounded-lg text-sm font-medium transition-colors"
                :style="{
                  background: isInstallingCC ? 'var(--bg-elevated)' : 'var(--accent)',
                  color: isInstallingCC ? 'var(--text-muted)' : '#09090b',
                }"
              >{{ isInstallingCC ? $t('settings.installingCC') : $t('settings.installCC') }}
              </button>
              <div v-if="ccInstallResult === 'ok'" class="text-xs" style="color:var(--accent)">✓ {{ $t('settings.installCCOk') }}</div>
              <div v-if="ccInstallResult === 'fail'" class="text-xs" style="color:var(--coral)">✕ {{ $t('settings.installCCFail') }}</div>
            </div>
            <div class="text-[10px] mb-1 mt-1" :style="{ color: 'var(--text-muted)' }">{{ $t('settings.claudePathOverride') }}</div>
            <input v-model="settings.claudePath" type="text" :placeholder="$t('settings.claudePathOverridePlaceholder')"
              class="settings-input w-full rounded-lg px-3.5 py-2 text-sm outline-none" />
          </div>
        </section>

        <!-- CC 管理 -->
        <section class="space-y-4 w-[300px] shrink-0">
          <h3 class="text-[10px] font-semibold uppercase tracking-widest" :style="{ color: 'var(--text-muted)' }">CC 管理</h3>
          <div class="grid grid-cols-2 gap-1.5">
            <button @click="openManageTo('plugins')" class="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs transition-colors hover:bg-[var(--bg-hover)]" :style="{ color: 'var(--text-secondary)' }">
              <span class="text-[13px]">🧩</span> 插件
            </button>
            <button @click="openManageTo('mcp')" class="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs transition-colors hover:bg-[var(--bg-hover)]" :style="{ color: 'var(--text-secondary)' }">
              <span class="text-[13px]">🔌</span> MCP 服务器
            </button>
            <button @click="openManageTo('skills')" class="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs transition-colors hover:bg-[var(--bg-hover)]" :style="{ color: 'var(--text-secondary)' }">
              <span class="text-[13px]">🎯</span> Skills
            </button>
            <button @click="openManageTo('agents')" class="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs transition-colors hover:bg-[var(--bg-hover)]" :style="{ color: 'var(--text-secondary)' }">
              <span class="text-[13px]">🤖</span> Agents
            </button>
            <button @click="openManageTo('hooks')" class="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs transition-colors hover:bg-[var(--bg-hover)]" :style="{ color: 'var(--text-secondary)' }">
              <span class="text-[13px]">🪝</span> Hooks
            </button>
            <button @click="openManageTo('memory')" class="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs transition-colors hover:bg-[var(--bg-hover)]" :style="{ color: 'var(--text-secondary)' }">
              <span class="text-[13px]">🧠</span> Memory
            </button>
            <button @click="openManageTo('permissions')" class="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs transition-colors hover:bg-[var(--bg-hover)]" :style="{ color: 'var(--text-secondary)' }">
              <span class="text-[13px]">🛡️</span> 权限规则
            </button>
            <button @click="openManageTo('styles')" class="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs transition-colors hover:bg-[var(--bg-hover)]" :style="{ color: 'var(--text-secondary)' }">
              <span class="text-[13px]">🎨</span> 输出样式
            </button>
          </div>

        </section>

        <!-- cc-gui 设置 -->
        <section class="space-y-4 w-[300px] shrink-0">
          <div class="flex items-center gap-2">
            <h3 class="text-[10px] font-semibold uppercase tracking-widest" :style="{ color: 'var(--text-muted)' }">{{ $t('settings.ccGuiSettings') }}</h3>
            <button @click="openSettingsJson" class="text-[9px] px-1.5 py-0.5 rounded-full font-medium transition-colors hover:underline" :style="{ background: 'var(--accent-glow)', color: 'var(--accent)', cursor: 'pointer' }">{{ $t('settings.fromSettingsJson') }} ↗</button>
          </div>

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


          <div>
            <label class="block text-xs font-medium mb-1.5" style="color:var(--text-secondary)">{{ $t('settings.ponytailMode') }}</label>
            <!-- 检测中不渲染，未安装 → 安装按钮 -->
            <button
              v-if="hasPonytail === false"
              @click="emitChatCommand('install-ponytail'); router.push('/chat')"
              class="w-full rounded-lg px-3.5 py-2 text-sm font-medium transition-colors"
              style="background: var(--accent); color: #09090b"
            >{{ $t('settings.installPonytail') }}</button>
            <!-- 已安装 → 模式下拉 -->
            <div
              v-else-if="hasPonytail === true"
              class="settings-dropdown relative cursor-pointer rounded-lg px-3.5 py-2 text-sm flex items-center gap-1.5 select-none transition-colors"
              :style="{
                background: 'var(--bg-elevated)',
                border: openDropdown === 'ponytail' ? '1px solid var(--accent)' : '1px solid var(--border-default)',
                color: currentPonytail.color
              }"
              @click.stop="toggleDropdown('ponytail')"
            >
              <span class="text-[13px]">{{ currentPonytail.icon }}</span>
              <span class="font-medium truncate flex-1">{{ $t(currentPonytail.labelKey) }}</span>
              <span class="italic text-[0.6rem] opacity-50 hidden sm:inline" style="color:var(--text-secondary)">{{ currentPonytail.cliKey }}</span>
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"
                :style="{ opacity: 0.4, transition: 'transform 150ms', transform: openDropdown === 'ponytail' ? 'rotate(180deg)' : '' }">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
              <Transition name="drop-settings">
                <div
                  v-if="openDropdown === 'ponytail'"
                  class="absolute right-0 top-full mt-1 py-1 rounded-lg z-30 w-[300px] shrink-0 max-w-[420px]"
                  style="background: var(--bg-elevated); border: 1px solid var(--border-default); box-shadow: 0 8px 24px rgba(0,0,0,0.35)"
                >
                  <button
                    v-for="o in ponytailOptions"
                    :key="o.value"
                    @click="settings.ponytailMode = o.value; closeDropdowns()"
                    class="w-full text-left px-3 py-2 transition-colors hover:bg-[var(--bg-hover)]"
                    :style="{ background: settings.ponytailMode === o.value ? o.color + '18' : 'transparent' }"
                  >
                    <div class="flex items-center gap-1.5">
                      <span class="text-[13px]">{{ o.icon }}</span>
                      <span class="text-xs font-medium" :style="{ color: settings.ponytailMode === o.value ? o.color : 'var(--text-primary)' }">{{ $t(o.labelKey) }}</span>
                      <span class="italic text-[0.6rem] ml-auto" style="color:var(--text-secondary)">{{ o.cliKey }}</span>
                    </div>
                  </button>
                </div>
              </Transition>
            </div>
          </div>

          <!-- 权限模式 -->
          <div>
            <label class="block text-xs font-medium mb-1.5" style="color:var(--text-secondary)">{{ $t('settings.defaultMode') }} <button @click="openSettingsJson" class="text-[9px] px-1.5 py-0.5 rounded-full font-medium transition-colors hover:underline ml-1" :style="{ background: 'var(--accent-glow)', color: 'var(--accent)', cursor: 'pointer' }">{{ $t('settings.fromSettingsJson') }} ↗</button></label>
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

          <!-- 思考深度 -->
          <div>
            <label class="block text-xs font-medium mb-1.5" style="color:var(--text-secondary)">{{ $t('settings.defaultEffort') }} <button @click="openSettingsJson" class="text-[9px] px-1.5 py-0.5 rounded-full font-medium transition-colors hover:underline ml-1" :style="{ background: 'var(--accent-glow)', color: 'var(--accent)', cursor: 'pointer' }">{{ $t('settings.fromSettingsJson') }} ↗</button></label>
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
        </section>
      </div>

      <!-- Footer：关于（固定底部） -->
      <footer class="shrink-0 px-5 py-2.5" style="border-top:1px solid var(--border-dim)">
        <div class="flex items-center justify-between text-[10px]" :style="{ color: 'var(--text-muted)' }">
          <div class="flex items-center gap-2">
            <span>{{ $t('app.title') }}</span>
            <span style="opacity:0.4">by MaxNull</span>
            <a
              href="https://github.com/MaxNull/cc-gui"
              target="_blank"
              class="hover:text-[var(--accent)] transition-colors"
              :style="{ color: 'var(--text-muted)' }"
              title="GitHub"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
            </a>
          </div>
          <div class="flex items-center gap-3">
            <button
              class="hover:underline transition-colors"
              @click="showChangelog = true"
            >{{ $t('settings.changelog') }}</button>
            <span class="font-mono">v{{ appVersion }}</span>
          </div>
        </div>
      </footer>
    </div>
  <!-- settings.json 编辑器弹窗 -->
  <ModalShell :open="showJsonEditor" size="lg" position="top" @close="showJsonEditor = false">
    <template #header>
      <span class="text-sm font-semibold" :style="{ color: 'var(--text-bright)' }">{{ $t('settings.editSettingsJson') }}</span>
    </template>
    <div v-if="jsonEditorError" class="text-xs mb-2 px-3 py-2 rounded" :style="{ background: 'var(--coral-glow)', color: 'var(--coral)' }">{{ jsonEditorError === 'settingsJsonReadError' ? $t('settings.settingsJsonReadError') : jsonEditorError }}</div>
    <textarea
      v-model="jsonEditorContent"
      class="w-full rounded-lg p-3 text-xs font-mono leading-relaxed resize-none outline-none"
      :style="{ background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border-dim)', minHeight: '420px' }"
      rows="24"
      spellcheck="false"
    ></textarea>
    <div class="flex items-center justify-end gap-2 mt-3">
      <button @click="showJsonEditor = false" class="text-xs px-3 py-1.5 rounded transition-colors hover:bg-[var(--bg-hover)]" :style="{ color: 'var(--text-muted)' }">{{ $t('manage.back') }}</button>
      <button
        @click="saveSettingsJson"
        class="px-4 py-1.5 rounded text-xs font-medium transition-colors"
        :style="{ background: jsonEditorSaved ? 'var(--accent-dim)' : 'var(--accent)', color: 'var(--bg-root)' }"
      >{{ jsonEditorSaved ? $t('manage.saved') : $t('manage.save') }}</button>
    </div>
  </ModalShell>
  <!-- 更新日志弹窗 -->
  <ModalShell :open="showChangelog" size="lg" position="top" @close="showChangelog = false">
    <template #header>
      <span class="text-sm font-semibold" :style="{ color: 'var(--text-bright)' }">{{ $t('settings.changelog') }}</span>
    </template>
    <MarkdownRenderer :content="changelogContent" />
  </ModalShell>
  <ManagePanel :open="showManagePanel" :initial-tab="manageInitialTab" @close="showManagePanel = false; manageInitialTab = ''" />
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
</style>
