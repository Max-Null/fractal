// electron-bridge.ts：渲染进程桥——替代原 tauri-bridge（Electron 版）
// 分类：
//   A 类：本地能力 → 主进程 IPC 真实实现（fs/git/settings/logs/dialog）
//   B 类：引擎相关 → 主进程 IPC 真实实现（阶段 4 接入 serve）
// 函数签名与类型定义与原 tauri-bridge.ts 完全同名，保证调用点仅需替换 import 路径。

/** IPC invoke 统一入口：经 preload 暴露的 window.electronBridge */
async function invoke<T>(channel: string, args?: Record<string, unknown>): Promise<T> {
  // preload 类型返回 unknown，此处按通道约定断言为目标类型
  return window.electronBridge.invoke(channel, args) as Promise<T>
}

export interface StreamEvent {
  type: string;
  session_id?: string;
  text: string;
  thinking: string;
  tool_use?: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>;
  /** CC content 块原始顺序（text/thinking/tool_use 交替），用于按时间线渲染 */
  content_blocks?: Array<{
    type: string;
    text?: string;
    thinking?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  }>;
  control_request?: {
    subtype: string;
    tool_name?: string;
    tool_input: Record<string, unknown>;
    request_id?: string;
    /** permission.asked 的免审批建议（通配符，如 ["echo *"]）——前端「总是允许」展示 */
    always?: string[];
    /** question.asked 的问题列表（subtype='question' 时）——提问弹窗渲染 */
    questions?: Array<{
      question: string;
      header?: string;
      options?: Array<{ label: string; description?: string }>;
      multiple?: boolean;
    }>;
  };
  /** serve todo.updated → 待办数据（type='todo' 时；status: pending|in_progress|completed|cancelled） */
  todos?: Array<{ content: string; status: string; priority: string }>;
  duration_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
  is_final: boolean;
  error?: string;
  /** 工具执行结果（从 user 事件中提取） */
  tool_results?: Array<{
    tool_use_id: string;
    content: string;
    is_error?: boolean;
  }>;
}

export interface SendOptions {
  planMode?: boolean;
  autoMode?: boolean;
  permissionMode?: string;
  /** 思考强度 variant（模型 variant 名，如 low/high/max；空串/缺省不传——模型无 variants 时留空） */
  variant?: string;
  /** Model name (e.g. deepseek-v4-pro[1M]) */
  model?: string;
  /** 主 agent（双星/build/plan），透传给引擎 promptAsync.agent */
  agent?: string;
  /** File paths to attach (parent dirs are added via --add-dir) */
  filePaths?: string[];
  /** 附件（FilePart 链路 P6）：path 绝对路径 + name 展示名，随消息一起发送给引擎 */
  attachments?: Array<{ path: string; name: string }>;
  /** Working directory (overrides session cwd, used when workspace changes) */
  cwd?: string;
}

export interface SessionData {
  id: string;
  title: string;
  cli_session_id: string | null;
  cwd: string;
  /** serve 原生字段：会话绑定的项目目录（SDK Session.directory；cwd 是旧别名——serve 实际只返回 directory） */
  directory?: string;
  model: string;
  status: string;
  mode: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  total_tokens: number | null;
  total_cost: number | null;
}

export interface MessageData {
  id: string;
  session_id: string;
  role: string;
  content: string;
  token_usage: string;
  created_at: string;
}

export interface ConnectionTestResult {
  cc: string;
  chat: string | null;
}

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
}

export interface DescriptionItem {
  item_type: string;
  name: string;
  desc_en?: string | null;
  desc_zh?: string | null;
}

export interface GitFile {
  path: string;
  status: "staged" | "modified" | "untracked";
}

export interface GitStatus {
  branch: string;
  staged: GitFile[];
  modified: GitFile[];
  untracked: GitFile[];
}

/** 文件选择对话框参数（tauri plugin-dialog 的 open 兼容形状） */
export interface OpenDialogOptions {
  directory?: boolean;
  multiple?: boolean;
  title?: string;
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}

/** 文件保存对话框参数（tauri plugin-dialog 的 save 兼容形状） */
export interface SaveDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}

/**
 * Emitted by the main process when the OC serve engine process exits.
 */
export interface ProcessExitedEvent {
  session_id: string;
  exit_code: number | null;
  success: boolean;
}

