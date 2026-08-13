<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import { readFileBase64 } from "@/lib/electron-bridge";
import JSZip from "jszip";
import { useI18n } from "vue-i18n";

const props = defineProps<{ file: { name: string; path: string } }>();

const { t } = useI18n();

interface TextBlock { y: number; text: string }

const slides = ref<{ num: number; blocks: TextBlock[] }[]>([]);
const loading = ref(true);
const error = ref("");

/** 从 slide XML 提取形状文字，按 Y 坐标从上到下排列并分块 */
function parseSlide(xml: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  // 匹配整个 <p:sp> 形状元素
  const shapeRegex = /<p:sp\b[\s\S]*?<\/p:sp>/g;
  let sm: RegExpExecArray | null;
  while ((sm = shapeRegex.exec(xml)) !== null) {
    const s = sm[0];
    // Y 坐标
    const offY = s.match(/<a:off[^>]*y="(\d+)"/);
    const y = offY ? parseInt(offY[1]) : 99999999;
    // 按 <a:p> 段落提取文字，段落间用换行分隔
    const paras: string[] = [];
    const paraRegex = /<a:p[ >][\s\S]*?<\/a:p>/g;
    let pm: RegExpExecArray | null;
    while ((pm = paraRegex.exec(s)) !== null) {
      const words = [...pm[0].matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)]
        .map(m => m[1])
        .filter(Boolean);
      if (words.length > 0) paras.push(words.join(""));
    }
    if (paras.length > 0) {
      blocks.push({ y, text: paras.join("\n") });
    }
  }
  // 按 Y 排序
  blocks.sort((a, b) => a.y - b.y);
  return blocks;
}

/** 将连续排列的形状合成组（Y 间距 > 500K EMU ≈ 52px 则为新组） */
function groupBlocks(blocks: TextBlock[]): string[] {
  if (blocks.length === 0) return [];
  const GAP_THRESHOLD = 500000; // EMU
  const groups: string[] = [];
  let cur = blocks[0].text;
  for (let i = 1; i < blocks.length; i++) {
    if (blocks[i].y - blocks[i - 1].y > GAP_THRESHOLD) {
      groups.push(cur);
      cur = blocks[i].text;
    } else {
      cur += "\n" + blocks[i].text;
    }
  }
  groups.push(cur);
  return groups;
}

async function loadPptx() {
  loading.value = true;
  error.value = "";
  slides.value = [];
  try {
    const b64 = await readFileBase64(props.file.path);
    const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const zip = await JSZip.loadAsync(raw);

    const slideFiles = Object.keys(zip.files)
      .filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f))
      .sort((a, b) => {
        const na = parseInt(a.match(/slide(\d+)/)?.[1] || "0");
        const nb = parseInt(b.match(/slide(\d+)/)?.[1] || "0");
        return na - nb;
      });

    for (const file of slideFiles) {
      const xml = await zip.files[file]?.async("text") || "";
      const num = parseInt(file.match(/slide(\d+)/)?.[1] || "0");
      const blocks = parseSlide(xml);
      slides.value.push({ num, blocks });
    }
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(() => loadPptx());
watch(() => props.file.path, () => loadPptx());
</script>

<template>
  <div class="flex-1 flex flex-col" style="min-height:0">
    <div v-if="loading" class="flex-1 flex items-center justify-center">
      <span class="text-xs animate-pulse" style="color:var(--text-muted)">{{ $t('preview.loading') }}</span>
    </div>

    <div v-else-if="error" class="flex-1 flex items-center justify-center p-6 text-sm" style="color:var(--coral)">
      {{ error }}
    </div>

    <div v-else-if="slides.length === 0" class="flex-1 flex items-center justify-center" style="color:var(--text-muted)">
      <span class="text-xs">{{ $t('preview.noSlides') }}</span>
    </div>

    <div v-else class="flex-1 overflow-auto pptx-view">
      <div v-for="s in slides" :key="s.num" class="pptx-page">
        <div class="pptx-page-num">幻灯片 {{ s.num }}</div>
        <div v-if="s.blocks.length === 0" class="pptx-block-empty">(无文字内容)</div>
        <template v-else v-for="(block, bi) in groupBlocks(s.blocks)" :key="bi">
          <div v-if="bi > 0" class="pptx-block-sep" />
          <pre class="pptx-block-text">{{ block }}</pre>
        </template>
      </div>
    </div>
  </div>
</template>

<style>
.pptx-view {
  padding: 16px;
  background: var(--bg-root);
}
.pptx-page {
  margin-bottom: 24px;
  border: 1px solid var(--border-dim);
  border-radius: 6px;
  overflow: hidden;
}
.pptx-page-num {
  padding: 4px 12px;
  font-size: 0.786rem;
  font-weight: 600;
  color: var(--text-secondary);
  background: var(--bg-elevated);
  border-bottom: 1px solid var(--border-dim);
}
.pptx-block-text {
  margin: 0;
  padding: 12px 14px;
  white-space: pre-wrap; word-break: break-word;
  font-size: 0.929rem; line-height: 1.7; font-family: inherit;
  color: var(--text-primary); user-select: text;
}
.pptx-block-empty {
  padding: 12px 14px;
  font-size: 0.929rem;
  color: var(--text-muted);
}
.pptx-block-sep {
  margin: 0 14px;
  border-top: 1px dashed var(--border-dim);
}
</style>
