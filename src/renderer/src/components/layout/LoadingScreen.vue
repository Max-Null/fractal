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
        <!-- 外层轨道（4 电子，最慢）：倾角 62° 近水平 -->
        <div class="si-orbit si-orbit--outer"><div class="si-spin si-spin--outer">
          <i class="si-e-pos" style="--d: 0deg"><i class="si-e" /></i><i class="si-e-pos" style="--d: 90deg"><i class="si-e" /></i><i class="si-e-pos" style="--d: 180deg"><i class="si-e" /></i><i class="si-e-pos" style="--d: 270deg"><i class="si-e" /></i>
        </div></div>
        <!-- 中层轨道（8 电子，中速）：绕 Y 偏转 14°（轨道平面错开，立体感） -->
        <div class="si-orbit si-orbit--mid"><div class="si-spin si-spin--mid">
          <i class="si-e-pos" style="--d: 0deg"><i class="si-e" /></i><i class="si-e-pos" style="--d: 45deg"><i class="si-e" /></i><i class="si-e-pos" style="--d: 90deg"><i class="si-e" /></i><i class="si-e-pos" style="--d: 135deg"><i class="si-e" /></i><i class="si-e-pos" style="--d: 180deg"><i class="si-e" /></i><i class="si-e-pos" style="--d: 225deg"><i class="si-e" /></i><i class="si-e-pos" style="--d: 270deg"><i class="si-e" /></i><i class="si-e-pos" style="--d: 315deg"><i class="si-e" /></i>
        </div></div>
        <!-- 内层轨道（2 电子，最快）：绕 Y 反向偏转 22°（与中层镜像错开） -->
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

/* ── CRT 扫描线微噪：2.5% 透明度水平细线（制图师 P2——3% 上限，再高就脏）── */
.boot::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: repeating-linear-gradient(to bottom, transparent 0 2px, rgba(148, 163, 184, 0.025) 2px 3px);
  z-index: 2;
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

/* ── Si 原子模型 v3：真 3D（preserve-3d）——参考 react-loading-indicator + fresh-portfolio 原子动画方案
   轨道 rotateX(80°) 近直立 + rotateY(0/120/240°) 三向分布（长轴互成 120°，教科书原子）；
   核不设 z-index → 参与 3D 深度排序，轨道穿核时前段盖核、后段被核盖（天然遮挡）── */
.si-atom {
  position: relative;
  width: 200px;
  height: 200px;
  perspective: 700px;
  transform-style: preserve-3d;
  /* 整体摇摆：观察者视角缓动，错层轨道立刻「活」起来（制图师 P1，2026-08-09） */
  animation: atom-wobble 12s ease-in-out infinite;
}
@keyframes atom-wobble {
  0%, 100% { transform: rotateY(-10deg); }
  50% { transform: rotateY(10deg); }
}

/* ── 轨道环 v3.1：scale 定半径层级 + 3D 摆放（rotateX 60° + rotateY 三向主轴互成 120°）──
   用户反馈三轮：rotateX 80° 投影过扁轨道不可见 → 60°；border 1px→1.5px 加亮 */
.si-orbit {
  position: absolute;
  inset: 0;
  border: 1.5px solid rgba(14, 165, 233, 0.5);
  border-radius: 50%;
  transform-style: preserve-3d;
  animation: orbit-breathe 6s ease-in-out infinite;
}
.si-orbit--outer { transform: scale(1) rotateX(60deg) rotateY(0deg); }
.si-orbit--mid { transform: scale(0.78) rotateX(60deg) rotateY(120deg); animation-delay: -2s; }
.si-orbit--inner { transform: scale(0.52) rotateX(60deg) rotateY(240deg); animation-delay: -4s; }
@keyframes orbit-breathe {
  0%, 100% { border-color: rgba(125, 211, 252, 0.3); }
  50% { border-color: rgba(125, 211, 252, 0.6); }
}

/* ── 公转：轨道平面内 rotateZ 0→360（动画覆盖 transform，keyframes 保留静态摆放）── */
.si-spin {
  position: absolute;
  inset: 0;
  animation: si-spin linear infinite;
  transform-style: preserve-3d;
}
.si-spin--outer { animation-name: si-spin-0; animation-duration: 11s; animation-delay: -2.6s; }
.si-spin--mid { animation-name: si-spin-120; animation-duration: 6.5s; animation-delay: -1.2s; }
.si-spin--inner { animation-name: si-spin-240; animation-duration: 3.2s; }
@keyframes si-spin-0 { from { transform: rotateZ(0deg); } to { transform: rotateZ(360deg); } }
@keyframes si-spin-120 { from { transform: rotateZ(0deg); } to { transform: rotateZ(360deg); } }
@keyframes si-spin-240 { from { transform: rotateZ(0deg); } to { transform: rotateZ(360deg); } }