// ══════════════════════════════════════════════════════════════════
// A 类：本地能力 → 主进程 IPC 真实实现
// ══════════════════════════════════════════════════════════════════

// ── 文件系统 ──

export async function listDir(path: string): Promise<FileEntry[]> {
  return invoke("fs:listDir", { path });
}

export async function readFileContent(path: string): Promise<string> {
  return invoke("fs:readFileContent", { path });
}

export async function writeFile(path: string, content: string): Promise<void> {
  return invoke("fs:writeFile", { path, content });
}

/** 保存文件内容（无路径限制，供编辑保存使用） */
export async function saveFileContent(path: string, content: string): Promise<void> {
  return invoke("fs:saveFileContent", { path, content });
}

/** 删除文件或目录 */
export async function deleteFile(path: string): Promise<void> {
  return invoke("fs:deleteFile", { path });
}

/** 重命名文件，返回新路径 */
export async function renameFile(path: string, newName: string): Promise<string> {
  return invoke("fs:renameFile", { path, newName });
}

/** 移动文件到目标目录，返回新路径 */
export async function moveFile(path: string, destDir: string): Promise<string> {
  return invoke("fs:moveFile", { path, destDir });
}

/** 复制文件到目标目录，返回新路径 */
export async function copyFile(path: string, destDir: string): Promise<string> {
  return invoke("fs:copyFile", { path, destDir });
}

/** 创建目录 */
export async function createDir(path: string): Promise<void> {
  return invoke("fs:createDir", { path });
}

/** Read a file as base64-encoded string (for image thumbnails) */
export async function readFileBase64(path: string): Promise<string> {
  return invoke("fs:readFileBase64", { path });
}

/** 工作区根目录（阶段 2 返回用户主目录，阶段 4 由 serve 工作区决定） */
export async function getWorkspaceRoot(): Promise<string> {
  return invoke("fs:getWorkspaceRoot");
}

export async function revealInExplorer(path: string): Promise<void> {
  return invoke("fs:revealInExplorer", { path });
}

// ── Git（主进程用 git CLI 执行）──

export async function gitStatus(repoPath: string): Promise<GitStatus> {
  return invoke("git:status", { repoPath });
}

export async function gitDiff(repoPath: string, file: string, staged?: boolean): Promise<string> {
  return invoke("git:diff", { repoPath, file, staged: staged ?? false });
}

export async function gitStage(repoPath: string, files: string[]): Promise<void> {
  return invoke("git:stage", { repoPath, files });
}

export async function gitUnstage(repoPath: string, files: string[]): Promise<void> {
  return invoke("git:unstage", { repoPath, files });
}

export async function gitCommit(repoPath: string, message: string, amend?: boolean): Promise<string> {
  return invoke("git:commit", { repoPath, message, amend: amend ?? false });
}

export async function gitPush(repoPath: string): Promise<void> {
  return invoke("git:push", { repoPath });
}

// ── 设置持久化（JSON 文件，存 app.getPath('userData')）──

/** 保存前端 UI 设置（JSON blob） */
export async function saveUiSettings(json: string): Promise<void> {
  return invoke("settings:saveUiSettings", { json });
}

/** 加载前端 UI 设置，无记录返回 "{}" */
export async function loadUiSettings(): Promise<string> {
  return invoke("settings:loadUiSettings");
}

/** 保存单个 provider 配置，切换前调用；restart=true 时主进程会重启 serve（用户主动保存，非 watch 自动保存） */
export async function saveProviderConfig(
  providerId: string, apiKey: string, baseUrl: string, model: string, restart = false,
): Promise<void> {
  return invoke("settings:saveProviderConfig", { providerId, apiKey, baseUrl, model, restart });
}

/** 加载所有已保存的 provider 配置 */
export async function loadProviderConfigs(): Promise<Record<string, { apiKey: string; baseUrl: string; model: string }>> {
  return invoke("settings:loadProviderConfigs");
}

// ── settings.json 配置体系（阶段 6，方案 3.8）：类 VSCode settings.json + agent 可自检自改 ──

export interface SettingsJsonConfig {
  config: Record<string, unknown>;
  warnings: string[];
  jsoncText: string;
  /** settings.json 是否真实存在于磁盘——默认态（不存在）时前端不把默认值当显式配置（主题持久化依赖） */
  exists?: boolean;
}

