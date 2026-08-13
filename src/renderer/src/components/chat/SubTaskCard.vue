<script setup lang="ts">
// 子任务卡片（消息流内 ToolCard 风格）：三态渲染——运行中（实时进度）/ 已完成（摘要 + 展开）/ 详情按钮
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import type { SubTask } from "@/stores/chat";

const props = defineProps<{
  subtask: SubTask;
  /** 行内展开摘要全文（ChatPanel expandId 管理） */
  expanded?: boolean;
  /**
   * 历史场景摘要懒加载：subtask.summary 为空且展开时调用，返回子会话摘要文本
   * （undefined = 子会话无 assistant 文本产出）。
   * 实时场景不传——summary 已由 idle 事件拉好，向后兼容。
   */
  summaryLoader?: (subId: string) => Promise<string | undefined>;
}>();

const emit = defineEmits<{
  (e: "monitor"): void;
  (e: "expand"): void;
  (e: "detail"): void;
}>();

// 每秒刷新耗时（运行中显示实时秒数）
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  timer = setInterval(() => { now.value = Date.now(); }, 1000);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
});

/** 运行耗时秒数（运行中=startedAt→now；已完成=startedAt→endedAt） */
const elapsedSec = computed(() => {
  const end = props.subtask.endedAt ?? now.value;
  return Math.max(0, Math.floor((end - props.subtask.startedAt) / 1000));
});

/** 徽标映射：agent 名包含匹配（与 locales 文案一致：工匠👷 军师🧭 参谋🧭 侦查兵🕵️ 制图师🎨 其他🤖） */
function badgeFor(name: string): string {
  if (!name) return "🤖";
  if (name.includes("工匠")) return "👷";
  if (name.includes("军师") || name.includes("参谋")) return "🧭";
  if (name.includes("侦查兵") || name.includes("侦察兵")) return "🕵️";
  if (name.includes("制图师")) return "🎨";
  return "🤖";
}

/**
 * 点击分流（含降级态拦截）：
 * - stale：状态未知，禁止交互（不 emit 任何事件）
 * - 运行中 → monitor 实时弹窗
 * - 已完成 → expand 行内展开摘要全文
 */
function handleClick() {
  if (props.subtask.stale) return;
  if (props.subtask.status === "running") {
    emit("monitor");
  } else {
    emit("expand");
  }
}

const badge = computed(() => badgeFor(props.subtask.agent));

/** 动态行：deltaText 尾部（单行省略）；空时提示等待 */
const liveText = computed(() => {
  const t = props.subtask.deltaText.trim();
  if (!t) return "等待子智能体产出…";
  return t.length > 120 ? t.slice(-120) : t;
});

/**
 * 摘要文案三态（军师 #9）：获取失败 / 本来无文本 / 正常有内容
 * - summaryFailed=true → 显「（摘要获取失败）」（idle 拉取异常，非空表示原本有产出但没拉成）
 * - summary 为空且未失败 → 显「（无摘要）」（子会话本身无 assistant 文本产出）
 */
const summaryFallback = computed(() => {
  if (props.subtask.summaryFailed) return "（摘要获取失败）";
  return "（无摘要）";
});

// ── summary 懒加载（历史场景 D1-D6）：summary 空 + 展开 + 有 loader → 拉取子会话摘要（瞬态数据，不写 store）──
const lazySummary = ref<string | null>(null);
const lazyLoading = ref(false);
const lazyFailed = ref(false);
let lazyRequestId = 0;

// immediate 覆盖初始即展开的场景（历史卡片展开态挂载）
watch(
  () => props.expanded,
  async (expanded) => {
    // 仅展开态触发；已有内容或正在加载不重复请求
    if (!expanded) return;
    if (props.subtask.summary || lazySummary.value !== null || lazyLoading.value) return;
    if (!props.summaryLoader) return;
    const reqId = ++lazyRequestId;
    lazyLoading.value = true;
    lazyFailed.value = false;
    try {
      const text = await props.summaryLoader(props.subtask.id);
      // 竞态保护：展开→收起→再展开期间旧请求过期，丢弃过期结果
      if (reqId !== lazyRequestId) return;
      // undefined = 子会话无 assistant 产出（正常结束），走「（无摘要）」兜底；仅异常（catch）标 failed
      lazySummary.value = text ?? "";
    } catch {
      if (reqId !== lazyRequestId) return;
      lazyFailed.value = true;
    } finally {
      if (reqId === lazyRequestId) lazyLoading.value = false;
    }
  },
  { immediate: true }
);

/**
 * 未展开预览（用户反馈：收起态无提示文案）：summary 有 → 前 3 行梗概；
 * summary 空（历史场景未预拉成功/实时无产出）→ 空字符串 → 模板不渲染预览行
 * （只显示头部徽标行；点击展开才加载或显示兜底）
 */
const summaryPreview = computed(() => {
  const s = props.subtask.summary || "";
  if (s) return s.split("\n").slice(0, 3).join("\n");
  return "";
});

