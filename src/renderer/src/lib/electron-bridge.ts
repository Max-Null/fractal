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

/** 渲染层 console 桥（main.ts 拦截 console 后调用）：单向上报主进程，仅调试模式落盘 renderer.log。
 * 正常模式主进程静默丢弃——高频 console 不拖慢使用 */
export function debugLog(level: "log" | "warn" | "error" | "debug" | "info", msg: string): void {
  try {
    window.electronBridge?.debugLog(level, msg)
  } catch {
    // 桥不可用（非 electron 环境/初始化前）静默——console 桥是附加能力，不影响主流程
  }
}

export interface StreamEvent {
  type: string;
  session_id?: string;
  text: string;
  thinking: string;
  /** 会话标题自动更新（serve 首条消息后重命名；主进程 session.updated 识别） */
  title?: string;
  /** 思考耗时 ms（serve ReasoningPart.time.end - start；2026-08-10 补——流式 thinking 节点显示用） */
  thinkingDurationMs?: number;
  tool_use?: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
    /** 工具开始执行时间戳（serve ToolState.time.start 透传；流式客户端计时兜底） */
    startedAt?: number;
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
  /** 回合缓存命中输入 tokens（消息级，events.ts session.idle 下发；弹窗「当前上下文占用」= input+cacheRead+cacheWrite） */
  cache_read_tokens?: number;
  /** 回合缓存写入 tokens（消息级，同上） */
  cache_write_tokens?: number;
  cost_usd?: number;
  /** 回合人民币成本（元）——主进程本地价格表计算下发（events.ts session.idle），替代美元 cost_usd */
  cost_cny?: number;
  is_final: boolean;
  /** 错误文本（type='error' 会话错误；subtask kind='error' 时携带子 agent 失败原因，主进程 events.ts 提取） */
  error?: string;
  /** 工具执行结果（从 user 事件中提取） */
  tool_results?: Array<{
    tool_use_id: string;
    content: string;
    is_error?: boolean;
    /** 工具执行耗时 ms（serve ToolState.time 透传；流式客户端计时兜底） */
    executionDurationMs?: number;
  }>;
  /** 子会话活动（type='subtask' 时；serve 广播的子 agent 会话事件，主进程 events.ts 识别） */
  subId?: string;
  parentId?: string;
  agent?: string;
  kind?: "created" | "delta" | "part" | "idle" | "error";
  part?: { type: string; tool?: string; state?: string; text?: string };
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
  /** 子会话归属的主会话 id（serve Session.parentID；主会话无此字段）——历史子任务归属数据源 */
  parentId?: string;
  /** 子会话 agent 名（serve 会话列表实测返回；SDK 类型未生成） */
  agent?: string;
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

/** 加载所有已保存的 provider 配置；moonshotai-cn 条目仅含 apiKey（无 baseUrl/model），字段可选 */
export async function loadProviderConfigs(): Promise<Record<string, { apiKey: string; baseUrl?: string; model?: string }>> {
  return invoke("settings:loadProviderConfigs");
}

/** DeepSeek 余额查询结果（deepseek:getBalance）——ok=false 时 message 承载失败原因 */
export interface DeepSeekBalanceResult {
  ok: boolean;
  message?: string;
  isAvailable?: boolean;
  balanceInfos?: Array<{ currency: string; totalBalance: string }>;
}

/** 查询 DeepSeek 账户余额（主进程读 API Key，渲染进程不接触密钥） */
export async function getBalance(): Promise<DeepSeekBalanceResult> {
  return invoke("deepseek:getBalance");
}

/** 查询 Kimi 多模态账户余额（与 getBalance 对称；主进程读 moonshotai-cn 槽位 key） */
export async function getKimiBalance(): Promise<DeepSeekBalanceResult> {
  return invoke("kimi:getBalance");
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

/** 读取渲染层 console 桥日志尾部（诊断面板「控制台日志」页；仅调试模式有内容） */
export async function readRendererLog(lines = 500): Promise<string[]> {
  return invoke("logs:readRendererLog", { lines });
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

/** HTML 转 PDF（主进程隐藏窗口 printToPDF）：ok=false 且无 error = 用户取消保存对话框，前端静默 */
export async function htmlToPdf(path: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  return invoke("pdf:htmlToPdf", { path });
}

// ── 头像图片（avatar:pick/clear/getPath；图片存 <userData>/avatar/avatar.{ext}，统一命名覆盖旧图）──

/** 选择头像图片（主进程弹系统对话框，仅接受 png/jpg/jpeg/webp）；ok=false=取消或扩展名非法，filename=avatar.{ext} */
export async function pickAvatar(): Promise<{ ok: boolean; filename?: string }> {
  return invoke<{ ok: boolean; filename?: string }>("avatar:pick");
}

/** 清除已选头像（主进程删除 avatar 目录；前端随后清空 avatarImage 回退 emoji 兜底） */
export async function clearAvatar(): Promise<{ ok: boolean }> {
  return invoke<{ ok: boolean }>("avatar:clear");
}

/** 头像存储目录（<userData>/avatar；渲染 avatarImage 时拼 file:// 前缀的路径来源） */
export async function getAvatarPath(): Promise<string> {
  return invoke<string>("avatar:getPath");
}

/** 系统通知（主进程 Notification；异常由主进程吞掉，不阻断渲染主流程） */
export async function showNotification(title: string, body: string): Promise<void> {
  return invoke<void>("notification:show", { title, body });
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

/**
 * 通知主进程当前活跃会话（子会话识别依赖：events.ts 用 sessionID ≠ 活跃会话 区分子任务事件）。
 * fire-and-forget：切会话是高频操作，不等主进程确认；失败静默（仅影响子任务识别精度，不影响主链路）。
 */
export function setActiveSession(sessionId: string): void {
  void invoke<{ ok: boolean }>("session:setActive", { id: sessionId }).catch(() => {});
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

/** 测试 Kimi 多模态 Key：GET api.moonshot.cn/v1/models 轻量校验（无 serve 依赖），返回 {ok, message}（设置面板「测试连接」） */
export async function testKimiConnection(apiKey: string): Promise<{ ok: boolean; message: string }> {
  return invoke<{ ok: boolean; message: string }>("engine:testKimiConnection", { apiKey });
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

/** 引擎状态（engine:status 广播 / engine:getStatus 拉取共用） */
export interface EngineStatus {
  running: boolean;
  baseURL?: string;
  port?: number;
}

/** 引擎状态（engine:status 广播可能早于组件监听挂载——启动竞态，挂载时主动拉一次兜底） */
export async function getEngineStatus(): Promise<EngineStatus> {
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
): Promise<DescriptionItem[]> {
  void names; void apiKey; void baseUrl;
  return [];
}

/**
 * 确保每个 item 都有中英双语描述。桩：原样返回，不做翻译。
 */
export async function ensureItemDescriptions(
  items: DescriptionItem[],
  apiKey: string,
  baseUrl: string,
): Promise<DescriptionItem[]> {
  void apiKey; void baseUrl;
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
  /** 文件最后修改时间（mtimeMs，面板按此倒序显示） */
  updatedAt: number;
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

/** 记忆详情：元数据 + 全文（详情弹窗数据源） */
export interface MemoryDetail extends MemoryEntry {
  content: string;
}

/** 读取单条记忆全文（路径越界由主进程校验） */
export async function readMemory(file: string): Promise<MemoryDetail> {
  return invoke<MemoryDetail>("memory:read", { file });
}

/** 删除记忆文件，返回 ok */
export async function removeMemory(file: string): Promise<{ ok: boolean }> {
  return invoke<{ ok: boolean }>("memory:remove", { file });
}

/** 计划列表（隔离 + 项目级两目录合并）+ 当前活跃计划 */
export async function listPlans(): Promise<{ plans: PlanEntry[]; active: PanelActivePlan | null }> {
  return invoke<{ plans: PlanEntry[]; active: PanelActivePlan | null }>("plans:list", {});
}

/** 计划详情：元数据 + 全文（详情弹窗数据源） */
export interface PlanDetail extends PlanEntry {
  content: string;
}

/** 读取单条计划全文（路径越界由主进程校验） */
export async function readPlan(file: string): Promise<PlanDetail> {
  return invoke<PlanDetail>("plans:read", { file });
}

/** Guardian 状态读取（.fractal-state.json）：文件不存在返回 { exists: false, state: null } */
export async function getStatusState(): Promise<{ exists: boolean; state: unknown }> {
  return invoke<{ exists: boolean; state: unknown }>("status:get", {});
}

// ── 生态面板数据（原「技能」tab）：serve 原生清单聚合（capabilities:list）──

export interface CapabilityAgent {
  name: string;
  description: string;
  mode: string;
  native: boolean;
}

export interface CapabilitySkill {
  name: string;
  description: string;
  location: string;
}

export interface CapabilityPlugin {
  name: string;
  source: string;
}

export interface CapabilityMcp {
  name: string;
  status: string;
  type: "local" | "remote" | "";
  target: string;
}

export interface CapabilityBundle {
  agents: CapabilityAgent[];
  skills: CapabilitySkill[];
  plugins: CapabilityPlugin[];
  mcp: CapabilityMcp[];
}

/** 生态清单（agent/技能/插件/MCP）：serve 运行时数据，端点失败时主进程返回空数组 */
export async function listCapabilities(): Promise<CapabilityBundle> {
  return invoke<CapabilityBundle>("capabilities:list", {});
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

/** 上报当前窗口的工作区（窗口去重需要）：主窗口创建时未登记，串行链拿到 cwd 后调用 */
export async function registerWorkspace(cwd: string): Promise<void> {
  return invoke("window:registerWorkspace", { cwd });
}

/** 订阅新窗口工作区下发（主进程 createWindow(workspace) 后主动推送），返回取消订阅函数 */
export function onInitWorkspace(cb: (path: string) => void): () => void {
  return window.electronBridge.onInitWorkspace(cb);
}

/** 打开文件预览独立窗口（主进程 openPreviewWindow → 新窗口 did-finish-load 后下发 init-preview） */
export async function openPreviewWindow(path: string): Promise<void> {
  return invoke("preview:open", { path });
}

/** 订阅预览窗口文件路径下发（主进程 openPreviewWindow 后主动推送），返回取消订阅函数 */
export function onInitPreview(cb: (path: string) => void): () => void {
  return window.electronBridge.onInitPreview(cb);
}

/** 预览独立窗口发起「发送到对话」转发：载荷经主进程转投主窗口（standalone 无会话上下文） */
export function forwardChat(payload: string): void {
  window.electronBridge?.forwardChat(payload);
}

/** 主窗口接收预览窗口转发载荷（主进程 window:forward-chat 推送），返回取消订阅函数 */
export function onForwardChat(cb: (payload: string) => void): () => void {
  return window.electronBridge.onForwardChat(cb);
}

/** 主窗口发起预览自动刷新：oc-file-changed（agent 改文件）→ 主进程广播所有预览窗口 */
export function notifyPreviewChanged(): void {
  window.electronBridge?.notifyPreviewChanged();
}

/** 预览窗口接收刷新信号（主进程 window:preview-changed 推送），返回取消订阅函数 */
export function onPreviewChanged(cb: () => void): () => void {
  return window.electronBridge.onPreviewChanged(cb);
}
