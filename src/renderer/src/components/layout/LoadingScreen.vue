<script setup lang="ts">
/**
 * 启动载入画面（赛博科幻风）：分形 logo 呼吸辉光 + 阶段进度条 + 假终端日志滚动。
 * 数据由 AppShell 串行启动链驱动（bootStage/bootPercent/bootTimedOut），本组件只做渲染与装饰。
 */
import { computed } from 'vue'

const props = defineProps<{
  /** 启动阶段（AppShell 串行链维护）：local（本地配置）→ engine（引擎就绪）→ sessions（会话列表）→ done/timeout */
  stage: 'local' | 'engine' | 'sessions' | 'done' | 'timeout'
  /** 进度百分比（0-100） */
  percent: number
  /** 引擎 15s 未就绪超时（显示降级提示） */
  timedOut: boolean
  /** 真实启动阶段日志行（AppShell 串行链逐步 push，驱动逐行出现动画） */
  logs: Array<{ text: string; decor?: boolean }>
}>()

// 装饰性「代码行」：赛博氛围用的假终端输出（纯展示，不伪造任何系统信息）
const DECOR_LINES = [
  '$ fractal init --core v0.1.0',
  '$ opencode serve --port 51888',
  '[ok] 校验引擎完整性 sha256 … 通过',
  '[ok] 建立事件通道 … connected',
  '[ok] 索引记忆区块 … 42 blocks',
  '[ok] 恢复工作区 … fractal',
]

// 装饰行随真实日志条数渐进出现（第 2 条真实行配 1 行装饰，以此类推）——
// 效果：真实阶段文案与假代码交替滑入，进度感 + 赛博氛围
const stageLines = computed(() => {
  const decorCount = Math.max(0, Math.min(props.logs.length - 1, DECOR_LINES.length))
  return [...props.logs, ...DECOR_LINES.slice(0, decorCount).map((t) => ({ text: t, decor: true }))]
})
</script>

<template>
  <div class="boot">
    <!-- 赛博网格背景（缓慢向下滚动） -->
    <div class="boot-grid" aria-hidden="true" />
    <!-- 顶部扫描光带 -->
    <div class="boot-scan" aria-hidden="true" />

    <div class="boot-center">
      <!-- Si 原子模型（硅基之心）：核=瞳孔 + 2-8-4 三层电子轨道公转——呼应 logo 的 Si 原子设计 -->
      <div class="si-atom" aria-hidden="true">
        <span class="si-label">Si</span>
        <!-- 外层轨道（4 电子，最慢）：si-e-pos 定起始角，si-spin 层公转 -->
        <div class="si-orbit si-orbit--outer"><div class="si-spin si-spin--outer">
          <i class="si-e-pos" style="--d: 0deg"><i class="si-e" /></i><i class="si-e-pos" style="--d: 90deg"><i class="si-e" /></i><i class="si-e-pos" style="--d: 180deg"><i class="si-e" /></i><i class="si-e-pos" style="--d: 270deg"><i class="si-e" /></i>
        </div></div>
        <!-- 中层轨道（8 电子，中速） -->
        <div class="si-orbit si-orbit--mid"><div class="si-spin si-spin--mid">
          <i class="si-e-pos" style="--d: 0deg"><i class="si-e" /></i><i class="si-e-pos" style="--d: 45deg"><i class="si-e" /></i><i class="si-e-pos" style="--d: 90deg"><i class="si-e" /></i><i class="si-e-pos" style="--d: 135deg"><i class="si-e" /></i><i class="si-e-pos" style="--d: 180deg"><i class="si-e" /></i><i class="si-e-pos" style="--d: 225deg"><i class="si-e" /></i><i class="si-e-pos" style="--d: 270deg"><i class="si-e" /></i><i class="si-e-pos" style="--d: 315deg"><i class="si-e" /></i>
        </div></div>
        <!-- 内层轨道（2 电子，最快） -->
        <div class="si-orbit si-orbit--inner"><div class="si-spin si-spin--inner">
          <i class="si-e-pos" style="--d: 0deg"><i class="si-e" /></i><i class="si-e-pos" style="--d: 180deg"><i class="si-e" /></i>
        </div></div>
        <!-- 原子核 = 瞳孔（logo 同款：虹膜深蓝 + 瞳孔天蓝 + 高光） -->
        <div class="si-nucleus"><span class="si-pupil" /><span class="si-glint" /></div>
      </div>

      <!-- 进度条：accent 渐变 + 前端光点 -->
      <div class="boot-progress" role="progressbar" :aria-valuenow="percent" aria-valuemin="0" aria-valuemax="100">
        <div class="boot-progress-fill" :style="{ width: percent + '%' }" />
        <span class="boot-progress-pct">{{ percent }}%</span>
      </div>

      <!-- 假终端日志区：真实阶段文案 + 装饰代码行 -->
      <div class="boot-terminal" aria-label="启动日志">
        <div v-for="(l, i) in stageLines" :key="i" class="boot-line" :class="{ 'boot-line--decor': l.decor }">
          <span v-if="l.decor" class="boot-caret">›</span>
          <span v-else class="boot-caret boot-caret--accent">▶</span>
          {{ l.text }}
        </div>
        <!-- 行尾光标（打字机感） -->
        <span class="boot-cursor" />
      </div>

      <!-- 引擎超时降级提示 -->
      <span v-if="timedOut" class="boot-timeout">{{ $t('chat.engineNotReady') }}</span>
    </div>

    <div class="boot-footer">分形 v0.1.0 · OC 引擎 v1.18.15</div>
  </div>
