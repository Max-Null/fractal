<script setup lang="ts">
import { ref, watch, computed, onMounted, onUnmounted, shallowRef, nextTick, inject } from "vue";

import { readFileContent, readFileBase64, saveFileContent, checkSkillInstalled, openPreviewWindow, forwardChat, onPreviewChanged, htmlToPdf, fileFingerprint } from "@/lib/electron-bridge";
import { decidePreviewRefresh, sameStat, type FileFingerprint } from "@/lib/preview-fingerprint";
import { isImageFile, mimeType } from "@/composables/useFilePreview";
import { buildInspectorScript, resolveLinkTarget, isIgnorableHref } from "@/lib/inspector-script";
import { emitChatCommand } from "@/composables/useCommandPalette";
import MarkdownRenderer from "./MarkdownRenderer.vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import { marked, type Token, type Tokens } from "marked";
import mammoth from "mammoth";
import DOMPurify from "dompurify";
import { useI18n } from "vue-i18n";
import { PANEL_LAYOUT_KEY } from "@/composables/usePanelLayout";
import { useSelectionTip } from "@/composables/useSelectionTip";
import { RefreshCw, ExternalLink, PanelLeft, X, Pencil, Send, Loader2, MousePointerClick, FileDown } from "lucide-vue-next";
import PptxPreview from "./PptxPreview.vue";
import PdfPreview from "./PdfPreview.vue";
import * as XLSX from "xlsx";
// CodeMirror 6（编辑 tab）
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { EditorState, Prec } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { oneDark } from "@codemirror/theme-one-dark";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";

const props = defineProps<{
  file: { name: string; path: string } | null;
  /** 独立预览窗口模式（无会话上下文）：隐藏 docx 转换等会话相关操作，✕ 关闭自身窗口 */
  standalone?: boolean;
}>();

const emit = defineEmits<{ close: [] }>();

// 列宽由 usePanelLayout composable 统一管理
const layout = inject(PANEL_LAYOUT_KEY)!;

// HTML 预览宽度预设：0 = 跟随面板，>0 = 固定宽度
const HTML_PRESETS = [0, 375, 768, 1024, 1440, 1920] as const
const htmlWidth = ref(0)

// PDF 预览重建计数：PdfPreview 仅 watch props.file.path，刷新/文件变更不换 path 时
// 靠递增此 key 强制重建组件（reloadFile 的 pdf 分支递增，见下方）
const pdfRefreshKey = ref(0)

// ── MD 大纲 ──
const showMdOutline = ref(false);

/** 与 MarkdownRenderer.slug() 保持一致的 id 生成 */
function mdSlug(text: string): string {
  return text.toLowerCase().replace(/[^\w一-鿿]+/g, "-").replace(/^-|-$/g, "");
}

const mdHeadings = computed(() => {
  if (fileKind.value !== "markdown" || !content.value) return [];
  const headings: { level: number; text: string; id: string }[] = [];
  // 用 marked.lexer 解析——与 MarkdownRenderer 使用同一个解析器，
  // 自动排除代码块/引用等结构内的假标题，保证 id 与渲染 HTML 一致
  const tokens = marked.lexer(content.value);
  walkTokens(tokens);
  return headings;

  function walkTokens(tokens: Token[]) {
    for (const t of tokens) {
      if (t.type === "heading") {
        const h = t as Tokens.Heading;
        headings.push({ level: h.depth, text: h.text, id: mdSlug(h.text) });
      }
      // 递归嵌套 token（blockquote、list item 等）
      if ("tokens" in t && Array.isArray(t.tokens)) walkTokens(t.tokens as Token[]);
      if ("items" in t && Array.isArray(t.items)) {
        for (const item of t.items as Tokens.ListItem[]) {
          if (item.tokens) walkTokens(item.tokens);
        }
      }
    }
  }
});

