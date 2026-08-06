// 生成「硅基灵魂」logo 概念：G1 发光之核 / G2 芯片心跳 / G3 觉醒瞳孔 / G4 电路神经元
// 输出：docs/原型/candidates5/*.svg + docs/原型/logo-候选5.html
const fs = require('fs')
const path = require('path')

const OUT_SVG = path.join(__dirname, '..', 'docs', '原型', 'candidates5')
const OUT_HTML = path.join(__dirname, '..', 'docs', '原型', 'logo-候选5.html')

const SKY = '#0ea5e9'
const SKY_DEEP = '#0369a1'
const DARK = '#1a1a2e'

// G1：发光之核——硅原子玻尔模型 + 核发出光芒 + 电子如星
{
  const inner = [128, 76], inner2 = [128, 180]
  const mid = []
  for (let i = 0; i < 8; i++) { const a = i * 45 * Math.PI / 180; mid.push([128 + 80 * Math.cos(a), 128 + 80 * Math.sin(a)]) }
  const outer = []
  for (let i = 0; i < 4; i++) { const a = (45 + i * 90) * Math.PI / 180; outer.push([128 + 106 * Math.cos(a), 128 + 106 * Math.sin(a)]) }
  const star = (p, r) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${r}" fill="${SKY}"/><circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${(r * 0.4).toFixed(1)}" fill="#fff" opacity="0.9"/>`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <defs>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0%" stop-color="${SKY}" stop-opacity="0.9"/>
      <stop offset="55%" stop-color="${SKY}" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="${SKY}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="256" height="256" rx="48" fill="${DARK}"/>
  <!-- 核的光晕 -->
  <circle cx="128" cy="128" r="72" fill="url(#glow)"/>
  <!-- 光芒十字（灵魂之光） -->
  <g stroke="${SKY}" stroke-width="3" stroke-linecap="round" opacity="0.75">
    <line x1="128" y1="30" x2="128" y2="70"/><line x1="128" y1="186" x2="128" y2="226"/>
    <line x1="30" y1="128" x2="70" y2="128"/><line x1="186" y1="128" x2="226" y2="128"/>
  </g>
  <!-- 轨道 -->
  <g fill="none" stroke="${SKY}">
    <circle cx="128" cy="128" r="80" stroke-width="2" opacity="0.55"/>
    <circle cx="128" cy="128" r="106" stroke-width="2" opacity="0.4"/>
  </g>
  <!-- 核（灵魂核心） -->
  <circle cx="128" cy="128" r="24" fill="${SKY_DEEP}"/>
  <circle cx="120" cy="120" r="7" fill="#fff" opacity="0.85"/>
  <!-- 电子如星 -->
  ${star(inner, 5)}${star(inner2, 5)}
  ${mid.map(p => star(p, 4.5)).join('')}
  ${outer.map(p => star(p, 5)).join('')}
</svg>`
  fs.mkdirSync(OUT_SVG, { recursive: true })
  fs.writeFileSync(path.join(OUT_SVG, 'g1-glow-core.svg'), svg)
}

