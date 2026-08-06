// 协议探测：question 提问 / 权限授权 / todo 待办 三类事件的真实结构（serve 1.18.5）
// 前置：XGD 临时配置目录（permission.bash=ask）+ 真实 API Key（读全局配置）
// 用法：node probe-extras.mjs（输出 fixtures/extras-*.json）
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createOpencodeClient } from '@opencode-ai/sdk'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIX_DIR = join(__dirname, 'fixtures')

// ── 解析 opencode 真实 exe（npm shim 是 .cmd，Node spawn 不解析——阶段 0 踩坑 #2）──
async function resolveOpencodeBin() {
  if (process.platform !== 'win32') return 'opencode'
  const npmDir = process.env.APPDATA ? join(process.env.APPDATA, 'npm') : null
  if (!npmDir) return 'opencode'
  const cmdPath = join(npmDir, 'opencode.cmd')
  try {
    const content = await readFile(cmdPath, 'utf8')
    const m = content.match(/"([^"]*%dp0%[^"]*\.exe)"/i)
    if (m) return join(npmDir, m[1].replace(/%dp0%/i, ''))
  } catch { /* 兜底 PATH */ }
  return 'opencode'
}

// ── 配置准备：XDG 隔离目录 + permission.bash=ask + DeepSeek 模型 ──
const xdg = join(__dirname, '.xdg-probe-extras')
await rm(xdg, { recursive: true, force: true })
await mkdir(join(xdg, 'opencode'), { recursive: true })
const globalCfgPath = join(process.env.APPDATA, 'oc-gui', 'provider-configs.json')
let apiKey = ''
try {
  const raw = await readFile(globalCfgPath, 'utf8')
  apiKey = JSON.parse(raw.replace(/^\uFEFF/, '')).deepseek?.apiKey ?? ''
} catch { /* 无正式配置 */ }
if (!apiKey) {
  console.log('✗ 无 API Key（APPDATA/oc-gui/provider-configs.json）')
  process.exit(1)
}
await writeFile(
  join(xdg, 'opencode', 'opencode.json'),
  JSON.stringify({
    model: 'deepseek/deepseek-v4-flash',
    permission: { bash: 'ask', edit: 'ask' }, // 触发授权弹窗探测
    provider: { deepseek: { options: { apiKey } } }
  }, null, 2),
  'utf8'
)

// ── 启动 serve ──
const port = 40000 + Math.floor(Math.random() * 20000)
const baseURL = `http://127.0.0.1:${port}`
const ocBin = await resolveOpencodeBin()
console.log('serve bin = ' + ocBin)
const serve = spawn(ocBin, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
  env: { ...process.env, XDG_CONFIG_HOME: xdg, OPENCODE_SERVER_USERNAME: 'probe', OPENCODE_SERVER_PASSWORD: 'probe' }
})
const logs = []
serve.stdout.on('data', d => logs.push(d.toString()))
serve.stderr.on('data', d => logs.push(d.toString()))
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function waitHealthy(timeoutMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      // /doc 也需要 Basic 认证（v1.15+ serve 默认认证——阶段 0 踩坑 #5）
      const r = await fetch(`${baseURL}/doc`, { headers: auth })
      if (r.ok) return true
    } catch { /* 未就绪 */ }
    await sleep(400)
  }
  return false
}

const auth = { Authorization: 'Basic ' + Buffer.from('probe:probe').toString('base64') }

