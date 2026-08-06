// 生成「钥匙」logo 候选（把手在左）：K1 经典圆环 / K2 几何方环
// 输出：docs/原型/candidates3/*.svg + docs/原型/logo-候选3.html
const fs = require('fs')
const path = require('path')

const OUT_SVG = path.join(__dirname, '..', 'docs', '原型', 'candidates3')
const OUT_HTML = path.join(__dirname, '..', 'docs', '原型', 'logo-候选3.html')

const GREEN = '#34d399'

// K1：经典钥匙（圆环把手 + 杆 + 双下齿 + 一上齿），横放、把手在左
{
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <rect width="256" height="256" rx="48" fill="#1a1a2e"/>
  <g fill="${GREEN}">
    <!-- 圆环把手（左，中心 62,128，外径 42，环宽 16） -->
    <circle cx="62" cy="128" r="42" fill="none" stroke="${GREEN}" stroke-width="16"/>
    <!-- 杆：96 → 212，y 118-138 -->
    <rect x="96" y="118" width="116" height="20" rx="8"/>
    <!-- 上齿（杆右端上方） -->
    <rect x="188" y="104" width="16" height="14" rx="3"/>
    <!-- 下齿 1（杆右端下方） -->
    <rect x="176" y="138" width="16" height="16" rx="3"/>
    <!-- 下齿 2（末端） -->
    <rect x="200" y="138" width="20" height="16" rx="3"/>
  </g>
</svg>`
  fs.mkdirSync(OUT_SVG, { recursive: true })
  fs.writeFileSync(path.join(OUT_SVG, 'k1-classic.svg'), svg)
}

// K2：几何方环钥匙（方环 + 斜切杆 + 双齿），更现代
{
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <rect width="256" height="256" rx="48" fill="#1a1a2e"/>
  <g fill="${GREEN}">
    <!-- 方环把手（左）：圆角方环 -->
    <rect x="20" y="86" width="84" height="84" rx="20" fill="none" stroke="${GREEN}" stroke-width="16"/>
    <!-- 环内小圆点（分形点，暗底透出） -->
    <circle cx="62" cy="128" r="7" fill="#1a1a2e"/>
    <!-- 杆：96 → 208 -->
    <rect x="96" y="118" width="112" height="20" rx="6"/>
    <!-- 下齿 1 -->
    <rect x="176" y="138" width="16" height="16" rx="3"/>
    <!-- 下齿 2 -->
    <rect x="200" y="138" width="20" height="16" rx="3"/>
  </g>
</svg>`
  fs.writeFileSync(path.join(OUT_SVG, 'k2-square.svg'), svg)
}

// K3：圆环 + 内嵌小环（分形自相似：环中环），杆加渐变
{
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <defs><linearGradient id="keyg" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0%" stop-color="#6ee7b7"/><stop offset="100%" stop-color="#34d399"/>
  </linearGradient></defs>
  <rect width="256" height="256" rx="48" fill="#1a1a2e"/>
  <g fill="none" stroke="url(#keyg)">
    <!-- 环中环：自相似分形感 -->
    <circle cx="62" cy="128" r="42" stroke-width="16"/>
    <circle cx="62" cy="128" r="13" stroke-width="5" opacity="0.7"/>
    <path d="M 96 128 L 212 128" stroke-width="20" stroke-linecap="round"/>
  </g>
  <g fill="url(#keyg)">
    <rect x="188" y="104" width="16" height="16" rx="3"/>
    <rect x="176" y="138" width="16" height="16" rx="3"/>
    <rect x="200" y="138" width="20" height="16" rx="3"/>
  </g>
</svg>`
  fs.writeFileSync(path.join(OUT_SVG, 'k3-ring.svg'), svg)
}

const cards = [
  ['k1-classic.svg', 'K1 · 经典圆环钥匙', '圆环把手 + 杆 + 上一下二齿，标准钥匙轮廓，识别最直接'],
  ['k2-square.svg', 'K2 · 几何方环钥匙', '圆角方环 + 环内分形点，更现代硬朗'],
  ['k3-ring.svg', 'K3 · 环中环钥匙', '圆环内嵌小环（自相似分形感）+ 渐变杆']
]
const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>分形 Logo · 钥匙方向</title>
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
<h1>分形 Logo · 钥匙方向（把手在左）</h1>
<div class="sub">钥匙 = 打开 AI 能力的钥匙 · 下一步可叠加「水面镜像错位」</div>
<div class="grid">
${cards.map(c => `<div class="card">
  <h2>${c[1]}</h2><div class="desc">${c[2]}</div>
  <img class="big" src="candidates3/${c[0]}"/>
  <div class="preview">
    <div class="dark-bg"><img class="mid" src="candidates3/${c[0]}"/></div>
    <div class="light-bg"><img class="mid" src="candidates3/${c[0]}"/></div>
    <div class="dark-bg"><img class="small" src="candidates3/${c[0]}"/></div>
    <span class="label">暗底 / 亮底 / 小尺寸</span>
  </div>
</div>`).join('\n')}
</div>
<div class="sub" style="margin-top:28px">选定钥匙形状后，叠加水面镜像错位效果</div>
</body></html>`
fs.mkdirSync(path.dirname(OUT_HTML), { recursive: true })
fs.writeFileSync(OUT_HTML, html)
console.log('OK: 3 个钥匙 SVG →', OUT_SVG)
console.log('OK: 展示页 →', OUT_HTML)