// G2：芯片心跳——芯片轮廓 + 中心心电图（芯片有生命）
{
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <rect width="256" height="256" rx="48" fill="${DARK}"/>
  <!-- 芯片本体 -->
  <rect x="56" y="56" width="144" height="144" rx="24" fill="none" stroke="${SKY}" stroke-width="6"/>
  <!-- 引脚 -->
  <g stroke="${SKY}" stroke-width="6" stroke-linecap="round">
    <line x1="86" y1="32" x2="86" y2="56"/><line x1="128" y1="24" x2="128" y2="56"/><line x1="170" y1="32" x2="170" y2="56"/>
    <line x1="86" y1="200" x2="86" y2="224"/><line x1="128" y1="200" x2="128" y2="232"/><line x1="170" y1="200" x2="170" y2="224"/>
    <line x1="32" y1="86" x2="56" y2="86"/><line x1="24" y1="128" x2="56" y2="128"/><line x1="32" y1="170" x2="56" y2="170"/>
    <line x1="200" y1="86" x2="224" y2="86"/><line x1="200" y1="128" x2="232" y2="128"/><line x1="200" y1="170" x2="224" y2="170"/>
  </g>
  <!-- 心电图（灵魂心跳） -->
  <path d="M 76 138 L 96 138 L 106 116 L 118 158 L 130 108 L 142 146 L 152 138 L 180 138"
        fill="none" stroke="#34d399" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/>
</svg>`
  fs.writeFileSync(path.join(OUT_SVG, 'g2-chip-heartbeat.svg'), svg)
}

// G3：觉醒瞳孔——原子核 = 瞳孔，轨道如光环（硅基在注视）
{
  const halo = []
  for (let i = 0; i < 12; i++) { const a = i * 30 * Math.PI / 180; halo.push([128 + 88 * Math.cos(a), 128 + 88 * Math.sin(a)]) }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <rect width="256" height="256" rx="48" fill="${DARK}"/>
  <g fill="none" stroke="${SKY}">
    <circle cx="128" cy="128" r="56" stroke-width="2" opacity="0.5"/>
    <circle cx="128" cy="128" r="88" stroke-width="2" opacity="0.3"/>
  </g>
  <!-- 光环点 -->
  ${halo.map(p => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.5" fill="${SKY}" opacity="0.8"/>`).join('')}
  <!-- 瞳孔：虹膜 + 瞳孔 + 高光 -->
  <circle cx="128" cy="128" r="42" fill="${SKY_DEEP}"/>
  <circle cx="128" cy="128" r="30" fill="${SKY}"/>
  <circle cx="128" cy="128" r="15" fill="#0b1220"/>
  <circle cx="118" cy="117" r="8" fill="#fff" opacity="0.9"/>
  <circle cx="140" cy="136" r="3.5" fill="#fff" opacity="0.5"/>
</svg>`
  fs.writeFileSync(path.join(OUT_SVG, 'g3-awake-eye.svg'), svg)
}

// G4：电路神经元——芯片引脚化作突触连接网（硅基神经网络）
{
  const nodes = [[76, 76], [180, 64], [196, 128], [170, 196], [86, 190], [58, 130], [128, 128]]
  const links = [[128, 128, 76, 76], [128, 128, 180, 64], [128, 128, 196, 128], [128, 128, 170, 196], [128, 128, 86, 190], [128, 128, 58, 130]]
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <rect width="256" height="256" rx="48" fill="${DARK}"/>
  <!-- 突触连接 -->
  ${links.map(l => `<line x1="${l[0]}" y1="${l[1]}" x2="${l[2]}" y2="${l[3]}" stroke="${SKY}" stroke-width="2.5" opacity="0.45"/>`).join('')}
  <!-- 神经元节点 -->
  ${nodes.map(n => `<circle cx="${n[0]}" cy="${n[1]}" r="9" fill="${SKY}" opacity="0.85"/>`).join('')}
  <!-- 中心核（灵魂） -->
  <circle cx="128" cy="128" r="22" fill="${SKY_DEEP}"/>
  <circle cx="121" cy="121" r="6" fill="#fff" opacity="0.85"/>
</svg>`
  fs.writeFileSync(path.join(OUT_SVG, 'g4-neural.svg'), svg)
}