function scrollToHeading(id: string) {
  const el = document.getElementById(id);
  el?.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ── xlsx 状态 ──
const xlsxSheets = ref<{ name: string; html: string }[]>([]);
const xlsxActiveSheet = ref("");
// ── pptx 预览由独立组件 PptxPreview.vue 处理 ──

const content = ref("");       // 原始文本（编辑 tab）
const previewHtml = ref("");   // 渲染后 HTML（预览 tab）
const loading = ref(false);
const error = ref("");
const imageSrc = ref("");
const activeTab = ref<"edit" | "preview">("edit");

// ── 统一浮动 tip ──
const selTip = useSelectionTip();
const selectionTipRef = ref<HTMLElement | null>(null);

// 选区 mouseup 后会紧接着触发 click，用标志位防止 onClickOutside 误关 tip
let skipNextClickOutside = false;

function onClickOutside(e: MouseEvent) {
  if (skipNextClickOutside) { skipNextClickOutside = false; return; }
  if (!selTip.tipVisible.value) return;
  if (!selectionTipRef.value || selectionTipRef.value.contains(e.target as Node)) return;
  selTip.hideTip();
}

// ── HTML 预览 Blob URL（绕过 srcdoc 的脚本执行 bug）──
const previewHtmlBlob = ref("");
function updateHtmlBlob(html: string) {
  URL.revokeObjectURL(previewHtmlBlob.value);
  previewHtmlBlob.value = URL.createObjectURL(new Blob([html], { type: "text/html" }));
}
onUnmounted(() => URL.revokeObjectURL(previewHtmlBlob.value));

// ── DOM 选择器（HTML 预览 tab）──
interface DomInfo { tag: string; id: string; classes: string; text: string; attrs: Record<string, string>; left: number; top: number; bottom: number }
const selectedDom = ref<DomInfo | null>(null);
const previewIframe = ref<HTMLIFrameElement | null>(null);

// 检查模式开关（2026-08-12）：开=点击选元素（默认），关=iframe 页面恢复正常交互——
// 部分页面元素需操作（hover 菜单/下拉/tab）才出现，检查模式拦截 click 导致无法触发。
// 状态不持久化：切文件/关闭面板重置为开。
const inspectorEnabled = ref(true);
/** 切换检查模式：通过 postMessage 控制 iframe 内脚本 flag（不重新注入/reload blob）；关闭时清掉已开 tip */
function toggleInspector() {
  inspectorEnabled.value = !inspectorEnabled.value;
  previewIframe.value?.contentWindow?.postMessage(
    { type: "set-inspect-enabled", enabled: inspectorEnabled.value },
    "*",
  );
  if (!inspectorEnabled.value) selectedDom.value = null;
}

function onIframeMessage(e: MessageEvent) {
  // 只处理来自当前实例 iframe 的消息，避免多实例同时响应
  if (e.source !== previewIframe.value?.contentWindow) return;
  // 链接点击（检查模式关闭时由注入脚本上报）：分流处理，避免 iframe 内部导航白屏
  if (e.data?.type === "link-click") { handleLinkClick(String(e.data.href)); return; }
  if (e.data?.type !== "dom-selected") return;
  const info = e.data.info as DomInfo;
  // iframe 内坐标 → 页面坐标（加上 iframe 偏移）
  const ir = previewIframe.value?.getBoundingClientRect();
  if (ir) {
    info.left += ir.left;
    info.top += ir.top;
    info.bottom += ir.top;
  }
  selectedDom.value = info;
}
onMounted(() => window.addEventListener("message", onIframeMessage));
onUnmounted(() => window.removeEventListener("message", onIframeMessage));

/** iframe 内链接点击分流（2026-08-12 防白屏）：绝对 URL → 系统浏览器（主进程 setWindowOpenHandler 拦截 window.open → shell.openExternal）；
 * 相对路径 → 基于源文件目录拼本地绝对路径，开预览窗口加载相邻文件 */
function handleLinkClick(href: string) {
  // 非导航协议（javascript:void(0) 等占位链接）直接忽略，不打开预览窗口
  if (isIgnorableHref(href)) return;
  if (/^(https?:|mailto:|tel:)/i.test(href)) {
    window.open(href, "_blank");
    return;
  }
  const raw = props.file?.path;
  if (!raw || !href) return;
  const baseDir = raw.replace(/[\\/][^\\/]*$/, "");
  const target = resolveLinkTarget(baseDir, href);
  if (target) void openPreviewWindow(target);
}

/** iframe 加载兜底：若被导航到非 blob 内容（JS location 跳转等注入脚本拦不到的漏网），自动恢复预览。
 * 跨源导航读 location 抛 SecurityError → url 空 → 同样触发恢复 */
function onIframeLoad() {
  const w = previewIframe.value?.contentWindow;
  if (!w) return;
  let url = "";
  try { url = w.location.href; } catch { /* 跨源：已导航到外部页面 */ }
  if (!url.startsWith("blob:")) void reloadFile(true);
}

// OC 修改文件后自动重载（silent：不闪 loading、保持滚动位置）
// 2026-08-15 优化：先比磁盘指纹——仅当前预览文件确实被编辑才刷新，修复「会话中预览一直闪」
// （oc-file-changed 事件不携带被编辑文件路径，原实现无条件 reloadFile(true)，agent 改任何文件都触发预览重读）
let previewFp: FileFingerprint | null = null;
// reload 代际计数：并发读盘时「最后完成者赢」——先发的 reload 若后完成，结果会被标记为过期丢弃，
// 防止旧内容覆盖新内容（军师 P1：大文件 + 快速连续信号的可达竞态）
let reloadSeq = 0;

/** reloadFile 成功读盘后异步刷新指纹缓存（不阻塞渲染）；失败清空缓存，下次信号保守刷新。
 *  path 校验：切文件后旧文件的异步 refreshFingerprint 到达时丢弃，避免污染新文件缓存（军师 P2） */
async function refreshFingerprint(path: string) {
  try {
    const fp = await fileFingerprint(path, true);
    if (path === props.file?.path) previewFp = { ...fp, path };
  } catch {
    if (path === props.file?.path) previewFp = null;
  }
}

/** 刷新信号处理：指纹对比——未变跳过，真变才 reloadFile(true)（独立预览窗口复用同一逻辑） */
async function handleFileChanged() {
  const f = props.file;
  if (!f) return;
  // data: 附件（共享 storage 内嵌图）无真实文件路径，指纹调用必抛错——直接跳过（与 reloadFile data: 保护对称，军师 P4）
  if (f.path.startsWith("data:")) return;
  try {
    // 快路径：仅 stat 不读盘，绝大多数「没变」场景直接跳过，避免大文件每轮读全文件
    const fp = await fileFingerprint(f.path, false);
    if (previewFp && previewFp.path === f.path && sameStat(previewFp, fp)) {
      return;
    }
    // stat 变了 → 读盘算 MD5 确认内容是否真变（排除 touch 等只改时间戳的误报）
    const full = await fileFingerprint(f.path, true);
    const fullFp: FileFingerprint = { ...full, path: f.path };
    const decision = decidePreviewRefresh(previewFp, fullFp);
    if (decision === "skip") return;
    // update-stat 与 refresh 都更新缓存（refresh 的 reloadFile 内部读盘内容与缓存一致）
    previewFp = fullFp;
    if (decision === "refresh") void reloadFile(true);
  } catch {
    // 指纹读取失败（文件被删/权限）：保守刷新，避免卡在旧内容
    void reloadFile(true);
  }
}
function onOcFileChanged() {
  void handleFileChanged();
}
onMounted(() => window.addEventListener("oc-file-changed", onOcFileChanged));
onUnmounted(() => window.removeEventListener("oc-file-changed", onOcFileChanged));

// 独立预览窗口：收不到主窗口的 oc-file-changed（跨 BrowserWindow）——主窗口经主进程广播刷新信号（2026-08-12）
let stopPreviewChanged: (() => void) | null = null;
onMounted(() => {
  if (props.standalone) {
    stopPreviewChanged = onPreviewChanged(() => { void handleFileChanged(); });
  }
});
onUnmounted(() => {
  stopPreviewChanged?.();
  stopPreviewChanged = null;
});

// 点击 tip 外部关闭
onMounted(() => document.addEventListener("click", onClickOutside));
onUnmounted(() => document.removeEventListener("click", onClickOutside));

const { t } = useI18n();
const converting = ref(false);

// ── HTML 导出 PDF（htmlToPdf IPC：ok=false 且无 error = 用户取消保存对话框，静默不提示）──
const exporting = ref(false);
const exportMsg = ref<{ type: "ok" | "err"; text: string } | null>(null);
let exportMsgTimer: ReturnType<typeof setTimeout> | null = null;
function showExportMsg(type: "ok" | "err", text: string) {
  exportMsg.value = { type, text };
  if (exportMsgTimer) clearTimeout(exportMsgTimer);
  exportMsgTimer = setTimeout(() => {
    exportMsg.value = null;
  }, 5000);
}
// 卸载清理导出提示定时器：预览面板关闭后不再触碰已卸载组件的响应式状态
onUnmounted(() => {
  if (exportMsgTimer) {
    clearTimeout(exportMsgTimer);
    exportMsgTimer = null;
  }
});
async function exportPdf() {
  if (!props.file || exporting.value) return;
  exporting.value = true;
  try {
    const r = await htmlToPdf(props.file.path);
    if (r.ok) {
      showExportMsg("ok", t("preview.pdfExportSuccess"));
    } else if (r.error) {
      showExportMsg("err", `${t("preview.pdfExportFailed")}${r.error}`);
    }
    // ok=false 且无 error = 用户取消，静默
  } catch (e) {
    console.error("[FilePreviewPanel] PDF export failed:", e);
    showExportMsg("err", `${t("preview.pdfExportFailed")}${String(e)}`);
  } finally {
    exporting.value = false;
  }
}

/** MD → docx：检测 docx skill → 安装或直接发送给 CC */
async function sendConvertDocx() {
  if (!props.file) return;
  converting.value = true;
  try {
    const hasSkill = await checkSkillInstalled("docx");
    if (hasSkill) {
      const cmd = `请使用 /docx 命令将 \`${props.file.path}\` 转换为 docx 格式，输出到原文件同级位置，中间文件请使用临时目录，完成后清理临时文件`;
      emitChatCommand(`md-convert:${cmd}`);
      // panel 模式不关闭，保持编辑
    } else {
      const cmd = `请先全局安装 docx skill：npx skills add https://github.com/anthropics/skills --skill docx，安装完成后将 \`${props.file.path}\` 转换为 docx 格式，输出到原文件同级位置，中间文件请使用临时目录并清理`;
      emitChatCommand(`md-convert:${cmd}`);
      // panel 模式不关闭，保持编辑
    }
  } finally {
    converting.value = false;
  }
}

function sendDomToChat() {
  if (!selectedDom.value || !props.file) return;
  const d = selectedDom.value;
  const parts = [`<${d.tag}`, d.id ? ` id="${d.id}"` : "", d.classes ? ` class="${d.classes}"` : ""];
  const a = Object.entries(d.attrs).map(([k, v]) => ` ${k}="${v}"`).join("");
  if (a) parts.push(a);
  parts.push(">");
  if (d.text) parts.push(`\n  ${d.text}\n`);
  parts.push(`</${d.tag}>`);
  const msg = `我在 \`${props.file.path}\` 中选中了这个元素，请修改其内容：\n\`\`\`html\n${parts.join("")}\n\`\`\``;
  chatSend(`attach-dom:${msg}`);
  selectedDom.value = null;
  // panel 模式不关闭，保持编辑  // panel 模式不关闭，保持编辑
}

// ── 发送到会话统一出口：standalone（独立预览窗口）无会话上下文，载荷经主进程转投主窗口 ──
function chatSend(payload: string) {
  if (props.standalone) {
    forwardChat(payload);
  } else {
    emitChatCommand(payload);
  }
}

// ── MD 选中 → 发送修改建议到对话 ──
const mdSelection = ref<{ text: string; from: number; to: number; startLine: number; endLine: number } | null>(null);
const mdSuggestion = ref("");

function domTipStyle() {
  if (!selectedDom.value) return { left: '-9999px', top: '-9999px' };
  const d = selectedDom.value;
  // 固定宽高估算 + 视口钳制：tip 在元素下方放不下（元素贴近底部）时翻转到元素上方
  const TIP_W = 320, TIP_H = 34, GAP = 6;
  let left = Math.min(d.left, window.innerWidth - TIP_W - GAP);
  if (left < GAP) left = GAP;
  let top = d.bottom + GAP;
  if (top + TIP_H > window.innerHeight) top = d.top - TIP_H - GAP;
  if (top < GAP) top = GAP;
  return { left: left + 'px', top: top + 'px' };
}

function sendMdToChat() {
  if (!mdSelection.value || !props.file) return;
  const sel = mdSelection.value;
  const suggestion = mdSuggestion.value.trim();
  // 包含文件路径 + 行列信息，让 AI 精确知道改哪里
  const loc = `文件 \`${props.file.path}\` 第 ${sel.startLine}-${sel.endLine} 行`;
  const body = suggestion
    ? `${loc}，请修改以下内容：\n\n\`\`\`markdown\n${sel.text}\n\`\`\`\n\n修改建议：${suggestion}`
    : `${loc}，请修改以下内容：\n\n\`\`\`markdown\n${sel.text}\n\`\`\``;
  chatSend(`md-selection:${props.file.name}|${body}`);
  // 清除选区和输入 + 关闭 tip
  mdSelection.value = null;
  mdSuggestion.value = "";
  selTip.hideTip();
  editorView.value?.dispatch({ selection: { anchor: 0, head: 0 } });
}

// ── 文件类型检测 ──

type FileKind = "text" | "html" | "markdown" | "docx" | "xlsx" | "pptx" | "pdf" | "image" | "unsupported";

const DOCX_EXTS = new Set(["docx", "doc"]);
const HTML_EXTS = new Set(["html", "htm"]);
const MD_EXTS = new Set(["md", "mdx", "markdown"]);
const XLSX_EXTS = new Set(["xlsx", "xls", "csv"]);
const PPTX_EXTS = new Set(["pptx"]);
const PDF_EXTS = new Set(["pdf"]);

function detectKind(filename: string): FileKind {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  if (isImageFile(filename)) return "image";
  if (DOCX_EXTS.has(ext)) return "docx";
  if (HTML_EXTS.has(ext)) return "html";
  if (MD_EXTS.has(ext)) return "markdown";
  if (XLSX_EXTS.has(ext)) return "xlsx";
  if (PPTX_EXTS.has(ext)) return "pptx";
  if (PDF_EXTS.has(ext)) return "pdf";
  // 二进制 / 无文本预览
  const binary = new Set([
    "exe","dll","so","dylib","bin","dat","db","sqlite","sqlite3",
    "zip","tar","gz","rar","7z",
    "mp3","mp4","avi","mov","mkv","wav","flac",
    "ttf","otf","woff","woff2","eot","class","pyc","o","obj","lib","a","wasm",
  ]);
  if (binary.has(ext)) return "unsupported";
  return "text";
}

const fileKind = computed(() => props.file ? detectKind(props.file.name) : "unsupported");

/** 哪些 tab 可用 */
// pdf 与 docx/xlsx/pptx 一致：无编辑 tab（内容由 PdfPreview 只读渲染，编辑 tab 会空白）
const hasEdit = computed(() =>
  fileKind.value !== "image" && fileKind.value !== "unsupported" && fileKind.value !== "xlsx" && fileKind.value !== "pptx" && fileKind.value !== "docx" && fileKind.value !== "pdf"
);
const hasPreview = computed(() =>
  fileKind.value === "html" || fileKind.value === "markdown" || fileKind.value === "docx" || fileKind.value === "xlsx" || fileKind.value === "pptx" || fileKind.value === "pdf" || fileKind.value === "image"
);

// ── 加载文件 ──

// 预览滚动容器 ref（MD 预览 / docx 预览）：自动刷新时保持滚动位置
const mdPreviewBody = ref<HTMLElement | null>(null);
const docxPreviewBody = ref<HTMLElement | null>(null);
// editorView 声明必须早于 reloadFile：watch immediate 在 setup 期同步调用 reloadFile，
// 若此处晚声明会触发 TDZ（Cannot access 'editorView' before initialization）→ 首次打开白屏
const editorView = shallowRef<EditorView | null>(null);

/** 重载后恢复滚动位置：编辑器/iframe/MD/docx 四类各保存一次，双拍恢复（微任务 + 120ms 兜底 blob 加载）。
 * scrollTimer 模块级持有：restoreScroll 可被 silent 刷新高频触发，旧 timer 先清再设；onUnmounted 对称清理 */
let scrollTimer: ReturnType<typeof setTimeout> | null = null;
function restoreScroll(s: { editor: number; iframe: number; md: number; docx: number }) {
  const restore = () => {
    if (s.editor > 0) {
      const dom = editorView.value?.scrollDOM;
      if (dom) dom.scrollTop = s.editor;
    }
    if (s.iframe > 0) {
      const se = previewIframe.value?.contentDocument?.scrollingElement;
      if (se) se.scrollTop = s.iframe;
    }
    if (s.md > 0 && mdPreviewBody.value) mdPreviewBody.value.scrollTop = s.md;
    if (s.docx > 0 && docxPreviewBody.value) docxPreviewBody.value.scrollTop = s.docx;
  };
  nextTick(restore);
  if (scrollTimer) clearTimeout(scrollTimer);
  scrollTimer = setTimeout(restore, 120);
}

/** 重新加载当前文件（手动刷新按钮 / 文件变更事件共用——watch props.file 与刷新按钮同一路径，2026-08-12）。
 * silent=true（自动刷新）：不清空内容不闪 loading，保持滚动位置——手动刷新保持默认行为 */
async function reloadFile(silent = false) {
  const f = props.file;
  if (!f) return;
  // 本次 reload 的代际：并发读盘时若期间有更新的 reload 发起（seq 已递增），本代结果过期——
  // 读盘完成后校验代际，非最新代丢弃写入（最后完成者赢），防止旧内容覆盖新内容（军师 P1）
  const seq = ++reloadSeq;
  // 自动刷新（silent）不改变滚动位置：重载前记录各预览形态滚动位置，完成后恢复（2026-08-12）
  const savedScroll = {
    editor: editorView.value?.scrollDOM.scrollTop ?? 0,
    iframe: previewIframe.value?.contentDocument?.scrollingElement?.scrollTop ?? 0,
    md: mdPreviewBody.value?.scrollTop ?? 0,
    docx: docxPreviewBody.value?.scrollTop ?? 0,
  };
  // 成功读盘后异步刷新指纹缓存（data: 附件无真实路径跳过）；不阻塞本次加载
  if (!f.path.startsWith("data:")) void refreshFingerprint(f.path);
  if (!silent) {
    content.value = "";
    previewHtml.value = "";
    error.value = "";
    imageSrc.value = "";
    loading.value = true;
    mdSelection.value = null;
    mdSuggestion.value = "";
  }

  const kind = detectKind(f.name);

  if (kind === "image") {
    activeTab.value = "preview";
    // data URL 附件（共享 storage 旧会话 file part url 内嵌图片）：直接显示，不能当文件路径读
    if (f.path.startsWith("data:")) {
      imageSrc.value = f.path;
      if (!silent) loading.value = false;
      return;
    }
    try {
      const b64 = await readFileBase64(f.path);
      if (seq !== reloadSeq) return; // 过期代：期间已有更新的 reload，丢弃本次结果
      imageSrc.value = `data:${mimeType(f.name)};base64,${b64}`;
    } catch (e) { if (seq === reloadSeq) error.value = String(e); }
    if (!silent) loading.value = false;
    return;
  }

  if (kind === "unsupported") {
    activeTab.value = "edit";
    if (!silent) loading.value = false;
    return;
  }

  if (kind === "docx") {
    activeTab.value = "preview"; // Word 优先预览
    try {
      const b64 = await readFileBase64(f.path);
      if (seq !== reloadSeq) return;
      const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
      const rawHtml = (await mammoth.convertToHtml({ arrayBuffer: buf })).value;
      if (seq !== reloadSeq) return; // mammoth 转换是长任务，转换完成后再次校验代际
      previewHtml.value = DOMPurify.sanitize(rawHtml);
      content.value = (await mammoth.extractRawText({ arrayBuffer: buf })).value;
    } catch (e) { if (seq === reloadSeq) error.value = String(e); }
    if (!silent) loading.value = false;
    // docx 分支提前返回：恢复滚动位置（silent 自动刷新保持阅读位置）
    restoreScroll(savedScroll);
    return;
  }

  if (kind === "xlsx") {
    activeTab.value = "preview";
    try {
      const ext = f.name.split(".").pop()?.toLowerCase();
      let wb: XLSX.WorkBook;
      if (ext === "csv") {
        const text = await readFileContent(f.path);
        wb = XLSX.read(text, { type: "string" });
      } else {
        const b64 = await readFileBase64(f.path);
        const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
        wb = XLSX.read(buf, { type: "array" });
      }
      if (seq !== reloadSeq) return; // 过期代：期间已有更新的 reload，丢弃本次结果
      // 手动构建带 data-row/data-col 的 HTML 表格，支持单元格选取
      xlsxSheets.value = wb.SheetNames.map(name => {
        const data = XLSX.utils.sheet_to_json<(string | number | boolean | null | undefined)[]>(wb.Sheets[name], { header: 1 });
        // 截断：最多渲染 1000 行
        const maxRows = 1000;
        const rows = data.slice(0, maxRows);
        let html = "<table>";
        for (let r = 0; r < rows.length; r++) {
          html += "<tr>";
          const row = rows[r] || [];
          for (let c = 0; c < row.length; c++) {
            const cell = row[c] != null ? String(row[c]).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : "";
            const tag = r === 0 ? "th" : "td";
            html += `<${tag} data-row="${r}" data-col="${c}">${cell}</${tag}>`;
          }
          html += "</tr>";
        }
        html += "</table>";
        if (data.length > maxRows) {
          html += `<div class="text-[0.714rem] mt-1" style="color:var(--text-muted)">${t("preview.truncated", { n: maxRows })}</div>`;
        }
        return { name, html };
      });
      xlsxActiveSheet.value = wb.SheetNames[0] || "";
    } catch (e) {
      if (seq === reloadSeq) {
        error.value = String(e);
        if ((e as any)?.message?.includes("password") || (e as any)?.message?.includes("Password")) {
          error.value = t("preview.xlsxPassword");
        }
      }
    }
    if (!silent) loading.value = false;
    return;
  }

  if (kind === "pptx") {
    activeTab.value = "preview";
    if (!silent) loading.value = false;
    return;
  }

  // pdf 与 pptx 同构：内容由 PdfPreview 组件自己 readFileBase64 加载，面板层不读文件
  // （若落入下方文本兜底会以 utf-8 读整个 PDF 二进制，视觉正确纯属巧合，且与 pptx 不对称）
  if (kind === "pdf") {
    activeTab.value = "preview";
    if (!silent) loading.value = false;
    // 手动刷新（silent=false）与自动刷新（silent=true）都走此分支：递增 key 强制 PdfPreview 重建
    // （PdfPreview 仅 watch props.file.path，同文件刷新时引用不变不会触发重载）
    pdfRefreshKey.value++;
    return;
  }

  // 文本文件（html / markdown / code / text）
  activeTab.value = hasPreview.value ? "preview" : "edit";
  try {
    const raw = await readFileContent(f.path);
    if (seq !== reloadSeq) return; // 过期代：期间已有更新的 reload，丢弃本次结果
    content.value = raw;
    if (kind === "html") {
      // 注入脚本初始值 = 父窗口当前检查模式状态：刷新/重建 blob 后 iframe 重新加载执行脚本，
      // 若不随当前状态初始化，关闭检查模式后刷新会重置为开启（点击被拦截）——2026-08-12 修复
      const injected = raw.includes("<body>")
        ? raw.replace("<body>", "<body>" + buildInspectorScript(inspectorEnabled.value))
        : raw + buildInspectorScript(inspectorEnabled.value);
      updateHtmlBlob(injected);
    }
    // markdown 预览由 MarkdownRenderer 处理，不需要 previewHtml
  } catch (e) { if (seq === reloadSeq) error.value = String(e); }
  if (!silent) loading.value = false;
  // 恢复滚动位置（silent 自动刷新保持阅读位置——2026-08-12）
  restoreScroll(savedScroll);
}

watch(() => props.file, () => {
  // 切文件重置指纹基准：避免旧文件指纹与新文件误对比（2026-08-15）
  previewFp = null;
  void reloadFile();
}, { immediate: true });

// ═══ Excel 拖拽选区 ═══
const excelAnchor = ref<{ r: number; c: number } | null>(null);
const excelSelection = ref<{ r1: number; c1: number; r2: number; c2: number } | null>(null);

/** 列数字 → Excel 字母（0→A, 1→B, …, 25→Z, 26→AA） */
function colLetter(n: number): string {
  let s = "";
  while (n >= 0) { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; }
  return s;
}

function onExcelMouseDown(e: MouseEvent) {
  const td = (e.target as HTMLElement).closest("td,th") as HTMLTableCellElement | null;
  if (!td) {
    // 点击表格空白处（padding / 无单元格区域）→ 清除旧选区 + 关闭 tip
    excelSelection.value = null;
    excelAnchor.value = null;
    clearSelectionHighlight();
    selTip.hideTip();
    return;
  }
  const r = parseInt(td.dataset.row || "0");
  const c = parseInt(td.dataset.col || "0");
  if (isNaN(r) || isNaN(c)) return;
  excelAnchor.value = { r, c };
  excelSelection.value = { r1: r, c1: c, r2: r, c2: c };
  applySelectionHighlight();
}

function onExcelMouseMove(e: MouseEvent) {
  if (!excelAnchor.value) return;
  const td = (e.target as HTMLElement).closest("td,th") as HTMLTableCellElement | null;
  if (!td) return;
  const r = parseInt(td.dataset.row || "0");
  const c = parseInt(td.dataset.col || "0");
  if (isNaN(r) || isNaN(c)) return;
  excelSelection.value = {
    r1: Math.min(excelAnchor.value.r, r), c1: Math.min(excelAnchor.value.c, c),
    r2: Math.max(excelAnchor.value.r, r), c2: Math.max(excelAnchor.value.c, c),
  };
  applySelectionHighlight();
}

/** 查询单元格（td 或 th），行 0 是 th */
function queryCell(r: number, c: number) {
  return document.querySelector(`td[data-row="${r}"][data-col="${c}"],th[data-row="${r}"][data-col="${c}"]`);
}

const SEL_CLASS = "xlsx-selected";

/** 清除所有选区高亮 */
function clearSelectionHighlight() {
  document.querySelectorAll(`.${SEL_CLASS}`).forEach(el => el.classList.remove(SEL_CLASS));
}

/** 按 excelSelection 给单元格加高亮 */
function applySelectionHighlight() {
  const sel = excelSelection.value;
  if (!sel) return;
  // 先清除旧高亮再应用新的——选区通常不大，全量刷足够快
  clearSelectionHighlight();
  for (let r = sel.r1; r <= sel.r2; r++) {
    for (let c = sel.c1; c <= sel.c2; c++) {
      queryCell(r, c)?.classList.add(SEL_CLASS);
    }
  }
}

function onExcelMouseUp() {
  if (!excelSelection.value) return;
  excelAnchor.value = null;
  const sel = excelSelection.value;
  const rangeStr = sel.r1 === sel.r2 && sel.c1 === sel.c2
    ? `${colLetter(sel.c1)}${sel.r1 + 1}`
    : `${colLetter(sel.c1)}${sel.r1 + 1}:${colLetter(sel.c2)}${sel.r2 + 1}`;
  // 生成选区摘要
  const lines: string[] = [];
  for (let r = sel.r1; r <= Math.min(sel.r2, sel.r1 + 2); r++) {
    const rowCells: string[] = [];
    for (let c = sel.c1; c <= Math.min(sel.c2, sel.c1 + 2); c++) {
      rowCells.push(queryCell(r, c)?.textContent?.trim() || "");
    }
    lines.push(`| ${rowCells.join(" | ")} |`);
  }
  const summary = `${xlsxActiveSheet.value}!${rangeStr}  ${lines.join("  ")}`;
  // 定位 tip 在选区附近
  const rect = queryCell(sel.r1, sel.c1)?.getBoundingClientRect();
  if (rect) { selTip.showTip(summary, rect); skipNextClickOutside = true; }
}

/** 生成 Excel 选区 → sent to CC 的 markdown 表格消息 */
function sendExcelSelection() {
  const sel = excelSelection.value;
  if (!sel || !props.file) return;
  const rangeStr = sel.r1 === sel.r2 && sel.c1 === sel.c2
    ? `${colLetter(sel.c1)}${sel.r1 + 1}`
    : `${colLetter(sel.c1)}${sel.r1 + 1}:${colLetter(sel.c2)}${sel.r2 + 1}`;
  const lines: string[] = [];
  for (let r = sel.r1; r <= sel.r2; r++) {
    const rowCells: string[] = [];
    for (let c = sel.c1; c <= sel.c2; c++) {
      rowCells.push(queryCell(r, c)?.textContent?.trim() || "");
    }
    lines.push(`| ${rowCells.join(" | ")} |`);
  }
  const table = lines.join("\n");
  const msg = `在 \`${props.file.name}\` 的 ${xlsxActiveSheet.value}!${rangeStr} 区域，当前内容为：\n\n${table}\n\n请修改为...`;
  chatSend(`excel-selection:${props.file.name}|${msg}`);
  excelSelection.value = null;
  clearSelectionHighlight();
  selTip.hideTip();
}

// ═══ 文本划选取（DOCX / PPTX / MD 预览）═══
function onTextSelectionMouseUp() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
  const text = sel.toString().trim();
  // 取选区末尾（光标位）的 rect，而非整段包围盒——否则段宽撑满容器，定位偏移
  const endRange = sel.getRangeAt(0).cloneRange();
  endRange.collapse(false);
  const rect = endRange.getClientRects()[0] || sel.getRangeAt(0).getBoundingClientRect();
  selTip.showTip(text, rect);
  skipNextClickOutside = true;
}

