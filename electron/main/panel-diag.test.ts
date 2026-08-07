import { describe, it } from 'vitest'
import { startPanelWatchers } from './panel'
import { existsSync } from 'node:fs'

describe('startPanelWatchers 真实路径诊断', () => {
  it('真实 userData：mkdir 应创建 memories/blocks + plans', async () => {
    const fakeWin = { isDestroyed: () => false, webContents: { send: () => {} } } as never
    const w = startPanelWatchers(fakeWin as never, 'C:/Users/MaxNull/AppData/Roaming/oc-gui')
    await new Promise(r => setTimeout(r, 1500))
    const base = 'C:/Users/MaxNull/AppData/Roaming/oc-gui/config/opencode'
    console.log('memories/blocks:', existsSync(base + '/memories/blocks'))
    console.log('plans:', existsSync(base + '/plans'))
    w.dispose()
  })
})
