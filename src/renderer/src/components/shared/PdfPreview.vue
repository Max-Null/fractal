<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from "vue";
import { readFileBase64 } from "@/lib/electron-bridge";
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from "lucide-vue-next";
import * as pdfjsLib from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useI18n } from "vue-i18n";

// pdfjs 渲染由独立 worker 承担，主线程只负责调度
pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

const props = defineProps<{ file: { name: string; path: string } }>();
const { t } = useI18n();

const canvasRef = ref<HTMLCanvasElement | null>(null);
const loading = ref(true);
const error = ref("");
const pageCount = ref(0);
const pageNum = ref(1);
const scale = ref(1);

let pdfDoc: pdfjsLib.PDFDocumentProxy | null = null;
let renderTask: pdfjsLib.RenderTask | null = null;
// 渲染序号：快速翻页/缩放时旧渲染请求作废，防止旧页覆盖新页
let renderId = 0;
// 加载序号：快速切换 file.path 时旧 load 的 getDocument 后返回会覆盖新文档，序号校验丢弃旧结果
let loadId = 0;
// 缩放上下限：过大渲染开销高，过小失去可读性
const MAX_SCALE = 3, MIN_SCALE = 0.5;

// base64 → Uint8Array（pdfjs 需要 ArrayBuffer 数据）
function base64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// 渲染当前页：DPR 缩放保清晰；renderId 序号防竞态，取消异常（cancel 使 promise reject）静默处理
async function renderPage() {
  if (!pdfDoc || !canvasRef.value) return;
  const myId = ++renderId;
  // 快速翻页时取消上一次渲染，避免旧页覆盖新页
  if (renderTask) { renderTask.cancel(); renderTask = null; }
  try {
    const page = await pdfDoc.getPage(pageNum.value);
    // await getPage 期间已有更新的渲染请求，放弃本次
    if (myId !== renderId) return;
    const viewport = page.getViewport({ scale: scale.value });
    const dpr = window.devicePixelRatio || 1;
    const canvas = canvasRef.value;
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = viewport.width + "px";
    canvas.style.height = viewport.height + "px";
    // v6 推荐传 canvas 本体（canvasContext 仅向后兼容），DPR 缩放由 transform 处理
    renderTask = page.render({ canvas, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
    await renderTask.promise;
    // 渲染期间被新调用取代（cancel 导致 reject 走 catch），此处序号校验兜底
    if (myId !== renderId) return;
    // 渲染成功即恢复可渲染状态：清除此前真实渲染失败残留的 error（翻页/缩放成功后不应停留在错误界面）
    if (error.value) error.value = "";
    page.cleanup();
  } catch {
    // 被取消或已被新调用取代：静默忽略；真实失败（非取消）才置 error
    if (myId !== renderId) return;
    error.value = t("preview.pdfLoadFailed");
  }
}

async function load() {
  loading.value = true; error.value = ""; pageNum.value = 1; scale.value = 1;
  // 记录本次加载序号：旧 load 在 await 返回后发现已被新 load 取代，直接丢弃
  const myId = ++loadId;
  try {
    const b64 = await readFileBase64(props.file.path);
    const loadingTask = pdfjsLib.getDocument({ data: base64ToUint8Array(b64) });
    const doc = await loadingTask.promise;
    // 加载期间已有更新的 load 请求：销毁旧文档资源，避免旧文件覆盖新文件
    if (myId !== loadId) {
      void loadingTask.destroy?.();
      return;
    }
    pdfDoc = doc;
    pageCount.value = pdfDoc.numPages;
    await renderPage();
  } catch {
    // 被新 load 取代（destroy 使 promise reject）不报错，只有最新 load 才置错误
    if (myId !== loadId) return;
    error.value = t("preview.pdfLoadFailed");
  } finally {
    // 只有最新 load 才有权结束 loading，防止旧 load 提前清除新 load 的加载态
    if (myId === loadId) loading.value = false;
  }
}

function prev() { if (pageNum.value > 1) { pageNum.value--; void renderPage(); } }
function next() { if (pageNum.value < pageCount.value) { pageNum.value++; void renderPage(); } }
function zoomIn() { if (scale.value < MAX_SCALE) { scale.value = Math.round((scale.value + 0.25) * 100) / 100; void renderPage(); } }
function zoomOut() { if (scale.value > MIN_SCALE) { scale.value = Math.round((scale.value - 0.25) * 100) / 100; void renderPage(); } }

watch(() => props.file.path, load);
onMounted(load);
// 卸载：使在途加载/渲染全部作废（序号递增）。
// loadId 递增让加载中的 getDocument resolve 后落入丢弃分支（myId !== loadId → destroy loadingTask），
// 否则 myId === loadId 会赋 pdfDoc 且无人 destroy，文档资源滞留；renderId 递增照旧作废在途渲染
onBeforeUnmount(() => { loadId++; renderId++; if (renderTask) renderTask.cancel(); void pdfDoc?.loadingTask.destroy(); });
</script>

<template>
  <div class="flex-1 flex flex-col" style="min-height:0">
    <!-- 翻页/缩放工具栏（暗色，照 FilePreviewPanel 宽度预设按钮风格） -->
    <div class="flex items-center gap-1 px-2 h-7 text-[0.714rem] shrink-0" style="background: var(--bg-elevated); border-bottom: 1px solid var(--border-dim)">
      <button
        @click="prev"
        :disabled="pageNum <= 1"
        class="flex items-center px-1.5 py-0.5 rounded transition-colors font-medium shrink-0 hover:opacity-80"
        :class="pageNum <= 1 ? 'opacity-40 cursor-not-allowed' : ''"
        :title="$t('preview.prevPage')"
        style="border: 1px solid var(--border-dim); color: var(--text-muted)"
      ><ChevronLeft :size="13" /></button>
      <span class="shrink-0" style="color: var(--text-muted)">{{ pageNum }} / {{ pageCount }}</span>
      <button
        @click="next"
        :disabled="pageNum >= pageCount"
        class="flex items-center px-1.5 py-0.5 rounded transition-colors font-medium shrink-0 hover:opacity-80"
        :class="pageNum >= pageCount ? 'opacity-40 cursor-not-allowed' : ''"
        :title="$t('preview.nextPage')"
        style="border: 1px solid var(--border-dim); color: var(--text-muted)"
      ><ChevronRight :size="13" /></button>
      <span class="w-px h-3 shrink-0" style="background: var(--border-dim)"></span>
      <button
        @click="zoomOut"
        :disabled="scale <= MIN_SCALE"
        class="flex items-center px-1.5 py-0.5 rounded transition-colors font-medium shrink-0 hover:opacity-80"
        :class="scale <= MIN_SCALE ? 'opacity-40 cursor-not-allowed' : ''"
        :title="$t('preview.zoomOut')"
        style="border: 1px solid var(--border-dim); color: var(--text-muted)"
      ><ZoomOut :size="13" /></button>
      <button
        @click="zoomIn"
        :disabled="scale >= MAX_SCALE"
        class="flex items-center px-1.5 py-0.5 rounded transition-colors font-medium shrink-0 hover:opacity-80"
        :class="scale >= MAX_SCALE ? 'opacity-40 cursor-not-allowed' : ''"
        :title="$t('preview.zoomIn')"
        style="border: 1px solid var(--border-dim); color: var(--text-muted)"
      ><ZoomIn :size="13" /></button>
    </div>

    <div v-if="loading" class="flex-1 flex items-center justify-center">
      <span class="text-xs animate-pulse" style="color:var(--text-muted)">{{ $t('preview.loading') }}</span>
    </div>

    <div v-else-if="error" class="flex-1 flex items-center justify-center p-6 text-sm" style="color:var(--coral)">
      {{ error }}
    </div>

    <!-- 内容区：滚动容器内居中 canvas -->
    <div v-else class="flex-1 overflow-auto flex items-center justify-center p-4">
      <canvas ref="canvasRef" class="shadow" style="max-width:100%; height:auto; background:var(--bg-surface); border:1px solid var(--border-dim)" />
    </div>
  </div>
</template>