function sendTextSelection() {
  if (!props.file) return;
  const text = selTip.tipFullText.value;
  if (!text) return;
  const kind = fileKind.value;
  let msg: string;
  if (kind === "markdown") {
    // MD：在 content.value 中搜索选中文本，获取行号和出现次数
    const lines = content.value.split("\n");
    const occurrences: number[] = [];
    lines.forEach((line, i) => { if (line.includes(text.split("\n")[0])) occurrences.push(i + 1); });
    if (occurrences.length === 1) {
      msg = `在 \`${props.file.name}\` 第 ${occurrences[0]} 行选中了以下内容：\n\n${text}`;
    } else {
      msg = `在 \`${props.file.name}\` 中选中（此文本出现 ${occurrences.length} 次，以下为第 1 处）：\n\n> ${text}\n\n⚠️ 请先确认修改位置后再操作。`;
    }
  } else if (kind === "docx" || kind === "pptx") {
    // DOCX/PPTX：取选区上方的标题作为结构上下文
    const heading = findClosestHeading();
    const loc = heading ? `「${heading}」小节中` : "";
    msg = `在 \`${props.file.name}\` 的${loc}选中了以下内容：\n\n> ${text}`;
  } else {
    msg = `在 \`${props.file.name}\` 中选中了以下内容：\n\n> ${text}`;
  }
  chatSend(`selection:${props.file.name}|${msg}`);
  selTip.hideTip();
  window.getSelection()?.removeAllRanges();
}