export interface SaveSettingsResult {
  ok: boolean;
  warnings: string[];
}

/** 获取当前生效配置（含 JSONC 原文 + 校验 warnings）——SettingsJsonEditor 加载用 */
export async function getSettingsConfig(): Promise<SettingsJsonConfig> {
  return invoke<SettingsJsonConfig>("settings:getConfig", {});
}

/** 保存 settings.json（JSONC 文本；主进程写盘 + 校验 + 引擎联动），返回校验 warnings */
export async function saveSettingsJson(jsoncText: string): Promise<SaveSettingsResult> {
  return invoke<SaveSettingsResult>("settings:saveSettings", { jsoncText });
}

/** 获取 settings.schema.json（编辑器 schema 提示用） */
export async function getSettingsSchema(): Promise<Record<string, unknown>> {
  return invoke<Record<string, unknown>>("settings:getSchema", {});
}

/** config-changed 广播载荷：config = settings.json 显式字段；exists = 文件是否真实存在于磁盘（默认态区分） */
export interface ConfigChangedPayload {
  config: Record<string, unknown>;
  warnings: string[];
  exists?: boolean;
}

/** 订阅 settings.json 变更广播（主进程 fs.watch → config-changed），返回取消订阅函数 */
export function onConfigChanged(cb: (payload: ConfigChangedPayload) => void): () => void {
  return window.electronBridge.on("config-changed", (data) => cb(data as ConfigChangedPayload));
}

// ── 会话日志持久化 ──

/** 持久化会话 debug 日志 */
export async function saveSessionDebugLog(sessionId: string, linesJson: string): Promise<void> {
  return invoke("logs:saveSessionDebugLog", { sessionId, linesJson });
}

/** 读取 serve 引擎日志尾部（诊断面板「引擎日志」页；文件不存在返回空数组，lines 默认 500 尾部行） */
export async function readServeLog(lines = 500): Promise<string[]> {
  return invoke("logs:readServeLog", { lines });
}

/** 应用信息（诊断面板「复制诊断信息」打包头 + 设置页「关于」三行版本） */
export interface AppInfo {
  name: string;
  version: string;
  /** OC 引擎版本（opencode --version 首行，失败 '未知'） */
  engineVersion: string;
  /** 预置包版本（preset.json.version，读不到 '—'） */
  presetVersion: string;
}

export async function getAppInfo(): Promise<AppInfo> {
  return invoke<AppInfo>("app:getInfo");
}

/** 加载会话日志（返回 [debugJson] 或 null；stderr.json 槽位已移除——OC 无 --verbose 输出，CC 遗留机制废除） */
export async function loadSessionLogs(sessionId: string): Promise<[string | null]> {
  return invoke("logs:loadSessionLogs", { sessionId });
}

// ── 文件对话框（替代 @tauri-apps/plugin-dialog 的 open/save）──

/** 打开文件/目录选择对话框，返回路径或 null（取消） */
export async function openDialog(options?: OpenDialogOptions): Promise<string | string[] | null> {
  return invoke("dialog:openDialog", { options: options ?? {} });
}

/** 打开保存对话框，返回路径或 null（取消） */
export async function saveDialog(options?: SaveDialogOptions): Promise<string | null> {
  return invoke("dialog:saveDialog", { options: options ?? {} });
}

// ══════════════════════════════════════════════════════════════════
// B 类：引擎相关 → 主进程 IPC 真实实现（阶段 4 接入 serve）
// ══════════════════════════════════════════════════════════════════

/**
 * 将前端模型名转换为 OC 会话模型参数 {providerID, modelID}。
 * 前端 settings.model 可能是 "deepseek-v4-pro[1M]"（CC 遗留带上下文窗口标注）或 "deepseek/deepseek-v4-pro"——
 * 去 [xxx] 后缀（阶段 0 实测 S3：serve 模型无 [1M]），无 provider 前缀时默认 deepseek（serve 内置 provider id）。
 */
function toOcModel(model?: string): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  const clean = model.replace(/\[.*\]/, "").trim();
  if (!clean) return undefined;
  const idx = clean.indexOf("/");
  if (idx > 0) return { providerID: clean.slice(0, idx), modelID: clean.slice(idx + 1) };
  return { providerID: "deepseek", modelID: clean };
}

