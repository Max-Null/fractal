# 分形（Fractal / oc-gui）

面向非编程人员的 OpenCode 桌面 GUI——开箱即用，OpenCode（OC）为唯一引擎。

- **引擎**：OpenCode，通过 ACP 双工协议集成（`opencode acp`），内置 OC sidecar，不依赖系统已装 OC
- **模型**：仅 DeepSeek（OC 内置 provider），**API Key 是唯一必填配置项**
- **配置体系**：类 VSCode settings.json + JSON Schema，agent 可自检自改配置
- **预置**：内置 MCP/skill/插件预置包，首次启动自动初始化，用户零概念门槛

## 快速开始（终端用户）

直接使用请查看 **[部署指南](docs/知识/分形-部署指南.md)**——安装包获取、另一台 Win11 安装步骤、常见问题。

**部署三步**：

1. 拷贝 `dist/oc-gui-0.1.0-setup.exe`（~132MB）到目标电脑
2. 双击安装（SmartScreen 提示选「更多信息 → 仍要运行」）
3. 首次启动自动初始化预置包 → 设置页填 DeepSeek API Key → 开聊

## 开发环境

### 环境要求

- Node.js ≥ 20（建议 22）
- Windows 10/11

### 安装与运行

```bash
npm install
npm run dev        # 开发模式（HMR）
```

### 测试与类型检查

```bash
npm run typecheck  # tsc (node) + vue-tsc (web) 双端
npm test           # vitest 全量单测
```

### 打包发布

```bash
npm run build:win  # 生成 dist/oc-gui-0.1.0-setup.exe（NSIS 安装包）
```

> 打包细节：内置 opencode sidecar（`resources/bin/`，由 `scripts/download-opencode.js` 下载）与预置包（`electron/resources/preset/`）；renderer 依赖已移入 devDependencies（vite 已 bundle，asar 瘦身）。详见 `electron-builder.yml`。

## 技术栈

| 层 | 技术 |
|----|------|
| 桌面壳 | Electron 43 + electron-vite + electron-builder |
| 渲染层 | Vue 3 + TypeScript + Pinia + Vue Router + vue-i18n |
| 样式 | SCSS（CSS 变量语义化，见 [开发规范](docs/知识/开发规范.md)） |
| 引擎通信 | OpenCode serve（sidecar 子进程）+ @opencode-ai/sdk（SSE 事件流） |

## 目录结构

```
electron/            # 主进程 + preload
├── main/            #   server-manager（serve 生命周期）、events（SSE→前端事件）、ipc、preset（预置初始化）、oc-config
├── preload/         #   contextBridge 桥
└── resources/preset #   预置包源（agents/skills/plugins）
src/renderer/src/    # 渲染层（Vue3）
├── components/      #   ChatPanel/NodeTimeline/NodeCard/SettingsPanel 等
├── stores/          #   chat/session/settings/config
└── lib/             #   node-timeline/nodeSummary/electron-bridge 等
docs/                # 文档（设计/原型/计划/知识，各含 README 索引）
scripts/             # download-opencode.js 等构建脚本
```

## 文档入口

| 文档 | 说明 |
|------|------|
| [分形-设计方案](docs/设计/分形-设计方案.md) | 完整方案 v1.8+（关键设计决策、迁移清单、实施计划、附录） |
| [开发规范](docs/知识/开发规范.md) | 编码总则、CSS 语义化命名、颜色系统、Git 提交规范 |
| [部署指南](docs/知识/分形-部署指南.md) | 安装包获取/打包、安装步骤、常见问题 |
| [oc-engine 知识库](docs/知识/oc-engine/README.md) | OC 版本化知识（协议/插件 API/配置 schema，带版本锚点） |

## Git 提交规范

`<type>: <中文简短描述>`（如 `feat: 新增用户登录`、`fix: 修复空指针`）
