<script setup lang="ts">
/** 聊天 composer 卡片（对齐原型 v0.23）：
 *  ① chips 行（附件/引用，带 ×）② 操作行（附件/agent/模型/权限/推理/命令/上下文，独立一行）
 *  ③ 输入行（textarea + hint/发送 同一行，用户反馈布局）
 *  原独立 InputBarToolbar 的模式/effort/命令逻辑已并入（组件删除，见 ChatPanel 重构记录）。 */
import { ref, computed, nextTick, onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { useSlashCommands } from "@/composables/useSlashCommands";
import { useSettingsStore, type Effort } from "@/stores/settings";
import { useChatStore } from "@/stores/chat";
import ContextIndicator from "./ContextIndicator.vue";
import { polishMessage } from "@/lib/electron-bridge";

const { t } = useI18n();
const settings = useSettingsStore();
const chat = useChatStore();

/** chips 行数据（由 ChatPanel 组装：选区卡片 / 附件），纯展示、事件上报 */
export interface ComposerChip {
  id: string;
  label: string;
  /** chips 前缀图标（emoji，与 imageUrl 二选一） */
  icon?: string;
  /** 附件缩略图（图片文件预览） */
  imageUrl?: string;
  /** 底色语义：accent=选区卡片（accent-glow），elevated=附件（bg-elevated） */
  tone?: "accent" | "elevated";
  clickable?: boolean;
  removable?: boolean;
}

const props = withDefaults(defineProps<{
  disabled: boolean;
  autoMode?: boolean;
  apiKey?: string;
  baseUrl?: string;
  chips?: ComposerChip[];
  chipHint?: string;
}>(), {
  autoMode: false,
  apiKey: "",
  baseUrl: "",
  chips: () => [],
  chipHint: "",
});

const emit = defineEmits<{
  send: [text: string];
  files: [files: Array<{ name: string; path: string }>];
  stop: [];
  /** 📎 附件按钮（ChatPanel 打开文件对话框） */
  attach: [];
  /** chips 行关闭 ×（id 由 ChatPanel 映射到选区/附件） */
  removeChip: [id: string];
  /** 附件 chip 点击（打开文件预览） */
  chipClick: [id: string];
  /** ☰ 命令菜单 */
  openCommandMenu: [];
  /** / 快捷斜杠命令选中（直接发送） */
  sendSlash: [text: string];
  /** 上下文用量指示器点击 */
  showContext: [];
}>();

// ══════════════════════════════════════════════════════════════
// textarea 逻辑（现状保留）
// ══════════════════════════════════════════════════════════════

const input = ref("");
const focused = ref(false);
const isDragOver = ref(false);

function send() {
  const text = input.value.trim();
  if (!text) return;
  showSlashMenu.value = false;
  emit("send", text);
  input.value = "";
  autoResize();
}

// ── 斜杠命令自动补全（输入框内 / 触发）──
const { favorites, recentCommands } = useSlashCommands();
const slashMenuIdx = ref(0);
const showSlashMenu = ref(false);

const slashSuggestions = computed(() => {
  const val = input.value;
  // 仅当输入以 / 开头且无空格时弹出（单行命令模式）
  if (!val.startsWith("/") || val.includes(" ")) return [];
  const query = val.slice(1).toLowerCase();
  // 合并：最近使用在前，收藏在后，去重
  const seen = new Set<string>();
  const items: string[] = [];
  for (const r of recentCommands.value) {
    if (!seen.has(r) && r.toLowerCase().includes(query)) { items.push(r); seen.add(r); }
  }
  for (const f of favorites.value) {
    if (!seen.has(f) && f.toLowerCase().includes(query)) { items.push(f); seen.add(f); }
  }
  // 如果输入只有 /，加一个快速补全当前内容为 /command 而非过滤
  return items.slice(0, 8);
});

function applySlashSuggestion(suggestion: string) {
  showSlashMenu.value = false;
  // 斜杠命令选择后直接发送
  emit("send", "/" + suggestion);
  input.value = "";
  autoResize();
}

function onBlurSlash() {
  focused.value = false;
  setTimeout(() => { showSlashMenu.value = false; }, 150);
}

function onInputSlash() {
  const val = input.value;
  if (val.startsWith("/") && !val.includes(" ") && val.length >= 1) {
    showSlashMenu.value = true;
    slashMenuIdx.value = 0;
  } else {
    showSlashMenu.value = false;
  }
}

// ── Drag & drop files ──
function onDrop(e: DragEvent) {
  e.preventDefault();
  isDragOver.value = false;
  const files = e.dataTransfer?.files;
  if (!files || files.length === 0) return;

  const attached: Array<{ name: string; path: string }> = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    attached.push({ name: f.name, path: (f as any).path || f.name });
  }
  emit("files", attached);
}

