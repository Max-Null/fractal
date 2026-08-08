import { defineStore } from "pinia";
import { ref, watch } from "vue";
import { saveProviderConfig, loadProviderConfigs, saveUiSettings as saveUiSettingsDb, loadUiSettings as loadUiSettingsDb, listDir, onConfigChanged, getSettingsConfig, saveSettingsJson, loadModelVariants, stopSession, refreshEngine } from "@/lib/electron-bridge";
import { useChatStore } from "./chat";
import { useSessionStore } from "./session";

const STORAGE_KEY = "sb-ui-settings";

/** 模块级 guard：config-changed 监听只注册一次（pinia 单例下 setup 仅执行一次；测试多 pinia 场景事件用例直接调 applySettingsJson） */
let configListenerRegistered = false;

/**
 * 权限模式映射（对应 CLI --permission-mode 标志）:
 *   default | acceptEdits | bypassPermissions | plan | dontAsk | auto
 */
export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "dontAsk" | "auto";

/**
 * 思考强度 = OC 模型 variant（reasoningEffort）：值 = 当前模型可用 variant 名。
 * '' = 模型无 variants（如 deepseek-chat/reasoner）或未选择——发送时不传 variant。
 * 旧 6 档枚举（medium/xhigh/ultracode）是 CC 遗留假功能（前端只存不传引擎），改造后仅 variant 三档。
 */
export type Effort = "low" | "high" | "max" | "";

/**
 * 旧 effort 值归一为 variant（旧 6 档 → 最近的 variant 档）：
 *  medium→low、xhigh→high、ultracode→max；未知/空 → ''（不传）。
 */
