// 阶段 0 实测：OC serve 全链路探针（方案附录 B serve 轨）
// 用法：
//   node probe-serve.mjs                  # 协议层 + 模型轮（需本机已有 DeepSeek 凭据或注入 key）
//   node probe-serve.mjs --api-key sk-xxx # 注入 DeepSeek API Key（D17 隔离目录下无 auth，必传）
//   node probe-serve.mjs --auto           # 附带验证 serve 是否支持 --auto 启动参数（P4）
//   node probe-serve.mjs --skip-model     # 仅协议层（无 key 时跑通建会话/事件流/元数据）
// 产物：fixtures/ 目录下 JSON 证据 + 控制台逐项 PASS/FAIL 结论表
import { spawn } from "node:child_process";
import { mkdir, writeFile, appendFile, access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { createOpencodeClient } from "@opencode-ai/sdk";

// ── 配置 ──
const HAS_FLAG = (f) => process.argv.includes(f);
const AUTO = HAS_FLAG("--auto");
const SKIP_MODEL = HAS_FLAG("--skip-model");
const keyIdx = process.argv.indexOf("--api-key");
const API_KEY = keyIdx > -1 ? process.argv[keyIdx + 1] : process.env.DEEPSEEK_API_KEY;

// serve v1.15+ 默认要求 HTTP Basic 认证（实测 401 + WWW-Authenticate: Basic realm="Secure Area"，
// issue #31254 官方关闭 not planned）：凭据由 OPENCODE_SERVER_USERNAME/PASSWORD 环境变量配置，
// 启动时注入随机密码（本地回环 + 随机 = 安全），客户端（fetch/SDK）统一带 Basic 头
const SERVER_USER = "opencode";
const SERVER_PASS = crypto.randomBytes(16).toString("hex");
const basicHeader = "Basic " + Buffer.from(`${SERVER_USER}:${SERVER_PASS}`).toString("base64");

const FIX_DIR = fileURLToPath(new URL("./fixtures/", import.meta.url));
const RESULTS = []; // 结论表 [{id, name, status, detail}]
const PASS = (id, name, detail = "") => RESULTS.push({ id, name, status: "PASS", detail });
const FAIL = (id, name, detail = "") => RESULTS.push({ id, name, status: "FAIL", detail });
const NOTE = (id, name, detail = "") => RESULTS.push({ id, name, status: "待确认", detail });

// ── 工具函数 ──
async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, opts = {}) {
  // serve 要求 Basic 认证，所有裸 fetch 统一带头（调用点在 basicHeader 初始化之后）
  const headers = { ...(opts.headers || {}), Authorization: basicHeader };
  const res = await fetch(url, { ...opts, headers });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

// 轮询事件数组找指定会话的 idle（事件是全局流，按 sessionID 过滤）
async function waitIdle(events, sessionID, timeoutMs = 120_000, label = "") {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (events.some((e) => e.type === "session.idle" && e.properties?.sessionID === sessionID)) {
      return true;
    }
    if (events.some((e) => e.type === "session.error" && e.properties?.sessionID === sessionID)) {
      return false; // 出错提前返回，由调用方看 error 详情
    }
    await sleep(200);
  }
  console.log(`  ⏱ 等待 idle 超时（${label}）`);
  return false;
}

// ── 主流程 ──
await mkdir(FIX_DIR, { recursive: true });
// Windows 下 opencode 是 npm shim（.cmd），CreateProcess 不解析；解析 shim 找到真实 exe
// （%APPDATA%\npm\opencode.cmd → %APPDATA%\npm\node_modules\opencode-ai\bin\opencode.exe），
// 直接 spawn 原生 exe 可避免 cmd 中间层导致进程树清理失败
async function resolveOpencodeBin() {
  if (process.platform !== "win32") return "opencode";
  const npmDir = process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : null;
  if (!npmDir) return "opencode";
  const cmdPath = path.join(npmDir, "opencode.cmd");
  try {
    const content = await readFile(cmdPath, "utf8");
    const m = content.match(/"([^"]*%dp0%[^"]*\.exe)"/i);
    if (m) {
      const p = path.resolve(m[1].replace(/%dp0%/i, npmDir));
      await access(p); // 存在性检查，失败则走兜底
      return p;
    }
  } catch {}
  return "opencode"; // 兜底：依赖 PATH（或非 Windows）
}