function onDragOver(e: DragEvent) {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  isDragOver.value = true;
}

function onDragLeave() {
  isDragOver.value = false;
}

function onKeydown(e: KeyboardEvent) {
  if (showSlashMenu.value && slashSuggestions.value.length > 0) {
    if (e.key === "ArrowDown") { e.preventDefault(); slashMenuIdx.value = Math.min(slashMenuIdx.value + 1, slashSuggestions.value.length - 1); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); slashMenuIdx.value = Math.max(slashMenuIdx.value - 1, 0); return; }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); applySlashSuggestion(slashSuggestions.value[slashMenuIdx.value]); return; }
    if (e.key === "Escape") { e.preventDefault(); showSlashMenu.value = false; return; }
  }
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
}

function onPaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items;
  if (!items) return;
  const files: Array<{ name: string; path: string }> = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === "file") {
      const file = item.getAsFile();
      if (file) {
        files.push({ name: file.name, path: (file as any).path || file.name });
      }
    }
  }
  if (files.length > 0) {
    e.preventDefault();
    emit("files", files);
  }
}

async function autoResize() {
  await nextTick();
  const el = document.querySelector(".chat-textarea") as HTMLTextAreaElement | null;
  if (el) { el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 160) + "px"; }
  updateInputGradient();
}

// ── 输入框双向渐变提示（隐藏滚动条后提示上下还有更多内容——仿会话列表 rail 渐变）──
const showInputGradient = ref(false);
const showInputGradientTop = ref(false);

function updateInputGradient() {
  const el = document.querySelector(".chat-textarea") as HTMLTextAreaElement | null;
  if (!el) return;
  // 可滚动（scrollHeight > clientHeight + 容差）
  const scrollable = el.scrollHeight > el.clientHeight + 4;
  // 未到底（scrollTop 未到最大值，留 4px 容差）→ 底部渐变
  showInputGradient.value = scrollable && el.scrollTop + el.clientHeight < el.scrollHeight - 4;
  // 未到顶（scrollTop > 4）→ 顶部渐变
  showInputGradientTop.value = scrollable && el.scrollTop > 4;
}

/** 外部设置输入框文本（FilePreview DOM 选择器等） */
defineExpose({ setText: (text: string) => { input.value = text; autoResize(); } });

// ══════════════════════════════════════════════════════════════
// foot 操作行：agent / 模型（会话级选择器，对齐原型 v0.20/0.23）
// ══════════════════════════════════════════════════════════════

/** 主 agent 选项（值即引擎 promptAsync.agent 参数，双星为分形预置 agent） */
const AGENT_OPTIONS = [
  { value: "双星", label: "✦ 双星", desc: () => t("composer.agentShuangxing") },
  { value: "build", label: "build", desc: () => t("composer.agentBuild") },
  { value: "plan", label: "plan", desc: () => t("composer.agentPlan") },
];

/** 会话模型选项（值即 settings.model 存储格式，sendMessage 时 toOcModel 拆分） */
const MODEL_OPTIONS = [
  { value: "deepseek-v4-flash", label: "v4-flash", desc: () => t("composer.modelFlash") },
  { value: "deepseek-v4-pro[1M]", label: "v4-pro", desc: () => t("composer.modelPro") },
];

function modelKey(value: string): string {
  // 选项值可能带 [1M] 标注，比较时去标注并与 settings.model 的模型名部分匹配
  return value.replace(/\[.*\]/, "").split("/").pop() || value;
}

/** 当前模型显示名（去 provider 前缀与 [1M] 标注，与 toOcModel 的展示层一致） */
const currentModelLabel = computed(() => {
  const m = settings.model.replace(/\[.*\]/, "");
  return m.split("/").pop() || m;
});

function selectAgent(value: string) {
  settings.currentAgent = value;
  openMenu.value = null;
}

function selectModel(value: string) {
  settings.model = value;
  openMenu.value = null;
}

// ══════════════════════════════════════════════════════════════
// 权限模式 / 思考强度（variant 语义：思考强度 = OC 模型 variant，非前端假功能）
// ══════════════════════════════════════════════════════════════

