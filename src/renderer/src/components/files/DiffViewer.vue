<script setup lang="ts">
/** Git diff 行级对比渲染——用 diff 库将 oldStr/newStr 逐行对比，输出 add/remove/equal 三类 DiffLine */
import { computed } from "vue";
import * as Diff from "diff";

const props = defineProps<{ oldStr: string; newStr: string }>();

// 逐行对比结果，type 决定背景色（绿增/红删/无变化）
interface DiffLine {
  type: "add" | "remove" | "equal";
  text: string;
  lineNum?: number;  // add/remove 行在原始文件中的行号
}

// diffLines 拆分文本为变更块 → 展平为单行数组，保留 add/remove 的行号用于显示
const lines = computed<DiffLine[]>(() => {
  const changes = Diff.diffLines(props.oldStr || "", props.newStr || "");
  const result: DiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;

  for (const change of changes) {
    const changeLines = change.value.split("\n");
    // 去掉 split 产生的末尾空串
    if (changeLines[changeLines.length - 1] === "") changeLines.pop();

    for (const line of changeLines) {
      if (change.added) {
        result.push({ type: "add", text: line, lineNum: newLine++ });
      } else if (change.removed) {
        result.push({ type: "remove", text: line, lineNum: oldLine++ });
      } else {
        result.push({ type: "equal", text: line });
        oldLine++;
        newLine++;
      }
    }
  }

  return result;
});
</script>

<template>
  <div v-if="oldStr || newStr" class="text-xs font-mono leading-relaxed overflow-auto max-h-96">
    <div
      v-for="(line, i) in lines"
      :key="i"
      class="flex px-3 py-px"
      :style="{
        background: line.type === 'add' ? 'rgba(6,214,160,0.08)' : line.type === 'remove' ? 'rgba(255,94,91,0.08)' : 'transparent',
        borderLeft: line.type === 'add' ? '2px solid var(--accent)' : line.type === 'remove' ? '2px solid var(--coral)' : '2px solid transparent',
      }"
    >
      <span class="w-12 shrink-0 text-right mr-3 select-none" :style="{ color: 'var(--text-muted)' }">
        {{ line.lineNum || '' }}
      </span>
      <span
        :style="{
          color: line.type === 'add' ? 'var(--accent)' : line.type === 'remove' ? 'var(--coral)' : 'var(--text-primary)',
        }"
      >
        {{ line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ' }}{{ line.text }}
      </span>
    </div>
  </div>
  <div v-else class="p-4 text-xs text-center" :style="{ color: 'var(--text-muted)' }">
    No diff to display
  </div>
</template>