/** 展开区最终文案：懒加载中 → 提示；loader 失败 → 失败文案；loader 结果 → 结果；实时 summary → 全文；否则兜底 */
const expandedText = computed(() => {
  if (lazyLoading.value) return "正在加载结果…";
  if (lazyFailed.value) return "（摘要获取失败）";
  if (lazySummary.value) return lazySummary.value;
  return props.subtask.summary || summaryFallback.value;
});
</script>

<template>
  <!-- 点击分流：运行中 → monitor 实时弹窗；已完成 → expand 行内展开摘要全文 -->
  <!-- stale 降级态（军师 #4）：切走期间 idle 事件丢失，切回后卡片不可点击，仅展示灰显提示 -->
  <div
    class="subtask-card"
    :class="{
      'subtask-card--done': subtask.status === 'done',
      'subtask-card--stale': subtask.stale,
    }"
    @click="handleClick"
  >
    <div class="subtask-card-header">
      <span class="subtask-badge">{{ badge }}</span>
      <span class="subtask-agent">{{ subtask.agent }}</span>
      <template v-if="subtask.stale">
        <!-- 降级态：状态未知，禁止点击（状态可能已变化，但事件在切走期间丢失） -->
        <span class="subtask-status subtask-status--stale">⚠️ 状态未知 · 会话已切换</span>
      </template>
      <template v-else-if="subtask.status === 'running'">
        <span class="subtask-status subtask-status--running">🔄 运行中 · {{ elapsedSec }}s</span>
      </template>
      <template v-else-if="subtask.failed">
        <span class="subtask-status subtask-status--failed">❌ 失败 · {{ elapsedSec }}s</span>
      </template>
      <template v-else>
        <span class="subtask-status subtask-status--done">✅ 已完成 · {{ elapsedSec }}s</span>
      </template>
      <span class="flex-1"></span>
      <!-- 仅已完成（非 stale / 非 failed）显示「查看会话详情」按钮（军师 #8：原型对照表运行中无按钮；
           运行中查看进展 = 点击卡片开 Monitor 弹窗；stale/failed 无完整进展可看） -->
      <button
        v-if="subtask.status === 'done' && !subtask.failed && !subtask.stale"
        class="subtask-detail-btn"
        :title="$t('chat.subTaskDetail')"
        @click.stop="emit('detail')"
      >{{ $t('chat.subTaskDetail') }}</button>
    </div>

    <!-- 降级态：仅展示提示，无内容预览 -->
    <div v-if="subtask.stale" class="subtask-stale-note">会话已切换，子任务进展未完整记录。</div>

    <!-- 运行中：动态行（deltaText 尾部，单行省略） -->
    <div v-else-if="subtask.status === 'running'" class="subtask-live" :title="subtask.deltaText">{{ liveText }}</div>

    <!-- 已完成：未展开显预览（summary 前 3 行；summary 空 → 无预览行，只显示头部徽标行）；
         展开态显全文（loader 结果或实时 summary 或兜底）——收起且无预览时不渲染该 div -->
    <div
      v-else-if="!subtask.failed && (expanded || summaryPreview)"
      class="subtask-summary"
      :class="{ 'subtask-summary--expanded': expanded }"
    >
      {{ expanded ? expandedText : summaryPreview }}
    </div>
  </div>
</template>

<style scoped>
/* 工具卡片风格（同 MessageBubble .tl-tool）：bg-surface/border-dim/radius 6px */
.subtask-card {
  background: var(--bg-surface);
  border: 1px solid var(--border-dim);
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
  margin: 0.25rem 0;
  cursor: pointer;
  transition: background-color 150ms;
  user-select: none;
}
.subtask-card:hover {
  background: var(--bg-hover);
}
.subtask-card-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.subtask-badge {
  font-size: 1rem;
  line-height: 1;
}
.subtask-agent {
  font-weight: 600;
  color: var(--violet);
  font-size: 0.857rem;
}
.subtask-status {
  font-size: 0.714rem;
  white-space: nowrap;
}
.subtask-status--running {
  color: var(--accent);
  animation: pulse 1s ease-in-out infinite;
}
.subtask-status--done {
  color: var(--text-muted);
}
/* 降级态（军师 #4）：灰显提示，非交互 */
.subtask-card--stale {
  opacity: 0.6;
  cursor: default;
}
.subtask-status--stale {
  color: var(--text-muted);
}
.subtask-status--failed {
  color: var(--danger, #e5484d);
}
.subtask-stale-note {
  margin-top: 0.35rem;
  font-size: 0.786rem;
  color: var(--text-muted);
}
.subtask-detail-btn {
  font-size: 0.714rem;
  color: var(--text-muted);
  background: transparent;
  border: 1px solid var(--border-dim);
  border-radius: 4px;
  padding: 0.1rem 0.4rem;
  cursor: pointer;
  transition: color 150ms, background-color 150ms;
}
.subtask-detail-btn:hover {
  color: var(--text-bright);
  background: var(--bg-hover);
}
.subtask-live {
  margin-top: 0.35rem;
  font-size: 0.786rem;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.subtask-summary {
  margin-top: 0.35rem;
  font-size: 0.786rem;
  color: var(--text-secondary);
  white-space: pre-line;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}
/* 展开态：全文展示，取消行数限制 */
.subtask-summary--expanded {
  display: block;
  white-space: pre-wrap;
}
</style>