/** 在 DOCX mammoth HTML 中查找选区上方最近的标题 */
function findClosestHeading(): string {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return "";
  let node: Node | null = sel.getRangeAt(0).startContainer;
  while (node) {
    if (node.nodeType === 1) {
      const el = node as HTMLElement;
      if (/^H[1-6]$/.test(el.tagName)) return el.textContent?.trim() || "";
      // 查找同层级前方兄弟中的标题
      let prev = el.previousElementSibling;
      while (prev) {
        if (/^H[1-6]$/.test(prev.tagName)) return prev.textContent?.trim() || "";
        prev = prev.previousElementSibling;
      }
    }
    node = node.parentNode;
  }
  return "";
}

// ── CodeMirror 编辑器 ──

const editorContainer = ref<HTMLElement | null>(null);
const dirty = ref(false);
const saving = ref(false);

function cmLang(filename: string) {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts": case "tsx": case "js": case "jsx": return javascript();
    case "py": return python();
    case "rs": return rust();
    case "css": return css();
    case "vue": case "svelte": return html();
    case "json": return json();
    case "md": return markdown();
    case "sql": return sql();
    case "xml": case "svg": return xml();
    case "yaml": case "yml": return yaml();
    default: return null;
  }
}

function createEditor(doc: string) {
  if (!editorContainer.value || !props.file) return;
  editorView.value?.destroy();
  const extensions = [
    lineNumbers(),
    highlightActiveLine(),
    history(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    oneDark,
    keymap.of([...defaultKeymap, ...historyKeymap]),
    // Ctrl+S 通过 CodeMirror keymap 注册（而非 DOM @keydown，避免被编辑器吞事件）
    Prec.high(keymap.of([{ key: "Mod-s", run: () => { saveFile(); return true; } }])),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) dirty.value = true;
      // MD 文件选中检测 → 浮动修改建议 Tip
      if (props.file && fileKind.value === "markdown") {
        const sel = update.state.selection.main;
        if (!sel.empty) {
          const text = update.state.sliceDoc(sel.from, sel.to);
          const startLine = update.state.doc.lineAt(sel.from).number;
          const endLine = update.state.doc.lineAt(sel.to).number;
          mdSelection.value = { text, from: sel.from, to: sel.to, startLine, endLine };
          // 用 selTip 统一 tip 显示选区文本
          const coords = editorView.value!.coordsAtPos(sel.to);
          if (coords) {
            const r = { left: coords.left, right: coords.right, top: coords.top, bottom: coords.bottom } as DOMRect;
            selTip.showTip(text, r);
            skipNextClickOutside = true;
          }
        } else {
          mdSelection.value = null;
          mdSuggestion.value = "";
          selTip.hideTip();
        }
      }
    }),
  ];
  const lang = cmLang(props.file.name);
  if (lang) extensions.push(lang);
  editorView.value = new EditorView({
    state: EditorState.create({ doc, extensions }),
    parent: editorContainer.value,
  });
  // 编辑器滚动时更新 tip 位置（设标志位防止 scrollbar 点击误关 tip）
  editorView.value.scrollDOM.addEventListener("scroll", () => {
    if (mdSelection.value && editorView.value) {
      const coords = editorView.value.coordsAtPos(mdSelection.value.to);
      if (coords) {
        const r = { left: coords.left, right: coords.right, top: coords.top, bottom: coords.bottom } as DOMRect;
        selTip.showTip(mdSelection.value.text, r);
        skipNextClickOutside = true;
      }
    }
  }, { passive: true });
}