// 权限模式下拉：对齐原型 4 项（询问/自动编辑/全自动/计划）——auto（serve 启动参数，非会话级）与 dontAsk（CC 遗留）移除
const modeOptions = [
  { value: "askBefore", label: () => t("mode.askBefore") },
  { value: "editAuto", label: () => t("mode.editAuto") },
  { value: "bypass", label: () => t("mode.bypass") },
  { value: "plan", label: () => t("mode.plan") },
];

/** 思考强度 variant 映射表（OC 模型 variant 三档：低/高/最大；medium/xhigh/ultracode 为 CC 遗留档已删） */
const EFFORT_VARIANTS: Record<string, { label: () => string; color: string }> = {
  low: { label: () => t("mode.effort.low"), color: "#22c55e" },
  high: { label: () => t("mode.effort.high"), color: "#f59e0b" },
  max: { label: () => t("mode.effort.max"), color: "#ef4444" },
};

/**
 * 选项 = settings.modelVariants 的映射子集（顺序固定 low/high/max，过滤当前模型不可用的档）。
 * modelVariants 空（模型无 variants，如 deepseek-chat/reasoner）→ 空数组 → 模板 v-if 隐藏选择器。
 */
const effortOptions = computed<Array<{ value: Effort; label: () => string; color: string }>>(() => {
  const order = ["low", "high", "max"] as const;
  return order
    .filter((v) => settings.modelVariants.includes(v))
    .map((v) => ({ value: v as Effort, ...EFFORT_VARIANTS[v] }));
});

const currentEffortColor = computed(() => {
  return effortOptions.value.find(o => o.value === settings.effort)?.color || "var(--amber)";
});

// ── Custom dropdowns ──
const openMenu = ref<"mode" | "effort" | "agent" | "model" | "slash" | null>(null);

function toggleMenu(menu: "mode" | "effort" | "agent" | "model" | "slash") {
  openMenu.value = openMenu.value === menu ? null : menu;
}

function selectMode(value: string) {
  activeMode.value = value;
  openMenu.value = null;
}

function selectEffort(value: Effort) {
  settings.effort = value;
  openMenu.value = null;
}

function closeMenus() {
  openMenu.value = null;
}

// Click outside listener：点击 dropdown 区域外关闭所有菜单
function onBodyClick(e: MouseEvent) {
  if (!(e.target as HTMLElement).closest(".dropdown-menu")) {
    closeMenus();
  }
}
onMounted(() => document.addEventListener("click", onBodyClick));
onUnmounted(() => document.removeEventListener("click", onBodyClick));

const activeMode = computed({
  get: () => {
    if (settings.planMode) return "plan";
    // dontAsk 旧值（CC 遗留）兼容：并入全自动显示
    if (settings.permissionMode === "bypassPermissions" || settings.permissionMode === "dontAsk") return "bypass";
    if (settings.permissionMode === "acceptEdits") return "editAuto";
    return "askBefore";
  },
  set: (v: string) => {
    settings.planMode = v === "plan";
    settings.permissionMode = v === "editAuto" ? "acceptEdits" : v === "bypass" ? "bypassPermissions" : "default";
  },
});

const currentModeLabel = computed(() => {
  const m = modeOptions.find(o => o.value === activeMode.value);
  return m ? m.label() : activeMode.value;
});

const currentEffortLabel = computed(() => {
  const e = effortOptions.value.find(o => o.value === settings.effort);
  return e ? e.label() : settings.effort;
});

// 发送按钮启用条件：输入非空（chips 附件不计入，保持现有交互）
const canSend = computed(() => input.value.trim().length > 0);

// ══════════════════════════════════════════════════════════════
// ✨ 优化输入消息（原型发送按钮左侧功能）：调引擎临时会话润色，结果替换输入框
// ══════════════════════════════════════════════════════════════
const polishing = ref(false);

async function polishInput() {
  const text = input.value.trim();
  if (!text || polishing.value) return;
  polishing.value = true;
  try {
    const result = await polishMessage(text);
    if (result?.ok && result.text) {
      input.value = result.text;
      autoResize();
    }
  } finally {
    polishing.value = false;
  }
}
</script>