/**
 * Send a message to the backend, which forwards to OC serve (promptAsync + SSE).
 * 返回 accepted 状态（promptAsync 无 messageID，结果经 engine:event 流回）。
 */
export async function sendMessage(sessionId: string, message: string, options?: SendOptions): Promise<string> {
  const ocModel = toOcModel(options?.model);
  const r = await invoke<{ accepted: boolean }>("chat:sendMessage", {
    sessionId,
    message,
    ...(ocModel ? { model: ocModel } : {}),
    ...(options?.agent ? { agent: options.agent } : {}),
    // variant 思考强度透传（空串/缺省不传，主进程走默认）
    ...(options?.variant ? { variant: options.variant } : {}),
    // 附件透传（无附件不传，主进程走便捷调用）
    ...(options?.attachments?.length ? { attachments: options.attachments } : {}),
  });
  return r.accepted ? "" : "";
}

/**
 * Stop a running session (abort serve session; abort 端点可能 500 但事件流生效——主进程已容错).
 */
export async function stopSession(sessionId: string): Promise<void> {
  await invoke<{ stopped: boolean }>("chat:stopSession", { sessionId });
}

/**
 * 响应权限审批（permission:respond，serve 权限事件 permission.updated 的落点）。
 * response: once / always / reject（always 即当前会话记住；跨会话持久化 = oc-config.ts 写 permission 规则）
 */
export async function respondPermission(
  sessionId: string,
  permissionId: string,
  response: "once" | "always" | "reject"
): Promise<void> {
  await invoke<{ responded: boolean }>("permission:respond", { sessionId, permissionId, response });
}

/**
 * 回答引擎提问（question.asked → POST /question/{requestId}/reply）。
 * answers 按 questions 顺序排列，每项是该问题选中的 label 字符串数组（单选也包一层数组）。
 */
export async function questionReply(
  sessionId: string,
  requestId: string,
  answers: string[][]
): Promise<{ ok: boolean }> {
  return invoke<{ ok: boolean }>("question:reply", { sessionId, requestId, answers });
}

/** 拒绝引擎提问（POST /question/{requestId}/reject，无 body） */
export async function questionReject(
  sessionId: string,
  requestId: string
): Promise<{ ok: boolean }> {
  return invoke<{ ok: boolean }>("question:reject", { sessionId, requestId });
}

export async function createSession(model?: string, cwd?: string, mode?: string, title?: string): Promise<SessionData> {
  void model; void mode;
  // cwd 透传 serve query.directory：会话绑定工作区（会话跟随工作区的关键——不传则绑 serve 启动目录）
  return invoke<SessionData>("session:create", { title: title ?? undefined, cwd: cwd ?? undefined });
}

export async function listSessions(directory?: string): Promise<SessionData[]> {
  // directory 指定时只返回该工作区的会话（serve ?directory= 过滤）
  return invoke<SessionData[]>("session:list", { directory });
}

export async function deleteSession(sessionId: string): Promise<void> {
  await invoke<{ deleted: boolean }>("session:delete", { id: sessionId });
}

export async function renameSession(sessionId: string, title: string): Promise<void> {
  await invoke<SessionData>("session:rename", { id: sessionId, title });
}

export async function getSession(sessionId: string): Promise<SessionData> {
  return invoke<SessionData>("session:get", { id: sessionId });
}

/** 服务端分叉会话（OC serve session.fork）：返回新会话（标题自动追加 fork #N，阶段 0 实测 S8） */
export async function forkSession(sessionId: string, messageID?: string): Promise<SessionData> {
  return invoke<SessionData>("session:fork", {
    id: sessionId,
    ...(messageID ? { messageID } : {}),
  });
}

export async function listMessages(sessionId: string, options?: { limit?: number; before?: string }): Promise<MessageData[]> {
  // options 缺省时展开为 undefined → 与旧调用完全兼容（全量拉取）；
  // limit=50 首屏最近 N 条 / before=首条消息 id 滚动加载更早
  return invoke<MessageData[]>("message:list", { sessionId, ...options });
}

