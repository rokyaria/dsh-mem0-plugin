#!/usr/bin/env node
/**
 * mem0-llm-shim —— 把 mem0ai 发的 `response_format: {type:"json_object"}` 改写成
 * LM Studio 能接受的形状，再转发给它。
 *
 * 为什么需要它（2026-10-16 实测）：
 *   mem0ai 的 `lmstudio` provider 继承 OpenAILLM，抽取事实时发
 *   `response_format: {type: "json_object"}`；LM Studio 的 /v1/chat/completions
 *   只认 `json_schema` 或 `text`，直接回 400：
 *     "'response_format.type' must be 'json_schema' or 'text'"
 *   于是 infer:true 这条路在 LM Studio 上走不通（Ollama 原生支持 JSON 格式，
 *   但 Docker 版在 macOS 上是纯 CPU：实测一次调用 4 分钟 + 4096 上下文截断，
 *   同样不可用）。
 *
 * 这个 shim 做两件事，都是"适配本机模型"，不碰 mem0 的语义：
 *   ① 请求侧：json_object → json_schema（宽松 schema，等价于"给我一个 JSON 对象"）
 *   ② 响应侧：**推理模型会把答案放进 `reasoning_content`，`content` 是空的** ——
 *      mem0ai 的 extractJson 拿到的就是空串，报 `text.replace is not a function`。
 *      所以 content 为空时把 reasoning_content 搬过去。
 *   ③ 响应侧：**LM Studio 会带一个 `tool_calls: []`（空数组）**，而 OpenAI 真 API
 *      在没有工具调用时干脆不带这个字段。mem0ai 的 OpenAILLM 里写的是
 *      `if (response.tool_calls) { return {content, role, toolCalls} }` —— **空数组在 JS 里是 truthy**，
 *      于是本该返回字符串的地方返回了对象，调用方 `.replace` 直接炸：
 *      `TypeError: text.replace is not a function`。所以把空的 tool_calls 删掉。
 * 其余请求/响应原样透传。纯本地、无依赖、默认端口 1235。
 *
 *   node server.mjs [--port 1235] [--upstream http://127.0.0.1:1234]
 */
import { createServer } from 'node:http'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const PORT = Number(arg('--port', '1235'))
const UPSTREAM = arg('--upstream', 'http://127.0.0.1:1234')
/**
 * 抽取是"判断题"，不该抽样：默认把 temperature 钉成 0。
 * 起因（2026-10-16）：同一段自我介绍，一次抽出 2 条事实、另一次返回 {"memory": []} ——
 * 采样让"值不值得记"每次都变，去重也就测不出来。--temperature 传 -1 则不干预。
 */
const TEMPERATURE = Number(arg('--temperature', '0'))

/**
 * 第一个版本把它改写成 json_schema（宽松 schema），结果更糟：LM Studio 会**照着 schema 约束**输出，
 * 而我们的 schema 是「任意对象」，于是模型回了一个「形状对、内容是空对象」的 JSON
 * （memory 数组里只有一个 {}）—— mem0 的 zod 校验要求 id/text，于是抽 0 条（2026-10-16 实测）。
 *
 * 所以改成 LM Studio 也接受的 text：**等于不加约束**，让模型按 mem0 的提示词自己输出 JSON
 * （mem0 的 extractJson 会剥掉代码块、再从中找 JSON 对象）。
 * 这也更接近 OpenAI 的 json_object 原义 ——「请回 JSON」，而不是「按这个 schema 回」。
 */
function toTextFormat() {
  return { type: 'text' }
}

const server = createServer(async (req, res) => {
  if (!req.url || !req.url.startsWith('/v1/')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'only /v1/* is proxied' } }))
    return
  }
  const chunks = []
  for await (const c of req) chunks.push(c)
  let body = Buffer.concat(chunks).toString('utf8')
  let rewritten = false
  if (body && req.method === 'POST') {
    try {
      const parsed = JSON.parse(body)
      let touched = false
      const rf = parsed?.response_format
      if (rf && rf.type === 'json_object') {
        parsed.response_format = toTextFormat()
        rewritten = true
        touched = true
      }
      if (TEMPERATURE >= 0 && parsed.temperature === undefined) {
        parsed.temperature = TEMPERATURE
        touched = true
      }
      if (touched) body = JSON.stringify(parsed)
    } catch {
      // 不是 JSON 就原样转发（比如 /v1/models 的 GET 没有 body）
    }
  }
  try {
    const upstream = await fetch(UPSTREAM + req.url, {
      method: req.method,
      headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    })
    let text = await upstream.text()
    if (rewritten) console.log(`[shim] json_object → json_schema ｜ upstream ${upstream.status}`)
    // ② 推理模型：答案在 reasoning_content，content 空 → 搬过去（只处理非流式的 JSON 响应）
    if (upstream.status === 200 && (upstream.headers.get('content-type') ?? '').includes('json')) {
      try {
        const payload = JSON.parse(text)
        let moved = 0
        let stripped = 0
        for (const choice of payload?.choices ?? []) {
          const msg = choice?.message
          if (!msg) continue
          const content = typeof msg.content === 'string' ? msg.content.trim() : ''
          const reasoning = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : ''
          if (!content && reasoning) {
            msg.content = reasoning
            moved += 1
          }
          // ③ 空 tool_calls 会让 mem0ai 误判成"有工具调用"（JS 里 [] 是 truthy）
          if (Array.isArray(msg.tool_calls) && msg.tool_calls.length === 0) {
            delete msg.tool_calls
            stripped += 1
          }
          if (msg.function_call === null) delete msg.function_call
        }
        if (process.env.SHIM_DEBUG === '1') {
          const first = payload?.choices?.[0]?.message?.content
          console.log('[shim:debug] 模型给的 content 前 500 字:', String(first ?? '').slice(0, 500).replace(/\n/g, ' '))
          const um = payload?.messages?.find?.((m) => m.role === 'user')
          if (um) console.log('[shim:debug] 它被问的是:', String(um.content ?? '').replace(/\n/g, ' ').slice(0, 700))
        }
        if (moved > 0 || stripped > 0) {
          text = JSON.stringify(payload)
          if (moved > 0) console.log(`[shim] reasoning_content → content（${moved} 个 choice；本机推理模型 content 为空）`)
          if (stripped > 0) console.log(`[shim] 去掉空 tool_calls（${stripped} 个 choice；空数组会让 mem0ai 误判）`)
        }
      } catch {
        // 不是 JSON（或流式），原样返回
      }
    }
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
    res.end(text)
  } catch (error) {
    console.error('[shim] upstream failed:', error?.message ?? error)
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `shim could not reach ${UPSTREAM}: ${error?.message ?? error}` } }))
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[shim] listening on http://127.0.0.1:${PORT} → ${UPSTREAM}（把 json_object 改写成 json_schema）`)
})
