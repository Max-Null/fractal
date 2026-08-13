import { defineStore } from "pinia";
import { ref, watch } from "vue";
import { saveProviderConfig, loadProviderConfigs, saveUiSettings as saveUiSettingsDb, loadUiSettings as loadUiSettingsDb, listDir, onConfigChanged, getSettingsConfig, saveSettingsJson, loadModelVariants, stopSession, refreshEngine, pickAvatar as pickAvatarBridge, clearAvatar as clearAvatarBridge } from "@/lib/electron-bridge";
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

/** 系统通知场景配置（settings.json ui.notifications；全局开关 + 4 触发点，缺省按此补全） */
export interface NotificationsConfig {
  /** 全局通知开关：false 时全部场景静默 */
  enabled: boolean;
  /** AI 回答完成（assistant 流结束） */
  replyDone: boolean;
  /** 引擎异常退出（非主动停止且非零退出码） */
  engineError: boolean;
  /** 权限请求待审批 */
  permissionPending: boolean;
  /** 子任务完成 */
  subtaskDone: boolean;
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
  /** 消息排布：left=全部靠左 / split=左右分列（我右 · AI 左），方案 §3.8.2 */
  messageLayout: "left" | "split";
  /** 用户昵称（消息区用户名显示，空=「我」兜底） */
  nickname: string;
  /** 用户头像（emoji 字符串，空=「我」字兜底） */
  avatar: string;
  /** 思考节点开关（时间线 thinking 节点显隐，v-show 不删数据，切回即恢复） */
  showThinking: boolean;
  /** 图片头像文件名（avatar.{png|jpg|jpeg|webp}，存 <userData>/avatar/；空=emoji 兜底） */
  avatarImage: string;
  /** 系统通知场景配置（全局开关 + 4 触发点） */
  notifications: NotificationsConfig;
  /** 子 agent 模型覆盖（agent 名 → 模型全名 provider/model；空表=全部跟随槽位） */
  agentModelOverrides: Record<string, string>;
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
    // 消息排布默认 split：与当前实际渲染一致（时间线实现已按 v0.5+ 默认左右分列硬编码），切换 left 才变化
    messageLayout: "split",
    nickname: "",
    avatar: "",
    // 思考节点默认显示（关闭仅隐藏时间线节点，不删数据）
    showThinking: true,
    avatarImage: "",
    // 通知默认关闭全局开关（不打扰）；单场景勾选保留（全局开启时按场景决定）
    notifications: { enabled: false, replyDone: true, engineError: false, permissionPending: false, subtaskDone: false },
    agentModelOverrides: {},
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
    /** moonshotai-cn 条目无 baseUrl/model（模型固定 kimi-k3），可选保证类型兼容 */
    baseUrl?: string;
    model?: string;
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

  // ── 多模态 provider（moonshotai-cn/kimi-k3，制图师 VISION 槽位）──
  const kimiApiKey = ref("");

  /** 保存制图师多模态 key（moonshotai-cn 槽位；重启由主进程按 key 是否变化决定）
   *  restart=true 仅设置页「保存」按钮传——key 首次保存/变化后重启 serve 使 provider 生效 */
  async function saveKimiKey(restart = false) {
    providerConfigs.value["moonshotai-cn"] = { apiKey: kimiApiKey.value };
    try { await saveProviderConfig("moonshotai-cn", kimiApiKey.value, "", "", restart); } catch { /* 后台静默 */ }
  }