/** 测试连接：写 API Key 到 serve 隔离配置 + 验证 serve 可达，返回 {ok, message}（设置面板「测试连接」） */
export async function testConnection(apiKey: string): Promise<{ ok: boolean; message: string }> {
  return invoke<{ ok: boolean; message: string }>("engine:testConnection", { apiKey });
}

/** 刷新引擎：重启 serve 进程（右上角刷新按钮 / 数据模式切换；配置/预置包变更立即生效）。error 存在 = 重启失败（不抛） */
export async function refreshEngine(): Promise<{ ok: boolean; error?: string }> {
  return invoke<{ ok: boolean; error?: string }>("engine:refresh");
}

/** ✨ 优化输入消息：引擎临时会话润色，返回 {ok, text}（失败 ok=false，无文本） */
/** 优化消息引用（用户显式引用的上下文：选区片段 content 或附件 path） */
export interface PolishRef {
  label: string;
  content?: string;
  path?: string;
}

export async function polishMessage(text: string, refs?: PolishRef[]): Promise<{ ok: boolean; text?: string }> {
  // refs 为用户显式引用的背景上下文（chips：选区/附件），主进程读文件内容拼入润色指令
  return invoke<{ ok: boolean; text?: string }>("ai:polishMessage", { text, refs });
}

/**
 * 拉取指定模型的可用思考强度 variants（如 deepseek-v4-flash → ['low','high','max']）。
 * modelId 兼容 settings.model 存储格式（带 [1M] 标注/provider 前缀），主进程按去标注后的模型 id 匹配。
 */
export async function loadModelVariants(modelId: string): Promise<string[]> {
  const clean = modelId.replace(/\[.*\]/, "").trim();
  if (!clean) return [];
  return invoke<string[]>("provider:modelVariants", { modelId: clean });
}

/** 引擎状态（engine:status 广播可能早于组件监听挂载——启动竞态，挂载时主动拉一次兜底） */
export async function getEngineStatus(): Promise<{ running: boolean; baseURL?: string; port?: number }> {
  return invoke("engine:getStatus");
}

/** 压缩上下文：调 serve v2 compact 端点（命令菜单「压缩上下文」） */
export async function compactSession(sessionId: string): Promise<{ ok: boolean }> {
  return invoke<{ ok: boolean }>("session:compact", { id: sessionId });
}

// ── Approved Scenarios ──
// 阶段 4 保留桩：approved_scenarios 表是 GUI 层索引（db.ts 阶段 5 实现），
// 免审批真实生效 = oc-config.ts 把场景写入 opencode.json permission 规则（设计方案 3.5 修正）

export async function addApprovedScenario(toolName: string, pattern: string): Promise<void> {
  void toolName; void pattern;
  return Promise.resolve();
}

export async function removeApprovedScenario(toolName: string, pattern: string): Promise<void> {
  void toolName; void pattern;
  return Promise.resolve();
}

export async function listApprovedScenarios(): Promise<Array<{ tool_name: string; pattern: string }>> {
  return [];
}

/**
 * Save a message to the backend SQLite store.
 */
export async function saveMessage(
  id: string,
  sessionId: string,
  role: string,
  content: string,
  tokenUsage?: string,
): Promise<void> {
  void id; void sessionId; void role; void content; void tokenUsage;
  return Promise.resolve();
}

export async function updateMessageContent(
  messageId: string,
  sessionId: string,
  content: string,
): Promise<void> {
  void messageId; void sessionId; void content;
  return Promise.resolve();
}

export async function deleteMessagesAfter(
  messageId: string,
  sessionId: string,
): Promise<number> {
  void messageId; void sessionId;
  return Promise.resolve(0);
}

// ── 项目描述（翻译 + 缓存）──

/** 清空所有翻译缓存 */
export async function clearItemDescriptions(): Promise<void> {
  return Promise.resolve();
}

/** 只清空 MCP 描述缓存 */
export async function clearMcpDescriptions(): Promise<void> {
  return Promise.resolve();
}

/**
 * 用 DeepSeek API 为 MCP 服务器名称批量生成中文描述，缓存到 DB。
 */
export async function generateMcpDescriptions(
  names: string[],
  apiKey: string,
  baseUrl: string,
  optimizeApiUrl?: string,
): Promise<DescriptionItem[]> {
  void names; void apiKey; void baseUrl; void optimizeApiUrl;
  return [];
}

