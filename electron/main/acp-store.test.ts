// acp-store.ts 单元测试（纯函数，不依赖 electron 运行时）
// 覆盖：压缩块解析（字段透传/倒序/摘要截断）、分类汇总（role 关联/缺失兜底）、
//       文件不存在兜底、JSON 损坏兜底
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getAcpSessionState, getAcpStorageDir, type AcpSessionState } from './acp-store'

const realUserProfile = process.env.USERPROFILE

function setHomeForTest(home: string) {
  process.env.USERPROFILE = home
}
function restoreHome() {
  if (realUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = realUserProfile
}

const sampleBlocks = {
  '1': {
    blockId: 1,
    topic: '旧块',
    compressedTokens: 18000,
    summaryTokens: 1200,
    tier: 1,
    active: true,
    startId: 'm00001',
    endId: 'm00100',
    createdAt: '2026-08-14T10:00:00.000Z',
    summary: '短摘要',
  },
  '2': {
    blockId: 2,
    topic: '新块',
    compressedTokens: 9000,
    summaryTokens: 800,
    tier: 2,
    active: false,
    startId: 'm00101',
    endId: 'm00200',
    createdAt: '2026-08-15T10:00:00.000Z',
    summary: 'x'.repeat(200),
  },
}

const sampleState = {
  prune: {
    messages: {
      byMessageId: {
        msg_user_1: { tokenCount: 3200, allBlockIds: [], activeBlockIds: [] },
        msg_assist_1: { tokenCount: 15000, allBlockIds: [1], activeBlockIds: [1] },
        msg_internal_1: { tokenCount: 700, allBlockIds: [], activeBlockIds: [] },
      },
      blocksById: sampleBlocks,
      activeBlockIds: [1],
    },
  },
  stats: { pruneTokenCounter: 0, totalPruneTokens: 3054778 },
  lastCompaction: 0,
  modelContextLimit: 1000000,
}

const messages = [
  { id: 'msg_user_1', role: 'user' },
  { id: 'msg_assist_1', role: 'assistant' },
  // msg_internal_1 不在 message:list 中 → 模拟缺失 role
]

describe('getAcpSessionState（ACP 状态读取）', () => {
  beforeEach(async () => {
    // 测试隔离：USERPROFILE → 临时目录，homedir() 一致
    setHomeForTest(join(tmpdir(), `acp-store-test-${Date.now()}`))
    await fsp.mkdir(getAcpStorageDir(), { recursive: true })
  })

  afterEach(() => {
    restoreHome()
  })

  it('文件不存在 → detected=false 空态', async () => {
    const state = await getAcpSessionState('ses_missing', [])
    expect(state.detected).toBe(false)
    expect(state.blocks).toEqual([])
    expect(state.categories).toEqual([])
    expect(state.error).toBeUndefined()
  })

  it('JSON 损坏 → detected=false + error', async () => {
    await fsp.writeFile(join(getAcpStorageDir(), 'ses_bad.json'), '{broken', 'utf8')
    const state = await getAcpSessionState('bad', [])
    expect(state.detected).toBe(false)
    expect(state.error).toContain('ACP 状态解析失败')
  })

  it('解析块列表：字段透传 + createdAt 倒序 + 摘要截断', async () => {
    await fsp.writeFile(
      join(getAcpStorageDir(), 'ses_ok.json'),
      JSON.stringify(sampleState),
      'utf8',
    )
    const state = await getAcpSessionState('ok', messages)
    expect(state.detected).toBe(true)
    expect(state.totalPruneTokens).toBe(3054778)
    expect(state.modelContextLimit).toBe(1000000)
    // 倒序：新块（2026-08-15）在前
    expect(state.blocks.map((b) => b.blockId)).toEqual([2, 1])
    // 字段透传
    const b = state.blocks[1] // 旧块
    expect(b.topic).toBe('旧块')
    expect(b.compressedTokens).toBe(18000)
    expect(b.summaryTokens).toBe(1200)
    expect(b.tier).toBe(1)
    expect(b.active).toBe(true)
    expect(b.startId).toBe('m00001')
    expect(b.endId).toBe('m00100')
    // 摘要截断：长摘要截到 120 + …
    expect(state.blocks[0].summaryPreview.endsWith('…')).toBe(true)
    expect(state.blocks[0].summaryPreview.length).toBe(121)
    // 短摘要原样
    expect(state.blocks[1].summaryPreview).toBe('短摘要')
  })

  it('分类汇总：role 关联 user/assistant，缺失 role 归 system 兜底', async () => {
    await fsp.writeFile(
      join(getAcpStorageDir(), 'ses_cat.json'),
      JSON.stringify(sampleState),
      'utf8',
    )
    const state = await getAcpSessionState('cat', messages)
    const cat = new Map(state.categories.map((c) => [c.role, c]))
    expect(cat.get('user')?.tokens).toBe(3200)
    expect(cat.get('assistant')?.tokens).toBe(15000)
    // msg_internal_1 缺失 role → system 兜底
    expect(cat.get('system')?.tokens).toBe(700)
    // 零值分类行被移除
    expect(state.categories.some((c) => c.role === 'tool')).toBe(false)
  })

  it('零 token 消息跳过，不产生零值分类', async () => {
    const state: AcpSessionState = await (async () => {
      await fsp.writeFile(
        join(getAcpStorageDir(), 'ses_zero.json'),
        JSON.stringify({
          prune: {
            messages: {
              byMessageId: {
                msg_a: { tokenCount: 0 },
                msg_b: { tokenCount: 123 },
              },
              blocksById: {},
            },
          },
          stats: { totalPruneTokens: 0 },
          modelContextLimit: 1000000,
        }),
        'utf8',
      )
      return getAcpSessionState('zero', [{ id: 'msg_a', role: 'user' }, { id: 'msg_b', role: 'assistant' }])
    })()
    expect(state.detected).toBe(true)
    expect(state.categories.map((c) => c.role)).toEqual(['assistant'])
  })
})
