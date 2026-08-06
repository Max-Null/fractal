// 生成「硅原子」logo 候选（玻尔模型）：S1 亮底标准 / S2 亮底极简 / S3 深底对照
// 输出：docs/原型/candidates4/*.svg + docs/原型/logo-候选4.html
const fs = require('fs')
const path = require('path')

const OUT_SVG = path.join(__dirname, '..', 'docs', '原型', 'candidates4')
const OUT_HTML = path.join(__dirname, '..', 'docs', '原型', 'logo-候选4.html')

const SKY = '#0ea5e9'       // 亮模式 accent 天蓝
const SKY_DEEP = '#0369a1'  // 核用深天蓝

// 电子位置：r=轨道半径，n=个数，phase=起始角偏移
function electrons(r, n, phase = 0) {
  const pts = []
  for (let i = 0; i < n; i++) {
    const a = (phase + i * 360 / n) * Math.PI / 180
    pts.push([128 + r * Math.cos(a), 128 + r * Math.sin(a)])
  }
  return pts
}

// S1：亮底标准玻尔模型（核内 Si 文字 + 3 轨道 + 2-8-4 电子）
{
  const inner = electrons(52, 2, 90)
  const mid = electrons(82, 8, 0)
  const outer = electrons(112, 4, 45)
  const dots = (pts) => pts.map(p => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="6.5" fill="${SKY}"/>`).join('\n  ')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <rect width="256" height="256" rx="48" fill="#f6f7f9"/>
  <g fill="none" stroke="${SKY}">
    <circle cx="128" cy="128" r="52" stroke-width="2.5" opacity="0.55"/>
    <circle cx="128" cy="128" r="82" stroke-width="2.5" opacity="0.65"/>
    <circle cx="128" cy="128" r="112" stroke-width="2.5" opacity="0.75"/>
  </g>
  <circle cx="128" cy="128" r="34" fill="${SKY_DEEP}"/>
  <text x="128" y="140" font-family="Arial, sans-serif" font-size="30" font-weight="700" fill="#fff" text-anchor="middle">Si</text>
  ${dots(inner)}
  ${dots(mid)}
  ${dots(outer)}
</svg>`
  fs.mkdirSync(OUT_SVG, { recursive: true })
  fs.writeFileSync(path.join(OUT_SVG, 's1-standard.svg'), svg)
}

// S2：亮底极简（核无文字 + 电子点更大 + 轨道更细）
{
  const inner = electrons(52, 2, 90)
  const mid = electrons(82, 8, 0)
  const outer = electrons(112, 4, 45)
  const dots = (pts, r) => pts.map(p => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${r}" fill="${SKY}"/>`).join('\n  ')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <rect width="256" height="256" rx="48" fill="#ffffff"/>
  <g fill="none" stroke="${SKY}">
    <circle cx="128" cy="128" r="52" stroke-width="2" opacity="0.4"/>
    <circle cx="128" cy="128" r="82" stroke-width="2" opacity="0.55"/>
    <circle cx="128" cy="128" r="112" stroke-width="2" opacity="0.7"/>
  </g>
  <circle cx="128" cy="128" r="38" fill="${SKY_DEEP}"/>
  <circle cx="128" cy="128" r="22" fill="${SKY}" opacity="0.85"/>
  ${dots(inner, 7.5)}
  ${dots(mid, 7.5)}
  ${dots(outer, 7.5)}
</svg>`
  fs.writeFileSync(path.join(OUT_SVG, 's2-minimal.svg'), svg)
}

// S3：深底对照版（暗底 + 天蓝，供对比）
{
  const inner = electrons(52, 2, 90)
  const mid = electrons(82, 8, 0)
  const outer = electrons(112, 4, 45)
  const dots = (pts) => pts.map(p => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="6.5" fill="${SKY}"/>`).join('\n  ')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <rect width="256" height="256" rx="48" fill="#1a1a2e"/>
  <g fill="none" stroke="${SKY}">
    <circle cx="128" cy="128" r="52" stroke-width="2.5" opacity="0.6"/>
    <circle cx="128" cy="128" r="82" stroke-width="2.5" opacity="0.7"/>
    <circle cx="128" cy="128" r="112" stroke-width="2.5" opacity="0.8"/>
  </g>
  <circle cx="128" cy="128" r="34" fill="#0ea5e9"/>
  <text x="128" y="140" font-family="Arial, sans-serif" font-size="30" font-weight="700" fill="#1a1a2e" text-anchor="middle">Si</text>
  ${dots(inner)}
  ${dots(mid)}
  ${dots(outer)}
</svg>`
  fs.writeFileSync(path.join(OUT_SVG, 's3-dark.svg'), svg)
}

const cards = [
  ['s1-standard.svg', 'S1 · 亮底标准', '浅灰底 #f6f7f9 + 天蓝轨道/电子 + 深天蓝核内「Si」——完整玻尔模型（2-8-4 共 14 电子）'],
  ['s2-minimal.svg', 'S2 · 亮底极简', '纯白底 + 核双圆层次 + 无文字，更干净现代'],
  ['s3-dark.svg', 'S3 · 深底对照', '暗底 #1a1a2e + 天蓝——与暗色主题一致（对照组）']
]
const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>分形 Logo · 硅原子方向</title>
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
<h1>分形 Logo · 硅原子方向（亮色主题天蓝）</h1>
<div class="sub">硅 = 芯片与数字世界的基石 · 玻尔模型：核（14p+14n）+ 三层轨道 + 电子 2-8-4</div>
<div class="grid">
${cards.map(c => `<div class="card">
  <h2>${c[1]}</h2><div class="desc">${c[2]}</div>
  <img class="big" src="candidates4/${c[0]}"/>
  <div class="preview">
    <div class="dark-bg"><img class="mid" src="candidates4/${c[0]}"/></div>
    <div class="light-bg"><img class="mid" src="candidates4/${c[0]}"/></div>
    <div class="dark-bg"><img class="small" src="candidates4/${c[0]}"/></div>
    <span class="label">暗底 / 亮底 / 小尺寸</span>
  </div>
</div>`).join('\n')}
</div>
<div class="sub" style="margin-top:28px">选定后可叠加水面镜像错位效果</div>
</body></html>`
fs.mkdirSync(path.dirname(OUT_HTML), { recursive: true })
fs.writeFileSync(OUT_HTML, html)
console.log('OK: 3 个硅原子 SVG →', OUT_SVG)
console.log('OK: 展示页 →', OUT_HTML)