/* ── 电子：位置层定起始角（rotate(--d) 绕轨道中心），电子在位置层顶部 ── */
.si-e-pos {
  position: absolute;
  inset: 0;
  transform: rotate(var(--d, 0deg));
}
/* 电子：反向补偿动画 + delay 与公转严格对齐（同 start 时刻 counter 才成立——
   用户反馈「电子几乎不见了」= delay 未对齐，补偿失效电子被压扁成线） */
.si-e {
  position: absolute;
  left: 50%;
  top: -5px;
  width: 8px;
  height: 8px;
  margin-left: -4px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 10px var(--accent), 0 0 4px #fff;
}
.si-orbit--outer .si-e { animation: e-fix-0 11s linear -2.6s infinite; width: 6px; height: 6px; margin-left: -3px; top: -4px; opacity: 0.85; }
.si-orbit--mid .si-e { animation: e-fix-120 6.5s linear -1.2s infinite; opacity: 0.9; }
.si-orbit--inner .si-e { animation: e-fix-240 3.2s linear 0s infinite; }
@keyframes e-fix-0 { from { transform: rotateY(0deg) rotateX(-60deg) rotateZ(0deg); } to { transform: rotateY(0deg) rotateX(-60deg) rotateZ(-360deg); } }
@keyframes e-fix-120 { from { transform: rotateY(-120deg) rotateX(-60deg) rotateZ(0deg); } to { transform: rotateY(-120deg) rotateX(-60deg) rotateZ(-360deg); } }
@keyframes e-fix-240 { from { transform: rotateY(-240deg) rotateX(-60deg) rotateZ(0deg); } to { transform: rotateY(-240deg) rotateX(-60deg) rotateZ(-360deg); } }

/* ── 原子核 = 眼睛（logo 同款瞳孔）：虹膜容器 + 会「到处看」的瞳孔 ──
   v3.1：去 overflow hidden（瞳孔 22px 移动 ±9px 不越界 46px 核——原为防越界，实为多余）；
   去 box-shadow 呼吸辉光（preserve-3d 下被裁剪，用户反馈「左/上被切掉」）→ 辉光改伪元素 */
.si-nucleus {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 46px;
  height: 46px;
  margin: -23px 0 0 -23px;
  border-radius: 50%;
  /* 描边 + 内阴影：球体感而非平面圆（制图师 P1，2026-08-09） */
  border: 1px solid rgba(56, 189, 248, 0.35);
  background: radial-gradient(circle at 35% 30%, #0b4a75, #0369a1 55%, #075985);
  box-shadow: inset 0 0 10px rgba(0, 0, 0, 0.55), inset 0 2px 6px rgba(255, 255, 255, 0.12);
  /* v3 真 3D：不设 z-index（参与 preserve-3d 深度排序，轨道穿核时天然前后遮挡）；
     translateZ(0) 锚定核到 z=0 平面 */
  transform: translateZ(0);
}
/* 核辉光：独立伪元素 radial-gradient（呼吸动画在伪元素上，不被 3D 裁剪） */
.si-nucleus::after {
  content: '';
  position: absolute;
  inset: -16px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(14, 165, 233, 0.45), transparent 62%);
  animation: nucleus-glow 2.6s ease-in-out infinite;
  z-index: -1;
}
@keyframes nucleus-glow {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
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
/* 高光：光源反射固定在虹膜左上（瞳孔移动时高光不动——光源方向不变，用户指正 2026-08-09） */
.si-glint {
  position: absolute;
  left: 7px;
  top: 6px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.95);
  box-shadow: 0 0 5px rgba(255, 255, 255, 0.9), 0 0 12px rgba(255, 255, 255, 0.4);
}

/* ── 全息底座：原子下方淡光晕（投影盘感，锚定空间，制图师 P2）——translateZ(-40px) 放核后（3D 场景内）── */
.si-atom::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: 4px;
  width: 180px;
  height: 26px;
  transform: translateX(-50%) translateZ(-40px);
  border-radius: 50%;
  background: radial-gradient(ellipse, rgba(56, 189, 248, 0.10), transparent 70%);
  filter: blur(2px);
}

/* ── 轨道呼吸：边框亮度缓慢脉动（全息感，制图师 P2）── */
.si-orbit {
  animation: orbit-breathe 6s ease-in-out infinite;
}
.si-orbit--mid { animation-delay: -2s; }
.si-orbit--inner { animation-delay: -4s; }
@keyframes orbit-breathe {
  0%, 100% { border-color: rgba(125, 211, 252, 0.22); }
  50% { border-color: rgba(125, 211, 252, 0.5); }
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
