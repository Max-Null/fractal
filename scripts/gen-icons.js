// 一次性脚本：从 public/logo.svg（G3v2 觉醒瞳孔）渲染全套应用图标
// 用法：npx electron scripts/gen-icons.js；生成后本脚本保留（可复用）
const { app, BrowserWindow, nativeImage } = require('electron')
const fs = require('fs')
const path = require('path')

app.whenReady().then(async () => {
  const root = path.join(__dirname, '..')
  const svgPath = path.join(root, 'src', 'renderer', 'public', 'logo.svg')

  // 离屏渲染 SVG（Chromium 原生渲染，nativeImage 对 SVG 支持不可靠）
  const win = new BrowserWindow({ width: 512, height: 512, show: false, webPreferences: { offscreen: true } })
  await win.loadFile(svgPath)
  await new Promise((r) => setTimeout(r, 800))
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 })
  win.destroy()

  if (img.isEmpty()) {
    console.error('渲染截图失败')
    app.exit(1)
    return
  }
  const base = nativeImage.createFromBuffer(img.toPNG())

  // 512：窗口/打包图标
  fs.writeFileSync(path.join(root, 'resources', 'icon.png'), base.toPNG())
  fs.writeFileSync(path.join(root, 'build', 'icon.png'), base.toPNG())

  // 多尺寸：resources/icons/（备用 + favicon 候选）
  const sizes = [256, 128, 64, 32, 16]
  const iconsDir = path.join(root, 'resources', 'icons')
  fs.mkdirSync(iconsDir, { recursive: true })
  for (const s of sizes) {
    const resized = base.resize({ width: s, height: s, quality: 'best' })
    fs.writeFileSync(path.join(iconsDir, `icon-${s}.png`), resized.toPNG())
  }

  // favicon：16/32/64 复制到 renderer public（index.html 引用）
  const pub = path.join(root, 'src', 'renderer', 'public')
  for (const s of [16, 32]) {
    const resized = base.resize({ width: s, height: s, quality: 'best' })
    fs.writeFileSync(path.join(pub, `favicon-${s}.png`), resized.toPNG())
  }

  // icon.ico：electron-builder 会从 build/icon.png 自动生成，删除可能冲突的旧 ico
  try { fs.unlinkSync(path.join(root, 'build', 'icon.ico')) } catch { /* 无旧 ico */ }

  console.log('OK: resources/icon.png + build/icon.png (512) + resources/icons/ 多尺寸 + public/favicon-16/32.png')
  app.exit(0)
})