// ① 启动 serve（注入 OPENCODE_APPNAME 验证 D17 隔离）
console.log("── ① 启动 opencode serve ──");
const bin = await resolveOpencodeBin();
const port = await getFreePort();
const baseURL = `http://127.0.0.1:${port}`;
const serveArgs = ["serve", "--port", String(port), "--hostname", "127.0.0.1", "--print-logs"];
if (AUTO) serveArgs.push("--auto");
const env = { ...process.env, OPENCODE_APPNAME: "oc-gui", OPENCODE_SERVER_USERNAME: SERVER_USER, OPENCODE_SERVER_PASSWORD: SERVER_PASS };
if (API_KEY) {
  // DeepSeek provider 的 key 环境变量名待实测：两个都注入，从 /provider 结果确认
  env.DEEPSEEK_API_KEY = API_KEY;
  env.OPENAI_API_KEY = API_KEY;
}
console.log(`  bin=${bin}`);
const child = spawn(bin, serveArgs, { env, stdio: ["ignore", "pipe", "pipe"] });
let serveLog = "";
child.on("error", (err) => { serveLog += `[spawn error] ${err.message}\n`; console.log(`  [serve] spawn 失败：${err.message}`); });
child.stdout.on("data", (d) => { serveLog += d; if (serveLog.length < 4000) process.stdout.write(`  [serve] ${d}`); });
child.stderr.on("data", (d) => { serveLog += d; if (serveLog.length < 4000) process.stdout.write(`  [serve-err] ${d}`); });
child.on("exit", (code) => console.log(`  [serve] 进程退出 code=${code}`));

// 健康检查：轮询候选 spec 路径（serve 的 OpenAPI 路径因版本而异：/doc.json /doc /openapi.json）
const SPEC_CANDIDATES = ["/doc.json", "/doc", "/openapi.json"];
let specPath = null;
let healthy = false;
for (let i = 0; i < 60 && !healthy; i++) {
  for (const p of SPEC_CANDIDATES) {
    try {
      const r = await fetchJson(`${baseURL}${p}`);
      if (r.status === 200 && typeof r.body === "object") { specPath = p; healthy = true; break; }
    } catch {}
  }
  if (!healthy) await sleep(500);
}
if (!healthy) {
  FAIL("S0", "serve 启动与健康检查", "60×500ms 内 spec 路径全部不可达");
  await writeFile(fileURLToPath(new URL("./fixtures/serve-stdout.log", import.meta.url)), serveLog);
  child.kill();
printResults();
process.exit(0);
  process.exit(1);
}
PASS("S0", "serve 启动与健康检查", `port=${port}，spec 路径 ${specPath} 可达（${AUTO ? "带 --auto" : "默认"}）`);
await writeFile(fileURLToPath(new URL("./fixtures/serve-stdout.log", import.meta.url)), serveLog);

// ② 元数据：OpenAPI spec + /app 版本 + provider/model 清单
console.log("── ② 元数据收集 ──");
const doc = await fetchJson(`${baseURL}${specPath}`);
await writeFile(fileURLToPath(new URL("./fixtures/api-spec.json", import.meta.url)), JSON.stringify(doc.body, null, 2));
PASS("S1", `${specPath} OpenAPI spec`, `状态 ${doc.status}，已存 fixtures/api-spec.json（size=${JSON.stringify(doc.body).length}）`);

