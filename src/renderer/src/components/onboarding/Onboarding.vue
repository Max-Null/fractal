<script setup lang="ts">
/**
 * Onboarding 首屏引导：无 API Key 时全屏展示（2 步引导：输入 Key → 测试连接 → 完成）。
 * 对齐原型 v0.23 `.ob` 卡片：居中卡片 + 步骤指示 + 字段区 + 操作按钮；右上角可跳过。
 * 完成/跳过由 AppShell 统一处理持久化（settings.markOnboardingDismissed）。
 */
import { ref, computed, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { useSettingsStore } from "@/stores/settings";
import { testConnection } from "@/lib/electron-bridge";
import { translateError } from "@/lib/utils";

const emit = defineEmits<{
  /** 完成引导（API Key 已配置并测试通过） */
  finish: [];
  /** 跳过引导（不配置 API Key，稍后在设置中配置） */
  skip: [];
}>();

const { t } = useI18n();
const settings = useSettingsStore();

// ── 步骤状态机：1 输入 Key → 2 测试连接 → 3 完成 ──
const step = ref<1 | 2 | 3>(1);
// password 输入框明文切换（keyVisible=true 时显示明文）
const keyVisible = ref(false);
// 测试连接状态
const isTesting = ref(false);
const testSuccess = ref(false);
const testError = ref<string | null>(null);

// 最小展示时间（ms）：步骤 2 成功提示 / 步骤 3 完成页——防止流程一闪而过看不清（2026-08-10 用户反馈）
const STEP_OK_MIN_MS = 1500;
const STEP3_MIN_MS = 1500;
// 步骤 3 最小展示计时：进入后 step3Ready=false，满 STEP3_MIN_MS 才放开主按钮
const step3Ready = ref(false);
// 两个计时器统一引用，组件卸载时对称清理——skip 按钮全程可见，
// 用户在成功提示/完成页期间跳过后组件即被卸载，残留 timer 回调应一并清除
let step2Timer: ReturnType<typeof setTimeout> | null = null;
let step3Timer: ReturnType<typeof setTimeout> | null = null;
onUnmounted(() => {
  if (step2Timer) clearTimeout(step2Timer);
  if (step3Timer) clearTimeout(step3Timer);
});

const translatedTestError = computed(() => {
  if (!testError.value) return null;
  const { key, params } = translateError(testError.value);
  return t(key, params as Record<string, string>);
});

// 步骤 2 测试中/成功后均禁用主按钮（成功等待自动跳转时防止重复点击）；步骤 3 完成页满最小展示时间前禁用
const primaryDisabled = computed(() => {
  if (step.value === 1) return !settings.apiKey.trim() || isTesting.value;
  if (step.value === 2) return isTesting.value || testSuccess.value;
  return !step3Ready.value;
});

const primaryLabel = computed(() => {
  if (step.value === 1) return t("onboarding.test");
  if (step.value === 2) return isTesting.value ? t("onboarding.testing") : t("onboarding.retry");
  return t("onboarding.start");
});

/** 步骤 1/2 共用主按钮：测试连接（成功→自动完成页，失败→可重试） */
async function runTest() {
  if (primaryDisabled.value) return;
  step.value = 2;
  testError.value = null;
  testSuccess.value = false;
  isTesting.value = true;
  try {
    const r = await testConnection(settings.apiKey);
    if (r.ok) {
      testSuccess.value = true;
      // 显式保存配置到 SQLite + 重启 serve（settings watch 防抖也会存，此处确保退出引导前已落盘）
      // 保存顺序关键：先落盘制图师 kimi key（restart=false，不重启），再保存 deepseek key
      // （restart=true 重启 serve）——重启时 provider-configs.json 已含 moonshotai-cn，
      // 一次重启两个 provider 都生效；若 kimi 走 restart=true，moonshotai-cn 槽位
      // 在主进程 keyChanged 恒为 true（ipc.ts），会额外再重启一次 serve
      if (settings.kimiApiKey.trim()) {
        try { await settings.saveKimiKey(false); } catch { /* 后台静默，watch 防抖兜底 */ }
      }
      // restart=true：首次配置的 key 对运行中的 serve 是新的，不重启则发消息仍用无 key 的旧配置
      try { await settings.saveCurrentConfig(true); } catch { /* 后台静默，防抖 watch 兜底 */ }
      // 成功提示停留 STEP_OK_MIN_MS 让用户看清，再进入完成页
      step2Timer = setTimeout(() => {
        step.value = 3;
        step3Ready.value = false;
        step3Timer = setTimeout(() => { step3Ready.value = true; }, STEP3_MIN_MS);
      }, STEP_OK_MIN_MS);
    } else {
      testError.value = r.message;
    }
  } catch (err) {
    testError.value = String(err);
  } finally {
    isTesting.value = false;
  }
}

function finish() { emit("finish"); }
function skip() { emit("skip"); }
</script>

<template>
  <!-- 全屏遮罩：占满视口并盖住主界面，居中卡片 -->
  <div class="ob" role="dialog" aria-modal="true" aria-label="onboarding">
    <div class="ob-card">
      <!-- 顶部品牌区 -->
      <div class="ob-logo">
        <img src="/logo.svg" alt="分形" class="ob-mark" />
        <div>
          <h1>{{ $t('app.title') }}</h1>
          <div class="ob-sub">{{ $t('onboarding.subtitle') }}</div>
        </div>
      </div>

      <!-- 步骤指示：3 步，当前步高亮 -->
      <div class="ob-steps">
        <div class="ob-step" :class="{ active: step === 1, done: step > 1 }">1 · {{ $t('onboarding.step1') }}</div>
        <div class="ob-step" :class="{ active: step === 2, done: step > 2 }">2 · {{ $t('onboarding.step2') }}</div>
        <div class="ob-step" :class="{ active: step === 3 }">3 · {{ $t('onboarding.step3') }}</div>
      </div>

      <!-- 字段区：按步骤切换内容 -->
      <div class="ob-field">
        <!-- 步骤 1：输入 API Key -->
        <template v-if="step === 1">
          <label>{{ $t('onboarding.apiKeyLabel') }}</label>
          <div class="ob-key-wrap">
            <input
              v-model="settings.apiKey"
              :type="keyVisible ? 'text' : 'password'"
              :placeholder="$t('onboarding.apiKeyPlaceholder')"
              spellcheck="false"
              autocomplete="off"
              @keydown.enter="runTest"
            />
            <button
              class="ob-eye"
              :title="keyVisible ? $t('onboarding.hideKey') : $t('onboarding.showKey')"
              @click="keyVisible = !keyVisible"
            >
              <!-- 眼睛图标：闭眼 / 睁眼 -->
              <svg v-if="keyVisible" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/>
              </svg>
              <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>
              </svg>
            </button>
          </div>
          <div class="ob-hint">{{ $t('onboarding.apiKeyHint') }}</div>

          <!-- 制图师多模态 Key（选填）：VISION 槽位（kimi-k3）需要独立 provider key，不填则制图师不可用 -->
          <label class="ob-kimi-label">{{ $t('onboarding.kimiLabel') }}</label>
          <div class="ob-key-wrap">
            <input
              v-model="settings.kimiApiKey"
              type="password"
              :placeholder="$t('onboarding.kimiPlaceholder')"
              spellcheck="false"
              autocomplete="off"
              @keydown.enter="runTest"
            />
          </div>
          <div class="ob-hint">{{ $t('onboarding.kimiHint') }}</div>
        </template>

        <!-- 步骤 2：测试连接状态 -->
        <template v-else-if="step === 2">
          <div v-if="isTesting" class="ob-status ob-status--testing">
            <span class="ob-spinner" />
            <span>{{ $t('onboarding.testingHint') }}</span>
          </div>
          <div v-else-if="testSuccess" class="ob-status ob-status--ok">
            <span class="ob-status-icon">✓</span>
            <span>{{ $t('onboarding.success') }}</span>
          </div>
          <div v-else-if="translatedTestError" class="ob-status ob-status--err">
            <span class="ob-status-icon">✕</span>
            <span>{{ translatedTestError }}</span>
          </div>
        </template>

        <!-- 步骤 3：完成页 -->
        <template v-else>
          <div class="ob-success">
            <div class="ob-check">✓</div>
            <h2>{{ $t('onboarding.done') }}</h2>
            <p>{{ $t('onboarding.doneHint') }}</p>
          </div>
        </template>
      </div>

      <!-- 操作区：主按钮（步骤 1/2 测试连接、失败重试、步骤 3 开始使用） -->
      <div class="ob-actions">
        <button
          class="ob-primary"
          :disabled="primaryDisabled"
          @click="step === 3 ? finish() : runTest()"
        >
          <span v-if="isTesting" class="ob-spinner ob-spinner--btn" />
          {{ primaryLabel }}
        </button>
      </div>
    </div>

    <!-- 右上角跳过（faint 小字，稍后配置） -->
    <button class="ob-skip" @click="skip">{{ $t('onboarding.skip') }}</button>
  </div>
</template>

<style scoped>
/* 全屏遮罩：fixed 占满视口（z-index 需盖过 f-shell 顶栏），居中卡片 */
.ob {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-root);
}