function destroyEditor() {
  editorView.value?.destroy();
  editorView.value = null;
}

// 需要初始化/重建编辑器时调用
function maybeCreateEditor() {
  if (!editorView.value && content.value && props.file && hasEdit.value && activeTab.value === "edit") {
    nextTick(() => createEditor(content.value));
  }
}

// 文件切换时重建编辑器
watch(() => props.file?.path, () => {
  destroyEditor();
  dirty.value = false;
  maybeCreateEditor();
});

// 文件内容加载完成时初始化编辑器
watch(content, (val) => {
  if (val) maybeCreateEditor();
});

onMounted(() => maybeCreateEditor());
onUnmounted(() => {
  destroyEditor();
  // 清理滚动恢复兜底 timer（restoreScroll 双拍的第二拍——组件卸载后不再需要）
  if (scrollTimer) { clearTimeout(scrollTimer); scrollTimer = null; }
});

// 切换到编辑 tab 时初始化编辑器，离开时销毁——v-else-if 会重建 DOM，
// 旧 EditorView 挂载的父元素已不在文档中，必须重建
watch(activeTab, (tab) => {
  if (tab === "edit") { maybeCreateEditor(); selectedDom.value = null; }
  else { destroyEditor(); }
});

// 切换 Sheet 时清理选区
watch(xlsxActiveSheet, () => {
  excelSelection.value = null;
  excelAnchor.value = null;
});

