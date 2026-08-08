<script setup lang="ts">
/**
 * 启动载入画面（赛博科幻风）：分形 logo 呼吸辉光 + 阶段进度条 + 假终端日志滚动。
 * 数据由 AppShell 串行启动链驱动（bootStage/bootPercent/bootTimedOut），本组件只做渲染与装饰。
 */
import { computed, ref, onMounted, onUnmounted } from 'vue'

// ── Canvas 3D Si 原子渲染（数学投影，2026-08-09）──
// CSS 平面圆在 3D 里必然被压扁（用户实测不可见）；Canvas 画径向渐变球体 +
// 旋转矩阵投影（近大远小）+ z 分层遮挡（后段电子先画在核下/前段后画在核上）——任意角度都是圆
const ATOM_W = 460 // canvas 物理尺寸（230css × 2 DPR）
const ATOM_H = 460
const ATOM_CX = 230
const ATOM_CY = 230
const ATOM_ROT_X = Math.PI * 0.42 // 俯视角（轨道椭圆开口）
const ATOM_PERSP = 560 // 透视距离
const ATOM_WOBBLE_AMP = 0.16 // 整体摇摆 ±9.2°
// 轨道：r 半径 / tiltY 主轴（绕 Y 0/120/240°）/ speed 公转速度 / n 电子数 / phase 起始角
const ATOM_ORBITS = [
  { r: 100, tiltY: 0, speed: 0.5, n: 4, phase: 0 },
  { r: 78, tiltY: 2.094, speed: 0.9, n: 8, phase: 0.4 },
  { r: 52, tiltY: 4.189, speed: 1.95, n: 2, phase: 1.2 },
]
const ATOM_NUCLEUS_R = 25
const ATOM_PUPIL_R = 12