<template>
  <div class="f-input-bar">
    <!-- 斜杠自动补全下拉 — 绝对定位，不挤占消息区域 -->
    <div v-if="showSlashMenu && slashSuggestions.length > 0" class="slash-autocomplete">
      <button
        v-for="(s, i) in slashSuggestions"
        :key="s"
        @mousedown.prevent="applySlashSuggestion(s)"
        :class="['slash-ac-item', i === slashMenuIdx ? 'slash-ac-active' : '']"
      >/{{ s }}</button>
    </div>

    <!-- composer 卡片：chips 行 + textarea + foot 操作行 -->
    <div
      class="composer"
      :class="{
        'composer--dragover': isDragOver,
        'composer--autos': props.autoMode && !focused
      }"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
      <!-- ① chips 行：附件/引用 chips（无内容时不渲染，不占高度——用户反馈） -->
      <div v-if="props.chips.length > 0" class="composer-tools">
        <button
          v-for="chip in props.chips"
          :key="chip.id"
          class="composer-tool"
          :class="{ 'composer-tool--on': chip.tone === 'accent', 'composer-tool--clickable': chip.clickable }"
          @click="chip.clickable ? emit('chipClick', chip.id) : undefined"
        >
          <img v-if="chip.imageUrl" :src="chip.imageUrl" class="chip-thumb" alt="" />
          <span v-else-if="chip.icon" class="chip-icon">{{ chip.icon }}</span>
          <span class="chip-name" :title="chip.label">{{ chip.label }}</span>
          <span
            v-if="chip.removable"
            class="chip-x"
            :title="$t('chat.remove')"
            @click.stop="emit('removeChip', chip.id)"
          >×</span>
        </button>
      </div>

      <!-- ③ 输入行：textarea + 发送 同一行（cf-left 操作行用 order 显示在其上方） -->
      <div class="composer-inputrow">
        <!-- textarea 包一层：渐变提示的定位参照 = textarea 宽度（此前参照 inputrow 全宽，渐变延伸到发送按钮——用户反馈②） -->
        <div class="composer-input-wrap">
        <!-- ② textarea -->
        <textarea
          v-model="input"
          @keydown="onKeydown"
          @paste="onPaste"
          @input="autoResize(); onInputSlash(); updateInputGradient()"
          @scroll="updateInputGradient"
          @focus="focused = true"
          @blur="onBlurSlash"
          :placeholder="$t('chat.placeholder')"
          rows="1"
          class="chat-textarea composer-input"
          :style="{
            color: 'var(--text-primary)',
            caretColor: 'var(--accent)'
          }"
        ></textarea>

          <!-- 顶部渐变提示：可滚动且未到顶时显示（仿会话列表 rail 双向渐变——用户反馈①） -->
          <Transition name="grad-top">
            <div v-if="showInputGradientTop" class="input-scroll-hint input-scroll-hint--top"></div>
          </Transition>
          <!-- 底部渐变提示：可滚动且未到底时显示（贴 textarea 可视底——用户反馈②） -->
          <Transition name="grad">
            <div v-if="showInputGradient" class="input-scroll-hint"></div>
          </Transition>
        </div>

        <div class="cf-right">
          <!-- ✨ 优化消息（发送按钮左侧，原型有此功能——用户反馈⑤） -->
          <button
            class="polish-btn"
            :class="{ 'polish-btn--busy': polishing }"
            :disabled="!canSend || polishing"
            :title="$t('composer.polishTitle')"
            @click="polishInput"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9l1.25-2.75L23 5l-2.75-1.25L19 1l-1.25 2.75L15 5l2.75 1.25L19 9zm-7.5.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5L17 12l-5.5-2.5zM19 15l-1.25 2.75L15 19l2.75 1.25L19 23l1.25-2.75L23 19l-2.75-1.25L19 15z"/></svg>
          </button>
          <!-- Stop button（处理中显示红色方块，替代发送） -->
          <button
            v-if="disabled"
            class="send send--stop"
            :title="$t('chat.stop')"
            @click="emit('stop')"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
          </button>
          <!-- Send button（右上纸飞机图标，30x30 正方形与优化按钮一致；title 保留 Send——测试定位依赖） -->
          <button
            v-else
            class="send"
            :disabled="!canSend"
            :title="$t('chat.send')"
            @click="send"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/></svg>
          </button>
        </div>
      </div>

      <!-- ③ foot 操作行：左组（附件/斜杠/指令按钮）+ 右组（agent/模型/权限/推理/上下文）——用户反馈③ -->
      <div class="composer-foot">
        <div class="cf-left">
          <!-- ＋ 附件（指令按钮同风格 + 加号图标，用户反馈②） -->
          <button class="composer-icon-btn" :title="$t('toolbar.attachTitle')" @click="emit('attach')">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
          </button>

          <!-- / 快捷斜杠命令（按钮自身 position:relative 作下拉定位参照，去掉多余容器层——用户反馈④） -->
          <button class="composer-icon-btn" :title="$t('toolbar.slashTitle')" @click.stop="toggleMenu('slash')">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="4" x2="6" y2="20"/></svg>
            <Transition name="drop">
              <div v-if="openMenu === 'slash'" class="dropdown-menu slash-dropdown">
                <template v-if="recentCommands.length > 0">
                  <div class="slash-section-header">🕐 {{ $t('toolbar.slashRecent') }}</div>
                  <button
                    v-for="r in recentCommands.slice(0, 5)"
                    :key="r"
                    class="dropdown-item"
                    @click="emit('sendSlash', '/' + r); openMenu = null"
                  >{{ r }}</button>
                </template>
                <template v-if="favorites.size > 0">
                  <div class="slash-section-header">⭐ {{ $t('toolbar.slashFavorites') }}</div>
                  <button
                    v-for="f in [...favorites]"
                    :key="f"
                    class="dropdown-item"
                    @click="emit('sendSlash', '/' + f); openMenu = null"
                  >{{ f }}</button>
                </template>
                <div v-if="recentCommands.length > 0 || favorites.size > 0" class="slash-section-divider"></div>
                <button class="dropdown-item slash-browse-all" @click="emit('openCommandMenu'); openMenu = null">📋 {{ $t('toolbar.slashBrowseAll') }}</button>
                <div v-if="favorites.size === 0 && recentCommands.length === 0" class="slash-empty">{{ $t('toolbar.slashEmpty') }}</div>
              </div>
            </Transition>
          </button>

          <!-- ☰ 命令菜单 -->
          <button class="composer-icon-btn" :title="$t('toolbar.commandsTitle')" @click="emit('openCommandMenu')">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 12h18M3 6h18M3 18h18"/></svg>
          </button>
        </div>

        <div class="cf-right-pills">
          <!-- ✦ 主 agent pill -->
          <div class="composer-pill" @click.stop="toggleMenu('agent')" :title="$t('composer.agentTitle')">
            <span class="pill-star">✦</span><span>{{ settings.currentAgent }}</span><span class="pill-caret">▾</span>
            <Transition name="drop">
              <div v-if="openMenu === 'agent'" class="dropdown-menu">
                <div class="d-label">{{ $t('composer.agentTitle') }}</div>
                <div
                  v-for="a in AGENT_OPTIONS"
                  :key="a.value"
                  class="d-item"
                  :class="{ 'd-item--sel': settings.currentAgent === a.value }"
                  @click.stop="selectAgent(a.value)"
                >
                  <span class="d-name">{{ a.label }}</span>
                  <span class="d-desc">{{ a.desc() }}</span>
                </div>
              </div>
            </Transition>
          </div>

          <!-- 🎯 会话模型 pill -->
          <div class="composer-pill" @click.stop="toggleMenu('model')" :title="$t('composer.modelTitle')">
            <span class="pill-dot"></span><span>{{ currentModelLabel }}</span><span class="pill-caret">▾</span>
            <Transition name="drop">
              <div v-if="openMenu === 'model'" class="dropdown-menu">
                <div class="d-label">{{ $t('composer.modelTitle') }}</div>
                <div
                  v-for="m in MODEL_OPTIONS"
                  :key="m.value"
                  class="d-item"
                  :class="{ 'd-item--sel': settings.model.includes(modelKey(m.value)) }"
                  @click.stop="selectModel(m.value)"
                >
                  <span class="d-name">{{ m.label }}</span>
                  <span class="d-desc">{{ m.desc() }}</span>
                </div>
              </div>
            </Transition>
          </div>

          <!-- 🛡 权限模式 -->
          <div class="composer-select" @click.stop="toggleMenu('mode')" :title="$t('composer.permTitle')">
            <span class="pill-shield">🛡</span><span>{{ currentModeLabel }}</span><span class="pill-caret">▾</span>
            <Transition name="drop">
              <div v-if="openMenu === 'mode'" class="dropdown-menu">
                <button
                  v-for="m in modeOptions"
                  :key="m.value"
                  class="dropdown-item"
                  :style="{
                    color: activeMode === m.value ? 'var(--accent)' : 'var(--text-secondary)',
                    background: activeMode === m.value ? 'var(--accent-glow)' : 'transparent'
                  }"
                  @click.stop="selectMode(m.value)"
                >{{ m.label() }}</button>
              </div>
            </Transition>
          </div>

          <!-- ⚡ 推理强度（仅当前模型有 variants 时显示；无 variants 模型不渲染选择器） -->
          <div v-if="effortOptions.length > 0" class="composer-select" @click.stop="toggleMenu('effort')" :title="$t('composer.effortTitle')">
            <span class="pill-bolt" :style="{ color: currentEffortColor }">⚡</span><span :style="{ color: currentEffortColor }">{{ currentEffortLabel }}</span><span class="pill-caret" :style="{ color: currentEffortColor }">▾</span>
            <Transition name="drop">
              <div v-if="openMenu === 'effort'" class="dropdown-menu">
                <button
                  v-for="e in effortOptions"
                  :key="e.value"
                  class="dropdown-item"
                  :style="{
                    color: settings.effort === e.value ? e.color : 'var(--text-secondary)',
                    background: settings.effort === e.value ? e.color + '18' : 'transparent'
                  }"
                  @click.stop="selectEffort(e.value)"
                >{{ e.label() }}</button>
              </div>
            </Transition>
          </div>

          <!-- 上下文用量（有消息时才显示，点击打开上下文弹窗） -->
          <ContextIndicator @click="emit('showContext')" />

          <!-- 左侧扩展插槽：ChatPanel 注入 debug 按钮（放右组末尾） -->
          <slot name="left" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ── composer 容器：760px 居中（与消息区/待办列表对齐）+ 仅垂直 padding（水平 0——无背景无边框，避免双层卡片视觉）── */