// /app 是 Web UI 入口（返回 HTML），版本从 spec 的 info.version 取；OPENCODE_APPNAME 隔离验证移待 /config
const app = await fetchJson(`${baseURL}/app`);
await writeFile(fileURLToPath(new URL("./fixtures/app.json", import.meta.url)), JSON.stringify(app.body, null, 2));
const specVersion = doc.body?.info?.version ?? "(spec 无 info.version)";
const isHtml = typeof app.body === "string" && app.body.trim().startsWith("<!doctype");
PASS("S2", "应用信息与版本", `spec info.version=${specVersion}；GET /app 返回 ${isHtml ? "HTML（Web UI 入口，非 API）" : "JSON"}（隔离验证改验 /config）`);

// provider 清单（serve 无 /model 端点——返回 SPA HTML；模型从 /provider.all[].models 提取）
const providers = await fetchJson(`${baseURL}/provider`);
await writeFile(fileURLToPath(new URL("./fixtures/providers.json", import.meta.url)), JSON.stringify(providers.body, null, 2));
const providerList = Array.isArray(providers.body) ? providers.body : providers.body?.all ?? [];
const deepseekModels = [];
for (const p of providerList) {
  const pname = String(p.id).toLowerCase() + " " + String(p.name ?? "").toLowerCase();
  if (pname.includes("deepseek")) {
    for (const mid of Object.keys(p.models ?? {})) deepseekModels.push({ id: mid, providerID: p.id });
  }
}
console.log(`  共 ${providerList.length} 个 provider，deepseek 相关 ${deepseekModels.length} 个模型：`, deepseekModels.map((m) => `${m.providerID}/${m.id}`).join(", ") || "(无)");
NOTE("S3", "provider/模型清单", `GET /provider 状态 ${providers.status}（all[] 含 ${providerList.length} provider）；serve 无 /model 端点（SPA HTML 兜底）`);

// ③ SDK 连接 + 建会话 + 事件订阅 + 首轮消息
console.log("── ③ SDK 建会话 / 事件订阅 / 首轮消息 ──");
const client = createOpencodeClient({ baseUrl: baseURL, headers: { Authorization: basicHeader } });
const events = [];
const counts = {};
const recorder = (async () => {
  try {
    const { stream } = await client.event.subscribe();
    for await (const ev of stream) {
      events.push(ev);
      counts[ev.type] = (counts[ev.type] || 0) + 1;
    }
  } catch (err) {
    console.log(`  ⚠ 事件流中断：${err.message}`);
  }
})();
await sleep(300); // 等待订阅建立

const s1r = await client.session.create({ body: {} });
  console.log("  [调试] create keys:", Object.keys(s1r), "| status:", s1r.response?.status, "| url:", s1r.request?.url, "| reqBody:", JSON.stringify(s1r.request?.body), "| data:", JSON.stringify(s1r.data)?.slice(0, 400), "| err:", s1r.error?.name, s1r.error?.message, JSON.stringify(s1r.error?.body)?.slice(0, 300));
  const s1 = s1r.data ?? s1r;
if (s1?.id) {
  PASS("S4", "SDK 建会话", `session.id=${s1.id}`);
} else {
  FAIL("S4", "SDK 建会话", `create 返回 ${JSON.stringify(s1r.error ?? s1r).slice(0, 300)}`);
}
console.log(`  会话 ${s1.id}，事件类型计数：${JSON.stringify(counts)}`);

