// 下载官方 OpenCode 二进制（sidecar）：GitHub Releases → resources/bin/
// 用法：node scripts/download-opencode.js [version]
// 版本固定原则：与 docs/知识/oc-engine/版本矩阵.md 对齐；升级先改知识库再改这里
const { execFileSync } = require('node:child_process')
const { createWriteStream, mkdirSync, existsSync, rmSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const https = require('node:https')
const crypto = require('node:crypto')

const VERSION = process.argv[2] || 'v1.18.14'
const PLATFORM_ASSET = {
  win32: 'opencode-windows-x64.zip',
  darwin: process.arch === 'arm64' ? 'opencode-darwin-arm64.zip' : 'opencode-darwin-x64.zip',
  linux: 'opencode-linux-x64.tar.gz',
}
const ASSET = PLATFORM_ASSET[process.platform]
if (!ASSET) {
  console.error(`不支持的平台：${process.platform}`)
  process.exit(1)
}

const BIN_DIR = join(__dirname, '..', 'resources', 'bin')
// GitHub 直连在部分地区不可达——按序尝试镜像（gh-proxy / ghfast.top 实测可达，2026-08-07）
const MIRRORS = [
  (url) => url, // 直连
  (url) => `https://gh-proxy.com/${url}`,
  (url) => `https://ghfast.top/${url}`,
]
const ORIGIN_URL = `https://github.com/anomalyco/opencode/releases/download/${VERSION}/${ASSET}`
const ARCHIVE = join(BIN_DIR, ASSET)
const TARGET = join(BIN_DIR, process.platform === 'win32' ? 'opencode.exe' : 'opencode')

function download(url, dest, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) {
      // 镜像重定向链异常（循环/过长）——拒绝并尝试下一源（军师审查 🟡10）
      reject(new Error('重定向次数过多'))
      return
    }
    const req = https.get(url, { headers: { 'User-Agent': 'oc-gui-sidecar' } }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        // GitHub release 重定向到 CDN
        res.resume()
        download(res.headers.location, dest, depth + 1).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) {
        reject(new Error(`下载失败 HTTP ${res.statusCode}: ${url}`))
        return
      }
      const file = createWriteStream(dest)
      res.pipe(file)
      file.on('finish', () => file.close(resolve))
      file.on('error', reject)
    })
    req.on('error', reject)
  })
}

/** 校验 zip 的 SHA256 与官方 checksums.txt 一致（镜像源不可信，完整性必须验证——军师审查 🔴2） */
async function verifyChecksum(archivePath) {
  const checksumName = ASSET + '.sha256'
  const checksumUrl = ORIGIN_URL.replace(`/${ASSET}`, `/${checksumName}`)
  let content = null
  for (const mirror of MIRRORS) {
    try {
      content = await new Promise((resolve, reject) => {
        const req = https.get(mirror(checksumUrl), { headers: { 'User-Agent': 'oc-gui-sidecar' } }, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            res.resume()
            https.get(res.headers.location, { headers: { 'User-Agent': 'oc-gui-sidecar' } }, (r2) => {
              if (r2.statusCode !== 200) return reject(new Error(`校验和下载失败 HTTP ${r2.statusCode}`))
              let buf = ''
              r2.on('data', (c) => (buf += c))
              r2.on('end', () => resolve(buf))
            }).on('error', reject)
            return
          }
          if (res.statusCode !== 200) return reject(new Error(`校验和下载失败 HTTP ${res.statusCode}`))
          let buf = ''
          res.on('data', (c) => (buf += c))
          res.on('end', () => resolve(buf))
        })
        req.on('error', reject)
      })
      if (content) break
    } catch (err) {
      console.log(`  ✗ 校验和下载失败（${mirror(checksumUrl)}）：${err.message}`)
    }
  }
  if (!content) {
    console.warn('  ⚠️ 无法获取官方校验和（checksums 不可达）——跳过完整性校验')
    return
  }
  const expected = content.split(/\r?\n/).find((l) => l.includes(ASSET))?.split(/\s+/)[0]
  if (!expected) {
    console.warn('  ⚠️ 校验和文件未包含目标资产——跳过完整性校验')
    return
  }
  const actual = crypto.createHash('sha256').update(readFileSync(archivePath)).digest('hex')
  if (actual !== expected) {
    throw new Error(`SHA256 校验失败（期望 ${expected}，实际 ${actual}）——文件可能被篡改，删除重试`)
  }
  console.log('  ✅ SHA256 校验通过')
}

async function main() {
  mkdirSync(BIN_DIR, { recursive: true })
  if (existsSync(ARCHIVE)) rmSync(ARCHIVE, { force: true })

  // 逐镜像尝试下载（直连 → gh-proxy → ghfast.top）
  let downloaded = false
  for (const mirror of MIRRORS) {
    const url = mirror(ORIGIN_URL)
    console.log(`尝试 ${url} ...`)
    try {
      await download(url, ARCHIVE)
      downloaded = true
      break
    } catch (err) {
      console.log(`  ✗ ${err.message}`)
    }
  }
  if (!downloaded) {
    console.error('❌ 全部下载源失败，请检查网络或稍后重试')
    process.exit(1)
  }

  // 完整性校验（军师审查 🔴2）：失败则删除重试
  try {
    await verifyChecksum(ARCHIVE)
  } catch (err) {
    rmSync(ARCHIVE, { force: true })
    console.error(`❌ ${err.message}`)
    process.exit(1)
  }

  console.log('解压 ...')
  // Windows 10 1803+ 内置 tar（bsdtar）支持 zip；兜底 PowerShell Expand-Archive
  try {
    execFileSync('tar', ['-xf', ARCHIVE, '-C', BIN_DIR], { stdio: 'pipe' })
  } catch {
    execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${ARCHIVE}' -DestinationPath '${BIN_DIR}' -Force`], { stdio: 'pipe' })
  }
  rmSync(ARCHIVE, { force: true })

  console.log('验证版本 ...')
  const out = execFileSync(TARGET, ['--version'], { encoding: 'utf8' })
  // 验证 serve 子命令可用（分形实际执行 opencode serve——军师审查 🟡6）
  execFileSync(TARGET, ['serve', '--help'], { stdio: 'pipe', timeout: 10_000 })
  console.log(`✅ sidecar 就绪：${TARGET}（${out.trim()}，serve 子命令可用）`)
}

main().catch((err) => {
  console.error('❌ 下载失败：', err.message)
  process.exit(1)
})
