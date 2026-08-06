// electron-bridge.ts：渲染进程桥——替代 cc-gui 的 src/lib/tauri-bridge.ts（Electron 版）
// 分类：
//   A 类：本地能力 → 主进程 IPC 真实实现（fs/git/settings/logs/dialog）
//   B 类：引擎相关 → 桩实现（阶段 4 接入 serve 后替换）
//   C 类：CC 专属 → 保留签名 + 桩实现（用户指示不删除）
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
  };
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
  effort?: string;
  /** ultracode: xhigh effort + auto Workflow orchestration (harness-level, not an API param) */
  ultracode?: boolean;
  /** Model name (e.g. deepseek-v4-pro[1M]), passed to CLI via --model */
  model?: string;
  /** File paths to attach (parent dirs are added via --add-dir) */
  filePaths?: string[];
  /** Manual claude CLI path (overrides auto-detect) */
  claudePath?: string;
  /** Working directory (overrides session cwd, used when workspace changes) */
  cwd?: string;
  /** Resume a specific claude session (for forking) */
  resumeId?: string;
  /** Use --fork-session to branch from the resumed session */
  forkSession?: boolean;
}

export interface SessionCreatedEvent {
  ourId: string;
  claudeSessionId: string;
}

export interface SessionData {
  id: string;
  title: string;
  cli_session_id: string | null;
  cwd: string;
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
 * Emitted by Rust when a claude process exits.
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

/** 保存单个 provider 配置，切换前调用 */
export async function saveProviderConfig(
  providerId: string, apiKey: string, baseUrl: string, model: string,
): Promise<void> {
  return invoke("settings:saveProviderConfig", { providerId, apiKey, baseUrl, model });
}

/** 加载所有已保存的 provider 配置 */
export async function loadProviderConfigs(): Promise<Record<string, { apiKey: string; baseUrl: string; model: string }>> {
  return invoke("settings:loadProviderConfigs");
}

// ── 会话日志持久化 ──

/** 持久化会话 debug 日志 */
export async function saveSessionDebugLog(sessionId: string, linesJson: string): Promise<void> {
  return invoke("logs:saveSessionDebugLog", { sessionId, linesJson });
}

/** 持久化会话 stderr 日志 */
export async function saveSessionStderrLog(sessionId: string, linesJson: string): Promise<void> {
  return invoke("logs:saveSessionStderrLog", { sessionId, linesJson });
}

/** 加载会话日志（返回 [debugJson, stderrJson] 或 null） */
export async function loadSessionLogs(sessionId: string): Promise<[string | null, string | null]> {
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
// B 类：引擎相关 → 桩实现（阶段 4 接入 serve 后替换）
// ══════════════════════════════════════════════════════════════════

const ENGINE_NOT_READY = "引擎通道待阶段 4 接入 serve";

/**
 * Send a stdin line to a running CLI session (e.g., permission response).
 */
export async function sendStdin(sessionId: string, data: string): Promise<void> {
  throw new Error(ENGINE_NOT_READY);
}

/**
 * Send a message to the Rust backend, which spawns the Claude CLI.
 */
export async function sendMessage(sessionId: string, message: string, options?: SendOptions): Promise<string> {
  throw new Error(ENGINE_NOT_READY);
}

/**
 * Stop a running session (kill the claude process).
 */
export async function stopSession(sessionId: string): Promise<void> {
  // 桩：无运行中会话，静默成功，避免调用方（ChatPanel 等）走错误分支
  return Promise.resolve();
}

export async function createSession(model?: string, cwd?: string, mode?: string, title?: string): Promise<SessionData> {
  // 桩：session store 的 createSession 有本地 fallback，抛错触发 fallback 创建本地会话
  throw new Error(ENGINE_NOT_READY);
}

export async function listSessions(): Promise<SessionData[]> {
  return [];
}

export async function deleteSession(sessionId: string): Promise<void> {
  return Promise.resolve();
}

export async function renameSession(sessionId: string, title: string): Promise<void> {
  return Promise.resolve();
}

export async function getSession(sessionId: string): Promise<SessionData> {
  throw new Error(ENGINE_NOT_READY);
}

export async function listMessages(sessionId: string): Promise<MessageData[]> {
  return [];
}

// ── Approved Scenarios ──

export async function addApprovedScenario(toolName: string, pattern: string): Promise<void> {
  return Promise.resolve();
}

export async function removeApprovedScenario(toolName: string, pattern: string): Promise<void> {
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
  return Promise.resolve();
}

export async function updateMessageContent(
  messageId: string,
  sessionId: string,
  content: string,
): Promise<void> {
  return Promise.resolve();
}

export async function deleteMessagesAfter(
  messageId: string,
  sessionId: string,
): Promise<number> {
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
  return items;
}

/** 检查 skill 是否已安装（阶段 4 由 serve 侧实现） */
export async function checkSkillInstalled(name: string): Promise<boolean> {
  return false;
}

/** Check if auto mode is active in settings.json (may have been changed externally) */
export async function getAutoModeStatus(): Promise<boolean> {
  return false;
}

/** 检查 CC 会话是否仍存在（分叉前预检） */
export async function checkCcSessionExists(sessionId: string): Promise<boolean> {
  return false;
}

// ══════════════════════════════════════════════════════════════════
// C 类：CC 专属 → 保留签名 + 桩实现（用户指示不删除）
// ══════════════════════════════════════════════════════════════════

/**
 * Store the claude session UUID on the Rust side so subsequent
 * send_message calls can use --resume.
 */
export async function storeClaudeSession(
  ourSessionId: string,
  claudeSessionId: string
): Promise<void> {
  return Promise.resolve();
}

/**
 * Test connection to the DeepSeek API
 */
export async function connectLLM(
  apiKey: string,
  baseUrl: string,
  model: string,
  providerId: string,
  optimizeApiUrl?: string,
): Promise<ConnectionTestResult> {
  // 桩：返回空连接结果，UI 显示未连接（SettingsPanel 有 try/catch）
  return { cc: "", chat: null };
}

/** 禅模式：直接调 LLM chat/completions API（SSE 流式），绕过 CC CLI */
export async function zenSendMessage(
  sessionId: string,
  message: string,
  apiKey: string,
  chatUrl: string,
  model: string,
): Promise<string> {
  throw new Error(ENGINE_NOT_READY);
}

export async function getClaudeDir(): Promise<string> {
  // 桩：返回空串，调用方 try/catch 后进入未安装分支（CC 专属 UI 保留）
  return "";
}

/** 返回 claude CLI 的自动检测路径（不依赖用户手动配置） */
export async function resolveClaudePath(): Promise<string> {
  return "";
}

/** 一键安装 Claude Code CLI，返回退出码（0 成功） */
export async function installClaudeCode(): Promise<number> {
  // 桩：返回 1（失败），调用方展示安装失败（CC 专属 UI 保留）
  return 1;
}

/** 用 LLM 优化用户输入的提示词。桩：原样返回，不优化 */
export async function optimizePrompt(apiKey: string, baseUrl: string, prompt: string, optimizeUrl?: string): Promise<string> {
  return prompt;
}

/** 从 ~/.claude/settings.json 读取配置。桩：返回默认空配置 */
export async function getClaudeSettings(): Promise<{
  api_key: string; base_url: string; model: string; effort: string; permission_mode: string;
  provider_id: string; models: string[];
}> {
  return {
    api_key: "",
    base_url: "https://api.deepseek.com",
    model: "deepseek-v4-pro[1M]",
    effort: "high",
    permission_mode: "default",
    provider_id: "deepseek",
    models: [],
  };
}

/** 将配置写入 ~/.claude/settings.json。桩：静默成功 */
export async function setClaudeSettings(
  apiKey: string, baseUrl: string, model: string, effort: string, permissionMode: string,
  providerId: string,
): Promise<void> {
  return Promise.resolve();
}