// tip 关闭时清理 Excel 选区高亮 + MD 编辑器选区
watch(() => selTip.tipVisible.value, (v) => {
  if (!v) {
    clearSelectionHighlight();
    if (mdSelection.value) {
      mdSelection.value = null;
      mdSuggestion.value = "";
      editorView.value?.dispatch({ selection: { anchor: 0, head: 0 } });
    }
  }
});

// ── 保存 ──

async function saveFile() {
  if (!props.file || !editorView.value || saving.value) return;
  saving.value = true;
  try {
    const text = editorView.value.state.doc.toString();
    await saveFileContent(props.file.path, text);
    content.value = text;
    dirty.value = false;
  } catch (e) {
    console.error("[FilePreviewModal] Save failed:", e);
  } finally {
    saving.value = false;
  }
}

// ── 关闭确认（未保存更改）──
// 原生 confirm 替换为 ConfirmDialog（2026-08-13 用户反馈弹窗太丑）：state 驱动
const closeConfirmOpen = ref(false);
function confirmClose() {
  closeConfirmOpen.value = true;
}
function onCloseConfirm() {
  closeConfirmOpen.value = false;
  dirty.value = false;
  emit("close");
}
function onCloseCancel() { closeConfirmOpen.value = false; }

/** 关闭预览：独立窗口直接 window.close()（Electron 渲染进程可关自身窗口）；嵌入模式 dirty 走确认弹窗 */
function handleClose() {
  if (props.standalone) { window.close(); return; }
  if (dirty.value) { confirmClose(); } else { emit("close"); }
}
</script>

