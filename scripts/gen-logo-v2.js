// 生成「水面镜像错位」logo 候选：V1 山峦+切片错位+涟漪 / V2 大错位无涟漪 / V3 几何双峰
// 输出：docs/原型/candidates2/*.svg + docs/原型/logo-候选2.html
const fs = require('fs')
const path = require('path')

const OUT_SVG = path.join(__dirname, '..', 'docs', '原型', 'candidates2')
const OUT_HTML = path.join(__dirname, '..', 'docs', '原型', 'logo-候选2.html')

// 主体山峦剪影（圆润曲线，两峰）：y 在 40-140 之间
const HILL = 'M 28 140 C 60 92 80 118 96 96 C 112 74 132 40 148 60 C 164 80 190 102 228 140 Z'
// 镜像（以 y=140 为轴翻转 180°）
const HILL_MIRROR = 'M 28 140 C 60 188 80 162 96 184 C 112 206 132 240 148 220 C 164 200 190 178 228 140 Z'

// 几何风主体：双尖峰
const PEAKS = 'M 44 140 L 96 56 L 148 140 Z M 148 140 L 184 92 L 220 140 Z'
const PEAKS_MIRROR = 'M 44 140 L 96 224 L 148 140 Z M 148 140 L 184 188 L 220 140 Z'

// 切片错位镜像：clip 到 [y0,y1] 区间 + 水平偏移 dx
function slices(mirrorPath, cuts) {
  return cuts.map(([y0, y1, dx, op]) => `
  <clipPath id="cp${y0}"><rect x="0" y="${y0}" width="256" height="${y1 - y0}"/></clipPath>
  <g clip-path="url(#cp${y0})" transform="translate(${dx} 0)" opacity="${op}">
    <path d="${mirrorPath}" fill="#34d399"/>
  </g>`).join('\n')
}

function ripple(color) {
  return `
  <path d="M 40 210 Q 128 196 216 210" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" opacity="0.5"/>
  <path d="M 62 244 Q 128 234 194 244" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" opacity="0.3"/>`
}

// V1：山峦 + 中错位（6/0/10）+ 涟漪
{
  const body = `<g>
  <path d="${HILL}" fill="#34d399"/>
</g>`
  const mir = slices(HILL_MIRROR, [[140, 186, 6, 0.85], [186, 232, 0, 0.55], [232, 280, 10, 0.35]])
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <rect width="256" height="256" rx="48" fill="#1a1a2e"/>
  ${body}
  ${mir}
  ${ripple('#34d399')}
</svg>`
  fs.mkdirSync(OUT_SVG, { recursive: true })
  fs.writeFileSync(path.join(OUT_SVG, 'v1-hill.svg'), svg)
}

// V2：山峦 + 大错位（16/4/22）+ 无涟漪（更抽象，倒影淡）
{
  const mir = slices(HILL_MIRROR, [[140, 186, 16, 0.75], [186, 232, 4, 0.45], [232, 280, 22, 0.28]])
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <rect width="256" height="256" rx="48" fill="#1a1a2e"/>
  <path d="${HILL}" fill="#34d399"/>
  ${mir}
</svg>`
  fs.writeFileSync(path.join(OUT_SVG, 'v2-hill-big.svg'), svg)
}

// V3：几何双峰 + 中错位 + 涟漪（几何 vs 圆润对比）
{
  const mir = slices(PEAKS_MIRROR, [[140, 186, 8, 0.85], [186, 232, -4, 0.55], [232, 280, 12, 0.35]])
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <rect width="256" height="256" rx="48" fill="#1a1a2e"/>
  <path d="${PEAKS}" fill="#34d399"/>
  ${mir}
  ${ripple('#34d399')}
</svg>`
  fs.writeFileSync(path.join(OUT_SVG, 'v3-peaks.svg'), svg)
}

const cards = [
  ['v1-hill.svg', '方案 V1 · 山峦 + 涟漪错位', '圆润山峦剪影，倒影 3 片错位（6/0/10px），底部涟漪线 —— 完整「水面镜像」意象'],
  ['v2-hill-big.svg', '方案 V2 · 大错位无涟漪', '同山峦，错位加大（16/4/22px）、无涟漪线 —— 更抽象，突出「错位」本身'],
  ['v3-peaks.svg', '方案 V3 · 几何双峰', '尖峰几何双峰 + 错位镜像 + 涟漪 —— 更硬朗几何']
]
const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>分形 Logo 候选 · 水面镜像错位</title>
<style>
  body { font-family: "Microsoft YaHei", sans-serif; background: #0f1117; color: #e8eaf0; margin: 0; padding: 40px; }
  h1 { font-size: 22px; margin-bottom: 8px; }
  .sub { color: #8b93a7; font-size: 13px; margin-bottom: 32px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; max-width: 1100px; }
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
<h1>分形 Logo · 水面镜像错位方向</h1>
<div class="sub">主体图形 + 倒影，倒影切 3 条水平切片各自水平错位（涟漪折射感），底部涟漪线</div>
<div class="grid">
${cards.map(c => `<div class="card">
  <h2>${c[1]}</h2><div class="desc">${c[2]}</div>
  <img class="big" src="candidates2/${c[0]}"/>
  <div class="preview">
    <div class="dark-bg"><img class="mid" src="candidates2/${c[0]}"/></div>
    <div class="light-bg"><img class="mid" src="candidates2/${c[0]}"/></div>
    <div class="dark-bg"><img class="small" src="candidates2/${c[0]}"/></div>
    <span class="label">暗底 / 亮底 / 小尺寸</span>
  </div>
</div>`).join('\n')}
</div>
<div class="sub" style="margin-top:28px">选定后生成全套尺寸替换；也可微调：错位量 / 切片数 / 涟漪线 / 主体形状 / 配色</div>
</body></html>`
fs.mkdirSync(path.dirname(OUT_HTML), { recursive: true })
fs.writeFileSync(OUT_HTML, html)
console.log('OK: 3 个候选 SVG →', OUT_SVG)
console.log('OK: 展示页 →', OUT_HTML)