  /** 恢复目标 provider 的配置；无记录则清空 apiKey、用默认 baseUrl */
  function restoreConfig(id: string) {
    const saved = providerConfigs.value[id];
    if (saved) {
      apiKey.value = saved.apiKey;
      // moonshotai-cn 条目无 baseUrl/model（可选字段）——用默认值兜底，避免 undefined 写入表单
      baseUrl.value = saved.baseUrl ?? "https://api.deepseek.com";
      model.value = saved.model ?? DEEPSEEK_MODELS[0];
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
  // 消息排布/昵称/头像：ui.* 三写（localStorage + SQLite + settings.json），方案 §3.8.2 迁移补全
  const messageLayout = ref<"left" | "split">(ui.messageLayout);
  const nickname = ref(ui.nickname);
  const avatar = ref(ui.avatar);
  // 设置页重构新字段（同 ui.* 三写；notifications/agentModelOverrides 拷贝副本防共享引用）
  const showThinking = ref(ui.showThinking);
  const avatarImage = ref(ui.avatarImage);
  const notifications = ref<NotificationsConfig>({ ...ui.notifications });
  const agentModelOverrides = ref<Record<string, string>>({ ...ui.agentModelOverrides });

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
  // 默认 isolated：shared 与其他 opencode 实例同库会被 SQLite 锁竞争静默杀掉（2026-08-12 实测定案）
  const dataMode = ref<"shared" | "isolated">("isolated");
  /** 数据模式切换中（防连点锁；SettingsPanel 开关禁用 + 提示条） */
  const isRestarting = ref(false);

  /** 合并 dataMode 写 settings.json（读当前显式字段 + 新值，不覆盖文件其他字段） */
  async function persistDataMode(v: "shared" | "isolated") {
    const r = await getSettingsConfig();
    const next: Record<string, unknown> = { ...r.config, dataMode: v };
    await saveSettingsJson(JSON.stringify(next, null, 2));
  }

  // ── 轻量模型（settings.json smallModel：LOW 槽位，标题生成/会话摘要/消息润色专用）──
  // 不进 UI 偏好 watch 数组（同 dataMode 理由）：主题/语言 800ms 防抖写盘会以「当前文件字段 + 主题/语言」重建对象，
  // smallModel 混入防抖链会以旧值覆盖用户最新选择
  const smallModel = ref("");
  /** 可选值白名单（对齐设置页下拉与 settings.schema.json 枚举）：空=跟随主模型 / 两个显式模型全名 */
  const SMALL_MODEL_OPTIONS = ["", "deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro"];

  /** 合并 smallModel 写 settings.json（读当前显式字段 + 新值，不覆盖文件其他字段） */
  async function persistSmallModel(v: string) {
    const r = await getSettingsConfig();
    const next: Record<string, unknown> = { ...r.config, smallModel: v };
    await saveSettingsJson(JSON.stringify(next, null, 2));
  }

  // ── 设置页重构：子 agent 模型覆盖 / 头像图片 ──

  /**
   * 设置/删除子 agent 模型覆盖（settings.json 顶层 agentModelOverrides）。
   * model=null 删除该 agent 的覆盖（回退槽位默认）；删空后移除 key（settings.json 干净）。
   * 生效时机：写盘 → config-changed 广播 → applySettingsJson 同步；引擎侧由 syncEngineConfig 联动 applyModelAliases（阶段 1）。
   */
  async function setAgentModelOverride(agentName: string, model: string | null) {
    const next = { ...agentModelOverrides.value };
    if (model === null) delete next[agentName];
    else next[agentName] = model;
    // 先更新 ref：localStorage/SQLite 三写链由 watch 自动触发
    agentModelOverrides.value = next;
    // settings.json 合并写（agentModelOverrides 是顶层字段，不走 ui.* 防抖链——独立写避免覆盖冲突）
    const r = await getSettingsConfig();
    const cfg: Record<string, unknown> = { ...r.config };
    if (Object.keys(next).length === 0) delete cfg.agentModelOverrides;
    else cfg.agentModelOverrides = next;
    await saveSettingsJson(JSON.stringify(cfg, null, 2));
  }

  /** 选择头像图片（bridge 弹系统对话框）；成功后写 avatarImage（ui.* 三写链由 watch 自动同步） */
  async function pickAvatar(): Promise<{ ok: boolean; filename?: string }> {
    const r = await pickAvatarBridge();
    if (r.ok && r.filename) avatarImage.value = r.filename;
    return r;
  }

  /** 清除头像图片（bridge 删 avatar 目录）；成功后清空 avatarImage（回退 emoji/「我」字兜底） */
  async function clearAvatar(): Promise<{ ok: boolean }> {
    const r = await clearAvatarBridge();
    if (r.ok) avatarImage.value = "";
    return r;
  }

  // ── 引擎/预置配置（settings.json 字段；UI 补全方案 B1，生效时机=下次引擎启动）──
  /** OC 可执行文件路径（空=内置 sidecar/系统安装自动解析）；主进程 resolveOpencodeBin 优先使用 */
  const opencodePath = ref("");
  /** 引擎日志级别（DEBUG/INFO/WARN/ERROR）；spawn serve 传 --log-level */
  const logLevel = ref("INFO");
  /** 预置技能包开关（false=不加载预置 skills）；主进程 initPreset 删/补预置技能目录 */
  const presetSkillsEnabled = ref(true);
  const LOG_LEVEL_OPTIONS = ["DEBUG", "INFO", "WARN", "ERROR"];

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
      baseUrl.value = saved.baseUrl ?? "https://api.deepseek.com";
      model.value = saved.model ?? DEEPSEEK_MODELS[0];
    }
    // 恢复制图师多模态 key（moonshotai-cn 条目；老文件无此条目 → 保持空，制图师不可用直至用户填写）
    const kimiSaved = providerConfigs.value["moonshotai-cn"];
    if (kimiSaved) kimiApiKey.value = kimiSaved.apiKey;
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
    // 轻量模型（LOW 槽位）：settings.json 显式字段；白名单外/缺失保持当前值（对齐 schema 枚举）
    if (typeof config["smallModel"] === "string" && SMALL_MODEL_OPTIONS.includes(config["smallModel"])) smallModel.value = config["smallModel"];
    // ── B1 补全：引擎/预置字段（schema 定义但 UI 未接；settings.json 权威，白名单外/缺失保持当前值）──
    if (config["ui.messageLayout"] === "left" || config["ui.messageLayout"] === "split") messageLayout.value = config["ui.messageLayout"];
    if (typeof config["ui.nickname"] === "string") nickname.value = config["ui.nickname"];
    if (typeof config["ui.avatar"] === "string") avatar.value = config["ui.avatar"];
    if (typeof config["engine.opencodePath"] === "string") opencodePath.value = config["engine.opencodePath"];
    if (typeof config["engine.logLevel"] === "string" && LOG_LEVEL_OPTIONS.includes(config["engine.logLevel"])) logLevel.value = config["engine.logLevel"];
    if (typeof config["preset.skills.enabled"] === "boolean") presetSkillsEnabled.value = config["preset.skills.enabled"];
    // 设置页重构新字段（ui.* 三写链同步）：
    // 思考节点开关（布尔白名单，非法/缺失保持当前值）
    if (typeof config["ui.showThinking"] === "boolean") showThinking.value = config["ui.showThinking"];
    // 图片头像文件名（空=emoji 兜底）
    if (typeof config["ui.avatarImage"] === "string") avatarImage.value = config["ui.avatarImage"];
    // 通知场景（config-changed 广播可能只带部分子项——缺失子项保留当前值）
    const notif = config["ui.notifications"];
    if (notif && typeof notif === "object" && !Array.isArray(notif)) {
      const n = notif as Record<string, unknown>;
      notifications.value = {
        enabled: typeof n.enabled === "boolean" ? n.enabled : notifications.value.enabled,
        replyDone: typeof n.replyDone === "boolean" ? n.replyDone : notifications.value.replyDone,
        engineError: typeof n.engineError === "boolean" ? n.engineError : notifications.value.engineError,
        permissionPending: typeof n.permissionPending === "boolean" ? n.permissionPending : notifications.value.permissionPending,
        subtaskDone: typeof n.subtaskDone === "boolean" ? n.subtaskDone : notifications.value.subtaskDone,
      };
    }
    // 子 agent 模型覆盖（对象白名单：仅保留字符串值；非字符串条目丢弃——非法覆盖值由 applyModelAliases 白名单兜底）
    const overrides = config["agentModelOverrides"];
    if (overrides && typeof overrides === "object" && !Array.isArray(overrides)) {
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(overrides)) {
        if (typeof v === "string") next[k] = v;
      }
      agentModelOverrides.value = next;
    }
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