<template>
  <div v-if="file" class="flex h-full">
    <!-- 拖拽把手（独立窗口无 panel layout——隐藏，窗口级拖拽由系统标题栏承担） -->
    <div
      v-if="!standalone"
      @mousedown="layout.startResize('preview', $event)"
      class="panel-drag-handle"
      :class="{ 'panel-drag-handle--active': layout.previewDragging.value }"
    />

    <!-- 面板主体（独立窗口 standalone：全宽布局，不依赖 panel layout 注入） -->
    <div class="panel-body" :style="{ width: standalone ? '100%' : layout.previewWidth.value + 'px' }">
      <!-- Header -->
      <div class="panel-header">
        <div class="flex items-center gap-1.5 min-w-0 flex-1">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
          <span class="text-xs font-medium truncate" style="color: var(--text-bright)" :title="file.path">{{ file.name }}</span>
          <span v-if="dirty" class="shrink-0 w-1.5 h-1.5 rounded-full" style="background: var(--amber)" title="未保存" />
        </div>
        <div v-if="hasEdit && hasPreview" class="flex rounded-md shrink-0" style="background: var(--bg-root); border: 1px solid var(--border-dim)">
          <button
            v-for="t in (['edit', 'preview'] as const)"
            :key="t"
            @click="activeTab = t"
            class="text-[0.714rem] px-2.5 py-0.5 font-medium transition-colors rounded-md"
            :style="{ background: activeTab === t ? 'var(--accent)' : 'transparent', color: activeTab === t ? 'var(--bg-root)' : 'var(--text-muted)' }"
          >{{ t === 'edit' ? $t('preview.edit') : $t('preview.previewTab') }}</button>
        </div>
        <button v-if="activeTab === 'edit' && dirty" @click="saveFile" :disabled="saving"
          class="text-[0.714rem] px-2 py-0.5 rounded font-medium transition-colors shrink-0"
          :class="saving ? 'opacity-50 cursor-not-allowed' : 'hover:opacity-80'"
          style="background: var(--accent); color: var(--bg-root)"
        >{{ saving ? '…' : $t('preview.save') }}</button>
        <!-- 手动刷新：重新读取文件并刷新各类型预览（agent/外部改动后无需重开面板） -->
        <button v-if="!loading" @click="reloadFile()"
          class="text-[0.714rem] px-2 py-0.5 rounded font-medium transition-colors shrink-0 hover:opacity-80"
          style="border: 1px solid var(--border-dim); color: var(--text-muted)"
          :title="$t('preview.refresh')"
        ><RefreshCw :size="13" /></button>
        <!-- 独立窗口：双屏联调时把大预览单独开一窗（主界面内嵌模式可用） -->
        <button v-if="!standalone" @click="openPreviewWindow(file.path)"
          class="text-[0.714rem] px-2 py-0.5 rounded font-medium transition-colors shrink-0 hover:opacity-80"
          style="border: 1px solid var(--border-dim); color: var(--text-muted)"
          :title="$t('preview.openInWindow')"
        ><ExternalLink :size="13" /></button>
        <button v-if="fileKind === 'markdown'" @click="showMdOutline = !showMdOutline"
          class="text-[0.714rem] px-2 py-0.5 rounded font-medium transition-colors shrink-0 hover:opacity-80"
          :style="{ background: showMdOutline ? 'var(--accent)' : 'transparent', color: showMdOutline ? 'var(--bg-root)' : 'var(--text-muted)', border: showMdOutline ? 'none' : '1px solid var(--border-dim)' }"
        ><PanelLeft :size="13" /></button>
        <button v-if="!standalone && fileKind === 'markdown'" @click="sendConvertDocx" :disabled="converting"
          class="text-[0.714rem] px-2 py-0.5 rounded font-medium transition-colors shrink-0"
          :class="converting ? 'opacity-50 cursor-not-allowed' : 'hover:opacity-80'"
          style="background: var(--accent); color: var(--bg-root)"
          :title="$t('preview.convertDocx')"
        >{{ converting ? '' : $t('preview.toDocx') }}<Loader2 v-if="converting" :size="13" class="animate-spin" /></button>
        <button @click="handleClose"
          class="w-6 h-6 flex items-center justify-center rounded-md transition-colors hover:bg-[var(--bg-hover)] shrink-0"
          style="color: var(--text-muted)"
          :title="$t('file.closePreview')"
        ><X :size="14" /></button>
      </div>

      <!-- Body -->
      <div class="panel-content">
        <div v-if="loading" class="flex-1 flex items-center justify-center" style="color: var(--text-muted)">
          <span class="text-xs">{{ $t('chat.loading') }}</span>
        </div>
        <div v-else-if="error" class="flex-1 flex items-center justify-center p-6 text-sm" style="color: var(--coral)">{{ error }}</div>
        <div v-else-if="fileKind === 'unsupported'" class="flex-1 flex flex-col items-center justify-center gap-3">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color: var(--text-muted); opacity: 0.4"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
          <p class="text-sm" style="color: var(--text-muted)">{{ $t('preview.unsupported') }}</p>
        </div>
        <div v-else-if="activeTab === 'edit'" ref="editorContainer" class="flex-1 overflow-auto"></div>
        <div v-else-if="fileKind === 'image'" class="flex-1 flex items-center justify-center p-4 overflow-auto">
          <img v-if="imageSrc" :src="imageSrc" :alt="file.name" class="max-w-full max-h-full object-contain rounded" />
        </div>
        <div v-else-if="fileKind === 'html'" class="flex-1 flex flex-col relative" style="min-height: 0">
          <!-- 导出 PDF 反馈浮层（复用全局 status-toast 定位；ok=accent / err=coral） -->
          <Transition name="status-float">
            <div v-if="exportMsg" class="status-toast">
              <span class="status-pill" :style="exportMsg.type === 'ok' ? { background: 'var(--accent-glow)', color: 'var(--accent)' } : { background: 'var(--coral-glow)', color: 'var(--coral)' }">{{ exportMsg.text }}</span>
            </div>
          </Transition>
          <!-- 宽度预设工具栏 + 检查模式开关（2026-08-12：关闭后页面可交互，动态元素可操作） -->
          <div class="flex items-center gap-1 px-2 h-7 text-[0.714rem] shrink-0" style="background: var(--bg-elevated); border-bottom: 1px solid var(--border-dim)">
            <button
              @click="toggleInspector"
              :title="inspectorEnabled ? '检查模式：点击元素选中发送（关闭可操作页面）' : '检查模式已关闭：页面可正常交互（打开后点击元素选中）'"
              class="flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors font-medium shrink-0"
              :style="{
                background: inspectorEnabled ? 'var(--accent)' : 'transparent',
                color: inspectorEnabled ? 'var(--bg-root)' : 'var(--text-muted)',
                border: inspectorEnabled ? 'none' : '1px solid var(--border-dim)',
              }"
            >
              <MousePointerClick :size="11" />
              {{ inspectorEnabled ? $t('preview.inspectOn') : $t('preview.inspectOff') }}
            </button>
            <span class="w-px h-3 shrink-0" style="background: var(--border-dim)"></span>
            <button
              v-for="w in HTML_PRESETS" :key="w"
              @click="htmlWidth = w"
              class="px-1.5 py-0.5 rounded transition-colors font-medium"
              :style="{
                background: htmlWidth === w ? 'var(--accent)' : 'transparent',
                color: htmlWidth === w ? 'var(--bg-root)' : 'var(--text-muted)',
                border: htmlWidth === w ? 'none' : '1px solid var(--border-dim)',
              }"
            >{{ w === 0 ? $t('preview.htmlFit') : w }}</button>
            <span class="w-px h-3 shrink-0" style="background: var(--border-dim)"></span>
            <button
              :disabled="exporting"
              :title="t('preview.exportPdf')"
              class="flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors font-medium shrink-0 cursor-not-allowed"
              :style="{
                color: 'var(--text-muted)',
                border: '1px solid var(--border-dim)',
                opacity: exporting ? 0.6 : 1,
              }"
              @click="exportPdf"
            >
              <FileDown :size="11" />
              {{ exporting ? t('preview.exporting') : t('preview.exportPdf') }}
            </button>
          </div>
          <div class="flex-1" :style="{ minHeight: 0, overflow: htmlWidth > 0 ? 'auto' : 'hidden' }">
            <div :class="htmlWidth === 0 ? 'relative' : ''" :style="htmlWidth > 0 ? { width: htmlWidth + 'px', height: '100%' } : { height: '100%' }">
              <iframe
                :class="htmlWidth === 0 ? 'absolute inset-0 w-full h-full border-none' : 'h-full border-none'"
                ref="previewIframe"
                sandbox="allow-scripts"
                :src="previewHtmlBlob"
                :style="{ background: '#fff', width: htmlWidth > 0 ? htmlWidth + 'px' : '' }"
                @load="onIframeLoad"
              />
            </div>
          </div>
        </div>
        <div v-else-if="fileKind === 'xlsx'" class="flex-1 flex flex-col" style="min-height: 0">
          <!-- Sheet Tab 栏 -->
          <div v-if="xlsxSheets.length > 1" class="flex items-center gap-1 px-2 h-7 text-[0.714rem] shrink-0" style="background: var(--bg-elevated); border-bottom: 1px solid var(--border-dim)">
            <button
              v-for="s in xlsxSheets" :key="s.name"
              @click="xlsxActiveSheet = s.name"
              class="px-2 py-0.5 rounded transition-colors font-medium"
              :style="{
                background: xlsxActiveSheet === s.name ? 'var(--accent)' : 'transparent',
                color: xlsxActiveSheet === s.name ? 'var(--bg-root)' : 'var(--text-muted)',
                border: xlsxActiveSheet === s.name ? 'none' : '1px solid var(--border-dim)',
              }"
            >{{ s.name }}</button>
          </div>
          <!-- 表格（含拖拽选区） -->
          <div
            class="flex-1 overflow-auto p-3 xlsx-preview"
            @mousedown="onExcelMouseDown"
            @mousemove="onExcelMouseMove"
            @mouseup="onExcelMouseUp"
          >
            <div v-if="xlsxSheets.length === 0" class="flex items-center justify-center h-full" style="color: var(--text-muted)">
              <span class="text-xs">{{ $t('preview.noData') }}</span>
            </div>
            <div v-else v-html="xlsxSheets.find(s => s.name === xlsxActiveSheet)?.html || ''"></div>
          </div>
        </div>
        <div v-else-if="fileKind === 'pptx'" class="flex-1 flex flex-col" style="min-height:0" @mouseup="onTextSelectionMouseUp">
          <PptxPreview :file="{ name: props.file!.name, path: props.file!.path }" />
        </div>
        <div v-else-if="fileKind === 'pdf'" class="flex-1 flex flex-col" style="min-height:0">
          <!-- key 绑定 pdfRefreshKey：刷新时强制重建 PdfPreview（组件仅 watch path，同文件刷新不触发） -->
          <PdfPreview :key="pdfRefreshKey" :file="{ name: props.file!.name, path: props.file!.path }" />
        </div>
        <div v-else-if="fileKind === 'markdown'" class="flex-1 flex" style="min-height:0">
          <!-- 大纲侧边栏 -->
          <div v-if="showMdOutline && mdHeadings.length > 0"
            class="md-outline shrink-0 overflow-auto text-[0.786rem]"
            :style="{ width: '200px', background: 'var(--bg-surface)', borderRight: '1px solid var(--border-dim)' }"
          >
            <div class="px-3 py-2 font-medium" style="color: var(--text-secondary)">大纲</div>
            <a
              v-for="h in mdHeadings" :key="h.id"
              @click="scrollToHeading(h.id)"
              class="block px-3 py-1 cursor-pointer truncate transition-colors hover:bg-[var(--bg-hover)]"
              :style="{
                paddingLeft: `${8 + h.level * 12}px`,
                color: h.level <= 2 ? 'var(--text-primary)' : 'var(--text-secondary)',
              }"
              :title="h.text"
            >{{ h.text }}</a>
          </div>
          <div class="flex-1 overflow-auto p-5" ref="mdPreviewBody" @mouseup="onTextSelectionMouseUp">
            <MarkdownRenderer :content="content" />
          </div>
        </div>
        <div v-else-if="fileKind === 'docx'" ref="docxPreviewBody" class="flex-1 overflow-auto p-5 docx-preview" v-html="previewHtml" @mouseup="onTextSelectionMouseUp"></div>
        <div v-else-if="hasEdit" ref="editorContainer" class="flex-1 overflow-auto"></div>
        <div v-else class="flex-1 flex items-center justify-center" style="color: var(--text-muted)">
          <span class="text-xs">{{ $t('preview.noPreview') }}</span>
        </div>
      </div>

      <!-- 统一选区浮动 Tip（MD 编辑 / Excel / 文本划选 共用） -->
      <Teleport to="body">
        <div
          ref="selectionTipRef"
          v-if="selTip.tipVisible.value"
          class="selection-tip"
          :style="{
            left: selTip.tipPos.value.left,
            top: selTip.tipPos.value.top,
            background: 'var(--bg-elevated)',
            borderColor: 'var(--accent-dim)',
            minWidth: '320px',
          }"
        >
          <div class="flex items-center gap-2">
            <span style="color: var(--amber)"><Pencil :size="13" /></span>
            <span class="truncate" style="color: var(--text-secondary)">"{{ selTip.tipSummary.value }}"</span>
            <button @click="selTip.hideTip()" class="shrink-0 w-5 h-5 flex items-center justify-center rounded hover:bg-[var(--bg-hover)] ml-auto" style="color: var(--text-muted)"><X :size="13" /></button>
          </div>
          <!-- MD 编辑器：建议输入框 + 发送（独立预览窗口经主进程转发主窗口会话） -->
          <template v-if="fileKind === 'markdown' && activeTab === 'edit' && mdSelection">
            <input
              v-model="mdSuggestion"
              class="w-full mt-1 px-2 py-1 rounded text-[0.786rem] outline-none"
              :style="{ background: 'var(--bg-root)', color: 'var(--text-primary)', border: '1px solid var(--border-dim)' }"
              :placeholder="$t('preview.mdSuggestionPlaceholder')"
              @keyup.enter="sendMdToChat"
            />
            <div class="flex gap-2 mt-1">
              <button
                @click="sendMdToChat"
                class="flex-1 px-3 py-1 rounded text-[0.714rem] font-medium transition-colors hover:opacity-80"
                style="background: var(--accent); color: var(--bg-root)"
              ><Send :size="11" class="mr-1 inline" />{{ $t('preview.sendToChat') }}</button>
            </div>
          </template>
          <!-- Excel / 文本划选：无建议输入 -->
          <template v-else>
            <div class="flex gap-2">
              <button
                v-if="fileKind === 'xlsx'"
                @click="sendExcelSelection"
                class="flex-1 px-3 py-1 rounded text-[0.714rem] font-medium transition-colors hover:opacity-80"
                style="background: var(--accent); color: var(--bg-root)"
              ><Send :size="11" class="mr-1 inline" />{{ $t('preview.sendToChat') }}</button>
              <button
                v-else
                @click="sendTextSelection"
                class="flex-1 px-3 py-1 rounded text-[0.714rem] font-medium transition-colors hover:opacity-80"
                style="background: var(--accent); color: var(--bg-root)"
              ><Send :size="11" class="mr-1 inline" />{{ $t('preview.sendToChat') }}</button>
            </div>
          </template>
        </div>
      </Teleport>
    </div>
  </div>

  <!-- DOM 选中浮动 Tip（HTML 预览中点击元素后显示，modal/panel 共用） -->
  <Teleport to="body">
    <div
      v-if="selectedDom"
      class="fm-dom-tip"
      :style="domTipStyle()"
    >
      <span class="font-mono truncate" style="color: var(--accent)">
        &lt;{{ selectedDom.tag }}<template v-if="selectedDom.id">#{{ selectedDom.id }}</template><template v-if="selectedDom.classes">.{{ selectedDom.classes.split(' ').join('.') }}</template>&gt;
      </span>
      <span class="truncate flex-1" style="color: var(--text-muted)">{{ selectedDom.text.slice(0, 50) }}</span>
      <button @click="selectedDom = null" class="shrink-0 w-5 h-5 flex items-center justify-center rounded hover:bg-[var(--bg-hover)]" style="color: var(--text-muted)"><X :size="13" /></button>
      <!-- 发送到对话：独立预览窗口无会话上下文——载荷经主进程转发主窗口（双屏联调核心场景） -->
      <button v-if="selectedDom" @click.stop="sendDomToChat" class="shrink-0 px-2 py-0.5 rounded text-[0.714rem] font-medium hover:opacity-80" style="background: var(--accent); color: var(--bg-root)">发送到对话</button>
    </div>
  </Teleport>

  <!-- 未保存更改关闭确认（ConfirmDialog danger：确认后丢弃更改关闭） -->
  <ConfirmDialog
    :open="closeConfirmOpen"
    :title="$t('file.unsavedTitle')"
    :message="$t('file.unsavedChanges')"
    :confirm-text="$t('modal.confirm')"
    :danger="true"
    @confirm="onCloseConfirm"
    @cancel="onCloseCancel"
  />
