// 用官方 SDK + 并发请求复现 doc-edit 实例化崩溃（app 环境特征）
// 运行：node sdk-concurrent.mjs（stage0 目录，依赖本地 @opencode-ai/sdk）
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOpencodeClient } from '@opencode-ai/sdk'

const PORT = 18114
const USER = 'probe-user'
const PASS = 'probe-pass-123'
const bin = 'H:/MaxNull/WorkStation/fractal/resources/bin/opencode.exe'
const XDG = 'C:/Users/MaxNull/AppData/Roaming/fractal/config'
const env = { ...process.env, XDG_CONFIG_HOME: XDG, OPENCODE_SERVER_USERNAME: USER, OPENCODE_SERVER_PASSWORD: PASS }
let stderrBuf = ''
const child = spawn(bin, ['serve', '--port', String(PORT), '--hostname', '127.0.0.1', '--print-logs'], { env })
child.stderr.on('data', (d) => { stderrBuf += d.toString('utf8') })
child.on('exit', (code, signal) => {
  console.log('=== serve 退出 code=' + code + ' signal=' + signal + ' ===')
  if (code !== 0 && stderrBuf.length > 0) {
    console.log('--- 崩溃前 stderr 尾部 2000 ---')
    console.log(stderrBuf.slice(-2000))
  }
  process.exit(0)
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const auth = 'Basic ' + Buffer.from(USER + ':' + PASS).toString('base64')

;(async () => {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/doc`, { headers: { Authorization: auth } }); if (r.ok) break } catch { /* retry */ }
    await sleep(500)
  }
  console.log('=== SDK 并发 3 请求（session:list ×2 + provider.list）===')
  const client = createOpencodeClient({ baseUrl: `http://127.0.0.1:${PORT}`, headers: { Authorization: auth } })
  try {
    const [s1, s2, p] = await Promise.all([
      client.session.list({ query: { directory: 'H:/MaxNull/WorkStation/doc-edit' } }),
      client.session.list({ query: { directory: 'H:/MaxNull/WorkStation/doc-edit' } }),
      client.provider.list(),
    ])
    console.log('session:list 数量:', s1.data?.length, s2.data?.length, '| provider:', p.data?.all?.length)
  } catch (e) {
    console.log('SDK 请求失败:', e.message)
  }
  await sleep(4000)
  child.kill()
})()
