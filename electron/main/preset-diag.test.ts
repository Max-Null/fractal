import { describe, it } from 'vitest'
import { ensurePresetConfig } from './preset'

describe('真实 ensurePresetConfig 诊断', () => {
  it('真实 userData + presetRoot', async () => {
    const r = await ensurePresetConfig(
      'C:/Users/MaxNull/AppData/Roaming/oc-gui',
      'H:/MaxNull/WorkStation/fractal/electron/resources/preset',
    )
    console.log('RESULT:', r)
    const j = JSON.parse(require('fs').readFileSync('C:/Users/MaxNull/AppData/Roaming/oc-gui/config/opencode/opencode.json', 'utf8'))
    console.log('AFTER default_agent:', j.default_agent)
    console.log('AFTER plugin:', JSON.stringify(j.plugin))
  })
})
