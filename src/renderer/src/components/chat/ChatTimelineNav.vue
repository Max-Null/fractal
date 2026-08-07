<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import type { Message } from "@/stores/chat";

const { t } = useI18n();

const props = defineProps<{
  messages: Message[];
  /** 全量时间线索引（含未渲染的历史消息），完整目录的锚点来源；preview 供 50 条外锚点 tooltip 兜底 */
  timeline: Array<{ id: string; created: number; role: string; preview?: string }>;
  scrollContainer: HTMLElement | null;
}>();

/** jump 传全局锚点索引（timeline 过滤 user 后），由 ChatPanel 换算目标消息并滚动 */
const emit = defineEmits<{ jump: [index: number] }>();

// 全局 user 锚点：timeline（全量索引）过滤 user——目录完整，不受 DOM 分页（只渲染尾部 50 条）影响
const userTimeline = computed(() =>
  props.timeline.filter(m => m.role === "user")
);

// 当前滚动到的用户消息全局索引（scroll spy；index 为 userTimeline 内的位置，与 timelineItems 一致）
const activeIndex = ref(-1);

function updateActive() {
  const c = props.scrollContainer;
  if (!c) { activeIndex.value = -1; return; }
  const userEls = c.querySelectorAll<HTMLElement>('[data-role="user"]');
  if (userEls.length === 0) { activeIndex.value = -1; return; }
  // 局部定位：视口顶部（scrollTop+80 内最后一条）在已渲染 messages 中的 user index
  let bestLocal = 0;
  userEls.forEach((el, i) => {
    if (el.offsetTop <= c.scrollTop + 80) bestLocal = i;
  });
  // 全局换算：视口顶部消息 id → userTimeline（全量）中的位置，保留局部→全局的对应关系
  const localUsers = props.messages.filter(m => m.role === "user");
  const topId = localUsers[bestLocal]?.id;
  const globalIdx = topId ? userTimeline.value.findIndex(u => u.id === topId) : -1;
  activeIndex.value = globalIdx;
}

let timer: ReturnType<typeof setTimeout> | null = null;
function scheduleUpdate() {
  if (timer) return;
  timer = setTimeout(() => { timer = null; updateActive(); }, 80);
}

watch(() => props.messages.length, () => nextTick(() => scheduleUpdate()), { immediate: true });
watch(() => props.scrollContainer, (c) => {
  if (c) c.addEventListener("scroll", scheduleUpdate, { passive: true });
}, { immediate: true });
onMounted(() => {
  window.addEventListener("resize", scheduleUpdate);
  nextTick(() => scheduleUpdate());
});
onUnmounted(() => {
  props.scrollContainer?.removeEventListener("scroll", scheduleUpdate);
  window.removeEventListener("resize", scheduleUpdate);
  if (timer) clearTimeout(timer);
});

// ── 展开/压缩状态 ──
// 交互：鼠标悬停展开全部 + 点击省略号切换持久展开
// （原 Alt 键展开与 Windows Alt 激活菜单栏冲突，已移除全局 Alt 监听）
const hovered = ref(false);
const expandedClick = ref(false);
const showAll = computed(() => hovered.value || expandedClick.value);

function onMouseEnter() { hovered.value = true; }
function onMouseLeave() { hovered.value = false; }
function toggleExpanded() { expandedClick.value = !expandedClick.value; }
onMounted(() => {
  if (clickTimer) clearTimeout(clickTimer);
});
onUnmounted(() => {
  if (clickTimer) clearTimeout(clickTimer);
});

// ── 压缩逻辑 ──
const WINDOW = 2; // 活跃点前后保留数

interface DotItem { type: "dot"; index: number }
interface EllipsisItem { type: "ellipsis"; label: string; jumpTo: number }
type TimelineItem = DotItem | EllipsisItem;

const timelineItems = computed<TimelineItem[]>(() => {
  const total = userTimeline.value.length;
  if (total === 0) return [];

  const active = activeIndex.value < 0
    ? Math.max(0, total - 1)
    : Math.min(total - 1, Math.max(0, activeIndex.value));

  // 展开模式或消息少时，全部显示
  if (showAll.value || total <= WINDOW * 2 + 3) {
    return userTimeline.value.map((_, i) => ({ type: "dot" as const, index: i }));
  }

  const items: TimelineItem[] = [];
  const rangeStart = Math.max(1, active - WINDOW);
  const rangeEnd = Math.min(total - 2, active + WINDOW);

  items.push({ type: "dot", index: 0 });

  if (rangeStart > 1) {
    items.push({ type: "ellipsis", label: t("chat.timelineEllipsis", { n: rangeStart - 1 }), jumpTo: Math.floor(rangeStart / 2) });
  }

  for (let i = rangeStart; i <= rangeEnd; i++) {
    items.push({ type: "dot", index: i });
  }

  if (rangeEnd < total - 2) {
    items.push({ type: "ellipsis", label: t("chat.timelineEllipsis", { n: total - 2 - rangeEnd }), jumpTo: Math.floor((rangeEnd + total) / 2) });
  }

  if (total > 1) {
    items.push({ type: "dot", index: total - 1 });
  }

  return items;
});

/** 按全局锚点索引取 tooltip 文案：优先已渲染 messages 实时内容（流式更新），50 条外 fallback timeline 的 preview 快照 */
function tooltipFor(index: number): string {
  const anchor = userTimeline.value[index];
  if (!anchor) return "";
  const msg = props.messages.find(m => m.id === anchor.id);
  return msg?.content?.slice(0, 80) || anchor.preview || "";
}

