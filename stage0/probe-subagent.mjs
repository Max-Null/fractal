// probe-subagent.mjs —— 子智能体事件流可见性实测（2026-08-09）
// 目的：回答「主会话 SSE 事件流里能看到子 agent 的哪些活动？」
//   A. task 工具 part 的状态流转（pending→running→completed）？
//   B. 子会话（新 sessionID）的事件是否混入主会话事件流（子 agent 的思考/工具/消息）？
//   C. 子会话最终反馈内容是否可达（session.messages(subId)）？
// 用法：node probe-subagent.mjs（需 DEEPSEEK_API_KEY 在隔离配置中，stage0 配置复制全局 key）
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";

const XDG = join(os.tmpdir(), "oc-probe-subagent-" + Date.now());
await mkdir(join(XDG, "opencode"), { recursive: true });
await mkdir(join(XDG, "opencode", "agents"), { recursive: true });

// 复制全局配置的 key（探针直接读全局 provider-configs 的 key 来源——分形隔离配置）
const fracCfg = join(process.env.APPDATA, "fractal", "provider-configs.json");
let apiKey = "";
try { apiKey = JSON.parse(await readFile(fracCfg, "utf8")).deepseek?.apiKey || ""; } catch {}
if (!apiKey) { console.error("未找到 API Key（fractal/provider-configs.json）"); process.exit(1); }

// 隔离配置（含 key + 分形 agent 定义引用）
const cfg = {
  model: "deepseek/deepseek-v4-flash",
  provider: { deepseek: { options: { apiKey, baseURL: "https://api.deepseek.com/v1" } } },
  agent: {
    双星: { description: "分形主智能体", mode: "primary", prompt: "你是分形的主智能体。" },
    侦查兵: { description: "联网调研", mode: "subagent", prompt: "你是侦查兵，用 websearch 调研。" },
    工匠: { description: "编码工匠", mode: "subagent", prompt: "你是工匠，负责编码。" },
  },
};
await writeFile(join(XDG, "opencode", "opencode.json"), JSON.stringify(cfg, null, 2));

// 启动 serve
const serve = spawn(join(process.cwd(), "..", "resources", "bin", "opencode.exe"), ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
  env: { ...process.env, XDG_CONFIG_HOME: XDG, OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: "probe" },
  stdio: ["ignore", "pipe", "pipe"],
});
let port = "";
let errBuf = "";
serve.stdout.on("data", (d) => {
  const s = d.toString("utf8");
  const m = s.match(/listening on.*:(\d+)/);
  if (m && !port) { port = m[1]; }
  if (s.includes("listening")) console.error("[serve] " + s.trim());
});
serve.stderr.on("data", (d) => { errBuf += d.toString("utf8"); });

// 端口解析超时保护（--port 0 的 listening 输出格式若变化不再死循环）
const waitPort = () => new Promise((res, rej) => {
  const t0 = Date.now();
  const t = setInterval(() => {
    if (port) { clearInterval(t); res(); }
    else if (Date.now() - t0 > 30000) { clearInterval(t); rej(new Error("serve 端口 30s 未就绪，stderr=" + errBuf.slice(-300))); }
  }, 200);
});
const baseURL = () => `http://127.0.0.1:${port}`;
const AUTH = "Basic " + Buffer.from("opencode:probe").toString("base64");

async function post(path, body) {
  const r = await fetch(baseURL() + path, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: AUTH }, body: JSON.stringify(body ?? {}),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}
async function get(path) {
  const r = await fetch(baseURL() + path, { headers: { Authorization: AUTH } });
  return { status: r.status, json: await r.json().catch(() => null) };
}

await waitPort();
console.log("\n=== 建主会话 ===");
const s = await post("/session", {});
const mainId = s.json.id;
console.log("主会话:", mainId);

// 订阅事件流（全部事件——重点观察子会话事件是否混入主会话 SSE）
const events = [];
const ctrl = new AbortController();
const evtFetch = fetch(`${baseURL()}/event`, { headers: { Authorization: AUTH }, signal: ctrl.signal });
(async () => {
  const resp = await evtFetch;
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      try { events.push(JSON.parse(t.slice(5).trim())); } catch {}
    }
  }
})();

// 触发子 agent：明确要求用 task 工具
console.log("\n=== 触发子智能体（task 工具）===");
const p = await post(`/session/${mainId}/prompt_async`, {
  parts: [{ type: "text", text: "请使用 task 工具调用「侦查兵」子智能体，让它用 websearch 查一下今天深圳的天气，然后把它的反馈总结给我。必须调用 task 工具。" }],
});
console.log("prompt_async:", p.status, JSON.stringify(p.json).slice(0, 120));

// 等待 idle（最多 180s）
const t0 = Date.now();
while (Date.now() - t0 < 180000) {
  const m = await get(`/session/${mainId}/message`);
  if (m.json?.length) {
    const last = m.json[m.json.length - 1];
    if (last.info?.role === "assistant" && last.parts?.some((pt) => pt.type === "step-finish")) break;
  }
  await new Promise((r) => setTimeout(r, 2000));
}
ctrl.abort();

// 分析事件
console.log("\n=== 事件分析（共 " + events.length + " 条）===");
const sessionIDs = new Set(events.map((e) => e.sessionID));
console.log("出现过的 sessionID 集合:", [...sessionIDs]);
const types = {};
for (const e of events) { const k = e.type + (e.sessionID !== mainId ? " [子会话]" : ""); types[k] = (types[k] || 0) + 1; }
console.log("事件类型统计:", types);

// 找 task 工具 part
const taskParts = [];
for (const e of events) {
  if (e.type === "message.part.updated" && e.part?.type === "tool" && (e.part.tool === "task" || e.part.tool?.name === "task")) {
    taskParts.push({ state: e.part.state, callID: e.part.callID, sessionID: e.sessionID, tool: JSON.stringify(e.part.tool).slice(0, 200) });
  }
}
console.log("\ntask 工具 part 状态流转:", taskParts.length ? taskParts : "无");

// 子会话的 assistant 消息（子 agent 活动是否可见）
const subMsgs = [];
for (const e of events) {
  if (e.sessionID !== mainId && e.type === "message.part.updated" && e.part?.type === "text") {
    subMsgs.push(`[子 ${e.sessionID.slice(0, 20)}] ${e.part.text.slice(0, 80)}`);
  }
}
console.log("\n子会话 text part 事件数:", subMsgs.length, subMsgs.slice(0, 5));

// 子会话列表（找到子会话 id）
const list = await get("/session?limit=100");
const all = list.json?.sessions ?? list.json ?? [];
const subIds = all.filter((x) => x.parentID).map((x) => ({ id: x.id, parent: x.parentID, title: x.title, agent: x.agent }));
console.log("\n=== 子会话列表（serve 侧）===", subIds);

// C：子会话最终反馈可达性
if (subIds.length) {
  console.log("\n=== C. 子会话最终反馈 ===");
  const msgs = await get(`/session/${subIds[0].id}/message`);
  const lastAsst = [...(msgs.json ?? [])].reverse().find((m) => m.info?.role === "assistant");
  if (lastAsst) {
    const textParts = (lastAsst.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n");
    console.log("子会话最后 assistant 文本:", textParts.slice(0, 500));
  } else {
    console.log("子会话无 assistant 消息");
  }
}

console.log("\n=== serve stderr 尾部 ===");
console.log(errBuf.slice(-500));
serve.kill();
await rm(XDG, { recursive: true, force: true });
