/**
 * Failure-behaviour verification for dsh-mem0-plugin.
 *
 * The plugin must **always load** so that `mem0_status` can explain a broken
 * installation — that is the whole point of the tool. `startup.strict: true`
 * opts back into load-time failure.
 *
 * This suite asserts both modes for every realistic misconfiguration:
 *
 *   default  → plugin ACTIVE, 7 tools registered, mem0_status reports the
 *              key error, the memory tools fail with a pointer to it
 *   strict   → plugin FAILED, no tool registered
 *
 * Requires Elasticsearch 8 on :9200 and an embedding endpoint only for the
 * "unreachable" cases to be distinguishable from "misconfigured"; the config
 * cases need neither.
 *
 * Run: node test/config-failfast.mjs
 */
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as plugin from '../lib/index.js'
import { embedderConfig, vectorStoreConfig, describeBackends, embedderReachable, skip, EMBEDDER } from './backends.mjs'

const GOOD = {
  embedder: embedderConfig(),
  vectorStore: vectorStoreConfig('mem0_dsh_plugin_test'),
  preflight: { enabled: true, timeoutMs: 8000 },
  // Keep test history out of the user's DSH home.
  history: { dbPath: join(tmpdir(), 'dsh-mem0-test-history.db') },
}

const EXPECTED_TOOLS = [
  'mem0_add',
  'mem0_delete',
  'mem0_get',
  'mem0_get_all',
  'mem0_history',
  'mem0_search',
  'mem0_status',
  'mem0_update',
]

let seq = 0

/** Load the plugin and report what happened. */
async function attempt(config) {
  const ctx = new Context()
  const fibers = [await ctx.plugin(SystemPrompt), await ctx.plugin(ToolRuntime)]
  let loadError
  let loaded = false
  try {
    fibers.push(await ctx.plugin(plugin, config))
    loaded = true
  } catch (error) {
    loadError = error
  }
  const tools = ctx.tools.schemas().map((s) => s.name).filter((n) => n.startsWith('mem0_')).sort()

  let statusText
  let statusValue
  let addError
  if (loaded) {
    const status = await ctx.tools.execute({
      callId: `s${++seq}`,
      name: 'mem0_status',
      arguments: {},
      signal: new AbortController().signal,
    })
    statusValue = status.value
    statusText = status.content.map((b) => b.text ?? '').join('')
    const add = await ctx.tools.execute({
      callId: `a${++seq}`,
      name: 'mem0_add',
      arguments: { messages: [{ role: 'user', content: 'x' }], user_id: 'probe' },
      signal: new AbortController().signal,
    })
    if (add.isError) addError = add.content.map((b) => b.text ?? '').join('')
  }

  for (const fiber of fibers.reverse()) await fiber.dispose()
  return {
    loaded,
    loadError: loadError ? String(loadError.message).replace(/\s+/g, ' ') : undefined,
    tools,
    statusText,
    statusValue,
    addError,
  }
}

/** Assert the default (non-strict) behaviour: load succeeds and status explains. */
async function expectDiagnosable(label, config, expectedPattern) {
  const outcome = await attempt(config)
  console.log(`\n▸ ${label}`)
  assert.equal(outcome.loaded, true, 'the plugin must load even when misconfigured')
  assert.deepEqual(outcome.tools, EXPECTED_TOOLS, 'every tool must still be registered')
  assert.equal(outcome.statusValue.ok, false, 'mem0_status must not claim OK')
  assert.match(outcome.statusText, /关键报错/, 'mem0_status must surface the key error')
  assert.match(outcome.statusText, expectedPattern, 'the reported error must name the real cause')
  assert.ok(outcome.addError, 'memory tools must fail rather than silently no-op')
  assert.match(outcome.addError, /mem0_status/, 'the tool error must point at mem0_status')
  console.log(`  loaded=true tools=${outcome.tools.length} ok=false`)
  console.log(`  status: ${outcome.statusValue.error?.message?.slice(0, 130)}`)
  assert.equal(outcome.statusValue.error?.message?.includes('cooling down'), false)
}

/** Assert the opt-in strict behaviour: load fails and nothing is registered. */
async function expectStrictFailure(label, config) {
  const outcome = await attempt({ ...config, startup: { strict: true } })
  console.log(`\n▸ ${label} [startup.strict=true]`)
  assert.equal(outcome.loaded, false, 'strict mode must fail the plugin load')
  assert.equal(outcome.tools.length, 0, 'no tool may be registered in strict mode')
  console.log(`  loaded=false tools=0`)
  console.log(`  error: ${outcome.loadError?.slice(0, 130)}`)
}

