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
    version: "1.0.0",
    date: "2026-08-10",
    sections: [
      {
        titleZh: "全新引擎：OpenCode 驱动",
        titleEn: "New Engine: Powered by OpenCode",
        itemsZh: [
          "内置 OpenCode 引擎，DeepSeek 模型开箱即用——只需配置一个 API Key",
          "经 ACP 双工协议与引擎实时通信：流式消息、思考过程、工具调用全程可见",
          "不再依赖任何其他 AI 工具，OC 是唯一引擎",
        ],
        itemsEn: [
          "Bundled OpenCode engine, DeepSeek out of the box — just one API Key",
          "Real-time communication over the ACP duplex protocol: streaming, thinking, and tool calls all visible",
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