/* 居中卡片：约 360px 宽，卡片底色 + 圆角 + 描边 */
.ob-card {
  width: 360px;
  max-width: 92vw;
  display: flex;
  flex-direction: column;
  gap: 24px;
  padding: 28px 26px 24px;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-pop);
  animation: ob-rise 0.3s ease-out;
}
@keyframes ob-rise {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}

/* 品牌区：logo + 标题 + 副标题 */
.ob-logo {
  display: flex;
  align-items: center;
  gap: 14px;
}
.ob-mark {
  width: 64px;
  height: 64px;
  border-radius: 16px;
  flex-shrink: 0;
}
.ob-logo h1 {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--text-bright);
}
.ob-sub {
  font-size: 12px;
  margin-top: 2px;
  color: var(--text-secondary);
}

/* 步骤指示：3 等宽步骤，当前步 accent 高亮 */
.ob-steps {
  display: flex;
  gap: 8px;
}
.ob-step {
  flex: 1;
  padding: 8px 6px;
  text-align: center;
  border-radius: 10px;
  font-size: 11.5px;
  color: var(--text-muted);
  border: 1px solid var(--border-dim);
  transition: all 0.25s;
}
.ob-step.active {
  border-color: var(--accent-line);
  color: var(--accent);
  background: var(--accent-glow);
}
.ob-step.done {
  border-color: var(--accent-line);
  color: var(--accent);
}

