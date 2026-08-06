<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { useRouter } from "vue-router";
import { useSettingsStore } from "@/stores/settings";
import { useChatStore } from "@/stores/chat";
import { useI18n } from "vue-i18n";
import { testConnection, sendMessage, openDialog, type ConnectionTestResult } from "@/lib/electron-bridge";
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
type DropdownKind = "lang" | "theme" | "font" | "perm" | "effort" | "model";
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
    } else {
      testError.value = r.message;
    }
  }
  catch (err) { testError.value = String(err); }  // translateError applied in template display
  finally { isTesting.value = false; }
}

// ── 更新日志弹窗 ──
const showChangelog = ref(false);

// ── 高级设置（settings.json JSONC 编辑器，阶段 6）──
// 默认折叠：面向高级用户/agent 协作，避免小白误改配置（方案 3.8：高级配置类 VSCode settings.json）
const showAdvanced = ref(false);
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

          <!-- 思考深度 -->
          <div>
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

          <!-- 重新显示引导页：重置 dismissed 标记，AppShell 检测到 apiKey 为空即切回 onboarding 全屏 -->
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
</style>
