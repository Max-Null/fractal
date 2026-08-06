// 生成分形 logo 候选方案：A 谢尔宾斯基三角 / B 科赫雪花 / C 递归分叉树
// 输出：src/renderer/public/candidates/*.svg + docs/原型/logo-候选.html
const fs = require('fs')
const path = require('path')

const OUT_SVG = path.join(__dirname, '..', 'src', 'renderer', 'public', 'candidates')
const OUT_HTML = path.join(__dirname, '..', 'docs', '原型', 'logo-候选.html')

function sierpinski(depth, x, y, size, out) {
  if (depth === 0) {
    out.push(`M${x.toFixed(1)} ${y.toFixed(1)}L${(x + size).toFixed(1)} ${y.toFixed(1)}L${(x + size / 2).toFixed(1)} ${(y - size * Math.sqrt(3) / 2).toFixed(1)}Z`)
    return
  }
  const h = size * Math.sqrt(3) / 2
  sierpinski(depth - 1, x, y, size / 2, out)
  sierpinski(depth - 1, x + size / 2, y, size / 2, out)
  sierpinski(depth - 1, x + size / 4, y - h / 2, size / 2, out)
}

function koch(depth, pts) {
  const a = pts.slice(0, 1)
  const segs = []
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[i + 1]
    const dx = x2 - x1, dy = y2 - y1
    const p1 = [x1 + dx / 3, y1 + dy / 3], p2 = [x1 + dx * 2 / 3, y1 + dy * 2 / 3]
    const mx = (p1[0] + p2[0]) / 2, my = (p1[1] + p2[1]) / 2
    const vx = p2[0] - p1[0], vy = p2[1] - p1[1]
    const px = mx - vy * Math.sqrt(3) / 2, py = my + vx * Math.sqrt(3) / 2
    segs.push(p1, [px, py], p2)
  }
  const next = [pts[0]]
  for (const s of segs) next.push(s)
  next.push(pts[pts.length - 1])
  if (depth <= 1) return next
  return koch(depth - 1, next)
}

function tree(cx, baseY, angle, len, depth, out, dirs) {
  if (depth <= 0) return
  const rad = angle * Math.PI / 180
  const x = cx + Math.sin(rad) * len
  const y = baseY - Math.cos(rad) * len
  const width = 3 + depth * 1.6
  out.push(`M${cx.toFixed(1)} ${baseY.toFixed(1)}L${x.toFixed(1)} ${y.toFixed(1)}`)
  dirs.push([x, y, angle, len, depth])
  tree(x, y, angle - 24, len * 0.72, depth - 1, out, dirs)
  tree(x, y, angle + 24, len * 0.72, depth - 1, out, dirs)
}

// ── A：谢尔宾斯基三角形（绿）──
{
  const t = []
  sierpinski(4, 40, 196, 176, t) // 画在 y=196 基线，倒三角区域
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <rect width="256" height="256" rx="48" fill="#1a1a2e"/>
  <g fill="#34d399" opacity="0.92">${t.map(p => `<path d="${p}"/>`).join('\n  ')}</g>
  <circle cx="128" cy="196" r="8" fill="#1a1a2e"/>
</svg>`
  fs.mkdirSync(OUT_SVG, { recursive: true })
  fs.writeFileSync(path.join(OUT_SVG, 'a-sierpinski.svg'), svg)
}

// ── B：科赫雪花（天蓝→绿渐变描边）──
{
  const size = 190
  const cx = 128, cy = 118
  const R = size / 2
  // 等边三角形顶点（尖朝上）
  const pts = [
    [cx, cy - R],
    [cx + R * Math.sqrt(3) / 2, cy + R / 2],
    [cx - R * Math.sqrt(3) / 2, cy + R / 2],
    [cx, cy - R]
  ]
  const flake = koch(3, pts)
  const d = flake.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('') + 'Z'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <defs><linearGradient id="snow" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#34d399"/>
  </linearGradient></defs>
  <rect width="256" height="256" rx="48" fill="#1a1a2e"/>
  <path d="${d}" fill="none" stroke="url(#snow)" stroke-width="7" stroke-linejoin="round" stroke-linecap="round"/>
</svg>`
  fs.mkdirSync(OUT_SVG, { recursive: true })
  fs.writeFileSync(path.join(OUT_SVG, 'b-koch.svg'), svg)
}

