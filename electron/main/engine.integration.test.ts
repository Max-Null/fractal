// 阶段 4 集成测试：serve 全链路冒烟（真 spawn + 真模型调用）
// 前置：DEEPSEEK_API_KEY 环境变量存在（无 key 时整组跳过——it.skip 语义）
// 流程：ensureConfig（写隔离配置含 apiKey）→ startServer → session.create → promptAsync
//       → 手动订阅 SSE → mapServeEvent → 断言 result 回合完成 → 事件序列存 fixture
// 注意：ensureConfig 必须先于 startServer——serve 启动时加载配置（阶段 0 实测：
// 全局配置有 apiKey 时 serve 直接可用，无需 env），先启动则 serve 读不到 key。
import { describe, it, expect } from 'vitest'
import { promises as fsp } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createServerManager } from './server-manager'
import { ensureConfig } from './oc-config'
import { createMapContext, mapServeEvent, type StreamFrontendEvent } from './events'

const hasKey = !!process.env.DEEPSEEK_API_KEY

// fixture 路径：electron/tests/fixtures/events-round3-success.json（与 events.test.ts 同目录约定）
const fixturePath = resolve(process.cwd(), 'electron/tests/fixtures/events-round3-success.json')

describe.skipIf(!hasKey)('engine 集成冒烟（serve 全链路）', () => {
  it('建会话 → promptAsync → SSE 回合完成（120s 超时）', async () => {
    const dir = await fsp.mkdtemp(join(tmpdir(), 'oc-engine-test-'))
    const manager = createServerManager({ userDataDir: dir })
    try {
      // ① 配置先行：隔离目录写 apiKey（permissionMode 用 default，冒烟不发权限敏感指令）
      await ensureConfig(dir, { apiKey: process.env.DEEPSEEK_API_KEY!, permissionMode: 'default' })

      // ② 启动 serve（健康检查内置于 startServer）
      await manager.startServer()
      const client = manager.getClient()

      // ③ 订阅 SSE（先于 promptAsync，避免丢首事件）
      const ctx = createMapContext()
      const rawEvents: unknown[] = []
      const mapped: StreamFrontendEvent[] = []
      const controller = new AbortController()
      const { stream } = await client.raw.event.subscribe({ signal: controller.signal })
      // 事件消费循环（后台运行，abort 时退出）
      void (async () => {
        try {
          for await (const ev of stream) {
            rawEvents.push(ev)
            for (const m of mapServeEvent(ev, ctx)) mapped.push(m)
          }
        } catch {
          // 消费循环异常（含 abort 主动停止）由上层超时兜底，不阻断断言
        }
      })()

      // ④ 建会话 + 发消息（结果走 SSE 事件流，promptAsync 本身立即返回）
      const session = await client.session.create({ title: '阶段4-集成冒烟' })
      expect(session.id).toMatch(/^ses_/)

      await client.session.promptAsync(session.id, '只回复两个字：你好')

      // ⑤ 等待 result（is_final）——轮询 mapped，120s 超时
      const deadline = Date.now() + 120_000
      let result: StreamFrontendEvent | undefined
      while (Date.now() < deadline) {
        result = mapped.find((e) => e.type === 'result' && e.is_final && e.session_id === session.id)
        if (result) break
        const err = mapped.find((e) => e.type === 'error' && e.session_id === session.id)
        if (err) throw new Error(`会话错误：${(err as { error?: string }).error ?? '未知'}`)
        await new Promise((r) => setTimeout(r, 500))
      }
      if (!result) throw new Error(`等待 session.idle 超时（120s），已收 ${mapped.length} 条映射事件`)

      // ⑥ 断言回合完成：assistant 文本产出
      expect(mapped.some((e) => e.type === 'assistant' && e.text.length > 0)).toBe(true)

      // ⑦ 事件序列原样存 fixture（原始 serve 事件，供回归比对）
      await fsp.mkdir(join(process.cwd(), 'electron/tests/fixtures'), { recursive: true })
      await fsp.writeFile(fixturePath, JSON.stringify(rawEvents, null, 2), 'utf-8')

      // 收尾：中断订阅消费（abort 底层 fetch）
      controller.abort()
    } finally {
      await manager.stopServer().catch(() => {})
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }, 120_000)
})