.f-input-bar {
  position: relative;
  max-width: 760px;
  margin-inline: auto;
  padding: 14px 0 18px;
  user-select: none;
}
.composer {
  /* flex column：chips(默认 order 0) → 操作行(order 2) → 输入行(order 3) 的显示顺序 */
  display: flex;
  flex-direction: column;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  padding: 6px 8px 8px;
  transition: border-color 0.2s, box-shadow 0.2s;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.12);
}
/* focus-within 光环：accent-line 边框 + accent-glow 外发光（原型的 4px soft shadow） */
.composer:focus-within {
  border-color: var(--accent-line);
  box-shadow: 0 0 0 4px var(--accent-glow);
}
/* 拖放文件时虚线高亮（覆盖 focus 边框，视觉优先） */
.composer--dragover {
  border: 2px dashed var(--accent);
}
/* auto 模式蓝色边框提示（仅未聚焦时，避免与 focus 光环抢视觉） */
.composer--autos {
  border-color: #0ea5e9;
}

/* ── ① chips 行 ── */
.composer-tools {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  padding: 2px 6px;
  min-height: 28px;
}
.composer-tool {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 9px;
  border-radius: 6px;
  font-size: 11px;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  transition: all 0.15s;
}
.composer-tool:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
/* chips：accent 底（选区卡片） / elevated 底（附件） */
.composer-tool--on {
  background: var(--accent-glow);
  color: var(--accent);
  border: 1px solid var(--accent-dim);
}
.composer-tool--clickable {
  background: var(--bg-elevated);
  color: var(--text-secondary);
  border: 1px solid var(--border-dim);
  cursor: pointer;
}
.composer-tool--clickable:hover {
  border-color: var(--accent-line);
}
.chip-thumb {
  width: 20px;
  height: 20px;
  border-radius: 4px;
  object-fit: cover;
  border: 1px solid var(--border-dim);
  flex-shrink: 0;
}
.chip-icon { line-height: 1; }
.chip-name {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* chips 关闭 ×（原型 .composer-tool .x） */
.chip-x {
  margin-left: 4px;
  color: var(--text-muted);
  font-size: 12px;
  padding: 0 2px;
}
.chip-x:hover { color: var(--coral); }

/* ── ② textarea（14px / 1.7 / min 42 max 160，对齐原型 .composer-input）── */
.composer-input {
  width: 100%;
  flex: 1;
  border: none;
  background: transparent;
  resize: none;
  outline: none;
  box-shadow: none;
  /* padding-bottom 6px 与右侧按钮底部对齐（cf-right padding-bottom 同为 6px——用户反馈底部距离不一致） */
  padding: 8px 10px 6px;
  font-size: 14px;
  line-height: 1.7;
  min-height: 42px;
  max-height: 160px;
  overflow-y: auto;
  /* 隐藏 Y 轴滚动条（保留滚动功能）——与会话列表 rail 一致，用户反馈① */
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.composer-input::-webkit-scrollbar {
  display: none;
}
.composer-input::placeholder { color: var(--text-muted); }

/* ── ③ 操作行（foot）+ 输入行 ── */
.composer-foot {
  /* 独立一行显示在输入行上方；左组（附件/斜杠/指令）与右组（pills）两端对齐——用户反馈③ */
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 4px;
  padding: 2px 8px 4px;
  order: 2;
  border-bottom: 1px solid var(--border-dim);
  margin-bottom: 2px;
}
.cf-left {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
/* 右组：agent/模型/权限/推理/上下文/debug（用户反馈③：功能类右对齐） */
.cf-right-pills {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  min-width: 0;
}
/* 输入行：textarea 与 hint/发送同一行（用户要求：textarea 和 cf-right 一行） */
.composer-inputrow {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 0 4px 2px;
  order: 3;
}
/* textarea 包装层：渐变提示的定位参照（= textarea 宽度，不含 cf-right） */
.composer-input-wrap {
  position: relative;
  flex: 1;
  min-width: 0;
}
/* 双向渐变提示：0.5em 高（半个字符），accent 蓝渐变，指向可继续滚动的内容 */
.input-scroll-hint {
  position: absolute;
  left: 10px;
  right: 10px;
  /* bottom 2px = textarea 可视底（wrap 即 textarea 边界）——贴底防文字漏出（此前 6px 悬空于 padding 区，滚动中间态裁切文字从条下方露出） */
  bottom: 2px;
  height: 0.5em;
  border-radius: 2px;
  pointer-events: none;
  background: linear-gradient(to top, var(--accent-glow), transparent);
}
.input-scroll-hint--top {
  top: 2px;
  bottom: auto;
  background: linear-gradient(to bottom, var(--accent-glow), transparent);
}
/* 底部渐变淡入淡出 + 微上滑（300ms——用户反馈①） */
.grad-enter-active, .grad-leave-active { transition: opacity 300ms ease, transform 300ms ease; }
.grad-enter-from { opacity: 0; transform: translateY(4px); }
.grad-leave-to { opacity: 0; transform: translateY(4px); }
/* 顶部渐变淡入淡出 + 微下滑（与底部对称） */
.grad-top-enter-active, .grad-top-leave-active { transition: opacity 300ms ease, transform 300ms ease; }
.grad-top-enter-from { opacity: 0; transform: translateY(-4px); }
.grad-top-leave-to { opacity: 0; transform: translateY(-4px); }
.composer-inputrow .composer-input {
  flex: 1;
  min-width: 0;
}
.cf-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  padding-bottom: 6px;
}

/* agent / 模型 pill（原型 .agent-pill / .model-pill：小圆角 + border + hover） */
.composer-pill {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 9px;
  border-radius: 6px;
  font-size: 11px;
  color: var(--text-secondary);
  border: 1px solid var(--border-dim);
  cursor: pointer;
  transition: border-color 150ms, background-color 150ms;
  user-select: none;
  white-space: nowrap;
}
.composer-pill:hover {
  background: var(--bg-hover);
  border-color: var(--border-bright);
}
.pill-star { color: var(--accent); font-size: 12px; line-height: 1; }
.pill-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  flex-shrink: 0;
}
.pill-caret {
  color: var(--text-muted);
  font-size: 10px;
  line-height: 1;
}

/* 权限 / 推理 composer-select（原型 .composer-select：边框 + hover 底） */
.composer-select {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 9px;
  border-radius: 6px;
  font-size: 11px;
  color: var(--text-secondary);
  border: 1px solid var(--border-dim);
  cursor: pointer;
  transition: background-color 150ms, border-color 150ms;
  user-select: none;
  white-space: nowrap;
}
.composer-select:hover {
  background: var(--bg-hover);
  border-color: var(--border-bright);
}
.pill-shield { font-size: 11px; line-height: 1; }
.pill-bolt { font-size: 11px; line-height: 1; }

/* 命令小图标按钮（＋/ / ☰，对齐原型 icon-btn：26px 边框按钮） */
.composer-icon-btn {
  position: relative; /* 斜杠下拉的定位参照（去掉旧容器层后需要自身 relative——用户反馈④） */
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border-radius: 6px;
  font-size: 11px;
  flex-shrink: 0;
  color: var(--text-secondary);
  background: transparent;
  border: 1px solid var(--border-dim);
  transition: all 150ms ease;
}
.composer-icon-btn:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
  border-color: var(--accent-line);
}

