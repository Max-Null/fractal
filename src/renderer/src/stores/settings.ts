import { defineStore } from "pinia";
import { ref, watch } from "vue";
import { saveProviderConfig, loadProviderConfigs, saveUiSettings as saveUiSettingsDb, loadUiSettings as loadUiSettingsDb, listDir } from "@/lib/electron-bridge";

const STORAGE_KEY = "sb-ui-settings";

/**
 * 权限模式映射（对应 CLI --permission-mode 标志）:
 *   default | acceptEdits | bypassPermissions | plan | dontAsk | auto
 */
export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "dontAsk" | "auto";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max" | "ultracode";

/** 仅存 localStorage 的 UI 偏好 */
interface UiSettings {
  planMode: boolean;
  autoMode: boolean;
  permissionMode: PermissionMode;
  effort: Effort;
  /** 会话主 agent（双星=分形默认 / build / plan），随消息发送传给引擎 promptAsync.agent */
  currentAgent: string;
  theme: "dark" | "light" | "system";
  locale: "zh" | "en";
  fontSize: "small" | "medium" | "large";
}

// ── DeepSeek 专属模型列表（分形固定模型 DeepSeek，方案 D16）──
export const DEEPSEEK_MODELS = ["deepseek-v4-pro[1M]", "deepseek-v4-flash", "deepseek-v4"];

function getUiDefaults(): UiSettings {
  return {
    planMode: false,
    autoMode: true,
    permissionMode: "bypassPermissions",
    effort: "high",
    // 默认主 agent = 分形预置「双星」（oc-plus 四 agent 协作的主 agent，D15）
    currentAgent: "双星",
    theme: "dark",
    locale: "zh",
    fontSize: "medium",
  };
}

function loadUiSettings(): UiSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...getUiDefaults(), ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return getUiDefaults();
}