</template>

<style>
/* ── mammoth .docx → HTML 预览样式 ── */
.docx-preview {
  color: var(--text-primary);
  line-height: 1.7;
  font-size: 1rem;
}
.docx-preview h1 {
  font-size: 1.4em;
  font-weight: 700;
  margin: 1em 0 0.5em;
  color: var(--text-bright);
}
.docx-preview h2 { font-size: 1.2em; font-weight: 600; margin: 0.8em 0 0.4em; }
.docx-preview p { margin: 0.4em 0; }
.docx-preview strong { font-weight: 600; color: var(--text-bright); }
.docx-preview table {
  border-collapse: collapse;
  width: 100%;
  margin: 0.8em 0;
}
.docx-preview td, .docx-preview th {
  border: 1px solid var(--border-dim);
  padding: 0.5em 0.75em;
  text-align: left;
}
.docx-preview tr:nth-child(even) { background: var(--bg-hover); }
.docx-preview tr:first-child { background: var(--bg-elevated); font-weight: 600; }

/* ── 统一选区浮动 Tip ── */
.selection-tip {
  position: fixed;
  z-index: 60;
  border-radius: 0.5rem;
  box-shadow: 0 10px 15px -3px rgba(0,0,0,.1), 0 4px 6px -4px rgba(0,0,0,.1);
  border: 1px solid;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.625rem 0.75rem;
  font-size: 0.786rem;
  min-width: 320px;
  max-width: min(380px, calc(100vw - 16px));
}

/* ── DOM 选中浮动 Tip ── */
.fm-dom-tip {
  position: fixed;
  z-index: 60;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  font-size: 0.786rem;
  border-radius: 0.5rem;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  background: var(--bg-elevated);
  border: 1px solid var(--accent-dim);
  min-width: 280px;
}

/* ── 面板布局 ── */
.panel-drag-handle {
  width: 0.375rem;
  flex-shrink: 0;
  cursor: col-resize;
  transition: background-color 150ms;
  user-select: none;
  background: transparent;
}
.panel-drag-handle:hover { background: rgba(6, 214, 160, 0.1); }
.panel-drag-handle--active { background: var(--accent-dim); }

.panel-body {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-surface);
  border-left: 1px solid var(--border-dim);
}

.panel-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  flex-shrink: 0;
  border-bottom: 1px solid var(--border-dim);
}

.panel-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-root);
  min-height: 0;
}

/* CodeMirror 填满容器高度，防止水平滚动条被内容撑到可视区外 */
.panel-content .cm-editor { height: 100%; }
.panel-content .cm-scroller { overflow: auto; }

/* ── xlsx 表格预览 ── */
.xlsx-preview table {
  border-collapse: collapse;
  font-size: 0.857rem;
  font-family: ui-monospace, monospace;
}
.xlsx-preview td, .xlsx-preview th {
  border: 1px solid var(--border-dim);
  padding: 0.25em 0.6em;
  text-align: left;
  white-space: nowrap;
  cursor: cell;
  user-select: none;
}
.xlsx-preview th {
  background: var(--bg-elevated);
  font-weight: 600;
  color: var(--text-bright);
  position: sticky;
  top: 0;
  z-index: 1;
}
.xlsx-preview tr:nth-child(even) td { background: var(--bg-hover); }
.xlsx-preview td:hover { background: var(--accent-glow); }
.xlsx-preview td.xlsx-selected, .xlsx-preview th.xlsx-selected {
  background: var(--accent-glow) !important;
  outline: 1px solid var(--accent-dim);
  outline-offset: -1px;
}

</style>
