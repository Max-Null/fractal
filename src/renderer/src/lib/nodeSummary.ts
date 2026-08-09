// 时间线节点梗概提取纯函数（D10 收起态梗概；3b 渲染层 NodeCard 使用）
// 全部导出函数为纯函数——同一输入恒同输出，便于单测与 computed 缓存

/** 提取输入中可读首行：字符串直接取首行；对象取 file_path/filePath/command/query/path 字段 */
function firstLineOf(input: unknown): string {
  if (typeof input === "string") return input.split("\n")[0];
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const candidate = obj.file_path ?? obj.filePath ?? obj.command ?? obj.query ?? obj.path;
    if (typeof candidate === "string") return candidate.split("\n")[0];
  }
  return "";
}

/** glob 匹配模式：patterns 数组首项（serve 实测 glob 入参为 patterns 数组）→ pattern 单值兜底 */
function globPatternOf(input: unknown): string {
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const patterns = obj.patterns;
    if (Array.isArray(patterns) && patterns.length > 0 && typeof patterns[0] === "string") {
      return patterns[0].split("\n")[0];
    }
    if (typeof obj.pattern === "string") return obj.pattern.split("\n")[0];
  }
  return "";
}

/** grep 匹配模式：pattern 字段（grep 工具必填；path/include 次要不展示） */
function grepPatternOf(input: unknown): string {
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (typeof obj.pattern === "string") return obj.pattern.split("\n")[0];
  }
  return "";
}

/** question 问题文本：questions 数组首项 question 字段（AskUserQuestion 工具，无 questions 则取 description） */
function questionTextOf(input: unknown): string {
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const questions = obj.questions;
    if (Array.isArray(questions) && questions.length > 0) {
      const first = questions[0] as Record<string, unknown> | undefined;
      if (first && typeof first.question === "string") return first.question.split("\n")[0];
    }
    if (typeof obj.description === "string") return obj.description.split("\n")[0];
  }
  return "";
}

/** todowrite 进行中任务：优先 in_progress 项，兜底首个任务；无任务/无内容 → 空串 */
function currentTodoTask(input?: unknown): string {
  const todos = (input as { todos?: Array<{ content?: unknown; status?: unknown }> } | undefined)?.todos;
  if (!Array.isArray(todos) || todos.length === 0) return "";
  const inProgress = todos.find((t) => t?.status === "in_progress");
  const target = inProgress ?? todos[0];
  const content = target && typeof target.content === "string" ? target.content : "";
  return content.slice(0, 60);
}

/**
 * 工具梗概（D10）：工具名小写规范化判定——serve 实测 part.tool 是小写（如 "task"），
 * 前端历史数据却可能存大写（Read/Bash），统一转小写再匹配。
 */
export function toolSummary(name: string, input?: unknown): string {
  switch (String(name).toLowerCase()) {
    case "read":
    case "edit":
      // 文件路径首行
      return firstLineOf(input).slice(0, 60);
    case "bash":
      // 命令首行
      return firstLineOf(input).slice(0, 60);
    case "websearch":
      // 查询词
      return firstLineOf(input).slice(0, 60);
    case "glob":
      // 匹配模式（patterns 数组首项 / pattern 单值）
      return globPatternOf(input).slice(0, 60);
    case "grep":
      // 匹配模式（grep 工具必填 pattern 字段；2026-08-10 补——此前收起态无梗概）
      return grepPatternOf(input).slice(0, 60);
    case "list":
      // 目录路径首行
      return firstLineOf(input).slice(0, 60);
    case "lsp":
      // LSP 查询目标（query / 文件路径）
      return firstLineOf(input).slice(0, 60);
    case "question":
      // AskUserQuestion：首个问题文本（无 questions 兜底 description）
      return questionTextOf(input).slice(0, 60);
    case "compress":
      // 压缩摘要（无 input 依赖，固定文案）
      return "已压缩历史消息（保留最近 N 轮）";
    case "todowrite":
      // 当前进行中任务（D10：仅进行中项，无则取首项）
      return `正在：${currentTodoTask(input)}`;
    default:
      // 未知工具无梗概（节点标题显示工具名兜底）
      return "";
  }
}

/** 思考梗概（D10）：前 60 字符（收起态一行展示，超出截断） */
export function thinkingSummary(text: string): string {
  return String(text).slice(0, 60);
}

/** 子智能体文字图标（D18）：角色名 → 标识字（侦查兵→侦、工匠→工、参谋→谋、军师→军、制图师→制、助理→助）。
 * 注意「参谋」标识字为「谋」而非首字「参」——色板键按职能字定义，用表匹配保证 agentChar/agentColor 一致。
 * 未知角色（英文 agent type 等）→ '?' */
const ROLE_CHARS: Array<[string, string]> = [
  ["侦查兵", "侦"],
  ["工匠", "工"],
  ["参谋", "谋"],
  ["军师", "军"],
  ["制图师", "制"],
  ["助理", "助"],
];

export function agentChar(agentName: string): string {
  const s = String(agentName ?? "").trim();
  if (!s) return "?";
  for (const [role, ch] of ROLE_CHARS) {
    // 包含匹配：agent 名可能带 agent type 前缀/后缀（如 "pr-review-toolkit:侦查兵"）
    if (s.includes(role)) return ch;
  }
  return "?";
}

/** 6 角色色板（D18）：按首字映射；未知角色 → 紫（与侦查兵同色兜底） */
const ROLE_COLORS: Record<string, string> = {
  侦: "#7c3aed",
  工: "#2563eb",
  谋: "#0d9488",
  军: "#9333ea",
  制: "#0891b2",
  助: "#4f46e5",
};

/** 子智能体颜色（D18）：按角色首字取色；未知 → #7c3aed */
export function agentColor(agentName: string): string {
  return ROLE_COLORS[agentChar(agentName)] ?? "#7c3aed";
}