  // 制图师多模态 key → 自动写 SQLite（500ms 防抖；restart=false——重启由设置页「保存」按钮显式触发）
  let kimiSaveTimer: ReturnType<typeof setTimeout> | null = null;
  watch(kimiApiKey, () => {
    if (kimiSaveTimer) clearTimeout(kimiSaveTimer);
    kimiSaveTimer = setTimeout(() => saveKimiKey(false), 500);
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

  // UI 偏好变更 → 写 localStorage（B1 补 messageLayout/nickname/avatar；设置页重构补 showThinking/avatarImage/notifications/agentModelOverrides）
  watch([planMode, autoMode, permissionMode, effort, theme, locale, fontSize, currentAgent, messageLayout, nickname, avatar, showThinking, avatarImage, notifications, agentModelOverrides], () => {
    const s: UiSettings = {
      planMode: planMode.value,
      autoMode: autoMode.value,
      permissionMode: permissionMode.value,
      effort: effort.value,
      currentAgent: currentAgent.value,
      theme: theme.value,
      locale: locale.value,
      fontSize: fontSize.value,
      messageLayout: messageLayout.value,
      nickname: nickname.value,
      avatar: avatar.value,
      showThinking: showThinking.value,
      avatarImage: avatarImage.value,
      notifications: { ...notifications.value },
      agentModelOverrides: { ...agentModelOverrides.value },
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  }, { deep: true });

  // UI 偏好变更 → 写 SQLite（500ms 防抖，不受 Tauri identifier 变更影响）
  let uiDbTimer: ReturnType<typeof setTimeout> | null = null;
  watch(
    [optimizeApiUrl, theme, locale, fontSize, planMode, autoMode, permissionMode, effort, cwd, recentWorkspaces, contextLimit, currentAgent, messageLayout, nickname, avatar, showThinking, avatarImage, notifications, agentModelOverrides],
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
          messageLayout: messageLayout.value,
          nickname: nickname.value,
          avatar: avatar.value,
          showThinking: showThinking.value,
          avatarImage: avatarImage.value,
          notifications: { ...notifications.value },
          agentModelOverrides: { ...agentModelOverrides.value },
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

  // ── 主题/语言/消息排布/昵称/头像同步写 settings.json（高级源）──
  // 根因：settings.json 不存在时 loadSettings 返回默认值（ui.theme=dark），applySettingsJson 把它当显式配置覆盖表单
  // 修复：①默认态（exists=false）不覆盖表单 ②用户显式切换主题/语言 → 写 settings.json（之后启动以文件为准）
  // 循环防护：写盘 → config-changed 广播 → applySettingsJson 同值 → watch 不触发（值未变），无死循环
  // B1 扩展：messageLayout/nickname/avatar 并入同一防抖链（theme=system 时只写 ui 三字段，不写 theme/locale）
  // 设置页重构扩展：showThinking/avatarImage/notifications 并入同链（notifications 对象需 deep 监听嵌套子项变化）
  let themeSyncTimer: ReturnType<typeof setTimeout> | null = null;
  watch([theme, locale, messageLayout, nickname, avatar, showThinking, avatarImage, notifications], () => {
    if (themeSyncTimer) clearTimeout(themeSyncTimer);
    // 防抖：连续切换只写一次（saveSettings 会触发引擎联动判断，但纯 UI 项不改 opencode.json）
    themeSyncTimer = setTimeout(() => {
      getSettingsConfig()
        .then((r) => {
          const next: Record<string, unknown> = { ...r.config };
          // system 不在 settings.json 枚举（schema 只有 dark/light），跳过 theme/locale 写入
          if (theme.value === "dark" || theme.value === "light") next["ui.theme"] = theme.value;
          if (locale.value === "zh" || locale.value === "en") next["ui.language"] = locale.value;
          next["ui.messageLayout"] = messageLayout.value;
          next["ui.nickname"] = nickname.value;
          next["ui.avatar"] = avatar.value;
          next["ui.showThinking"] = showThinking.value;
          next["ui.avatarImage"] = avatarImage.value;
          next["ui.notifications"] = { ...notifications.value };
          saveSettingsJson(JSON.stringify(next, null, 2)).catch(() => {
            // 写失败不阻断（settings.json 写入失败仍可运行，仅配置重启不恢复）
            console.error("[settings] 主题同步写 settings.json 失败");
          });
        })
        .catch(() => {});
    }, 800);
  }, { deep: true });

  // ── 引擎/预置字段变更 → 写 settings.json（生效时机=下次引擎启动，注释于设置页 UI）──
  // 与 ui 三字段分开防抖链：引擎字段变更触发 engineSnapshot 联动判断（写 opencode.json），混入会污染
  // 注意：三字段必须合并为一次写（并发多次 saveSettingsJson 会互相覆盖字段——读取-合并-写盘非原子）
  let engineSettingTimer: ReturnType<typeof setTimeout> | null = null;
  watch([opencodePath, logLevel, presetSkillsEnabled], () => {
    if (engineSettingTimer) clearTimeout(engineSettingTimer);
    engineSettingTimer = setTimeout(() => {
      getSettingsConfig()
        .then((r) => {
          const next: Record<string, unknown> = {
            ...r.config,
            "engine.opencodePath": opencodePath.value,
            "engine.logLevel": logLevel.value,
            "preset.skills.enabled": presetSkillsEnabled.value,
          };
          return saveSettingsJson(JSON.stringify(next, null, 2));
        })
        .catch((err) => {
          // 写失败不阻断（配置写失败仍可运行，仅下次启动不生效）
          console.error("[settings] 引擎字段写 settings.json 失败", err);
        });
    }, 800);
  });

  return { apiKey, baseUrl, model, providerId, models, planMode, autoMode, permissionMode, effort, modelVariants, setModelVariants, currentAgent, theme, locale, fontSize, messageLayout, nickname, avatar, showThinking, avatarImage, notifications, agentModelOverrides, setAgentModelOverride, pickAvatar, clearAvatar, optimizeApiUrl, contextLimit, settingsFileExists, saveCurrentConfig, restoreConfig, kimiApiKey, saveKimiKey, cwd, recentWorkspaces, addRecentWorkspace, removeRecentWorkspace, initFromDb, applySettingsJson, onboardingDismissed, markOnboardingDismissed, resetOnboarding, windowInitCwd, dataMode, isRestarting, setDataMode, smallModel, persistSmallModel, opencodePath, logLevel, presetSkillsEnabled, LOG_LEVEL_OPTIONS };
});
