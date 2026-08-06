import { defineStore } from "pinia";
import { ref, watch } from "vue";
import { getClaudeSettings, setClaudeSettings, resolveClaudePath, saveProviderConfig, loadProviderConfigs, saveUiSettings as saveUiSettingsDb, loadUiSettings as loadUiSettingsDb, listDir } from "@/lib/electron-bridge";

/** Provider logo CDN URL 映射（lobe-icons，与 SettingsPanel 同源） */
export const PROVIDER_LOGOS: Record<string, string> = {
  anthropic: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/anthropic.svg",
  deepseek: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/deepseek-color.svg",
  openrouter: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/openrouter.svg",
  siliconflow: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/siliconcloud-color.svg",
  zhipu: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/zhipu-color.svg",
  kimi: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/kimi-color.svg",
  minimax: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/minimax-color.svg",
};

const STORAGE_KEY = "sb-ui-settings";

/**
 * 权限模式映射（对应 CLI --permission-mode 标志）:
 *   default | acceptEdits | bypassPermissions | plan | dontAsk | auto
 */
export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "dontAsk" | "auto";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max" | "ultracode";
export type PonytailMode = "off" | "lite" | "full" | "ultra";

/** 仅存 localStorage 的 UI 偏好 */
interface UiSettings {
  planMode: boolean;
  autoMode: boolean;
  permissionMode: PermissionMode;
  effort: Effort;
  ponytailMode: PonytailMode;
  theme: "dark" | "light" | "system";
  locale: "zh" | "en";
  fontSize: "small" | "medium" | "large";
  claudePath: string;
}

// ── Provider 配置持久化 ──

interface ProviderConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

/** 各 provider 默认 base URL（用户面值，首次切换无已保存配置时使用） */
const PROVIDER_BASE_URLS: Record<string, string> = {
  anthropic: "",
  deepseek: "https://api.deepseek.com/anthropic",
  openrouter: "https://openrouter.ai/api",
  siliconflow: "https://api.siliconflow.cn/",
  zhipu: "https://open.bigmodel.cn/api/anthropic",
  kimi: "https://api.moonshot.cn/anthropic",
  minimax: "https://api.minimaxi.com/anthropic",
  custom: "",
};