</template>

<style scoped>
/* ── 容器：全屏覆盖（替换 AppShell 旧 initializing 界面）── */
.boot {
  position: fixed;
  inset: 0;
  z-index: 999;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 22px;
  background: var(--bg-root);
  overflow: hidden;
}

/* ── 赛博网格背景：细线十字格缓慢向下滚动（视差感）── */
.boot-grid {
  position: absolute;
  inset: -50%;
  background-image:
    linear-gradient(rgba(94, 234, 212, 0.06) 1px, transparent 1px),
    linear-gradient(90deg, rgba(94, 234, 212, 0.06) 1px, transparent 1px);
  background-size: 34px 34px;
  animation: boot-grid-scroll 2.6s linear infinite;
}
@keyframes boot-grid-scroll {
  from { transform: translateY(0); }
  to { transform: translateY(34px); }
}

/* ── 顶部扫描光带：上下缓慢浮动（CRT 扫描感）── */
.boot-scan {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 72px;
  background: linear-gradient(to bottom, rgba(94, 234, 212, 0.09), transparent);
  animation: boot-scan-float 3.8s ease-in-out infinite alternate;
}
@keyframes boot-scan-float {
  from { transform: translateY(-72px); opacity: 0.5; }
  to { transform: translateY(0); opacity: 1; }
}

.boot-center {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  z-index: 1;
}

/* ── Si 原子模型：核=瞳孔 + 2-8-4 三层电子轨道（呼应 logo 硅基设计）── */
.si-atom {
  position: relative;
  width: 200px;
  height: 200px;
  perspective: 700px;
}
/* 元素符号角标：右上角 mono 小字（硅 · Si） */
.si-label {
  position: absolute;
  top: 0;
  right: 4px;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
  text-shadow: 0 0 8px var(--accent-glow);
  z-index: 3;
}

/* ── 轨道环：rotateX 压扁成椭圆投影，inset 决定半径层级 ── */
.si-orbit {
  position: absolute;
  border: 1px solid rgba(14, 165, 233, 0.4);
  border-radius: 50%;
  transform: rotateX(63deg);
}
.si-orbit--outer { inset: 0; }
.si-orbit--mid { inset: 11%; }
.si-orbit--inner { inset: 24%; }

/* ── 旋转层：绕 z 公转（不同壳层不同速度 + 错位起始角）── */
.si-spin {
  position: absolute;
  inset: 0;
  animation: si-spin linear infinite;
}
.si-spin--outer { animation-duration: 11s; animation-delay: -2.6s; }
.si-spin--mid { animation-duration: 6.5s; animation-delay: -1.2s; }
.si-spin--inner { animation-duration: 3.2s; }
@keyframes si-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

/* ── 电子：位置层定起始角（rotate(--d) 绕轨道中心），电子在位置层顶部 ── */
.si-e-pos {
  position: absolute;
  inset: 0;
  transform: rotate(var(--d, 0deg));
}
.si-e {
  position: absolute;
  left: 50%;
  top: -4px;
  width: 8px;
  height: 8px;
  margin-left: -4px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 10px var(--accent), 0 0 4px #fff;
}
.si-orbit--outer .si-e { width: 6px; height: 6px; margin-left: -3px; top: -3px; opacity: 0.85; }
.si-orbit--mid .si-e { opacity: 0.9; }