/* 字段区 */
.ob-field label {
  display: block;
  font-size: 12.5px;
  margin-bottom: 8px;
  color: var(--text-secondary);
}
.ob-key-wrap {
  position: relative;
}
.ob-key-wrap input {
  width: 100%;
  padding: 11px 38px 11px 14px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  color: var(--text-bright);
  font-size: 13px;
  font-family: var(--font-mono);
  outline: none;
  caret-color: var(--accent);
  transition: border-color 0.2s;
}
.ob-key-wrap input:focus {
  border-color: var(--accent-line);
}
/* 明文/密文切换按钮：absolute 定位到输入框右侧（父容器 relative 锚点） */
.ob-eye {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  color: var(--text-muted);
  cursor: pointer;
  transition: color 150ms, background 150ms;
}
.ob-eye:hover {
  color: var(--text-secondary);
  background: var(--bg-hover);
}
.ob-hint {
  margin-top: 8px;
  font-size: 11px;
  color: var(--text-muted);
}
/* 制图师 key 标签：与上方 deepseek 的 hint 之间留出分组间距（默认 label 紧贴 hint 太挤） */
.ob-kimi-label {
  margin-top: 14px;
}

/* 步骤 2 状态展示 */
.ob-status {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  border-radius: var(--radius-md);
  font-size: 12.5px;
}
.ob-status--testing {
  color: var(--text-secondary);
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
}
.ob-status--ok {
  color: var(--accent);
  background: var(--accent-glow);
  border: 1px solid var(--accent-line);
}
.ob-status--err {
  color: var(--coral);
  background: var(--coral-glow);
  border: 1px solid var(--coral);
  word-break: break-all;
}
.ob-status-icon {
  font-size: 14px;
  font-weight: 700;
  flex-shrink: 0;
}

/* 转圈 spinner：border 圆环旋转动画 */
.ob-spinner {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid var(--border-default);
  border-top-color: var(--accent);
  animation: ob-spin 0.8s linear infinite;
  flex-shrink: 0;
}
.ob-spinner--btn {
  width: 12px;
  height: 12px;
  border-width: 1.5px;
}
@keyframes ob-spin {
  to { transform: rotate(360deg); }
}

/* 步骤 3 完成页 */
.ob-success {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 18px 0 6px;
  text-align: center;
}
.ob-check {
  width: 60px;
  height: 60px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 26px;
  color: var(--accent);
  background: var(--accent-glow);
  border: 2px solid var(--accent-line);
}
.ob-success h2 {
  font-size: 17px;
  font-weight: 600;
  color: var(--text-bright);
}
.ob-success p {
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text-secondary);
}

/* 操作区：主按钮 accent 底白字 */
.ob-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
.ob-primary {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 11px 22px;
  border-radius: var(--radius-md);
  font-size: 13px;
  font-weight: 600;
  color: var(--bg-root);
  background: var(--accent);
  cursor: pointer;
  transition: opacity 150ms;
}
.ob-primary:hover:not(:disabled) {
  opacity: 0.85;
}
.ob-primary:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 右上角跳过：faint 小字（absolute 相对 .ob 全屏容器） */
.ob-skip {
  position: absolute;
  top: 18px;
  right: 22px;
  font-size: 12px;
  color: var(--text-muted);
  cursor: pointer;
  transition: color 150ms;
}
.ob-skip:hover {
  color: var(--text-secondary);
}
</style>
