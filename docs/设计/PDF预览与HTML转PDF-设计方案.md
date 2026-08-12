# PDF 预览与 HTML 转 PDF - 设计方案

> 日期：2026-08-13
> 状态：已确认（用户 2026-08-13 批准）
> 范围：文件预览面板增强——①PDF 文件面板内预览 ②HTML 预览导出 PDF

## 1. 背景与需求

- **PDF 预览**：文件预览面板 `FilePreviewPanel.vue` 已支持 text/html/markdown/docx/xlsx/pptx/image，PDF 目前在 `detectKind` 中被归入 binary 集合返回 `'unsupported'`，无法预览。
- **HTML 转 PDF**：HTML 已有 iframe 预览（blob URL + 宽度预设 + 检查模式），但无导出能力。

用户确认的入口：
- PDF 预览：文件预览面板即可（与 docx/xlsx 体验一致）
- HTML 转 PDF：HTML 预览工具栏按钮

## 2. 技术选型（已查证）

| 能力 | 方案 | 理由 |
|------|------|------|
| PDF 预览 | `pdfjs-dist`（Mozilla PDF.js）canvas 渲染 | iframe+blob 内建 viewer 在沙箱/部分 Electron 配置下被拦截且无法暗色定制（LibreChat 实测）；pdf.js 纯 JS 渲染任意 context 可用、UI 可控 |
| HTML 转 PDF | Electron 内置 `webContents.printToPDF()` | 零依赖、Chromium 保真渲染；`printToPDF` 仅主进程可用，需 IPC 桥接 |

## 3. 详细设计

### 3.1 PDF 预览（文件预览面板）

**依赖**：`pdfjs-dist`（最新稳定版，ES module）

**类型扩展**（`FilePreviewPanel.vue`）：
- `FileKind` 新增 `'pdf'`
- `detectKind` 的 binary 集合中移除 pdf → 返回 `'pdf'`
- `hasPreview` 覆盖 pdf 类型

**新增子组件 `PdfPreview.vue`**：
- Props：`{ file: { name, path }, standalone?: boolean }`（照 PptxPreview 子组件模式）
- 读取链路：`readFileBase64(path)` → base64 解码 `Uint8Array` → `pdfjsLib.getDocument({ data })`
- 渲染：canvas 按 `devicePixelRatio` 缩放保证高清；单页渲染 + 翻页重绘
- 工具栏（lucide 图标 + 暗色主题）：
  - 上一页 / 下一页 / 页码输入框 / 总页数
  - 缩放 + / −、适应宽度（初始 fit width）
- worker：`import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'` → `GlobalWorkerOptions.workerSrc`，electron-vite 正常打包

### 3.2 HTML 转 PDF（HTML 预览工具栏）

**新增 IPC 通道 `pdf:htmlToPdf`**，照现有通道三段式：
1. `electron/preload/index.ts`：`ALLOWED_INVOKE` 白名单追加 `'pdf:htmlToPdf'`
2. `electron/main/ipc.ts`：注册 `ipcMain.handle('pdf:htmlToPdf', ...)`
3. `src/renderer/src/lib/electron-bridge.ts`：`htmlToPdf(path): Promise<{ ok: boolean; path?: string; error?: string }>`

**主进程实现**（`ipc.ts` handler）：
1. `dialog.showSaveDialog`（默认文件名 `<原名>.pdf`、filter `PDF`）；取消 → 返回 `{ ok: false }`（不报错）
2. 隐藏 `BrowserWindow`（`show: false`，复用 `panel.ts` 窗口管理能力）→ `loadFile(htmlPath)`（file:// 协议，保留相对 CSS/JS/图片资源）
3. `did-finish-load` → `webContents.printToPDF({ printBackground: true, pageSize: 'A4' })`
4. Buffer 写盘 → 返回 `{ ok: true, path }`
5. 超时/失败兜底（did-fail-load、printToPDF 抛错）→ 返回 `{ ok: false, error }`

**前端**（`FilePreviewPanel.vue` HTML 预览工具栏）：
- 新增「导出 PDF」按钮（`FileDown` lucide 图标），仅 html 类型显示
- loading 态（按钮禁用 + 转圈）；成功 ElMessage 提示；失败 ElMessage 报错

### 3.3 错误处理

| 场景 | 行为 |
|------|------|
| PDF 文件损坏/解密失败 | PdfPreview 面板内错误提示（`getDocument` 抛错捕获） |
| 导出时用户取消保存对话框 | 静默返回，无提示 |
| printToPDF / 写盘失败 | 返回 `{ ok: false, error }`，前端 ElMessage 报错 |

### 3.4 测试

- 主进程 handler 单测（照 `electron/main/ipc.test.ts` 现有 mock 模式）：mock `dialog.showSaveDialog` / `BrowserWindow`，验证通道注册与返回值分支
- PdfPreview 手动验证：多页 PDF 翻页、缩放、暗色主题、损坏文件提示
- 导出手动验证：含相对 CSS/图片的 HTML → PDF 保真度

## 4. 影响范围

| 文件 | 改动 |
|------|------|
| `package.json` | 新增 `pdfjs-dist` 依赖 |
| `electron/preload/index.ts` | ALLOWED_INVOKE 白名单 +1 通道 |
| `electron/main/ipc.ts` | 新增 `pdf:htmlToPdf` handler（含单测或独立测试文件） |
| `src/renderer/src/lib/electron-bridge.ts` | 新增 `htmlToPdf()` 函数 |
| `src/renderer/src/components/shared/FilePreviewPanel.vue` | FileKind/detectKind/hasPreview 扩展 + 导出按钮 |
| `src/renderer/src/components/shared/PdfPreview.vue` | **新增** PDF 预览组件 |

## 5. 不做的事（YAGNI）

- 不做 PDF 标注/注释/文本选中编辑
- 不做批量转换（文件管理器右键菜单）
- 导出纸张不跟随预览宽度预设，固定 A4（可后续扩展）
- 不引入 pdf.js 之外的 PDF 库