/* ── 原子核 = 眼睛（logo 同款瞳孔）：虹膜容器 + 会「到处看」的瞳孔 ── */
.si-nucleus {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 46px;
  height: 46px;
  margin: -23px 0 0 -23px;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 30%, #0b4a75, #0369a1 55%, #075985);
  box-shadow: 0 0 18px rgba(14, 165, 233, 0.55), inset 0 0 8px rgba(0, 0, 0, 0.5);
  overflow: hidden;
  z-index: 2;
  animation: si-nucleus-breathe 2.6s ease-in-out infinite;
}
@keyframes si-nucleus-breathe {
  0%, 100% { box-shadow: 0 0 14px rgba(14, 165, 233, 0.5), inset 0 0 8px rgba(0, 0, 0, 0.5); }
  50% { box-shadow: 0 0 30px rgba(14, 165, 233, 0.9), inset 0 0 8px rgba(0, 0, 0, 0.5); }
}
/* 瞳孔：天蓝圆点 + 「环顾」扫视动画（8 方向平滑循环 = 到处看） */
.si-pupil {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 22px;
  height: 22px;
  margin: -11px 0 0 -11px;
  border-radius: 50%;
  background: radial-gradient(circle at 40% 35%, #38bdf8, #0ea5e9 60%, #0284c7);
  animation: eye-look 6.5s ease-in-out infinite;
}
@keyframes eye-look {
  0%   { transform: translate(0, 0); }
  10%  { transform: translate(-8px, -5px); }   /* 左上 */
  22%  { transform: translate(2px, -9px); }    /* 上 */
  34%  { transform: translate(9px, -3px); }    /* 右上 */
  46%  { transform: translate(9px, 6px); }     /* 右下 */
  58%  { transform: translate(0, 9px); }       /* 下 */
  70%  { transform: translate(-9px, 4px); }    /* 左下 */
  82%  { transform: translate(-7px, -6px); }   /* 左 */
  92%  { transform: translate(0, 0); }
  100% { transform: translate(0, 0); }
}
/* 高光：瞳孔内随动（瞳孔移动即跟随） */
.si-glint {
  position: absolute;
  left: 5px;
  top: 4px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.95);
  box-shadow: 0 0 6px rgba(255, 255, 255, 0.8);
  animation: eye-look 6.5s ease-in-out infinite;
}

/* ── 进度条：accent 渐变填充 + 前端光点 ── */
.boot-progress {
  position: relative;
  width: 280px;
  height: 5px;
  border-radius: 3px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-dim);
  overflow: visible;
}
.boot-progress-fill {
  height: 100%;
  border-radius: 3px;
  background: linear-gradient(90deg, var(--accent-glow), var(--accent));
  box-shadow: 0 0 10px var(--accent-glow);
  transition: width 0.45s ease;
  position: relative;
}
/* 前端光点：白色亮点 + 弥散（扫过感） */
.boot-progress-fill::after {
  content: '';
  position: absolute;
  right: 0;
  top: 50%;
  width: 7px;
  height: 7px;
  transform: translate(50%, -50%);
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 0 8px var(--accent);
}
.boot-progress-pct {
  position: absolute;
  right: -34px;
  top: 50%;
  transform: translateY(-50%);
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  color: var(--text-muted);
}

/* ── 假终端日志：mono 等宽 + 逐行滑入 ── */
.boot-terminal {
  width: 320px;
  height: 150px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid var(--border-dim);
  font-family: var(--font-mono, monospace);
  font-size: 10.5px;
  line-height: 1.75;
  color: var(--text-muted);
  overflow: hidden;
  text-align: left;
  box-shadow: inset 0 0 24px rgba(0, 0, 0, 0.5);
}
.boot-line {
  animation: boot-line-in 220ms ease-out both;
  white-space: nowrap;
}
.boot-line--decor { color: rgba(148, 163, 184, 0.55); }
.boot-caret { margin-right: 6px; color: var(--text-muted); }
.boot-caret--accent { color: var(--accent); text-shadow: 0 0 6px var(--accent-glow); }
@keyframes boot-line-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
/* 行尾光标：闪烁方块（打字机感） */
.boot-cursor {
  display: inline-block;
  width: 6px;
  height: 10px;
  margin-top: 3px;
  background: var(--accent);
  box-shadow: 0 0 6px var(--accent);
  animation: boot-cursor-blink 0.9s steps(2) infinite;
  vertical-align: middle;
}
@keyframes boot-cursor-blink {
  0%, 50% { opacity: 1; }
  51%, 100% { opacity: 0; }
}

.boot-timeout {
  font-size: 11px;
  color: var(--el-color-danger);
}

.boot-footer {
  position: absolute;
  bottom: 18px;
  font-size: 10px;
  font-family: var(--font-mono, monospace);
  color: rgba(148, 163, 184, 0.45);
}
</style>
