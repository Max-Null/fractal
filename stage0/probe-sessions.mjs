// 阶段 0 补充探针：session:list 的 directory 过滤格式对比（正斜杠 vs 反斜杠）
// 背景：db 实测 fractal 工作区 72 会话（directory 存正斜杠 H:/MaxNull/...），
// 但 GUI 传反斜杠 H:\MaxNull\...（Windows settings.cwd）——验证 serve 是否规范化路径
import { spawn } from 'node:child_process'
import { readdirSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIX_DIR = join(__dirname, 'fixtures')

// 与 probe-serve.mjs 相同：解析 npm shim → 真实 exe（Node CreateProcess 不解析 .cmd）
function resolveOpencodeBin() {
  const candidates = [
    join(process.cwd(), 'resources', 'bin', 'opencode.exe'),
    join(__dirname, '..', 'resources', 'bin', 'opencode.exe'),
    join(__dirname, '..', '..', 'resources', 'bin', 'opencode.exe'),
  ]
  for (const c of candidates) if (existsSync(c)) return c
  // 系统安装（npm 全局 shim）：解析 %~dp0 指向的真实 exe
  const shim = join(os.homedir(), 'AppData', 'Roaming', 'npm', 'opencode.cmd')
  if (existsSync(shim)) {
    const content = readFileSync(shim, 'utf8')
    const m = content.match(/%~dp0\\([^\s"]+)/)
    if (m) return join(join(os.homedir(), 'AppData', 'Roaming', 'npm'), m[1])
  }
  return 'opencode'
}

// 简易 fetch 带 Basic 认证（serve 1.15+ 默认要求）
async function api(baseURL, username, password, path) {
  const res = await fetch(`${baseURL}${path}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` },
  })
  if (!res.ok) return { status: res.status, body: await res.text().catch(() => '') }
  const ct = res.headers.get('content-type') || ''
  return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text() }
}

async function main() {
  const bin = resolveOpencodeBin()
  console.log('bin:', bin)
  const username = `probe-${Date.now()}`
  const password = 'probe-pw'
  const port = 46000 + Math.floor(Math.random() * 500)
  const child = spawn(bin, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
    env: { ...process.env, OPENCODE_SERVER_USERNAME: username, OPENCODE_SERVER_PASSWORD: password },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (d) => { stderr += d.toString() })

  const baseURL = `http://127.0.0.1:${port}`
  // 健康检查（最多 20s）
  let ok = false
  for (let i = 0; i < 40; i++) {
    try {
      const r = await api(baseURL, username, password, '/doc')
      if (r.status === 200) { ok = true; break }
    } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  if (!ok) {
    console.log('❌ serve 未就绪；stderr:', stderr.slice(-800))
    child.kill()
    process.exit(1)
  }
  console.log('serve 就绪')

  try {
    const all = await api(baseURL, username, password, '/session')
    const list = all.body?.sessions ?? all.body
    console.log('① GET /session（无过滤）:', Array.isArray(list) ? `${list.length} 个` : JSON.stringify(all.body).slice(0, 120))

    const bs = await api(baseURL, username, password, '/session?directory=H:\\MaxNull\\WorkStation\\fractal')
    const bsList = bs.body?.sessions ?? bs.body
    console.log('② 反斜杠 directory:', Array.isArray(bsList) ? `${bsList.length} 个` : JSON.stringify(bs.body).slice(0, 120))

    const fs = await api(baseURL, username, password, '/session?directory=H:/MaxNull/WorkStation/fractal')
    const fsList = fs.body?.sessions ?? fs.body
    console.log('③ 正斜杠 directory:', Array.isArray(fsList) ? `${fsList.length} 个` : JSON.stringify(fs.body).slice(0, 120))

    const noSlash = await api(baseURL, username, password, '/session?directory=H%3A%5CMaxNull%5CWorkStation%5Cfractal')
    const nsList = noSlash.body?.sessions ?? noSlash.body
    console.log('④ URL编码反斜杠:', Array.isArray(nsList) ? `${nsList.length} 个` : JSON.stringify(noSlash.body).slice(0, 120))
  } finally {
    child.kill()
    process.exit(0)
  }
}

main().catch((e) => { console.error('探针失败:', e.message); process.exit(1) })