/**
 * 确保每个 item 都有中英双语描述。桩：原样返回，不做翻译。
 */
export async function ensureItemDescriptions(
  items: DescriptionItem[],
  apiKey: string,
  baseUrl: string,
  optimizeApiUrl?: string,
): Promise<DescriptionItem[]> {
  void apiKey; void baseUrl; void optimizeApiUrl;
  return items;
}

/** 检查 skill 是否已安装（阶段 4 由 serve 侧实现） */
export async function checkSkillInstalled(name: string): Promise<boolean> {
  void name;
  return false;
}

/** Check if auto mode is active in settings.json (may have been changed externally) */
export async function getAutoModeStatus(): Promise<boolean> {
  return false;
}

/**
 * 检查 OC 会话是否仍存在（分叉前预检）：session:get 成功 true / 404 false。
 * 替代原 CLI 会话检查（serve 会话即 ses_xxx，无 CLI 会话概念）。
 */
export async function checkCcSessionExists(sessionId: string): Promise<boolean> {
  try {
    await invoke<SessionData>("session:get", { id: sessionId });
    return true;
  } catch {
    return false;
  }
}

// ══════════════════════════════════════════════════════════════════
// 右侧面板数据源（阶段 6 遗留 P1-P3：记忆/计划/状态，文件监听实时刷新）
// ══════════════════════════════════════════════════════════════════

export interface MemoryEntry {
  file: string;
  title: string;
  status: "pending" | "auto" | "suggest";
  desc: string;
  preview: string;
}

export interface PlanEntry {
  file: string;
  title: string;
  currentStep: number;
  totalSteps: number;
  status: "执行中" | "已完成" | "未知";
  lastCompletedStep: string;
}

export interface PanelActivePlan {
  title: string;
  progress: string;
  lastCompletedStep: string;
}

/** 记忆列表：global=隔离全局记忆 / project=当前工作区记忆（无工作区则空） */
export async function listMemories(): Promise<{ global: MemoryEntry[]; project: MemoryEntry[] }> {
  return invoke<{ global: MemoryEntry[]; project: MemoryEntry[] }>("memory:list", {});
}

/** 确认记忆：pending → auto（主进程写回文件），返回 ok */
export async function confirmMemory(file: string): Promise<{ ok: boolean }> {
  return invoke<{ ok: boolean }>("memory:confirm", { file });
}

/** 删除记忆文件，返回 ok */
export async function removeMemory(file: string): Promise<{ ok: boolean }> {
  return invoke<{ ok: boolean }>("memory:remove", { file });
}

/** 计划列表（隔离 + 系统两目录合并）+ 当前活跃计划 */
export async function listPlans(): Promise<{ plans: PlanEntry[]; active: PanelActivePlan | null }> {
  return invoke<{ plans: PlanEntry[]; active: PanelActivePlan | null }>("plans:list", {});
}

/** Guardian 状态读取（.fractal-state.json）：文件不存在返回 { exists: false, state: null } */
export async function getStatusState(): Promise<{ exists: boolean; state: unknown }> {
  return invoke<{ exists: boolean; state: unknown }>("status:get", {});
}

/** 订阅面板数据源变更广播（主进程 fs.watch → engine:panel-update），返回取消订阅函数 */
export function onPanelUpdate(cb: (payload: { kind: "memory" | "plans" | "status" }) => void): () => void {
  return window.electronBridge.on("engine:panel-update", (data) => cb(data as { kind: "memory" | "plans" | "status" }));
}

// ══════════════════════════════════════════════════════════════════
// 多窗口（新开窗口并切到目标工作区，交互模式变更：最近工作区非当前项点击行为）
// ══════════════════════════════════════════════════════════════════

/** 新开窗口并切到目标工作区（主进程 createWindow(workspace) → 新窗口 did-finish-load 后下发 init-workspace） */
export async function openWorkspaceWindow(path: string): Promise<void> {
  return invoke("window:openWorkspace", { path });
}

/** 订阅新窗口工作区下发（主进程 createWindow(workspace) 后主动推送），返回取消订阅函数 */
export function onInitWorkspace(cb: (path: string) => void): () => void {
  return window.electronBridge.onInitWorkspace(cb);
}