const justClickedIndex = ref(-1);
let clickTimer: ReturnType<typeof setTimeout> | null = null;

function onClick(index: number) {
  emit("jump", index);
  // 点击脉冲动画：标记目标点 600ms 后清除（重复点击取消旧计时器）
  if (clickTimer) clearTimeout(clickTimer);
  justClickedIndex.value = index;
  clickTimer = setTimeout(() => { justClickedIndex.value = -1; clickTimer = null; }, 600);
}

// 展开态末尾状态按钮：
// - 已持久锁定（expandedClick）→ × 收起
// - 仅悬停展开（hovered）→ ⏸ 锁定（保持展开，移出不收起）
function onExpandAction() {
  if (expandedClick.value) {
    expandedClick.value = false;
  } else {
    expandedClick.value = true;
  }
}
</script>

<template>
  <div
    v-if="userTimeline.length > 0"
    class="chat-timeline-nav"
    :class="{ 'chat-timeline-nav--expanded': showAll }"
    @mouseenter="onMouseEnter"
    @mouseleave="onMouseLeave"
  >
    <template v-for="item in timelineItems" :key="item.type === 'dot' ? 'd'+item.index : 'e'+item.jumpTo">
      <!-- 消息点 -->
      <div
        v-if="item.type === 'dot'"
        class="chat-timeline-dot"
        :class="{
          'chat-timeline-dot--active': activeIndex === item.index,
          'chat-timeline-dot--just-clicked': justClickedIndex === item.index,
        }"
        @click="onClick(item.index)"
      >
        <Transition name="tooltip-fade">
          <div v-if="hovered" class="chat-timeline-tooltip">
            {{ tooltipFor(item.index) }}
          </div>
        </Transition>
      </div>
      <!-- 省略号：点击展开/收起全部（压缩态） -->
      <div
        v-else
        class="chat-timeline-ellipsis"
        :title="expandedClick ? t('chat.timelineCollapseHint') : item.label + '（' + t('chat.timelineExpandHint') + '）'"
        @click="toggleExpanded"
      >…</div>
    </template>
    <!-- 展开态末尾状态按钮：悬停临时展开 → ⏸ 锁定；已锁定 → × 收起 -->
    <div
      v-if="showAll"
      class="chat-timeline-collapse"
      :class="{ 'chat-timeline-collapse--locked': expandedClick }"
      :title="expandedClick ? t('chat.timelineCollapseHint') : t('chat.timelineLockHint')"
      @click="onExpandAction"
    >{{ expandedClick ? "×" : "⏸" }}</div>
  </div>
</template>

<style scoped>
.chat-timeline-nav {
  position: absolute;
  right: 6px;
  top: 0;
  bottom: 0;
  width: 20px;
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
}
.chat-timeline-nav--expanded {
  /* 展开时加微弱背景提示 */
  background: linear-gradient(to left, var(--bg-hover), transparent);
}

.chat-timeline-dot {
  position: relative;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--border-default);
  cursor: pointer;
  pointer-events: auto;
  flex-shrink: 0;
  transition: background 150ms, scale 150ms;
}
/* 展开态末尾状态按钮：悬停 ⏸ 锁定 / 锁定 × 收起，hover 高亮 */
.chat-timeline-collapse {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 8px;
  line-height: 1;
  color: var(--text-muted);
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  cursor: pointer;
  pointer-events: auto;
  flex-shrink: 0;
  transition: background 150ms, color 150ms;
}
.chat-timeline-collapse:hover {
  background: var(--accent);
  color: #fff;
}
.chat-timeline-collapse--locked {
  background: var(--accent-soft);
  border-color: var(--accent-line);
  color: var(--accent);
}
.chat-timeline-dot:hover {
  background: var(--accent);
  scale: 1.6;
}
.chat-timeline-dot--active {
  background: var(--accent);
  scale: 1.4;
  box-shadow: 0 0 6px var(--accent-line);
}
.chat-timeline-dot--just-clicked {
  animation: dot-pulse 600ms ease-out;
}
@keyframes dot-pulse {
  0%   { box-shadow: 0 0 0 0 var(--accent-glow); scale: 2; }
  50%  { box-shadow: 0 0 12px 4px var(--accent-line); scale: 1.2; }
  100% { box-shadow: 0 0 6px var(--accent-line); scale: 1.4; }
}

.chat-timeline-ellipsis {
  width: 8px;
  height: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  line-height: 1;
  color: var(--text-muted);
  cursor: pointer;
  pointer-events: auto;
  flex-shrink: 0;
  transition: color 150ms, scale 150ms;
  /* 补偿字体基线偏移，让 … 视觉居中 */
  margin-top: -1px;
}
.chat-timeline-ellipsis:hover {
  color: var(--accent);
  scale: 1.3;
}

.chat-timeline-tooltip {
  position: absolute;
  right: calc(100% + 8px);
  top: 50%;
  translate: 0 -50%;
  max-width: 260px;
  padding: 3px 8px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--text-primary);
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}

.tooltip-fade-enter-active { transition: opacity 100ms ease-out; }
.tooltip-fade-leave-active { transition: opacity 60ms ease-in; }
.tooltip-fade-enter-from, .tooltip-fade-leave-to { opacity: 0; }
</style>