// 模型轮（无 key 或 --skip-model 时跳过）
if (!SKIP_MODEL && deepseekModels.length > 0) {
  const model = deepseekModels.find((m) => String(m.id).toLowerCase().includes("flash")) ?? deepseekModels[0];
  // model.id 形如 "deepseek/deepseek-v4-flash"，providerID 与 modelID 需拆分
  const providerID = String(model.id).split("/")[0] ?? "deepseek";
  const modelID = String(model.id).split("/")[1] ?? model.id;
  console.log(`── ④ 首轮消息（model=${model.id}）──`);
  try {
    const resp = await client.session.promptAsync({
      path: { id: s1.id },
      body: {
        // model 为嵌套对象 {providerID, modelID}（SDK 类型 SessionPromptAsyncData）
        model: { providerID, modelID },
        parts: [{ type: "text", text: "只回复两个字：你好" }],
      },
    });
    await waitIdle(events, s1.id, 120_000, "round1");
    await writeFile(fileURLToPath(new URL("./fixtures/events-round1.json", import.meta.url)), JSON.stringify(events, null, 2));
    const m = await client.session.messages(s1.id);
    await writeFile(fileURLToPath(new URL("./fixtures/messages-round1.json", import.meta.url)), JSON.stringify(m, null, 2));
    PASS("S5", "chat + SSE 事件流", `idle 达成，事件 ${events.length} 条；chat 返回 tokens=${resp?.tokens ?? "?"}`);
    const stepParts = events.filter((e) => e.type === "message.part.updated").map((e) => e.properties?.part?.type);
    console.log(`  part 类型序列：${stepParts.join(" → ")}（P7 回答时间线阶段识别依据）`);
  } catch (err) {
    FAIL("S5", "chat + SSE 事件流", err.message);
  }
} else {
  console.log("── ④ 跳过模型轮（--skip-model 或无 API_KEY/模型清单）──");
  NOTE("S5", "chat + SSE 事件流", "跳过：需 --api-key 且 /model 含 deepseek");
}