function atomOrbitPoint(r: number, tiltY: number, theta: number): [number, number, number] {
  // 轨道圆在 XY 平面，绕 Y 轴 tiltY 旋转（主轴朝向）→ 3D 坐标
  const x = r * Math.cos(theta)
  const y = r * Math.sin(theta)
  return [x * Math.cos(tiltY), y, -x * Math.sin(tiltY)]
}
function atomProject(p: [number, number, number], wobble: number) {
  // 绕 Y（摇摆）→ 绕 X（俯视）→ 透视除法（近大远小）
  const [x, y, z] = p
  const x1 = x * Math.cos(wobble) + z * Math.sin(wobble)
  const z1 = -x * Math.sin(wobble) + z * Math.cos(wobble)
  const y1 = y * Math.cos(ATOM_ROT_X) - z1 * Math.sin(ATOM_ROT_X)
  const z2 = y * Math.sin(ATOM_ROT_X) + z1 * Math.cos(ATOM_ROT_X)
  const scale = ATOM_PERSP / (ATOM_PERSP + z2)
  return { x: ATOM_CX + x1 * scale, y: ATOM_CY + y1 * scale, z: z2, s: scale }
}
// 轨道分段绘制（z<=0 后段 / z>0 前段）——核夹在中间形成前后遮挡
function atomDrawOrbit(ctx: CanvasRenderingContext2D, o: (typeof ATOM_ORBITS)[number], wobble: number, alpha: number, back: boolean) {
  ctx.beginPath()
  ctx.strokeStyle = `rgba(125, 211, 252, ${alpha * (back ? 0.75 : 1)})`
  ctx.lineWidth = 1.6
  let started = false
  for (let i = 0; i <= 72; i++) {
    const pr = atomProject(atomOrbitPoint(o.r, o.tiltY, (i / 72) * Math.PI * 2), wobble)
    const match = back ? pr.z <= 0 : pr.z > 0
    if (match) {
      if (!started) { ctx.moveTo(pr.x, pr.y); started = true }
      else ctx.lineTo(pr.x, pr.y)
    } else started = false
  }
  ctx.stroke()
}
// 电子球体（径向渐变 + 辉光，大小 × 投影 scale = 近大远小）
function atomDrawElectron(ctx: CanvasRenderingContext2D, o: (typeof ATOM_ORBITS)[number], pr: ReturnType<typeof atomProject>) {
  const r = (o.r > 90 ? 4.2 : 5) * pr.s
  const g = ctx.createRadialGradient(pr.x - r * 0.35, pr.y - r * 0.35, r * 0.15, pr.x, pr.y, r)
  g.addColorStop(0, '#7dd3fc')
  g.addColorStop(0.55, '#0ea5e9')
  g.addColorStop(1, '#075985')
  ctx.beginPath(); ctx.arc(pr.x, pr.y, r, 0, Math.PI * 2); ctx.fillStyle = g; ctx.fill()
  ctx.beginPath(); ctx.arc(pr.x, pr.y, r * 2.1, 0, Math.PI * 2)
  ctx.fillStyle = `rgba(14, 165, 233, ${0.22 * pr.s})`; ctx.fill()
}
// 核（眼睛）：虹膜 + 瞳孔环顾 + 高光固定 + 辉光呼吸
function atomDrawNucleus(ctx: CanvasRenderingContext2D, s: number) {
  const glow = 0.5 + 0.5 * Math.sin(s * 2.4)
  const gg = ctx.createRadialGradient(ATOM_CX, ATOM_CY, ATOM_NUCLEUS_R * 0.4, ATOM_CX, ATOM_CY, ATOM_NUCLEUS_R * 2.2)
  gg.addColorStop(0, `rgba(14, 165, 233, ${0.38 * glow})`)
  gg.addColorStop(1, 'rgba(14, 165, 233, 0)')
  ctx.beginPath(); ctx.arc(ATOM_CX, ATOM_CY, ATOM_NUCLEUS_R * 2.2, 0, Math.PI * 2); ctx.fillStyle = gg; ctx.fill()
  const ig = ctx.createRadialGradient(ATOM_CX - 8, ATOM_CY - 9, 3, ATOM_CX, ATOM_CY, ATOM_NUCLEUS_R)
  ig.addColorStop(0, '#0b4a75'); ig.addColorStop(0.55, '#0369a1'); ig.addColorStop(1, '#075985')
  ctx.beginPath(); ctx.arc(ATOM_CX, ATOM_CY, ATOM_NUCLEUS_R, 0, Math.PI * 2); ctx.fillStyle = ig; ctx.fill()
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.35)'; ctx.lineWidth = 1; ctx.stroke()
  // 瞳孔环顾（sin/cos 不同频率组合 = 到处看）
  const px = ATOM_CX + Math.sin(s * 0.9) * 9
  const py = ATOM_CY + Math.cos(s * 1.3) * 9
  const pg = ctx.createRadialGradient(px - 3, py - 3, 2, px, py, ATOM_PUPIL_R)
  pg.addColorStop(0, '#38bdf8'); pg.addColorStop(0.6, '#0ea5e9'); pg.addColorStop(1, '#0284c7')
  ctx.beginPath(); ctx.arc(px, py, ATOM_PUPIL_R, 0, Math.PI * 2); ctx.fillStyle = pg; ctx.fill()
  // 高光固定（光源不动）
  ctx.beginPath(); ctx.arc(ATOM_CX - 11, ATOM_CY - 11, 4.5, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.95)'; ctx.fill()
  ctx.beginPath(); ctx.arc(ATOM_CX - 11, ATOM_CY - 11, 7, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.18)'; ctx.fill()
}
// 底座：与核辉光同步闪烁
function atomDrawBase(ctx: CanvasRenderingContext2D, s: number) {
  const glow = 0.5 + 0.5 * Math.sin(s * 2.4)
  const g = ctx.createRadialGradient(ATOM_CX, ATOM_CY + 108, 5, ATOM_CX, ATOM_CY + 108, 66)
  g.addColorStop(0, `rgba(56, 189, 248, ${0.14 * (0.6 + 0.4 * glow)})`)
  g.addColorStop(1, 'rgba(56, 189, 248, 0)')
  ctx.beginPath(); ctx.ellipse(ATOM_CX, ATOM_CY + 108, 66, 13, 0, 0, Math.PI * 2); ctx.fillStyle = g; ctx.fill()
}
function atomFrame(ctx: CanvasRenderingContext2D, s: number) {
  ctx.clearRect(0, 0, ATOM_W, ATOM_H)
  const wobble = Math.sin(s * 0.52) * ATOM_WOBBLE_AMP
  const glow = 0.5 + 0.5 * Math.sin(s * 2.4)
  const orbitAlpha = 0.3 + 0.3 * glow
  atomDrawBase(ctx, s)
  const backE: Array<{ o: (typeof ATOM_ORBITS)[number]; pr: ReturnType<typeof atomProject> }> = []
  const frontE: typeof backE = []
  for (const o of ATOM_ORBITS) {
    atomDrawOrbit(ctx, o, wobble, orbitAlpha, true)
    for (let i = 0; i < o.n; i++) {
      const pr = atomProject(atomOrbitPoint(o.r, o.tiltY, o.phase + s * o.speed + (i / o.n) * Math.PI * 2), wobble)
      ;(pr.z <= 0 ? backE : frontE).push({ o, pr })
    }
  }
  for (const e of backE) atomDrawElectron(ctx, e.o, e.pr) // 后段电子（核下）
  atomDrawNucleus(ctx, s) // 核
  for (const e of frontE) atomDrawElectron(ctx, e.o, e.pr) // 前段电子（核上）
  for (const o of ATOM_ORBITS) atomDrawOrbit(ctx, o, wobble, orbitAlpha, false) // 轨道前段
}

const atomCanvasRef = ref<HTMLCanvasElement | null>(null)
let atomRaf = 0
let atomStart = 0
function startAtom() {
  const canvas = atomCanvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  // 注意：不 scale！坐标系保持 460×460 物理像素（ATOM_CX=230 即画布中心），CSS width:100% 缩到 230css 显示——
  // scale(2) 会把坐标系压成 0..230，原子画到右下角（2026-08-09 实测）
  atomStart = performance.now()
  const loop = (now: number) => { atomFrame(ctx, (now - atomStart) / 1000); atomRaf = requestAnimationFrame(loop) }
  atomRaf = requestAnimationFrame(loop)
}
onMounted(startAtom)
onUnmounted(() => cancelAnimationFrame(atomRaf))

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
      <!-- Si 原子：Canvas 3D（电子=径向渐变球体 + 近大远小 + z 分层遮挡 + 眼睛环顾）——
           CSS 平面圆 3D 压扁问题改数学投影渲染（2026-08-09 用户建议） -->
      <div class="si-atom" aria-hidden="true">
        <canvas ref="atomCanvasRef" width="460" height="460" />
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

/* ── Si 原子：Canvas 3D 容器（渲染逻辑在 script；物理 460px = 230css × 2 DPR）── */
.si-atom {
  position: relative;
  width: 230px;
  height: 230px;
}
.si-atom canvas {
  display: block;
  width: 100%;
  height: 100%;
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