console.log('='.repeat(72))
console.log('启动行为：默认「可诊断」，strict 模式「加载即失败」')
console.log(`后端：${describeBackends()}`)
console.log('='.repeat(72))

const CASES = [
  {
    label: '缺少 embedder',
    config: { ...GOOD, embedder: undefined },
    pattern: /embedder.*not configured/i,
  },
  {
    label: '缺少 vectorStore',
    config: { ...GOOD, vectorStore: undefined },
    pattern: /vectorStore.*not configured/i,
  },
  {
    label: 'elasticsearch 缺少 collectionName',
    config: {
      ...GOOD,
      vectorStore: { provider: 'elasticsearch', config: { ...GOOD.vectorStore.config, collectionName: undefined } },
    },
    pattern: /collectionName/,
  },
  {
    label: 'elasticsearch 未设置 useSsl（mem0 会默认走 HTTPS）',
    config: {
      ...GOOD,
      vectorStore: {
        provider: 'elasticsearch',
        config: { collectionName: 'x', host: 'localhost', port: 9200, username: 'elastic', password: 'elastic' },
      },
    },
    pattern: /useSsl/,
  },
  {
    // Needs a *working* embedder: preflight probes the embedder before the store,
    // so with both broken the reported cause is the embedder, not the store.
    label: 'vector store 不可达（端口 9299）',
    needsEmbedder: true,
    config: {
      ...GOOD,
      vectorStore: { provider: 'elasticsearch', config: { ...GOOD.vectorStore.config, port: 9299 } },
      preflight: { enabled: true, timeoutMs: 4000 },
    },
    pattern: /9299|did not respond|no response/i,
  },
  {
    label: 'embedding 端点不可达（端口 11499）',
    config: {
      ...GOOD,
      embedder: { ...GOOD.embedder, config: { ...GOOD.embedder.config, url: 'http://localhost:11499', baseURL: 'http://localhost:11499' } },
    },
    pattern: /Embedding provider/i,
  },
  {
    // Ollama rejects an unknown model; LM Studio does not — it silently serves
    // whichever embedding model is loaded (verified 2026-10-16: requesting
    // "definitely-not-a-real-model" returned 1024 dims under model
    // text-embedding-bge-m3). So this property only holds on Ollama, and the
    // LM Studio difference is documented in README §5.4 instead of asserted here.
    label: 'embedding 模型不存在（Ollama 会拒绝）',
    ollamaOnly: true,
    config: {
      ...GOOD,
      embedder: { ...GOOD.embedder, config: { ...GOOD.embedder.config, model: 'definitely-not-a-real-model' } },
    },
    pattern: /Embedding provider/i,
  },
  {
    label: '未知配置键 refresh_after_write（拼写错误）',
    config: { ...GOOD, refresh_after_write: false },
    pattern: /Unknown configuration key/,
  },
]

// The store-unreachable scenarios need a live embedder (preflight probes the
// embedder first). Without one they would assert on the wrong failure — skip
// them loudly instead of reporting a defect that is not there.
const embedderOk = await embedderReachable()
if (!embedderOk) {
  skip('需要活 embedder 的场景', '没有 embedding 端点应答 —— 起 Ollama，或设 MEM0_TEST_EMBEDDER=lmstudio')
}

let ran = 0
let skipped = 0
for (const testCase of CASES) {
  if (testCase.needsEmbedder && !embedderOk) {
    skipped += 1
    continue
  }
  if (testCase.ollamaOnly && EMBEDDER !== 'ollama') {
    skip(testCase.label, `后端是 ${EMBEDDER}：它不会拒绝未知 model id（见 README §5.4），这条只在 Ollama 上有意义`)
    skipped += 1
    continue
  }
  await expectDiagnosable(testCase.label, testCase.config, testCase.pattern)
  ran += 1
}
console.log(`\n场景：跑过 ${ran} 个，跳过 ${skipped} 个（跳过的都打了 SKIP 行）`)

// Strict mode is the opt-in escape hatch; prove it on two representative cases.
await expectStrictFailure('缺少 embedder', { ...GOOD, embedder: undefined })
await expectStrictFailure('vector store 不可达', {
  ...GOOD,
  vectorStore: { provider: 'elasticsearch', config: { ...GOOD.vectorStore.config, port: 9299 } },
  preflight: { enabled: true, timeoutMs: 4000 },
})

console.log(`\n${'='.repeat(72)}`)
console.log(`✅ ${ran} 个失败场景在默认模式下：插件加载 + 7 个工具注册 + mem0_status 报出真实原因`)
console.log('✅ strict 模式下：插件加载失败且不注册任何工具')
