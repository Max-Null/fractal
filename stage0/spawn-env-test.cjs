// 决定性实验：spawn 注入 OPENCODE_PORT（模拟分形 buildServeEnv）→ serve 是否还崩 8800
const { spawn } = require('child_process')
const bin = 'H:\\MaxNull\\WorkStation\\fractal\\resources\\bin\\opencode.exe'
const env = {
  ...process.env,
  OPENCODE_SERVER_USERNAME: 't',
  OPENCODE_SERVER_PASSWORD: 't',
  XDG_CONFIG_HOME: 'C:\\Users\\MaxNull\\AppData\\Local\\Temp\\oc-gui-e2e\\config',
  OPENCODE_PORT: '54321',
}
const c = spawn(bin, ['serve', '--port', '54546', '--hostname', '127.0.0.1', '--print-logs'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''
c.stderr.on('data', (d) => { out += d.toString() })
c.stdout.on('data', () => {})
c.on('exit', (code, signal) => {
  console.log('EXIT code=' + code + ' signal=' + signal)
  console.log('--- stderr 尾部 ---')
  console.log(out.split('\n').slice(-10).join('\n'))
  process.exit(0)
})
setTimeout(() => {
  console.log('12s 后仍存活：serve 正常启动（OPENCODE_PORT 生效，未崩 8800）')
  c.kill()
  setTimeout(() => process.exit(0), 1000)
}, 12000)