export function normalizeEffort(v: unknown): Effort {
  switch (v) {
    case "low": return "low";
    case "high": return "high";
    case "max": return "max";
    case "medium": return "low";   // 旧档：中思考 → 低
    case "xhigh": return "high";   // 旧档：极高思考 → 高
    case "ultracode": return "max"; // 旧档：极高级 → 最大
    default: return "";
  }
}

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
    if (raw) {
      const parsed = JSON.parse(raw);
      // 旧 effort 档位（medium/xhigh/ultracode）归一为 variant（CC 遗留假功能改造，兼容老 localStorage）
      if (parsed.effort !== undefined) parsed.effort = normalizeEffort(parsed.effort);
      return { ...getUiDefaults(), ...parsed };
    }
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

  /** 保存当前配置到 SQLite（DeepSeek 单 provider 下固定写入 deepseek 槽位）
   *  restart=true 仅用户主动保存时传（SettingsPanel/Onboarding）——主进程据此重启 serve；
   *  watch 自动保存（启动恢复/输入防抖）不传：serve 刚用最新配置启动，重启会杀掉健康中的
   *  serve 导致并发请求 ECONNRESET + 会话列表加载失败（2026-08-09 实测 stopping=true 日志） */
  async function saveCurrentConfig(restart = false) {
    const id = providerId.value;
    if (!id) return;
    providerConfigs.value[id] = { apiKey: apiKey.value, baseUrl: baseUrl.value, model: model.value };
    try { await saveProviderConfig(id, apiKey.value, baseUrl.value, model.value, restart); } catch { /* 后台静默 */ }
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
  /** 当前模型可用的思考强度 variant 列表（如 ['low','high','max']）；空 = 模型无 variants（不显示选择器） */
  const modelVariants = ref<string[]>([]);
  function setModelVariants(v: string[]) {
    modelVariants.value = Array.isArray(v) ? v : [];
    // 当前模型无 variants → effort 清空（发送时不传 variant，防止残留旧档位）
    if (modelVariants.value.length === 0 && effort.value !== "") effort.value = "";
    // 当前模型有 variants 但 effort 不在其中 → 归一到 high（默认档，不存在则空）
    else if (modelVariants.value.length > 0 && effort.value !== "" && !modelVariants.value.includes(effort.value)) {
      effort.value = modelVariants.value.includes("high") ? "high" : "";
    }
  }
  const currentAgent = ref(ui.currentAgent);
  const theme = ref<"dark" | "light" | "system">(ui.theme);
  const locale = ref<"zh" | "en">(ui.locale);
  const fontSize = ref<"small" | "medium" | "large">(ui.fontSize);

  // settings.json 是否真实存在于磁盘（默认态标记）：不存在时 applySettingsJson 的 ui.theme/ui.language 不覆盖表单（主题持久化）
  const settingsFileExists = ref(false);

  // LLM API 地址：跟随 baseUrl，用户手动编辑过才存 localStorage 覆盖
  const LLM_API_URL_KEY = "sb-llm-api-url-override";
  const optimizeApiUrl = ref(localStorage.getItem(LLM_API_URL_KEY) || baseUrl.value);

  // 上下文窗口大小（tokens）：0 = 自动检测，>0 = 手动指定
  const contextLimit = ref(0);

  // ── 数据模式（settings.json dataMode：会话数据隔离开关）──
  // 不进任何 UI 偏好 watch 数组：主题/语言 800ms 防抖写盘会用「当前文件字段 + 主题/语言」重建对象，
  // dataMode 一旦混入防抖链，切换主题会带着旧值写回，覆盖用户最新选择（军师 P0）
  const dataMode = ref<"shared" | "isolated">("shared");
  /** 数据模式切换中（防连点锁；SettingsPanel 开关禁用 + 提示条） */
  const isRestarting = ref(false);

  /** 合并 dataMode 写 settings.json（读当前显式字段 + 新值，不覆盖文件其他字段） */
  async function persistDataMode(v: "shared" | "isolated") {
    const r = await getSettingsConfig();
    const next: Record<string, unknown> = { ...r.config, dataMode: v };
    await saveSettingsJson(JSON.stringify(next, null, 2));
  }

  /**
   * 切换数据模式：写 settings.json → 重启 serve（数据目录变更生效）→ 清理旧数据目录的会话缓存。
   * 失败回滚（D8 P0 防引擎停摆）：还原旧值再重启一次，二次失败才报错。
   * 返回 { ok, mode, error? }：ok=true 切换成功；ok=false 且 error 含「已恢复」= 回滚成功（引擎未停摆）。
   */
  async function setDataMode(v: "shared" | "isolated"): Promise<{ ok: boolean; mode: "shared" | "isolated"; error?: string }> {
    // 切换中防连点；目标值 = 当前值直接返回（无副作用）
    if (isRestarting.value || v === dataMode.value) return { ok: true, mode: dataMode.value };
    const prev = dataMode.value;
    isRestarting.value = true;
    dataMode.value = v; // 先更新 UI 立即反映（saveSettings 广播回来自动同步）
    try {
      // ① 收尾活跃流：abort 当前会话（防 isStreaming 悬挂——缓存清理前不中止会残留进行中状态）
      const sessionStore = useSessionStore();
      if (sessionStore.activeSessionId) {
        try {
          await stopSession(sessionStore.activeSessionId);
        } catch {
          // 引擎未就绪/会话已结束：忽略（abort 端点 500 容错在 IPC 层已处理）
        }
      }
      // ② 合并写 settings.json
      await persistDataMode(v);
      // ③ 重启引擎（XDG_DATA_HOME 注入在 startServer 时读取新值）
      const r = await refreshEngine();
      if (!r.ok) {
        // ④ 回滚：还原旧值 → 再重启 → 二次失败才报错（防引擎停摆）
        dataMode.value = prev;
        await persistDataMode(prev);
        const rb = await refreshEngine();
        if (!rb.ok) {
          return { ok: false, mode: prev, error: rb.error ?? "引擎重启失败" };
        }
        return { ok: false, mode: prev, error: "引擎重启失败，已恢复原模式" };
      }
      // ⑤ 成功：清空旧数据目录的会话缓存 + 活跃会话，重新拉列表（serve 数据目录已切换）
      const chatStore = useChatStore();
      chatStore.clearSessionCache();
      chatStore.clearMessages();
      sessionStore.setActiveSession("");
      await sessionStore.loadSessions(cwd.value || undefined);
      return { ok: true, mode: v };
    } catch (err) {
      // 写盘等异常：引擎未重启，仅还原 UI + 配置值
      dataMode.value = prev;
      try {
        await persistDataMode(prev);
      } catch {
        // 还原写盘失败不阻断（settings.json 不可写仍可运行，仅模式不恢复）
      }
      return { ok: false, mode: prev, error: err instanceof Error ? err.message : String(err) };
    } finally {
      isRestarting.value = false;
    }
  }

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
  /**
   * 新窗口工作区下发路径（多窗口支持）：AppShell 收到 window:init-workspace 时写入。
   * initFromDb 的异步 cwd 恢复可能晚于下发（did-finish-load 早于 SQLite IPC 返回）——
   * 有此标记时恢复逻辑以下发值为准，防止 SQLite 覆盖新窗口的目标工作区（2026-08-08 实测竞态）
   */
  const windowInitCwd = ref("");

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
    try { localStorage.setItem("sb-recent-workspaces", JSON.stringify(recentWorkspaces.value)); } catch {}
  }

  /** 从最近使用移除工作区记录（工作区管理）：仅移除记录，不影响磁盘目录与 serve 会话
   *  （serve 里有会话的工作区仍会经 serveDirs 聚合出现在菜单——「删除」= 不再记住，非删除数据） */
  function removeRecentWorkspace(path: string) {
    recentWorkspaces.value = recentWorkspaces.value.filter(p => p !== path);
    try { localStorage.setItem("sb-recent-workspaces", JSON.stringify(recentWorkspaces.value)); } catch {}
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
        listDir(db.cwd).then(() => {
          // 新窗口已收到 init-workspace 下发 → 以下发值为准，跳过 SQLite 恢复（多窗口竞态防护）
          if (windowInitCwd.value) {
            cwd.value = windowInitCwd.value;
            return;
          }
          cwd.value = db.cwd;
        }).catch(() => { /* 路径不存在，保持空让 AppShell 用 getWorkspaceRoot */ });
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
    // 启动拉取 settings.json（阶段 6，方案 3.8.1）：settings.json 是高级层源，优先级高于表单
    // （ui 偏好/引擎项以 settings.json 为准；API Key 仍在 providerConfigs，settings.json 不含密钥）
    // 启动拉取 settings.json（阶段 6）：settings.json 是高级源，优先级高于表单——await 保证渲染前配置已就绪（避免 UI 先渲染默认值再被覆盖的闪烁）
    try {
      const r = await getSettingsConfig();
      // 同步默认态标记：文件真实存在（exists=true）→ ui.theme 以文件为准；不存在 → 表单持久化优先
      if (typeof r.exists === "boolean") settingsFileExists.value = r.exists;
      applySettingsJson(r.config);
    } catch {
      // 拉取失败保持表单值（首次启动/引擎不可用）
    }
  }

  /**
   * 应用 settings.json 配置（config-changed 事件 + 启动拉取共用）。
   * settings.json 优先级高于表单：ui 偏好即时生效、agent 权限/思考深度同步、deepseek.model 更新模型选择。
   * 注意：store 的 watch 会把合并结果写回 localStorage/ui-settings.json——这是运行时偏好记录（同步值），
   * settings.json 本身不受表单影响（两通道并存，方案 3.8「三条路径统一走文件」）。
   */
  function applySettingsJson(config: Record<string, unknown>) {
    // ui 偏好即时生效（settings.json 枚举无 system，只在 dark/light 时覆盖，保留表单的跟随系统）
    // 仅文件真实存在时覆盖——首次启动 settings.json 不存在 = 默认态，不应覆盖表单持久化的主题/语言
    if (settingsFileExists.value) {
      if (config["ui.theme"] === "dark" || config["ui.theme"] === "light") theme.value = config["ui.theme"] as "dark" | "light";
      if (config["ui.language"] === "zh" || config["ui.language"] === "en") locale.value = config["ui.language"] as "zh" | "en";
    }
    // 引擎相关：模型选择同步（settings.json 的 deepseek-v4-pro → store 显示名带 [1M] 标注，与 DEEPSEEK_MODELS 一致）
    const m = config["deepseek.model"];
    if (m === "deepseek-v4-pro") model.value = "deepseek-v4-pro[1M]";
    else if (typeof m === "string" && DEEPSEEK_MODELS.includes(m)) model.value = m;
    // 权限模式四值 → store 三联动（plan/auto 是独立开关，default/acceptEdits 落在 permissionMode）
    const pm = config["agent.permissionMode"];
    if (pm === "plan") { planMode.value = true; autoMode.value = false; }
    else if (pm === "auto") { autoMode.value = true; planMode.value = false; }
    else if (pm === "default" || pm === "acceptEdits") { planMode.value = false; autoMode.value = false; permissionMode.value = pm as PermissionMode; }
    // 思考强度（settings.json 的 agent.effort 值 = variant 名；旧档位读入归一）
    const ef = config["agent.effort"];
    if (typeof ef === "string") effort.value = normalizeEffort(ef);
    if (typeof config["agent.contextLimit"] === "number") contextLimit.value = config["agent.contextLimit"];
    // 数据模式（settings.json 显式字段；非法/缺失保持当前值——agent 工具/GUI 保存三路统一生效）
    if (config["dataMode"] === "isolated" || config["dataMode"] === "shared") dataMode.value = config["dataMode"];
  }

  // 注册 config-changed 事件（主进程 fs.watch settings.json → 广播；agent 工具/GUI 保存三路统一生效）
  if (!configListenerRegistered) {
    configListenerRegistered = true;
    // 运行时 electronBridge 由 preload 注入；测试（happy-dom）无此对象，跳过注册（事件用例直接调 applySettingsJson）
    const bridge = (window as unknown as { electronBridge?: { on: (c: string, cb: (d: unknown) => void) => () => void } }).electronBridge;
    if (bridge?.on) {
      onConfigChanged((payload) => {
        // exists 同步：agent 首次创建 settings.json 后，默认态标记解除（此后 ui.theme 以文件为准）
        if (typeof payload.exists === "boolean") settingsFileExists.value = payload.exists;
        applySettingsJson(payload.config);
      });
    }
  }

  // Provider 配置编辑 → 自动写 SQLite（500ms 防抖，避免每次按键都写盘）
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  watch([apiKey, baseUrl, model], () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveCurrentConfig(), 500);
  });

  // 模型变更（InputBar 选择 / SettingsPanel / settings.json 同步）→ 拉取该模型可用 variants。
  // 数据源：主进程 provider:modelVariants（/provider 响应 all[].models[id].variants，spec 实测）。
  // 引擎未就绪/测试环境（electronBridge 缺失）→ 置空并静默（选择器隐藏，不阻断主流程）。
  watch(model, async (m) => {
    try {
      setModelVariants(await loadModelVariants(m));
    } catch {
      setModelVariants([]);
    }
  }, { immediate: true });

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

  // ── 主题/语言同步写 settings.json（高级源）──
  // 根因：settings.json 不存在时 loadSettings 返回默认值（ui.theme=dark），applySettingsJson 把它当显式配置覆盖表单
  // 修复：①默认态（exists=false）不覆盖表单 ②用户显式切换主题/语言 → 写 settings.json（之后启动以文件为准）
  // 循环防护：写盘 → config-changed 广播 → applySettingsJson 同值 → watch 不触发（值未变），无死循环
  let themeSyncTimer: ReturnType<typeof setTimeout> | null = null;
  watch([theme, locale], ([t, l]) => {
    if (themeSyncTimer) clearTimeout(themeSyncTimer);
    // 防抖：主题/语言连续切换只写一次（saveSettings 会触发引擎联动判断，但纯 UI 项不改 opencode.json）
    themeSyncTimer = setTimeout(() => {
      if (t !== "dark" && t !== "light") return; // system 不在 settings.json 枚举（schema 只有 dark/light），跳过
      getSettingsConfig()
        .then((r) => {
          const next: Record<string, unknown> = { ...r.config, "ui.theme": t };
          if (l === "zh" || l === "en") next["ui.language"] = l;
          saveSettingsJson(JSON.stringify(next, null, 2)).catch(() => {
            // 写失败不阻断（settings.json 写入失败仍可运行，仅主题重启不恢复）
            console.error("[settings] 主题同步写 settings.json 失败");
          });
        })
        .catch(() => {});
    }, 800);
  });

  return { apiKey, baseUrl, model, providerId, models, planMode, autoMode, permissionMode, effort, modelVariants, setModelVariants, currentAgent, theme, locale, fontSize, optimizeApiUrl, contextLimit, settingsFileExists, saveCurrentConfig, restoreConfig, cwd, recentWorkspaces, addRecentWorkspace, removeRecentWorkspace, initFromDb, applySettingsJson, onboardingDismissed, markOnboardingDismissed, resetOnboarding, windowInitCwd, dataMode, isRestarting, setDataMode };
});