/* ── 下拉菜单（agent / 模型带标题与描述的 d-item，权限/effort 复用 dropdown-item）── */
.dropdown-menu {
  position: absolute;
  bottom: 100%;
  left: 0;
  margin-bottom: 4px;
  padding-block: 4px;
  border-radius: 8px;
  z-index: 30;
  min-width: 170px;
  overflow: hidden;
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  /* 父级 .composer-select 的 nowrap 会被继承，导致 inline-block 的 item 横向重叠——必须重置 */
  white-space: normal;
}
.d-label {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 4px 12px 2px;
  color: var(--text-muted);
}
.d-item {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 5px 12px;
  cursor: pointer;
  transition: background-color 150ms;
}
.d-item:hover { background: var(--bg-hover); }
.d-item--sel { background: var(--accent-glow); }
.d-name { font-size: 12px; color: var(--text-primary); font-weight: 500; }
.d-item--sel .d-name { color: var(--accent); }
.d-desc { font-size: 10px; color: var(--text-muted); }
.dropdown-item {
  width: 100%;
  text-align: left;
  padding: 6px 12px;
  font-size: 11px;
  background: transparent;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background-color 150ms;
}
.dropdown-item:hover { background: var(--bg-hover); }

/* ── / 快捷斜杠菜单 ── */
.slash-dropdown {
  left: 0;
  min-width: 180px;
  max-height: 320px;
  overflow-y: auto;
}
.slash-section-header {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 6px 12px 2px;
  color: var(--text-muted);
}
.slash-section-divider {
  height: 1px;
  margin: 4px 8px;
  background: var(--border-dim);
}
.slash-browse-all { color: var(--accent); font-weight: 500; }
.slash-empty {
  font-size: 11px;
  padding: 12px;
  text-align: center;
  color: var(--text-muted);
}

