// scout-websearch：DeepSeek 服务端联网搜索注入代理
// 职责：起本地 HTTP 代理（127.0.0.1:8800）转发到 DeepSeek Anthropic 端点，
// 并在转发前给请求 tools 注入 web_search_20260209 服务端工具声明。
// WHY：opencode 协议层序列化工具不带 type 字段，DeepSeek 端点要求
// type=web_search_20260209 才执行服务端搜索（实测其他格式返回 tool_use 或 400）。
import http from "node:http"
import https from "node:https"

const PORT = 8800
const UPSTREAM = "api.deepseek.com"
const UPSTREAM_PATH = "/anthropic"
const WEB_SEARCH_TOOL = {
  type: "web_search_20260209",
  name: "web_search",
  description: "Search the web for current information. Returns up-to-date results with sources.",
  input_schema: { type: "object" },
}

// 给请求 tools 注入 web_search 服务端工具声明（若已存在同名工具则跳过）
function injectWebSearch(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.tools)) {
    body.tools = [WEB_SEARCH_TOOL]
    return
  }
  const hasSearch = body.tools.some((t) => t && (t.name === "web_search" || t.type === "web_search_20260209" || t.type === "web_search_20250305"))
  if (!hasSearch) body.tools.push(WEB_SEARCH_TOOL)
}

// 透传 HTTP headers（排除 hop-by-hop 与 host）
function forwardHeaders(headers, incoming) {
  const out = { ...headers }
  delete out.host
  delete out.connection
  delete out["content-length"]
  delete out["transfer-encoding"]
  return out
}

const server = http.createServer((req, res) => {
  const chunks = []
  req.on("data", (c) => chunks.push(c))
  req.on("end", () => {
    const raw = Buffer.concat(chunks)
    let body = null
    try {
      body = raw.length ? JSON.parse(raw.toString("utf8")) : null
    } catch {
      body = null
    }
    // 仅对 /v1/messages 的 JSON 请求注入搜索工具；其他请求原样转发
    if (req.url.startsWith("/v1/messages") && body) {
      injectWebSearch(body)
    }
    const payload = body ? JSON.stringify(body) : raw.toString("utf8")

    const upstreamReq = https.request(
      {
        hostname: UPSTREAM,
        port: 443,
        path: UPSTREAM_PATH + req.url,
        method: req.method,
        headers: { ...forwardHeaders(req.headers), "content-length": Buffer.byteLength(payload) },
      },
      (upRes) => {
        res.writeHead(upRes.statusCode, upRes.headers)
        upRes.pipe(res)
      },
    )
    upstreamReq.on("error", (err) => {
      res.writeHead(502, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: `proxy error: ${err.message}` } }))
    })
    upstreamReq.write(payload)
    upstreamReq.end()
  })
})

export const ScoutWebSearch = async () => {
  server.listen(PORT, "127.0.0.1")
  console.log(`[scout-websearch] proxy listening on http://127.0.0.1:${PORT} -> https://${UPSTREAM}${UPSTREAM_PATH}`)
  return {}
}
