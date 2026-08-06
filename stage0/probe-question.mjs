// probe-question.mjs：真实链路验证 question/todo 原生能力闭环
// 场景1：prompt 触发 question → POST reply → 模型继续 → idle
// 场景2：prompt 触发 todo → 捕获 todo.updated
// 复用 probe-serve.mjs 的 spawn/认证/SDK 模式
import { spawn } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { createOpencodeClient } from '@opencode-ai/sdk'

const FIX = new URL('./fixtures/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
await mkdir(FIX, { recursive: true })

// ── 解析 opencode shim → 原生 exe（同 probe-serve.mjs）──
import path from 'node:path'
import { access } from 'node:fs/promises'
async function resolveOpencodeBin() {
  if (process.platform !== 'win32') return 'opencode'
  const npmDir = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : null
  if (!npmDir) return 'opencode'
  const cmdPath = path.join(npmDir, 'opencode.cmd')
  const content = await readFile(cmdPath, 'utf8')
  const m = content.match(/"([^"]*%dp0%[^"]*\.exe)"/i)
  if (m) {
    const p = path.resolve(m[1].replace(/%dp0%/i, npmDir))
    await access(p)
    return p
  }
  throw new Error('shim 解析失败: ' + content.slice(0, 200))
}

const bin = await resolveOpencodeBin()
console.log('bin =', bin)
const port = 19000 + Math.floor(Math.random() * 2000)
const baseURL = `http://127.0.0.1:${port}`
const USER = 'opencode', PASS = 'test-pass-' + Math.floor(Math.random() * 1e6)

// XDG 注入分形隔离配置（与正式 app 一致：provider.deepseek + API Key + 双星 agent）
const ocGuiConfigDir = path.join(process.env.APPDATA, 'oc-gui', 'config')
const child = spawn(bin, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
  env: {
    ...process.env,
    XDG_CONFIG_HOME: ocGuiConfigDir,
    OPENCODE_SERVER_USERNAME: USER,
    OPENCODE_SERVER_PASSWORD: PASS,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', (d) => process.stdout.write('[serve] ' + d))
child.stderr.on('data', (d) => process.stdout.write('[serve-err] ' + d))

// 等待 /doc 可达
const auth = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64')
async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(baseURL + '/doc', { headers: { Authorization: auth } })
      if (r.ok) return
    } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('serve 未就绪')
}
await waitReady()
console.log('── serve 就绪 ──')

const client = createOpencodeClient({ baseUrl: baseURL, headers: { Authorization: auth } })
const session = await client.session.create({ body: { title: 'probe-question' } })
const sid = session.data.id
console.log('session =', sid)

// 场景1：question
console.log('── 场景1：触发 question ──')
const events1 = []
const stream = await client.event.subscribe({})
const collect1 = (async () => {
  for await (const chunk of stream.stream) {
    // SDK event.subscribe 的 chunk 已是解析后的对象（1.18.13）；字符串兜底
    const evt = typeof chunk === 'string' ? JSON.parse(chunk) : chunk
    events1.push(evt)
    if (evt.type === 'question.asked') {
      console.log('[QUESTION]', JSON.stringify(evt.properties))
      const q = evt.properties.questions[0]
      const firstOption = q.options?.[0]?.label ?? 'A'
      const r = await fetch(`${baseURL}/question/${evt.properties.id}/reply`, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: [[firstOption]] }),
      })
      console.log('[REPLY]', r.status, await r.text().catch(() => ''))
    }
    if (evt.type === 'session.idle') { console.log('[IDLE]'); break }
    if (evt.type === 'session.error') { console.log('[SESSION-ERROR]', JSON.stringify(evt.properties)?.slice(0, 300)) }
    if (evt.type === 'message.part.updated' && evt.properties?.part?.type !== 'text') {
      console.log('[PART]', JSON.stringify(evt.properties?.part)?.slice(0, 300))
    }
  }
})()
await client.session.promptAsync({
  path: { id: sid },
  body: {
    model: { providerID: 'deepseek', modelID: 'deepseek-v4-flash' },
    parts: [{ type: 'text', text: '请使用 question 工具向我提问一个问题：你偏好哪个配色？选项 A 深色 / B 浅色 / C 跟随系统。提问后请停止。' }],
  },
})
await collect1
console.log('[EVENTS1]', events1.map((e) => e.type).join(', '))

// 场景2：todo
console.log('── 场景2：触发 todo ──')
const events2 = []
let gotTodo = false
const collect2 = (async () => {
  for await (const chunk of stream.stream) {
    const evt = typeof chunk === 'string' ? JSON.parse(chunk) : chunk
    events2.push(evt)
    if (evt.type === 'todo.updated') { console.log('[TODO]', JSON.stringify(evt.properties)); gotTodo = true }
    if (evt.type === 'session.idle') { console.log('[IDLE2]'); break }
  }
})()
await client.session.promptAsync({
  path: { id: sid },
  body: {
    model: { providerID: 'deepseek', modelID: 'deepseek-v4-flash' },
    parts: [{ type: 'text', text: '请创建一个 todo 列表：1 写 README 2 运行测试 3 git 提交。然后直接停止。' }],
  },
})
await collect2

console.log('── 结论 ──')
console.log('question.asked 捕获:', events1.some((e) => e.type === 'question.asked') ? '✅' : '❌')
console.log('question reply 后模型继续（有 text part）:', events1.some((e) => e.type === 'message.part.updated' && e.properties?.part?.type === 'text') ? '✅' : '❌')
console.log('todo.updated 捕获:', gotTodo ? '✅' : '❌')
await new Promise((r) => setTimeout(r, 500))
child.kill()
process.exit(0)