try {
  if (!(await waitHealthy())) throw new Error('serve 未就绪')
  console.log('① serve 就绪 port=' + port)

  const client = createOpencodeClient({
    baseUrl: baseURL,
    headers: auth,
    fetch: globalThis.fetch
  })
  const s = await client.session.create({ body: { title: '协议探测' } })
  const sid = s.data.id
  console.log('② 会话=' + sid)

  // ── 订阅事件流：抓 question/permission/todo 事件 ──
  const collected = { question: [], permission: [], todo: [], others: [] }
  const sub = await client.event.subscribe({}) // SDK sse 是 async，返回 Promise<{stream}>
  ;(async () => {
    try {
      for await (const chunk of sub.stream) {
        // SDK 1.18.13 stream 的每个 chunk 是单个事件对象（{id, type, properties}），不是数组
        const type = chunk?.type ?? 'unknown'
        if (type.includes('question')) collected.question.push(chunk)
        else if (type.includes('permission')) collected.permission.push(chunk)
        else if (type.includes('todo')) collected.todo.push(chunk)
        else collected.others.push(chunk)
      }
    } catch (err) {
      console.log('  [stream-error]', err?.message ?? String(err))
      collected.streamError = String(err?.message ?? err)
    }
  })()

  // ── ③ 触发 question 工具：让模型提问 ──
  console.log('③ 触发 question 工具（请提问：你更偏好哪个配色？A 深色 B 浅色 C 跟随系统）…')
  await client.session.promptAsync({
    path: { id: sid },
    body: {
      model: { providerID: 'deepseek', modelID: 'deepseek-v4-flash' },
      parts: [{ type: 'text', text: '请使用 question 工具向我提问一个问题：你更偏好哪个配色方案？选项 A 深色 / B 浅色 / C 跟随系统。给出后停止。' }]
    }
  })
  // 等待 question 事件（最多 60s）
  let waited = 0
  while (collected.question.length === 0 && waited < 60000) { await sleep(500); waited += 500 }
  console.log(`   question 事件数=${collected.question.length}`)

  // ── 回答 question：模型回合在等待答案，必须 reply 才能继续（POST /question/{id}/reply，answers=选中 label 数组）──
  if (collected.question.length > 0) {
    const q = collected.question[0]
    const queId = q.properties.id
    console.log(`⑥ 回答 question ${queId}（选 A）…`)
    const r = await fetch(`${baseURL}/question/${queId}/reply`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: [['A 深色']] })
    })
    console.log(`   reply 状态=${r.status}`)
    // 等待回合结束（session.idle）再继续
    waited = 0
    while (!collected.others.some(e => e.type === 'session.idle') && waited < 60000) { await sleep(500); waited += 500 }
    console.log('   回合结束确认（session.idle）')
  }

  // ── ④ 触发 todo：让模型建待办 ──
  console.log('④ 触发 todo（把以下任务拆成 todo 列表：1 写 README 2 跑测试 3 提交）…')
  await client.session.promptAsync({
    path: { id: sid },
    body: {
      model: { providerID: 'deepseek', modelID: 'deepseek-v4-flash' },
      parts: [{ type: 'text', text: '请把这个任务拆成 todo 列表：1 写 README 2 运行测试 3 git 提交。拆完直接停止。' }]
    }
  })
  waited = 0
  while (collected.todo.length === 0 && waited < 60000) { await sleep(500); waited += 500 }
  console.log(`   todo 事件数=${collected.todo.length}`)

  // ── ⑤ 触发权限：bash ask ──
  console.log('⑤ 触发 bash 权限（运行 echo 探测授权）…')
  await client.session.promptAsync({
    path: { id: sid },
    body: {
      model: { providerID: 'deepseek', modelID: 'deepseek-v4-flash' },
      parts: [{ type: 'text', text: '运行命令 echo probe-permission-check，输出后停止。' }]
    }
  })
  waited = 0
  while (collected.permission.length === 0 && waited < 60000) { await sleep(500); waited += 500 }
  console.log(`   permission 事件数=${collected.permission.length}`)

  // ── 结果落地 ──
  await sleep(2000)
  const out = {
    question: collected.question,
    permission: collected.permission,
    todo: collected.todo,
    othersSample: collected.others.slice(0, 30)
  }
  await writeFile(join(FIX_DIR, 'extras-events.json'), JSON.stringify(out, null, 2), 'utf8')
  console.log('\n=== 结果摘要 ===')
  console.log('question 事件结构:', JSON.stringify(out.question[0] ?? null)?.slice(0, 600))
  console.log('permission 事件结构:', JSON.stringify(out.permission[0] ?? null)?.slice(0, 600))
  console.log('todo 事件结构:', JSON.stringify(out.todo[0] ?? null)?.slice(0, 600))
  console.log('others 类型:', JSON.stringify(Object.fromEntries(out.othersSample.map(e => [e.type, 1]))))
  console.log('\n完整结果: fixtures/extras-events.json')
  process.exit(0) // 强制退出：SSE 连接保持事件循环存活（SDK stream 不自动关闭）
} finally {
  serve.kill()
  await sleep(1000)
  await rm(xdg, { recursive: true, force: true }).catch(() => {})
}