export const useSettingsStore = defineStore("settings", () => {
  // ── API 配置 — DeepSeek 专属，持久化到 SQLite ──
  const apiKey = ref("");
  const baseUrl = ref("https://api.deepseek.com");
  const model = ref(DEEPSEEK_MODELS[0]);
  const providerId = ref("deepseek");
  const models = ref<string[]>([...DEEPSEEK_MODELS]);

  // ── Provider 配置持久化 — SQLite ──
  interface ProviderConfig {
    apiKey: string;
    baseUrl: string;
    model: string;
  }
  const providerConfigs = ref<Record<string, ProviderConfig>>({});

  /** 保存当前配置到 SQLite（DeepSeek 单 provider 下固定写入 deepseek 槽位） */
  async function saveCurrentConfig() {
    const id = providerId.value;
    if (!id) return;
    providerConfigs.value[id] = { apiKey: apiKey.value, baseUrl: baseUrl.value, model: model.value };
    try { await saveProviderConfig(id, apiKey.value, baseUrl.value, model.value); } catch { /* 后台静默 */ }
  }

  /** 恢复目标 provider 的配置；无记录则清空 apiKey、用默认 baseUrl */
  function restoreConfig(id: string) {
    const saved = providerConfigs.value[id];
    if (saved) {
      apiKey.value = saved.apiKey;
      baseUrl.value = saved.baseUrl;
      model.value = saved.model;
    } else {
      apiKey.value = "";
      baseUrl.value = "https://api.deepseek.com";
    }
  }

  // ── UI 偏好 — localStorage ──
  const ui = loadUiSettings();
  const planMode = ref(ui.planMode);
  const autoMode = ref(ui.autoMode);
  const permissionMode = ref<PermissionMode>(ui.permissionMode);
  const effort = ref<Effort>(ui.effort);
  const currentAgent = ref(ui.currentAgent);
  const theme = ref<"dark" | "light" | "system">(ui.theme);
  const locale = ref<"zh" | "en">(ui.locale);
  const fontSize = ref<"small" | "medium" | "large">(ui.fontSize);

  // LLM API 地址：跟随 baseUrl，用户手动编辑过才存 localStorage 覆盖
  const LLM_API_URL_KEY = "sb-llm-api-url-override";
  const optimizeApiUrl = ref(localStorage.getItem(LLM_API_URL_KEY) || baseUrl.value);

  // 上下文窗口大小（tokens）：0 = 自动检测，>0 = 手动指定
  const contextLimit = ref(0);

  // ── Onboarding 首屏引导状态 ──
  // 完成/跳过标记持久化到 localStorage，避免每次启动都弹引导；设置面板可重置重新触发
  const ONBOARDING_KEY = "sb-onboarding-dismissed";
  const onboardingDismissed = ref(localStorage.getItem(ONBOARDING_KEY) === "1");

  function markOnboardingDismissed() {
    onboardingDismissed.value = true;
    localStorage.setItem(ONBOARDING_KEY, "1");
  }

  function resetOnboarding() {
    onboardingDismissed.value = false;
    localStorage.removeItem(ONBOARDING_KEY);
  }

  // ── 工作区状态 ──
  const MAX_RECENT_WORKSPACES = 10;
  const cwd = ref(localStorage.getItem("sb-current-workspace") || "");

  const recentWorkspaces = ref<string[]>([]);
  try {
    const raw = localStorage.getItem("sb-recent-workspaces");
    if (raw) recentWorkspaces.value = JSON.parse(raw);
  } catch { recentWorkspaces.value = []; }

  function addRecentWorkspace(path: string) {
    const next = recentWorkspaces.value.filter(p => p !== path);
    next.unshift(path);
    if (next.length > MAX_RECENT_WORKSPACES) next.pop();
    recentWorkspaces.value = next;
    // localStorage 同步备份
    localStorage.setItem("sb-recent-workspaces", JSON.stringify(next));
  }

  // 启动时从 SQLite 恢复所有配置（统一入口，供 AppShell await）
  async function initFromDb() {
    // 并行加载，哪个先到就用哪个
    const tasks = [
      loadProviderConfigs().then(cfgs => { providerConfigs.value = cfgs || {}; }).catch(() => {}),
      // 从 SQLite 恢复 UI 设置（不受 Tauri identifier 变更影响），优先于 localStorage
      loadUiSettingsDb().then(json => {
    try {
      const db = JSON.parse(json);
      if (db.optimizeApiUrl) optimizeApiUrl.value = db.optimizeApiUrl;
      if (db.theme) theme.value = db.theme as "dark" | "light" | "system";
      if (db.locale) locale.value = db.locale as "zh" | "en";
      if (db.fontSize) fontSize.value = db.fontSize as "small" | "medium" | "large";
      if (db.contextLimit != null) contextLimit.value = db.contextLimit;
      if (db.cwd) {
        // 校验路径是否仍存在，防止 exe 换位置后加载无效工作区
        listDir(db.cwd).then(() => { cwd.value = db.cwd; }).catch(() => { /* 路径不存在，保持空让 AppShell 用 getWorkspaceRoot */ });
      }
      if (db.recentWorkspaces) recentWorkspaces.value = db.recentWorkspaces;
    } catch {}
      }).catch(() => {}),
    ];
    await Promise.all(tasks);
    // 启动恢复：以 SQLite providerConfigs 为准（真实持久化通道），恢复 DeepSeek 已保存的配置
    const saved = providerConfigs.value[providerId.value];
    if (saved) {
      apiKey.value = saved.apiKey;
      baseUrl.value = saved.baseUrl;
      model.value = saved.model;
    }
  }

  // Provider 配置编辑 → 自动写 SQLite（500ms 防抖，避免每次按键都写盘）
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  watch([apiKey, baseUrl, model], () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveCurrentConfig(), 500);
  });

  // LLM API 地址：未手填时跟随 baseUrl，手填后存 localStorage
  watch(baseUrl, (v) => {
    if (!optimizeApiUrl.value) optimizeApiUrl.value = v;
  });
  watch(optimizeApiUrl, (v) => {
    if (v) localStorage.setItem(LLM_API_URL_KEY, v);
    else localStorage.removeItem(LLM_API_URL_KEY);
  });

  // UI 偏好变更 → 写 localStorage
  watch([planMode, autoMode, permissionMode, effort, theme, locale, fontSize, currentAgent], () => {
    const s: UiSettings = {
      planMode: planMode.value,
      autoMode: autoMode.value,
      permissionMode: permissionMode.value,
      effort: effort.value,
      currentAgent: currentAgent.value,
      theme: theme.value,
      locale: locale.value,
      fontSize: fontSize.value,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  }, { deep: true });

  // UI 偏好变更 → 写 SQLite（500ms 防抖，不受 Tauri identifier 变更影响）
  let uiDbTimer: ReturnType<typeof setTimeout> | null = null;
  watch(
    [optimizeApiUrl, theme, locale, fontSize, planMode, autoMode, permissionMode, effort, cwd, recentWorkspaces, contextLimit, currentAgent],
    () => {
      if (uiDbTimer) clearTimeout(uiDbTimer);
      uiDbTimer = setTimeout(() => {
        saveUiSettingsDb(JSON.stringify({
          optimizeApiUrl: optimizeApiUrl.value,
          theme: theme.value,
          locale: locale.value,
          fontSize: fontSize.value,
          planMode: planMode.value,
          autoMode: autoMode.value,
          permissionMode: permissionMode.value,
          effort: effort.value,
          currentAgent: currentAgent.value,
          cwd: cwd.value,
          recentWorkspaces: recentWorkspaces.value,
          contextLimit: contextLimit.value,
        })).catch(() => {});
      }, 500);
    },
    { deep: true },
  );

  // cwd 变更 → localStorage 同步备份
  watch(cwd, (v) => {
    if (v) localStorage.setItem("sb-current-workspace", v);
    else localStorage.removeItem("sb-current-workspace");
  });

  return { apiKey, baseUrl, model, providerId, models, planMode, autoMode, permissionMode, effort, currentAgent, theme, locale, fontSize, optimizeApiUrl, contextLimit, saveCurrentConfig, restoreConfig, cwd, recentWorkspaces, addRecentWorkspace, initFromDb, onboardingDismissed, markOnboardingDismissed, resetOnboarding };
});
