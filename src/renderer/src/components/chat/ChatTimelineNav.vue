<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import type { Message } from "@/stores/chat";

const { t } = useI18n();

const props = defineProps<{
  messages: Message[];
  scrollContainer: HTMLElement | null;
}>();

const emit = defineEmits<{ scrollTo: [index: number] }>();

const userMessages = computed(() =>
  props.messages.filter(m => m.role === "user")
);

// 当前滚动到的用户消息索引（scroll spy）
const activeIndex = ref(-1);

function updateActive() {
  const c = props.scrollContainer;
  if (!c) { activeIndex.value = -1; return; }
  const userEls = c.querySelectorAll<HTMLElement>('[data-role="user"]');
  if (userEls.length === 0) { activeIndex.value = -1; return; }
  let best = 0;
  userEls.forEach((el, i) => {
    if (el.offsetTop <= c.scrollTop + 80) best = i;
  });
  activeIndex.value = best;
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
const showAll = ref(false);

function onKeyDown(e: KeyboardEvent) {
  if (e.key === "Alt" && !e.repeat) showAll.value = true;
}
function onKeyUp(e: KeyboardEvent) {
  if (e.key === "Alt") showAll.value = false;
}
// 切窗/失焦时重置，防止 showAll 卡在 true
function onBlur() { showAll.value = false; }
onMounted(() => {
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
});
onUnmounted(() => {
  window.removeEventListener("keydown", onKeyDown);
  window.removeEventListener("keyup", onKeyUp);
  window.removeEventListener("blur", onBlur);
  if (clickTimer) clearTimeout(clickTimer);
});

// ── 压缩逻辑 ──
const WINDOW = 2; // 活跃点前后保留数

interface DotItem { type: "dot"; index: number }
interface EllipsisItem { type: "ellipsis"; label: string; jumpTo: number }
type TimelineItem = DotItem | EllipsisItem;

const timelineItems = computed<TimelineItem[]>(() => {
  const total = userMessages.value.length;
  if (total === 0) return [];

  const active = activeIndex.value < 0
    ? Math.max(0, total - 1)
    : Math.min(total - 1, Math.max(0, activeIndex.value));

  // 展开模式或消息少时，全部显示
  if (showAll.value || total <= WINDOW * 2 + 3) {
    return userMessages.value.map((_, i) => ({ type: "dot" as const, index: i }));
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

const showTooltips = ref(false);
const justClickedIndex = ref(-1);
let clickTimer: ReturnType<typeof setTimeout> | null = null;

function onClick(index: number) {
  emit("scrollTo", index);
  // 点击脉冲动画：标记目标点 600ms 后清除（重复点击取消旧计时器）
  if (clickTimer) clearTimeout(clickTimer);
  justClickedIndex.value = index;
  clickTimer = setTimeout(() => { justClickedIndex.value = -1; clickTimer = null; }, 600);
}
</script>

<template>
  <div
    v-if="userMessages.length > 0"
    class="chat-timeline-nav"
    :class="{ 'chat-timeline-nav--expanded': showAll }"
    @mouseenter="showTooltips = true"
    @mouseleave="showTooltips = false"
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
          <div v-if="showTooltips" class="chat-timeline-tooltip">
            {{ userMessages[item.index].content?.slice(0, 80) || "" }}
          </div>
        </Transition>
      </div>
      <!-- 省略号 -->
      <div
        v-else
        class="chat-timeline-ellipsis"
        :title="item.label + '（' + t('chat.timelineExpandHint') + '）'"
        @click="onClick(item.jumpTo)"
      >…</div>
    </template>
  </div>
</template>

<style scoped>
.chat-timeline-nav {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 24px;
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 20px;
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
  background: var(--border-bright);
  cursor: pointer;
  pointer-events: auto;
  flex-shrink: 0;
  transition: background 150ms, scale 150ms;
}
.chat-timeline-dot:hover {
  background: var(--accent);
  scale: 1.6;
}
.chat-timeline-dot--active {
  background: var(--accent);
  scale: 1.4;
  box-shadow: 0 0 6px var(--accent);
}
.chat-timeline-dot--just-clicked {
  animation: dot-pulse 600ms ease-out;
}
@keyframes dot-pulse {
  0%   { box-shadow: 0 0 0 0 var(--accent-glow); scale: 2; }
  50%  { box-shadow: 0 0 12px 4px var(--accent); scale: 1.2; }
  100% { box-shadow: 0 0 6px var(--accent); scale: 1.4; }
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
  border-radius: 6px;
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
