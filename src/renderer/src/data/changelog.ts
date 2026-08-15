/**
 * 版本更新日志（中英双语）。
 *
 * ## 发版时怎么做
 *
 * 1. 修改 package.json 中的版本号（version 字段）
 * 2. 在下方 `changelog` 数组头部新增一条 ChangelogEntry（version 必须与 package.json 一致）
 * 3. 同步更新 docs/变更记录.md（设置页「更新日志」展示该文件）
 *
 * 如果忘了第 2 步，弹窗不会显示——不报错、不崩溃，下次补上即可。
 */

// 相对路径：src/renderer/src/data/ 到项目根（electron-vite renderer 构建允许访问项目根）
import appPackage from "../../../../package.json";

export interface ChangelogSection {
  titleZh: string;
  titleEn: string;
  itemsZh: string[];
  itemsEn: string[];
}

export interface ChangelogEntry {
  version: string;
  date: string;
  sections: ChangelogSection[];
}

/** 当前 app 版本（与 package.json 同步） */
export const APP_VERSION: string = appPackage.version;

// 按版本降序排列（最新在第一个）
export const changelog: ChangelogEntry[] = [
  {
    version: "1.2.0",
    date: "2026-08-16",
    sections: [
      {
        titleZh: "消息与输入体验",
        titleEn: "Messaging & Input",
        itemsZh: [
          "繁忙时 Enter 行为设置：可配置 AI 繁忙时 Enter 排队等待 / 提示错误，前端排队队列 + dcp-message-id 标签剥离",
          "草稿持久化到 localStorage，重启应用不丢失",
          "草稿跟随会话：首页迁移、会话列表草稿标记、润色跨会话写回",
          "润色改直连 DeepSeek API，会话进行时也能用",
          "主动打断显示「已停止」温和提示，不再显示「错误: Aborted」",
        ],
        itemsEn: [
          "Configurable Enter behavior while AI is busy: queue up or show an error, with a frontend queue and dcp-message-id tag stripping",
          "Drafts persist to localStorage across app restarts",
          "Drafts follow sessions: home migration, draft badges in the session list, polish writes back across sessions",
          "Polish now calls the DeepSeek API directly, usable while a session is running",
          "Interrupting shows a gentle \"Stopped\" message instead of \"Error: Aborted\"",
        ],
      },
      {
        titleZh: "上下文与诊断",
        titleEn: "Context & Diagnostics",
        itemsZh: [
          "上下文面板接入 ACP 插件真实数据，支持一键解压查看内容",
          "诊断面板 v1.2：引擎日志关键词高亮与搜索，上下文口径统一（消息级 tokens）",
        ],
        itemsEn: [
          "Context panel now shows real ACP plugin data with one-click decompress",
          "Diagnostics v1.2: engine log keyword highlighting and search, unified context accounting",
        ],
      },
      {
        titleZh: "文件与内容",
        titleEn: "Files & Content",
        itemsZh: [
          "不支持的文件类型右键添加时，路径直接插入输入框",
          "文件修改卡片：diff 展示行号（VSCode 风格），兼容 camelCase 工具入参，长路径单行省略",
          "文件预览面板按文件指纹判断会话编辑后自动刷新",
        ],
        itemsEn: [
          "Right-clicking an unsupported file type inserts its path into the input box",
          "File change cards: line numbers in diff view (VS Code style), camelCase tool input support, ellipsis for long paths",
          "File preview auto-refreshes based on file fingerprints after the session edits files",
        ],
      },
      {
        titleZh: "通知与回合体验",
        titleEn: "Notifications & Turn UX",
        itemsZh: [
          "回合完成计时修复：每回合独立计时，serve 重启后继续旧会话仍准确",
          "点击系统通知激活分形窗口（最小化自动还原 + 置顶聚焦）",
          "回答完成通知显示耗时时分秒格式化（12:03 / 1:00:00）",
          "权限/提问通知文案区分：approval 显示权限请求，question 显示需要你的回复",
        ],
        itemsEn: [
          "Turn duration fix: each turn is timed independently, accurate even after serve restart",
          "Clicking a system notification activates the Fractal window (restores + focuses)",
          "Reply-complete notifications show formatted duration (12:03 / 1:00:00)",
          "Distinct notification copy for permission requests vs. AI questions",
        ],
      },
      {
        titleZh: "稳定性与引擎",
        titleEn: "Stability & Engine",
        itemsZh: [
          "acceptEdits 权限模式正确映射（编辑/读取自动放行），启动与保存不再覆盖回 default",
          "sidecar 升级 OpenCode 1.18.18（Kimi/xai 修复）",
          "下载脚本校验改用官方 asset digest，镜像优先下载",
          "skill 节点收起态显示实际使用的 skill 名",
          "润色按钮状态按会话隔离；空会话点新建跳转复用，避免堆积空会话",
          "修复安装版检查更新误报「开发模式不可用」",
        ],
        itemsEn: [
          "acceptEdits permission mode maps correctly, no longer reverting to default on startup/save",
          "Sidecar upgraded to OpenCode 1.18.18 (Kimi/xai fixes)",
          "Download script validates official asset digests, mirror-first download",
          "Collapsed skill nodes show the actual skill name used",
          "Polish button state isolated per session; clicking New on an empty session reuses it",
          "Fixed installed builds reporting \"unavailable in dev mode\" when checking for updates",
        ],
      },
    ],
  },
  {
    version: "1.1.2",
    date: "2026-08-14",
    sections: [
      {
        titleZh: "通道安全",
        titleEn: "Channel Security",
        itemsZh: [
          "IPC 白名单防回归：preload 白名单抽取独立模块 + 静态扫描测试，新增通道漏白名单会自动红",
          "修复会话压缩（session:compact）通道漏白名单，渲染层调用原本会报错",
        ],
        itemsEn: [
          "IPC whitelist regression guard: whitelist extracted into a standalone module with static scan tests",
          "Fixed session:compact channel missing from whitelist, which errored at runtime",
        ],
      },
      {
        titleZh: "更新体验",
        titleEn: "Update UX",
        itemsZh: [
          "开发模式点击「检查更新」显示「开发模式不可用」，不再报内部错误",
          "关于页「更新日志」「检查更新」按钮并排对齐",
        ],
        itemsEn: [
          "Check for updates in dev mode shows \"Unavailable in dev mode\" instead of an internal error",
          "Changelog and check-update buttons aligned side by side on the About tab",
        ],
      },
    ],
  },
  {
    version: "1.1.1",
    date: "2026-08-14",
    sections: [
      {
        titleZh: "自动更新",
        titleEn: "Auto Update",
        itemsZh: [
          "自动检查更新：启动后静默检查，发现新版自动弹窗提示",
          "一键更新：设置页「检查更新」手动检查，下载进度实时展示，下载完成一键重启安装",
          "更新日志弹窗：发版说明（Release Notes）随更新提示展示",
        ],
        itemsEn: [
          "Auto check for updates: silently checks on launch, prompts automatically when a new version is found",
          "One-click update: manual check in Settings, live download progress, restart & install when ready",
          "Release notes shown in the update prompt",
        ],
      },
      {
        titleZh: "诊断面板重构",
        titleEn: "Diagnostics Panel Rework",
        itemsZh: [
          "独立组件化，样式统一语义化",
          "错误行高亮：❌ 错误红色、⚠️ 警告黄色，问题一眼定位",
          "复制语义化：标签页内「复制当前标签页」+ 头部「复制诊断信息」全量打包",
          "日志自动刷新：引擎/控制台日志 3 秒轮询，无需手动刷新",
        ],
        itemsEn: [
          "Extracted into a standalone component with unified semantic styles",
          "Error line highlighting: errors in red, warnings in yellow",
          "Copy semantics: per-tab \"Copy Current Tab\" plus \"Copy Diagnostics\" full bundle",
          "Auto-refresh: engine/console logs poll every 3 seconds",
        ],
      },
      {
        titleZh: "稳定性修复",
        titleEn: "Stability Fixes",
        itemsZh: [
          "子任务失败原因透传：失败卡片显示具体错误（如引擎过载），不再只有失败状态",
          "消息时间线文字节点重复修复：重放文本不再产生重复节点",
        ],
        itemsEn: [
          "Subtask failure reason shown on the failure card (e.g. engine overloaded)",
          "Fixed duplicated text nodes in the message timeline when text is replayed",
        ],
      },
    ],
  },
  {
    version: "1.1.0",
    date: "2026-08-13",
    sections: [
      {
        titleZh: "文件预览增强",
        titleEn: "Enhanced File Preview",
        itemsZh: [
          "PDF 预览：内置 pdfjs 渲染，缩放/翻页/DPR 高清适配",
          "HTML 检查模式开关：可切换「交互」模式让页面自身交互生效",
          "HTML 导出 PDF：一键导出 A4 PDF，无闪烁",
          "统一确认弹窗：原生 confirm 替换为 ConfirmDialog",
        ],
        itemsEn: [
          "PDF preview powered by pdfjs: zoom, paging, and DPR-optimized rendering",
          "HTML inspect mode toggle: switch to \"interact\" mode so page interactions work",
          "Export HTML preview to A4 PDF in one click, no flicker",
          "Unified confirm dialog replaces native confirm()",
        ],
      },
      {
        titleZh: "聊天与消息流",
        titleEn: "Chat & Message Flow",
        itemsZh: [
          "文件修改卡片：回合末尾展示 write/edit 修改的文件，合并去重、识别新增",
          "补充消息打断：处理中输入文字可打断当前回合立即发送",
          "只发附件：不输入文字也可发送附件",
          "office 附件弱提示：不支持读取的附件黄色警告 + 发送前二次确认",
          "总结节点平滑展开：输出完成时消除下方内容跳动",
        ],
        itemsEn: [
          "File change cards: show write/edit changes at turn end, merged and deduped",
          "Interrupt with a follow-up: typing while processing sends immediately",
          "Send attachments alone without text",
          "Weak warning for office attachments the model can't read, with pre-send confirmation",
          "Summary node smooth expansion: no layout jump when output completes",
        ],
      },
      {
        titleZh: "计费与上下文",
        titleEn: "Billing & Context",
        itemsZh: [
          "人民币计费：成本显示改为 ¥，按本地价格表计算缓存/输入/输出成本",
          "余额查询：设置面板与上下文面板显示 DeepSeek 账户余额",
          "上下文占用修正：修复指示器超估，显示真实输入量",
          "模型显示修复：上下文面板显示真实模型名",
        ],
        itemsEn: [
          "CNY billing: costs shown in ¥, computed from a local price table",
          "Balance query: show DeepSeek account balance in settings and context panel",
          "Context usage fix: indicator no longer over-counts, shows real input",
          "Model name fix: context panel shows the real model",
        ],
      },
      {
        titleZh: "稳定性与引擎",
        titleEn: "Stability & Engine",
        itemsZh: [
          "OC v1.18.16 升级：sidecar/依赖/下载脚本同步",
          "多窗口事件路由：每窗口独立订阅，按工作区目录路由事件",
          "question 跨工作区修复：提交答案不再 404",
          "serve 重启兜底：请求超时自动中断，不再永久卡 loading",
          "测试连接校验 API Key：无效 Key 直接提示",
          "权限放行：opencode 工具临时目录放行，subagent 不再卡死",
        ],
        itemsEn: [
          "OC v1.18.16 upgrade: sidecar, dependencies, and download script synced",
          "Multi-window event routing: per-window subscription routed by workspace directory",
          "question cross-workspace fix: submitting answers no longer 404s",
          "serve restart guard: requests time out instead of hanging forever",
          "Test connection now validates the API Key against DeepSeek",
          "Permission for opencode temp directory: subagents no longer stall",
        ],
      },
    ],
  },
  {
    version: "1.0.0",
    date: "2026-08-10",
    sections: [
      {
        titleZh: "全新引擎：OpenCode 驱动",
        titleEn: "New Engine: Powered by OpenCode",
        itemsZh: [
          "内置 OpenCode 引擎，DeepSeek 模型开箱即用——只需配置一个 API Key",
          "经 serve 实时通信（SSE 事件流）：流式消息、思考过程、工具调用全程可见",
          "不再依赖任何其他 AI 工具，OC 是唯一引擎",
        ],
        itemsEn: [
          "Bundled OpenCode engine, DeepSeek out of the box — just one API Key",
          "Real-time communication over serve (SSE event stream): streaming, thinking, and tool calls all visible",
          "OpenCode is the single engine — no other AI tools required",
        ],
      },
      {
        titleZh: "界面与交互",
        titleEn: "Interface & Interaction",
        itemsZh: [
          "整体界面迁移 cc-gui 设计资产：会话列表、消息时间线、文件管理、工具栏",
          "会话按工作区组织，多工作区切换互不干扰",
          "消息锚点时间线：快速跳转任意历史消息",
        ],
        itemsEn: [
          "UI migrated from cc-gui design assets: session list, message timeline, file manager, toolbar",
          "Sessions organized by workspace, switching between workspaces is fully isolated",
          "Message anchor timeline: jump to any historical message instantly",
        ],
      },
      {
        titleZh: "配置与预置",
        titleEn: "Configuration & Presets",
        itemsZh: [
          "类 VSCode settings.json 配置体系 + JSON Schema 校验，让 agent 帮你改配置",
          "内置 MCP / skills / 插件预置包，首次启动自动初始化，零概念门槛",
        ],
        itemsEn: [
          "VSCode-style settings.json with JSON Schema validation — let the agent configure for you",
          "Bundled MCP / skills / plugins presets, auto-initialized on first launch",
        ],
      },
      {
        titleZh: "安装与诊断",
        titleEn: "Installation & Diagnostics",
        itemsZh: [
          "安装路径可选、桌面快捷方式可选（辅助安装器向导）",
          "应用内诊断面板：引擎日志实时可读，30 秒无响应自动弹出提示",
          "npm run debug 一键启动：DevTools + serve 日志双通道排查",
        ],
        itemsEn: [
          "Selectable install directory and desktop shortcut (assisted installer wizard)",
          "In-app diagnostics panel: live engine logs, auto-prompt after 30s unresponsiveness",
          "npm run debug: DevTools + serve logs dual-channel troubleshooting",
        ],
      },
    ],
  },
];

/** 根据版本号查找对应的更新日志条目 */
export function findEntry(version: string): ChangelogEntry | undefined {
  return changelog.find((e) => e.version === version);
}

/** 根据当前语言返回本地化后的 section 数据 */
export function localizedSections(entry: ChangelogEntry, locale: string): { title: string; items: string[] }[] {
  const isZh = locale === "zh";
  return entry.sections.map((s) => ({
    title: isZh ? s.titleZh : s.titleEn,
    items: isZh ? s.itemsZh : s.itemsEn,
  }));
}

// key 前缀对齐产品名（迁移自 cc-gui 时残留 sb- 前缀，当前无历史数据，可直接改）
const STORAGE_KEY = "fractal-changelog-seen";

export function getLastSeenVersion(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export function markVersionSeen(version: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, version);
  } catch { /* ignore */ }
}