/* ── 发送 / 停止按钮（30x30 正方形，与优化按钮同风格：accent 实底 + 边框）── */
.send {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border-radius: 9px;
  background: var(--accent);
  color: #fff;
  font-weight: 600;
  font-size: 12.5px;
  border: 1px solid var(--accent-line);
  cursor: pointer;
  transition: all 0.2s;
}
.send:hover:not(:disabled) {
  filter: brightness(1.12);
  transform: translateY(-1px);
}
.send:active:not(:disabled) { transform: none; }
/* disabled：视觉不变（用户反馈：空输入不该半透明），仅禁用交互 */
.send:disabled {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent-line);
  cursor: default;
}
.send--stop {
  background: var(--coral);
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid color-mix(in srgb, var(--coral) 55%, transparent);
}
.send--stop:hover:not(:disabled) { filter: brightness(1.12); }

/* hint：mono 10.5px faint（原型 .composer-hint） */
.composer-hint {
  font-size: 10.5px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  white-space: nowrap;
}

/* ✨ 优化消息按钮（发送左侧）：实心主题蓝图标 + 浅底蓝边（用户反馈：空心描边不明显 → 实心蓝） */
.polish-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border-radius: 9px;
  color: var(--accent);
  background: var(--accent-glow);
  border: 1px solid var(--accent-line);
  cursor: pointer;
  flex-shrink: 0;
  transition: all 150ms ease;
}
.polish-btn:hover:not(:disabled) {
  color: #fff;
  background: var(--accent);
  border-color: var(--accent);
}
.polish-btn:active:not(:disabled) { transform: none; }
/* 禁用态：视觉不变（用户反馈：空输入不该半透明），仅禁用交互 */
.polish-btn:disabled {
  color: var(--accent);
  background: var(--accent-glow);
  border-color: var(--accent-line);
  cursor: default;
}
.polish-btn--busy {
  animation: polish-spin 1s linear infinite;
  border-style: dashed;
  border-color: var(--accent-line);
}
@keyframes polish-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* ── 斜杠自动补全（输入框内 / 触发，绝对定位不挤占卡片）── */
.slash-autocomplete {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  max-width: 760px;
  margin: 0 auto 8px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-pop);
  overflow: hidden;
  z-index: 20;
}
.slash-ac-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 6px 12px;
  font-size: 12px;
  font-family: ui-monospace, monospace;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
  transition: background-color 100ms;
}
.slash-ac-item:hover,
.slash-ac-active {
  background: var(--accent-glow);
  color: var(--accent);
}

/* ── Dropdown animation ── */
.drop-enter-active { transition: all 120ms ease-out; }
.drop-leave-active { transition: all 100ms ease-in; }
.drop-enter-from { opacity: 0; transform: translateY(4px) scale(0.96); }
.drop-leave-to { opacity: 0; transform: translateY(2px) scale(0.98); }
</style>
