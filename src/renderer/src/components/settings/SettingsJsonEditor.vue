<script setup lang="ts">
// SettingsJsonEditor：settings.json 的 JSONC 直接编辑器（阶段 6 高级设置层）
// 面向高级用户/agent 协作：类 VSCode settings.json 原文编辑，主进程保存时校验并返回 warnings
import { ref, shallowRef, onMounted, onBeforeUnmount, nextTick } from "vue";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { EditorState, Prec } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { oneDark } from "@codemirror/theme-one-dark";
import { json } from "@codemirror/lang-json";
import { getSettingsConfig, saveSettingsJson } from "@/lib/electron-bridge";

const editorContainer = ref<HTMLElement | null>(null);
const editorView = shallowRef<EditorView | null>(null);
const loading = ref(false);
const saving = ref(false);
const dirty = ref(false);
/** 保存后主进程校验返回的 warnings（非法值回退提示） */
const warnings = ref<string[]>([]);
const error = ref<string | null>(null);
const savedAt = ref<string | null>(null);

function createEditor(doc: string) {
  if (!editorContainer.value) return;
  editorView.value?.destroy();
  const extensions = [
    lineNumbers(),
    highlightActiveLine(),
    history(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    oneDark,
    // json() 语法高亮（@codemirror/lang-json@6.0.2 无 allowComments 选项）：
    // JSONC 注释由语法节点高亮，真正校验在主进程（jsonc-parser 解析，保存返回 warnings）——任务 5 备选方案
    json(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    // Ctrl+S 直接保存（CodeMirror keymap 注册，避免被编辑器吞事件）
    Prec.high(keymap.of([{ key: "Mod-s", run: () => { void handleSave(); return true; } }])),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) dirty.value = true;
    }),
  ];
  editorView.value = new EditorView({
    state: EditorState.create({ doc, extensions }),
    parent: editorContainer.value,
  });
}

async function loadConfig() {
  loading.value = true;
  error.value = null;
  try {
    const r = await getSettingsConfig();
    await nextTick();
    createEditor(r.jsoncText);
    if (r.warnings.length) warnings.value = r.warnings;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

async function handleSave() {
  if (!editorView.value) return;
  const text = editorView.value.state.doc.toString();
  saving.value = true;
  error.value = null;
  try {
    const r = await saveSettingsJson(text);
    warnings.value = r.warnings;
    dirty.value = false;
    savedAt.value = new Date().toLocaleTimeString();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    saving.value = false;
  }
}

onMounted(loadConfig);
onBeforeUnmount(() => {
  editorView.value?.destroy();
  editorView.value = null;
});
</script>

<template>
  <div class="settings-json-editor flex flex-col gap-2">
    <!-- 工具栏：保存 + 状态提示 -->
    <div class="flex items-center gap-2">
      <button
        @click="handleSave"
        :disabled="saving || loading"
        class="px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-150"
        :style="{
          background: saving ? 'var(--bg-elevated)' : 'var(--accent)',
          color: saving ? 'var(--text-muted)' : 'var(--bg-root)',
          opacity: saving || loading ? 0.6 : 1,
        }"
      >{{ saving ? $t('settings.saving') : $t('settings.save') }}</button>
      <span v-if="dirty" class="text-[10px]" style="color: var(--amber)">{{ $t('settings.jsonUnsaved') }}</span>
      <span v-if="savedAt" class="text-[10px] font-mono" style="color: var(--text-muted)">{{ $t('settings.jsonSavedAt') }} {{ savedAt }}</span>
    </div>

    <!-- 校验 warnings（非法值回退提示） -->
    <div v-if="warnings.length" class="space-y-1">
      <div
        v-for="(w, i) in warnings"
        :key="i"
        class="px-3 py-1.5 rounded-lg text-[10px] break-all"
        style="background: var(--amber-glow); color: var(--amber); border: 1px solid var(--amber)"
      >⚠ {{ w }}</div>
    </div>

    <!-- 加载/错误状态 -->
    <div v-if="error" class="px-3 py-2 rounded-lg text-xs break-all" style="background: var(--coral-glow); color: var(--coral); border: 1px solid var(--coral)">✕ {{ error }}</div>

    <!-- CodeMirror 编辑器 -->
    <div ref="editorContainer" class="rounded-lg overflow-hidden" style="border: 1px solid var(--border-default); min-height: 320px; max-height: 480px; overflow-y: auto">
      <div v-if="loading" class="p-4 text-xs" style="color: var(--text-muted)">{{ $t('settings.loading') }}</div>
    </div>

    <p class="text-[10px]" style="color: var(--text-muted); opacity: 0.7">{{ $t('settings.jsonHint') }}</p>
  </div>
</template>