function getUiDefaults(): UiSettings {
  return {
    planMode: false,
    autoMode: true,
    permissionMode: "bypassPermissions",
    effort: "high",
    ponytailMode: "full",
    theme: "dark",
    locale: "zh",
    fontSize: "medium",
    claudePath: "",
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
  // ── API 配置 — 读写 ~/.claude/settings.json ──
  const apiKey = ref("");
  const baseUrl = ref("https://api.deepseek.com");
  const model = ref("deepseek-v4-pro[1M]");
  const providerId = ref("deepseek");
  const models = ref<string[]>(["deepseek-v4-pro[1M]", "deepseek-v4-flash", "deepseek-v4"]);

  // ── Provider 配置持久化 — SQLite ──
  const providerConfigs = ref<Record<string, ProviderConfig>>({});

  /** 保存当前 provider 的配置到 SQLite */
  async function saveCurrentConfig() {
    const id = providerId.value;
    if (!id) return;
    providerConfigs.value[id] = { apiKey: apiKey.value, baseUrl: baseUrl.value, model: model.value };
    try { await saveProviderConfig(id, apiKey.value, baseUrl.value, model.value); } catch { /* 后台静默 */ }
  }

  /** 恢复目标 provider 的配置；无记录则用 PROVIDER_BASE_URLS 默认值 */
  function restoreConfig(id: string) {
    const saved = providerConfigs.value[id];
    if (saved) {
      apiKey.value = saved.apiKey;
      baseUrl.value = saved.baseUrl;
      model.value = saved.model;
    } else {
      apiKey.value = "";
      baseUrl.value = PROVIDER_BASE_URLS[id] ?? "";
      // model 由 switchProvider 设置，此处不覆盖
    }
  }

  // ── UI 偏好 — localStorage ──
  const ui = loadUiSettings();
  const planMode = ref(ui.planMode);
  const autoMode = ref(ui.autoMode);
  const permissionMode = ref<PermissionMode>(ui.permissionMode);
  const effort = ref<Effort>(ui.effort);
  const ponytailMode = ref<PonytailMode>(ui.ponytailMode);
  const theme = ref<"dark" | "light" | "system">(ui.theme);
  const locale = ref<"zh" | "en">(ui.locale);
  const fontSize = ref<"small" | "medium" | "large">(ui.fontSize);
  const claudePath = ref(ui.claudePath);
  const resolvedClaudePath = ref("");

  // LLM API 地址：跟随 baseUrl，用户手动编辑过才存 localStorage 覆盖
  const LLM_API_URL_KEY = "sb-llm-api-url-override";
  const optimizeApiUrl = ref(localStorage.getItem(LLM_API_URL_KEY) || baseUrl.value);

  // 上下文窗口大小（tokens）：0 = 自动检测，>0 = 手动指定
  const contextLimit = ref(0);

  // 禅模式：直接与 LLM 对话，不启动 CC CLI（仅内存状态，不持久化）
  const zenMode = ref(false);

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

  // 启动时获取自动检测的 claude 路径
  // 启动时从 SQLite + settings.json 恢复所有配置（统一入口，供 AppShell await）
  async function initFromDb() {
    // 并行加载，哪个先到就用哪个
    const tasks = [
      loadProviderConfigs().then(cfgs => { providerConfigs.value = cfgs || {}; }).catch(() => {}),
      resolveClaudePath().then(p => resolvedClaudePath.value = p).catch(() => {}),
      // 从 SQLite 恢复 UI 设置（不受 Tauri identifier 变更影响），优先于 localStorage
      loadUiSettingsDb().then(json => {
    try {
      const db = JSON.parse(json);
      if (db.optimizeApiUrl) optimizeApiUrl.value = db.optimizeApiUrl;
      if (db.claudePath) claudePath.value = db.claudePath;
      if (db.theme) theme.value = db.theme as "dark" | "light" | "system";
      if (db.locale) locale.value = db.locale as "zh" | "en";
      if (db.fontSize) fontSize.value = db.fontSize as "small" | "medium" | "large";
      if (db.ponytailMode) ponytailMode.value = db.ponytailMode as PonytailMode;
      if (db.contextLimit != null) contextLimit.value = db.contextLimit;
      if (db.cwd) {
        // 校验路径是否仍存在，防止 exe 换位置后加载无效工作区
        listDir(db.cwd).then(() => { cwd.value = db.cwd; }).catch(() => { /* 路径不存在，保持空让 AppShell 用 getWorkspaceRoot */ });
      }
      if (db.recentWorkspaces) recentWorkspaces.value = db.recentWorkspaces;
    } catch {}
      }).catch(() => {}),
      // 启动时从 ~/.claude/settings.json 加载配置
      getClaudeSettings().then(s => {
    apiKey.value = s.api_key;
    baseUrl.value = s.base_url;
    model.value = s.model;
    providerId.value = s.provider_id;
    if (s.models && s.models.length > 0) models.value = s.models;
    // 启动时将当前配置写入 providerConfigs（若尚未保存），供后续切换时恢复
    if (s.provider_id && s.api_key && !providerConfigs.value[s.provider_id]) {
      providerConfigs.value[s.provider_id] = { apiKey: s.api_key, baseUrl: s.base_url, model: s.model };
      saveProviderConfig(s.provider_id, s.api_key, s.base_url, s.model).catch(() => {});
    }
    // effort 只在 cc-gui 没设置过时从 settings.json 取
    if (!ui.effort || ui.effort === getUiDefaults().effort) {
      const eff = s.effort as Effort;
      if (["low","medium","high","xhigh","max","ultracode"].includes(eff)) {
        effort.value = eff;
      }
    }
    // 权限模式：从 permissions.defaultMode 还原
    switch (s.permission_mode) {
      case "auto": planMode.value = false; autoMode.value = true; break;
      case "plan": planMode.value = true; autoMode.value = false; break;
      default:
        planMode.value = false; autoMode.value = false;
        if (["default","acceptEdits","bypassPermissions","dontAsk"].includes(s.permission_mode)) {
          permissionMode.value = s.permission_mode as PermissionMode;
        }
    }
      }).catch(() => {}),
    ];
    await Promise.all(tasks);
  }

  // 权限模式 → 解析为 settings.json 的 permissions.defaultMode
  function resolvePermissionMode(): string {
    if (autoMode.value) return "auto";
    if (planMode.value) return "plan";
    return permissionMode.value;
  }

  // 配置变更 → 写回 ~/.claude/settings.json
  watch(
    [apiKey, baseUrl, model, effort, planMode, autoMode, permissionMode, providerId],
    ([k, u, m, e]) => {
      setClaudeSettings(k, u, m, e, resolvePermissionMode(), providerId.value).catch(() => {});
    },
    { deep: true },
  );

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
  watch([planMode, autoMode, permissionMode, effort, ponytailMode, theme, locale, fontSize, claudePath], () => {
    const s: UiSettings = {
      planMode: planMode.value,
      autoMode: autoMode.value,
      permissionMode: permissionMode.value,
      effort: effort.value,
      ponytailMode: ponytailMode.value,
      theme: theme.value,
      locale: locale.value,
      fontSize: fontSize.value,
      claudePath: claudePath.value,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  }, { deep: true });

  // UI 偏好变更 → 写 SQLite（500ms 防抖，不受 Tauri identifier 变更影响）
  let uiDbTimer: ReturnType<typeof setTimeout> | null = null;
  watch(
    [optimizeApiUrl, claudePath, theme, locale, fontSize, ponytailMode, planMode, autoMode, permissionMode, effort, cwd, recentWorkspaces, contextLimit],
    () => {
      if (uiDbTimer) clearTimeout(uiDbTimer);
      uiDbTimer = setTimeout(() => {
        saveUiSettingsDb(JSON.stringify({
          optimizeApiUrl: optimizeApiUrl.value,
          claudePath: claudePath.value,
          theme: theme.value,
          locale: locale.value,
          fontSize: fontSize.value,
          ponytailMode: ponytailMode.value,
          planMode: planMode.value,
          autoMode: autoMode.value,
          permissionMode: permissionMode.value,
          effort: effort.value,
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

  return { apiKey, baseUrl, model, providerId, models, planMode, autoMode, permissionMode, effort, ponytailMode, theme, locale, fontSize, claudePath, optimizeApiUrl, zenMode, contextLimit, resolvedClaudePath, saveCurrentConfig, restoreConfig, cwd, recentWorkspaces, addRecentWorkspace, initFromDb };
});
