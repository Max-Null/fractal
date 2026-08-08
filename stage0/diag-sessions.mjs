// 临时诊断：真实配置+共享数据下 serve 返回的会话列表（2026-08-09）
import { createOpencodeClient } from '@opencode-ai/sdk';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BIN = 'H:\\MaxNull\\WorkStation\\fractal\\resources\\bin\\opencode.exe';
const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const auth = { user: 'diag', pass: 'diag-' + Math.random().toString(36).slice(2, 10) };

const port = await freePort();
const env = {
  ...process.env,
  XDG_CONFIG_HOME: path.join(process.env.APPDATA, 'fractal', 'config'), // 用户真实隔离配置
  OPENCODE_SERVER_USERNAME: auth.user,
  OPENCODE_SERVER_PASSWORD: auth.pass,
};
const child = spawn(BIN, ['serve', '--port', String(port), '--hostname', '127.0.0.1', '--print-logs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', d => { out += d; if (out.includes('server listening')) tryHealth(); });
child.stderr.on('data', d => { out += d; });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let done = false;
async function tryHealth() {
  for (let i = 0; i < 40 && !done; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/doc`, { headers: { Authorization: 'Basic ' + Buffer.from(`${auth.user}:${auth.pass}`).toString('base64') } });
      if (r.ok) { await query(); return; }
    } catch {}
    await sleep(500);
  }
  if (!done) { console.log('DIAG serve 未就绪'); process.exit(1); }
}
async function query() {
  const client = createOpencodeClient({ baseUrl: `http://127.0.0.1:${port}`, headers: { Authorization: 'Basic ' + Buffer.from(`${auth.user}:${auth.pass}`).toString('base64') } });
  // 1) spec 里 session list 的 limit 参数定义
  const doc = await (await fetch(`http://127.0.0.1:${port}/doc`, { headers: { Authorization: 'Basic ' + Buffer.from(`${auth.user}:${auth.pass}`).toString('base64') } })).json();
  const paths = Object.keys(doc.paths || {}).filter(p => p.includes('session'));
  console.log('DIAG PATHS', paths.join(', '));
  const v1Get = doc.paths?.['/session']?.get;
  console.log('DIAG V1_LIMIT', JSON.stringify(v1Get?.parameters?.find(p => p.name === 'limit') || 'none'));
  // 2) v1 各种 limit 实测
  for (const lim of [50, 100, 200]) {
    const r = await client.session.list({ query: { limit: lim } });
    console.log('DIAG V1 limit=' + lim, '→', (r.data ?? []).length);
  }
  // 3) v2 API
  const v2 = await (await fetch(`http://127.0.0.1:${port}/api/session?limit=1000`, { headers: { Authorization: 'Basic ' + Buffer.from(`${auth.user}:${auth.pass}`).toString('base64') } })).json();
  const v2arr = v2.data ?? [];
  console.log('DIAG V2 ?limit=1000 →', v2arr.length, '| keys:', Object.keys(v2).join(','));
  const v2b = await (await fetch(`http://127.0.0.1:${port}/api/session?limit=200`, { headers: { Authorization: 'Basic ' + Buffer.from(`${auth.user}:${auth.pass}`).toString('base64') } })).json();
  console.log('DIAG V2 ?limit=200 →', (v2b.data ?? []).length);
  const v2c = await (await fetch(`http://127.0.0.1:${port}/api/session`, { headers: { Authorization: 'Basic ' + Buffer.from(`${auth.user}:${auth.pass}`).toString('base64') } })).json();
  console.log('DIAG V2 无limit →', (v2c.data ?? []).length, '| next:', v2c.next ?? '无');
  const main = v2arr.filter(s => !s.parentID);
  console.log('DIAG V2 MAIN', main.length);
  const byDir = {};
  for (const s of main) byDir[s.directory || s.cwd] = (byDir[s.directory || s.cwd] || 0) + 1;
  console.log('DIAG V2 BY_DIR', JSON.stringify(byDir));
  // 4) v2 会话完整字段（前端过滤需要 directory/cwd 字段名）
  console.log('DIAG V2 FIELDS', JSON.stringify(Object.keys(v2arr[0] || {})));
  const dirField = main[0] || {};
  console.log('DIAG V2 DIR_VALUES', JSON.stringify({ directory: dirField.directory, cwd: dirField.cwd, workspace: dirField.workspace, location: dirField.location }));
  // 5) v1 start 分页尝试
  const v1s = await (await fetch(`http://127.0.0.1:${port}/session?start=50&limit=50`, { headers: { Authorization: 'Basic ' + Buffer.from(`${auth.user}:${auth.pass}`).toString('base64') } })).json();
  console.log('DIAG V1 start=50 →', Array.isArray(v1s) ? v1s.length : '非数组');
  done = true;
  child.kill();
  process.exit(0);
}
child.on('exit', (c) => { if (!done) { console.log('DIAG serve 退出', c); process.exit(1); } });