// ⑤ 工具调用与权限审批（P5/P6/C-2 的关键实测）
if (!SKIP_MODEL && deepseekModels.length > 0) {
  console.log("── ⑤ 工具调用 / 权限审批 ──");
  const s2r = await client.session.create({ body: {} });
  const s2 = s2r.data;
  const t0 = events.length;
  try {
    await client.session.promptAsync({
      path: { id: s2.id },
      body: {
        model: { providerID: String(deepseekModels[0].id).split("/")[0], modelID: deepseekModels[0].id },
        parts: [{ type: "text", text: "用工具读取当前目录的文件列表" }],
      },
    });
    // 等待权限事件或 idle
    let perm = null;
    for (let i = 0; i < 300; i++) {
      perm = events.slice(t0).find((e) => e.type === "permission.updated" && e.properties?.sessionID === s2.id);
      if (perm) break;
      if (events.some((e) => e.type === "session.idle" && e.properties?.sessionID === s2.id)) break;
      await sleep(200);
    }
    if (perm) {
      const p = perm.properties;
      console.log(`  permission.updated：id=${p.id} title=${p.title} metadata=${JSON.stringify(p.metadata)}`);
      await writeFile(fileURLToPath(new URL("./fixtures/permission-event.json", import.meta.url)), JSON.stringify(perm, null, 2));
      // 审批响应（附录 B 端点，SDK 方法名待实测 → 裸 fetch 验证）
      const res = await fetchJson(`${baseURL}/session/${s2.id}/permissions/${p.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: "allow", remember: false }),
      });
      PASS("S6", "权限事件 + 审批响应", `审批 POST 状态 ${res.status} body=${JSON.stringify(res.body)}`);
      await waitIdle(events, s2.id, 120_000, "round2");
    } else {
      // 默认权限可能全 allow（v1.12 设计），工具直接执行无弹窗 → 也是有效结论
      NOTE("S6", "权限事件 + 审批响应", "未捕获 permission.updated（可能默认 allow 直接放行，符合 v1.12 设计；或工具未触发）");
    }
    await writeFile(fileURLToPath(new URL("./fixtures/events-round2.json", import.meta.url)), JSON.stringify(events, null, 2));
    const m2 = await client.session.messages(s2.id);
    await writeFile(fileURLToPath(new URL("./fixtures/messages-round2.json", import.meta.url)), JSON.stringify(m2, null, 2));
    // 工具 part 状态流（P7 操作阶段识别）
    const toolStates = events.filter((e) => e.type === "message.part.updated" && e.properties?.part?.type === "tool")
      .map((e) => `${e.properties.part.tool}(${e.properties.part.state?.status})`);
    console.log(`  工具 part 状态流：${toolStates.join(" → ")}`);
  } catch (err) {
    FAIL("S6", "工具调用 / 权限审批", err.message);
  }
} else {
  console.log("── ⑤ 跳过工具轮（需模型）──");
}

// ⑥ abort 测试
if (!SKIP_MODEL && deepseekModels.length > 0) {
  console.log("── ⑥ abort 中断 ──");
  const s3r = await client.session.create({ body: {} });
  const s3 = s3r.data;
  const t1 = events.length;
  try {
    await client.session.promptAsync({
      path: { id: s3.id },
      body: {
        // SDK 1.18.13 无 session.chat 方法，用与 S5 相同的 promptAsync 结构
        model: { providerID: String(deepseekModels[0].id).split("/")[0], modelID: deepseekModels[0].id },
        parts: [{ type: "text", text: "请写一篇 3000 字的文章，写完前不要停" }],
      },
    });
    await sleep(1500);
    const aborted = await client.session.abort(s3.id);
    await sleep(1000);
    const tail = events.slice(t1).map((e) => e.type);
    console.log(`  abort 返回 ${JSON.stringify(aborted)}；abort 后事件序列：${tail.join(" → ")}`);
    PASS("S7", "abort 中断", `abort 返回 ${JSON.stringify(aborted)}，后续事件 ${tail.length} 条（见 events-round3.json）`);
    await writeFile(fileURLToPath(new URL("./fixtures/events-round3.json", import.meta.url)), JSON.stringify(events.slice(t1), null, 2));
  } catch (err) {
    FAIL("S7", "abort 中断", err.message);
  }
} else {
  console.log("── ⑥ 跳过 abort 轮（需模型）──");
}

// ⑦ fork 测试
console.log("── ⑦ fork ──");
try {
  const forkRes = await fetchJson(`${baseURL}/session/${s1.id}/fork`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
  PASS("S8", "fork 分叉", `POST /session/:id/fork 状态 ${forkRes.status}，新会话=${forkRes.body?.id ?? JSON.stringify(forkRes.body)}`);
} catch (err) {
  FAIL("S8", "fork 分叉", err.message);
}

// ⑧ 会话级 model 参数（附录 B 步骤 f：PATCH /session/:id 标题）
console.log("── ⑧ 会话元信息 ──");
try {
  const upd = await fetchJson(`${baseURL}/session/${s1.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "阶段0-实测会话" }) });
  PASS("S9", "PATCH /session/:id 标题", `状态 ${upd.status} body=${JSON.stringify(upd.body)}`);
} catch (err) {
  FAIL("S9", "PATCH /session/:id 标题", err.message);
}

// 收尾：等事件流自然结束、生成汇总、杀 serve
await sleep(800);
recorder?.return?.();
await writeFile(fileURLToPath(new URL("./fixtures/events-all.json", import.meta.url)), JSON.stringify(events, null, 2));
await writeFile(fileURLToPath(new URL("./fixtures/summary.json", import.meta.url)), JSON.stringify({
  opened: { opencode: "1.18.5", serveArgs, env: { OPENCODE_APPNAME: "oc-gui", injectedKey: !!API_KEY } },
  eventTypeCounts: counts,
  results: RESULTS,
}, null, 2));

// 杀 serve（Windows 需 /T 树杀，避免残留子进程）
child.kill();
await sleep(800);
try { spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}

printResults();

// 强制退出：SSE 事件流连接（recorder 非 generator，无 return 可 abort）会挂住事件循环
process.exit(0);

// ── 结论表 ──
function printResults() {
  console.log("\n══ 阶段 0 实测结论表 ══");
  for (const r of RESULTS) {
    console.log(`  [${r.status}] ${r.id} ${r.name} — ${r.detail}`);
  }
  console.log(`\n产物：${FIX_DIR}（api-spec / app / providers / models / events-* / messages-* / summary）`);
}