// ── C：递归分叉树（绿渐变）──
{
  const segs = [], dirs = []
  tree(128, 208, 0, 88, 5, segs, dirs)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <defs><linearGradient id="tree" x1="0" y1="1" x2="0" y2="0">
    <stop offset="0%" stop-color="#10b981"/><stop offset="100%" stop-color="#a7f3d0"/>
  </linearGradient></defs>
  <rect width="256" height="256" rx="48" fill="#1a1a2e"/>
  <g fill="none" stroke="url(#tree)" stroke-linecap="round" opacity="0.95">
${segs.map((s, i) => `    <path d="${s}" stroke-width="${(3 + (5 - Math.floor(i / 2)) * 1.6).toFixed(1)}"/>`).join('\n')}
  </g>
</svg>`
  fs.mkdirSync(OUT_SVG, { recursive: true })
  fs.writeFileSync(path.join(OUT_SVG, 'c-tree.svg'), svg)
}

// ── 展示页：三候选并排 + 场景预览 ──
const cards = [
  ['a-sierpinski.svg', '方案 A · 谢尔宾斯基三角', '经典分形符号，几何秩序感，识别度高', '绿 #34d399 / 暗底 #1a1a2e'],
  ['b-koch.svg', '方案 B · 科赫雪花', '自然分形，柔和优雅，亲和力强', '天蓝→绿渐变'],
  ['c-tree.svg', '方案 C · 递归分叉树', '生命成长感，隐喻 AI 助手帮你成长', '翠绿→浅绿渐变']
]
const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>分形 Logo 候选方案</title>
<style>
  body { font-family: "Microsoft YaHei", sans-serif; background: #0f1117; color: #e8eaf0; margin: 0; padding: 40px; }
  h1 { font-size: 22px; margin-bottom: 8px; }
  .sub { color: #8b93a7; font-size: 13px; margin-bottom: 32px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; max-width: 1100px; }
  .card { background: #161a23; border: 1px solid #262c3a; border-radius: 16px; padding: 20px; }
  .card h2 { font-size: 15px; margin: 0 0 4px; }
  .card .desc { font-size: 12px; color: #8b93a7; line-height: 1.6; margin-bottom: 8px; }
  .card .meta { font-size: 11px; color: #5b6374; margin-bottom: 16px; }
  .preview { display: flex; gap: 14px; align-items: center; margin-top: 12px; }
  .preview img { border-radius: 10px; }
  .preview .label { font-size: 10px; color: #5b6374; }
  .dark-bg { background: #0f1117; border-radius: 10px; padding: 8px; }
  .light-bg { background: #f6f7f9; border-radius: 10px; padding: 8px; }
  img.big { width: 128px; height: 128px; }
  img.mid { width: 48px; height: 48px; }
  img.small { width: 24px; height: 24px; }
</style></head><body>
<h1>分形 Logo 候选方案</h1>
<div class="sub">三个几何分形方向 · 全部暗底 #1a1a2e 圆角 48 · 与当前 UI 主题色一致</div>
<div class="grid">
${cards.map(c => `<div class="card">
  <h2>${c[1]}</h2><div class="desc">${c[2]}</div><div class="meta">${c[3]}</div>
  <img class="big" src="candidates/${c[0]}"/>
  <div class="preview">
    <div class="dark-bg"><img class="mid" src="candidates/${c[0]}"/></div>
    <div class="light-bg"><img class="mid" src="candidates/${c[0]}"/></div>
    <div class="dark-bg"><img class="small" src="candidates/${c[0]}"/></div>
    <span class="label">暗底 / 亮底 / 小尺寸</span>
  </div>
</div>`).join('\n')}
</div>
<div class="sub" style="margin-top:28px">选定后：生成全套尺寸（512/256/128/64/32/16 + favicon + ico），替换 logo.svg / resources/icon.png / build/icon.png</div>
</body></html>`
fs.mkdirSync(path.dirname(OUT_HTML), { recursive: true })
fs.writeFileSync(OUT_HTML, html)
console.log('OK: 3 个候选 SVG →', OUT_SVG)
console.log('OK: 展示页 →', OUT_HTML)