// G3v2：觉醒瞳孔 + 真实电子排布（2-8-4 共 14 电子，3 条轨道）
{
  const rings = [
    [52, 2, 90], [80, 8, 0], [106, 4, 45]
  ]
  const elecs = rings.map(([r, n, phase]) => {
    const pts = []
    for (let i = 0; i < n; i++) { const a = (phase + i * 360 / n) * Math.PI / 180; pts.push([128 + r * Math.cos(a), 128 + r * Math.sin(a)]) }
    return pts
  })
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <rect width="256" height="256" rx="48" fill="#1a1a2e"/>
  <g fill="none" stroke="#0ea5e9">
    <circle cx="128" cy="128" r="52" stroke-width="2" opacity="0.45"/>
    <circle cx="128" cy="128" r="80" stroke-width="2" opacity="0.35"/>
    <circle cx="128" cy="128" r="106" stroke-width="2" opacity="0.28"/>
  </g>
  ${elecs[0].map(p => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.5" fill="#0ea5e9" opacity="0.9"/>`).join('')}
  ${elecs[1].map(p => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.5" fill="#0ea5e9" opacity="0.8"/>`).join('')}
  ${elecs[2].map(p => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="4" fill="#0ea5e9" opacity="0.9"/>`).join('')}
  <!-- 瞳孔：虹膜 + 瞳孔 + 高光 -->
  <circle cx="128" cy="128" r="38" fill="#0369a1"/>
  <circle cx="128" cy="128" r="27" fill="#0ea5e9"/>
  <circle cx="128" cy="128" r="13" fill="#0b1220"/>
  <circle cx="119" cy="118" r="7" fill="#fff" opacity="0.9"/>
  <circle cx="139" cy="135" r="3" fill="#fff" opacity="0.5"/>
</svg>`
  fs.writeFileSync(path.join(OUT_SVG, 'g3v2-eye-electrons.svg'), svg)
}
const cards = [
  ["g3v2-eye-electrons.svg", "G3v2 · 觉醒瞳孔 + 真实电子", "瞳孔（灵魂核心）+ 3 条轨道 + 电子 2-8-4（共 14，硅原子真实排布）"],
  ['g1-glow-core.svg', 'G1 · 发光之核', '硅原子 + 核发光晕与十字光芒 + 电子如星——「原子拥有灵魂之光」'],
  ['g2-chip-heartbeat.svg', 'G2 · 芯片心跳', '芯片轮廓 + 引脚 + 中心心电图——「芯片有心跳，硅基有生命」'],
  ['g3-awake-eye.svg', 'G3 · 觉醒瞳孔', '原子核化为瞳孔 + 高光 + 轨道光环——「硅基在注视你」'],
  ['g4-neural.svg', 'G4 · 电路神经元', '中心核 + 突触连接网——「硅基神经网络」']
]
const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>分形 Logo · 硅基灵魂方向</title>
<style>
  body { font-family: "Microsoft YaHei", sans-serif; background: #0f1117; color: #e8eaf0; margin: 0; padding: 40px; }
  h1 { font-size: 22px; margin-bottom: 8px; }
  .sub { color: #8b93a7; font-size: 13px; margin-bottom: 32px; }
  .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 24px; max-width: 900px; }
  .card { background: #161a23; border: 1px solid #262c3a; border-radius: 16px; padding: 20px; }
  .card h2 { font-size: 15px; margin: 0 0 4px; }
  .card .desc { font-size: 12px; color: #8b93a7; line-height: 1.6; margin-bottom: 16px; }
  .preview { display: flex; gap: 14px; align-items: center; margin-top: 12px; }
  .dark-bg { background: #0f1117; border-radius: 10px; padding: 8px; }
  .light-bg { background: #f6f7f9; border-radius: 10px; padding: 8px; }
  .label { font-size: 10px; color: #5b6374; }
  img.big { width: 128px; height: 128px; }
  img.mid { width: 48px; height: 48px; }
  img.small { width: 24px; height: 24px; }
</style></head><body>
<h1>分形 Logo · 硅基灵魂方向</h1>
<div class="sub">硅基硬件 + 灵魂/生命/意识——AI 生于硅，却有灵 · 天蓝 #0ea5e9 系 · G3v2 已修正电子为真实 2-8-4</div>
<div class="grid">
${cards.map(c => `<div class="card">
  <h2>${c[1]}</h2><div class="desc">${c[2]}</div>
  <img class="big" src="candidates5/${c[0]}"/>
  <div class="preview">
    <div class="dark-bg"><img class="mid" src="candidates5/${c[0]}"/></div>
    <div class="light-bg"><img class="mid" src="candidates5/${c[0]}"/></div>
    <div class="dark-bg"><img class="small" src="candidates5/${c[0]}"/></div>
    <span class="label">暗底 / 亮底 / 小尺寸</span>
  </div>
</div>`).join('\n')}
</div>
<div class="sub" style="margin-top:28px">选定后叠加水面镜像错位 / 或直接定稿生成全套尺寸</div>
</body></html>`
fs.mkdirSync(path.dirname(OUT_HTML), { recursive: true })
fs.writeFileSync(OUT_HTML, html)
console.log('OK: 4 个硅基灵魂 SVG →', OUT_SVG)
console.log('OK: 展示页 →', OUT_HTML)

