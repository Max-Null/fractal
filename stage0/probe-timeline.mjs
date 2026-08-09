// 探针：子智能体 created 与父消息事件的相对时序（B 验证——时间线锚定可靠性）
// 场景：prompt「先分析结构，再派侦查兵查版本，最后总结」→ 记录父消息 part 事件与子会话 created 的顺序
// 用法：node probe-timeline.mjs（需全局配置 key；XDG 隔离注入）
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { createOpencodeClient } from '@opencode-ai/sdk';

const FIX_DIR = join(os.homedir(), 'AppData', 'Roaming', 'fractal', 'config');
const XDG = join(FIX_DIR);
mkdirSync(XDG, { recursive: true });

// 用分形内置 sidecar（probe-subagent 验证过的模式）
const bin = join(process.cwd(), '..', 'resources', 'bin', 'opencode.exe');
const port = 54180 + Math.floor(Math.random() * 500);
const baseUrl = `http://127.0.0.1:${port}`;
const user = 'oc-gui-probe';
const pass = 'probe-' + Date.now();
const env = { ...process.env, XDG_CONFIG_HOME: XDG, OPENCODE_SERVER_USERNAME: user, OPENCODE_SERVER_PASSWORD: pass, NO_COLOR: '1' };

console.log('bin =', bin);
const child = spawn(bin, ['serve', '--port', String(port), '--hostname', '127.0.0.1', '--print-logs'], { env });
let serveLog = '';
child.stderr.on('data', (d) => { serveLog += d.toString('utf8', 0, d.length); });

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${baseUrl}/doc`, { headers: { Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') } });
      if (r.ok) return;
    } catch { /* 未就绪 */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('serve 未就绪');
}

const events = [];
const sids = new Set();

async function main() {
  await waitReady();
  console.log('serve 就绪 port=' + port);
  const client = createOpencodeClient({ baseUrl, headers: { Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') } });

  // 事件订阅（SDK 1.18.15 的 event.subscribe）
  const { stream } = await client.event.subscribe({ signal: new AbortController().signal });
  (async () => {
    for await (const evt of stream) {
      const e = evt;
      events.push(e);
      // 打印关键事件（会话创建/part 类型/状态）
      if (e.type === 'session.created') {
        const info = e.properties?.info ?? e.properties ?? {};
        sids.add(info.id ?? '?');
        console.log(`[evt] session.created id=${info.id} parent=${info.parentID ?? '-'} title=${(info.title ?? '').slice(0, 20)}`);
      } else if (e.type === 'message.part.updated') {
        const p = e.properties?.part ?? {};
        const delta = (e.properties?.delta ?? '').slice(0, 24).replace(/\n/g, ' ');
        console.log(`[evt] part.updated type=${p.type} state=${p.state?.status ?? '-'} call=${p.callID ?? '-'} tool=${p.tool ?? '-'} delta="${delta}"`);
      } else if (e.type === 'message.updated') {
        const info = e.properties?.info ?? {};
        console.log(`[evt] message.updated role=${info.role ?? '-'} id=${(info.id ?? '').slice(0, 18)}`);
      } else if (['session.idle', 'session.error', 'session.status'].includes(e.type)) {
        console.log(`[evt] ${e.type} sid=${(e.properties?.sessionID ?? e.properties?.id ?? '').slice(0, 18)}`);
      }
    }
  })();

  // 建会话 + 复合任务（思考→分析→子智能体→总结）
  const s1 = await client.session.create({ body: {} });
  const sid = s1.id ?? s1.data?.id;
  console.log('会话=' + sid);
  const prompt = '先分析当前目录的文件结构（列出 3 个关键文件即可），然后派侦查兵子智能体去联网查一下 opencode 的最新版本号，最后用一句话总结。';
  await client.session.promptAsync({ path: { id: sid }, body: { parts: [{ type: 'text', text: prompt }] } });

  // 等回合结束（idle）或超时
  await new Promise(resolve => setTimeout(resolve, 120_000));
  writeFileSync(join('fixtures', 'timeline-events.json'), JSON.stringify(events, null, 2));
  console.log('\n=== 摘要 ===');
  console.log('事件总数:', events.length);
  console.log('会话 ID:', [...sids]);
  // 分析：session.created（子会话）时父会话已有哪些 part 类型
  const createdIdx = events.findIndex(e => e.type === 'session.created');
  const beforeTypes = events.slice(0, createdIdx).filter(e => e.type === 'message.part.updated').map(e => e.properties?.part?.type);
  console.log('子会话 created 前父会话 part 序列:', beforeTypes.join(' → ') || '（无——子会话创建前父会话无任何 part 输出）');
  // 父会话（非子）part 完整序列
  const mainParts = events.filter(e => e.type === 'message.part.updated').map(e => {
    const p = e.properties?.part ?? {};
    return `${p.type}${p.tool ? ':' + p.tool : ''}`;
  });
  console.log('全部 part 序列（前 40）:', mainParts.slice(0, 40).join(' → '));
  child.kill();
  process.exit(0);
}

main().catch((e) => { console.error('失败:', e.message); child.kill(); process.exit(1); });
