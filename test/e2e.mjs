/**
 * End-to-end verification for dsh-mem0-plugin.
 *
 * Loads the real Cordis `Context`, the real `@deepseek-ai/dsh-tools`
 * `ToolRuntime`, and the built plugin — then drives every tool through the
 * registry's own dispatch path against a live Elasticsearch 8 + embedding
 * endpoint.
 *
 * Deliberately performs **no sleeps around writes**: with `refreshAfterWrite`
 * enabled (the default) every write must be immediately searchable. That is the
 * property this suite exists to protect.
 *
 * Requires (see install.md §1):
 *   - Elasticsearch 8 on http://localhost:9200  (elastic / elastic)
 *   - Ollama on http://localhost:11434 with `nomic-embed-text`
 *
 * Run: node test/e2e.mjs
 */
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as plugin from '../lib/index.js'
import { embedderConfig, vectorStoreConfig, describeBackends, liveBackendsOrSkip } from './backends.mjs'

const COLLECTION = 'mem0_dsh_plugin_test'
const USER = 'dsh_plugin_e2e_user'

console.log(`后端：${describeBackends()}`)
if (!(await liveBackendsOrSkip('e2e')) ) process.exit(0)
const config = {
  embedder: embedderConfig(),
  vectorStore: vectorStoreConfig(COLLECTION),
  // No `llm` on purpose: proves the plugin loads without one and that mem0_add
  // falls back to infer:false instead of calling a non-existent LLM.
  preflight: { enabled: true, timeoutMs: 15000 },
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

let callSeq = 0
async function call(ctx, name, args = {}) {
  callSeq += 1
  const result = await ctx.tools.execute({
    callId: `call-${callSeq}`,
    name,
    arguments: args,
    signal: new AbortController().signal,
  })
  const text = result.content.map((block) => (block.type === 'text' ? block.text : `[${block.type}]`)).join('\n')
  return { result, text, value: result.value, isError: result.isError }
}

function section(title) {
  console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`)
}

const ctx = new Context()
// `ToolRuntime` declares `static inject = ['systemPrompt']`, so the prompt
// service has to exist before the tool registry leaves PENDING.
const fibers = [await ctx.plugin(SystemPrompt), await ctx.plugin(ToolRuntime)]
fibers.push(await ctx.plugin(plugin, config))

// ---------------------------------------------------------------- registration
section('1. 注册与健康检查')
const names = ctx.tools.schemas().map((s) => s.name).filter((n) => n.startsWith('mem0_')).sort()
console.log(names.join(', '))
assert.deepEqual(names, EXPECTED_TOOLS, 'every tool must be registered')

const status = await call(ctx, 'mem0_status')
console.log(status.text.split('\n').slice(0, 3).join('\n'))
assert.equal(status.value.ok, true, 'mem0_status must report OK against a live stack')
assert.ok(status.value.report?.embedder?.dimensions > 0, 'status must expose the measured dimensions')
assert.ok(status.value.history.path, 'status must report where history lives')

// ---------------------------------------------------------------- clean slate
await call(ctx, 'mem0_delete', { user_id: USER })

// ------------------------------------------------------------------- ADD
section('2. mem0_add — 无 llm 时默认 infer:false')
const added = await call(ctx, 'mem0_add', {
  messages: [
    { role: 'user', content: 'My deployment uses Elasticsearch 8 as the mem0 vector store.' },
    { role: 'assistant', content: 'Noted — ES8 with the v8 JavaScript client.' },
  ],
  user_id: USER,
})
console.log(added.text)
assert.equal(added.isError, false, 'mem0_add must succeed')
const memoryId = added.value.results[0].id
assert.ok(memoryId, 'add must return a memory id')

// --------------------------------------------------- SEARCH (no sleep!)
section('3. mem0_search — 写入后立即检索（验证 refreshAfterWrite）')
const searched = await call(ctx, 'mem0_search', {
  query: 'which vector store does the deployment use?',
  user_id: USER,
  top_k: 5,
})
console.log(searched.text)
assert.ok(
  searched.value.results.length > 0,
  'write must be immediately searchable — refreshAfterWrite is not working',
)

section('4. mem0_search — 作用域隔离')
const other = await call(ctx, 'mem0_search', { query: 'vector store', user_id: 'someone_else', top_k: 5 })
console.log(`另一个 user_id 命中 ${other.value.results.length} 条（应为 0）`)
assert.equal(other.value.results.length, 0, 'a different user_id must not see these memories')

// ------------------------------------------------------------------- UPDATE
section('5. mem0_update — 改写并立即可见')
const updated = await call(ctx, 'mem0_update', {
  memory_id: memoryId,
  text: 'My deployment uses Elasticsearch 8.14 as the mem0 vector store (updated).',
})
console.log(updated.text)
assert.equal(updated.isError, false)
const afterUpdate = await call(ctx, 'mem0_search', { query: 'vector store version', user_id: USER, top_k: 5 })
assert.match(
  afterUpdate.value.results.map((r) => r.memory).join(' '),
  /updated/,
  'update must be immediately visible',
)
console.log('  → 改写后立即检索到新正文')

// ------------------------------------------------------------ GET_ALL (new)
section('6. mem0_get_all — 全量 / 时间窗 / 分页')
const all = await call(ctx, 'mem0_get_all', { user_id: USER, limit: 100 })
console.log(all.text.split('\n')[0])
assert.equal(all.value.scannedBy, 'elasticsearch', 'ES must use the native range scan')
assert.ok(all.value.total >= 2, 'scan must see the memories written above')

const bounded = await call(ctx, 'mem0_get_all', {
  user_id: USER,
  created_before: new Date().toISOString(),
  limit: 100,
})
console.log(`created_before=now → total=${bounded.value.total}`)
assert.equal(bounded.value.total, all.value.total, 'an open upper bound must not drop rows')

const future = await call(ctx, 'mem0_get_all', {
  user_id: USER,
  created_after: new Date(Date.now() + 86_400_000).toISOString(),
})
console.log(`created_after=+1d → total=${future.value.total}（应为 0）`)
assert.equal(future.value.total, 0, 'a future lower bound must match nothing')

const page1 = await call(ctx, 'mem0_get_all', { user_id: USER, limit: 1, offset: 0, order: 'asc' })
const page2 = await call(ctx, 'mem0_get_all', { user_id: USER, limit: 1, offset: 1, order: 'asc' })
console.log(`分页: page1=${page1.value.items[0]?.id?.slice(0, 8)} page2=${page2.value.items[0]?.id?.slice(0, 8)}`)
assert.equal(page1.value.returned, 1)
assert.equal(page1.value.hasMore, true, 'hasMore must be set when more rows remain')
assert.notEqual(page1.value.items[0].id, page2.value.items[0].id, 'offset must advance the page')

const badTime = await call(ctx, 'mem0_get_all', { user_id: USER, created_before: 'not-a-date' })
console.log(`非法时间参数 → isError=${badTime.isError}`)
assert.equal(badTime.isError, true, 'an unparseable time bound must be rejected')
assert.match(badTime.text, /not a valid time/, 'the error must explain the accepted formats')

// ---------------------------------------------------------- HISTORY (new)
section('7. mem0_get — 按 id 精确读取')
const fetched = await call(ctx, 'mem0_get', { memory_id: memoryId })
console.log(fetched.text)
assert.equal(fetched.isError, false, 'mem0_get must succeed for an existing id')
assert.equal(fetched.value.found, true)
assert.match(fetched.value.memory.memory, /Elasticsearch 8\.14/, 'must return the current text')
assert.ok(fetched.value.memory.createdAt, 'must return the item metadata')

// An unknown or malformed id resolves to "not found" — mem0's `get` returns
// null rather than throwing, and the tool must not turn that into an error.
const missing = await call(ctx, 'mem0_get', { memory_id: '00000000-0000-4000-8000-000000000000' })
console.log(`未知 id -> isError=${missing.isError} found=${missing.value.found}`)
assert.equal(missing.isError, false, 'a missing id is a normal answer, not a tool failure')
assert.equal(missing.value.found, false)

const malformed = await call(ctx, 'mem0_get', { memory_id: 'not-a-uuid' })
console.log(`非法 id -> isError=${malformed.isError} found=${malformed.value.found}`)
assert.equal(malformed.isError, false)
assert.equal(malformed.value.found, false)


section('8. mem0_history — ADD / UPDATE / DELETE 轨迹')
const trail = await call(ctx, 'mem0_history', { memory_id: memoryId })
console.log(trail.text)
assert.equal(trail.value.available, true, 'history must be available')
assert.deepEqual(
  trail.value.entries.map((e) => e.action),
  ['ADD', 'UPDATE'],
  'history must record the add and the update, in order',
)
assert.match(
  trail.value.entries[1].previous_value ?? '',
  /Elasticsearch 8 as/,
  'the update entry must preserve the previous text',
)

const emptyTrail = await call(ctx, 'mem0_history', { memory_id: 'no-such-memory-id' })
assert.equal(emptyTrail.value.entries.length, 0, 'an unknown id has no history')

// ------------------------------------------------------------------- DELETE
section('9. mem0_delete — 单条删除与历史留痕')
const deleted = await call(ctx, 'mem0_delete', { memory_id: memoryId })
console.log(deleted.text)
assert.equal(deleted.isError, false)
const afterDelete = await call(ctx, 'mem0_search', { query: 'vector store', user_id: USER, top_k: 5 })
const remainingIds = afterDelete.value.results.map((r) => r.id)
assert.ok(!remainingIds.includes(memoryId), `deleted memory ${memoryId} must be immediately gone`)

const deletedTrail = await call(ctx, 'mem0_history', { memory_id: memoryId })
console.log(`  删除后历史条数: ${deletedTrail.value.entries.length}`)
assert.equal(deletedTrail.value.entries.at(-1).action, 'DELETE', 'the delete must be recorded')

// -------------------------------------------------- DELETE all + guardrails
section('10. mem0_delete — 批量删除与参数护栏')
await call(ctx, 'mem0_add', { messages: [{ role: 'user', content: 'temp A' }], user_id: USER })
await call(ctx, 'mem0_add', { messages: [{ role: 'user', content: 'temp B' }], user_id: USER })
const before = await call(ctx, 'mem0_get_all', { user_id: USER, limit: 100 })
console.log(`批量删除前: ${before.value.total} 条`)
const deletedAll = await call(ctx, 'mem0_delete', { user_id: USER })
assert.equal(deletedAll.isError, false)
const afterAll = await call(ctx, 'mem0_get_all', { user_id: USER, limit: 100 })
console.log(`批量删除后: ${afterAll.value.total} 条`)
assert.equal(afterAll.value.total, 0, 'deleteAll must clear the scope')

for (const [label, args] of [
  ['memory_id + user_id 同时给出', { memory_id: 'abc', user_id: USER }],
]) {
  const guarded = await call(ctx, 'mem0_delete', args)
  console.log(`${label} → isError=${guarded.isError}`)
  assert.equal(guarded.isError, true, 'ambiguous delete must be rejected')
}

const noScope = await call(ctx, 'mem0_search', { query: 'anything' })
console.log(`无任何标识符 → isError=${noScope.isError}`)
assert.equal(noScope.isError, true, 'missing identifiers must be rejected')

const inferWithoutLlm = await call(ctx, 'mem0_add', {
  messages: [{ role: 'user', content: 'x' }],
  user_id: USER,
  infer: true,
})
console.log(`infer:true 但未配置 llm → isError=${inferWithoutLlm.isError}`)
assert.equal(inferWithoutLlm.isError, true, 'infer:true without an llm must fail loudly')

// ------------------------------------------- config-default identifiers
section('11. identifiers 默认值 — 调用可省略 user_id')
const ctx2 = new Context()
await ctx2.plugin(SystemPrompt)
await ctx2.plugin(ToolRuntime)
const ctx2Fiber = await ctx2.plugin(plugin, { ...config, identifiers: { user_id: USER } })
const withDefault = await call(ctx2, 'mem0_search', { query: 'vector store' })
console.log(`省略 user_id、依赖配置默认值 → isError=${withDefault.isError}`)
assert.equal(withDefault.isError, false, 'configured identifier defaults must satisfy the scope requirement')

// -------------------------------------------------- unload revokes tools
section('12. 卸载插件 — 注册必须被自动撤销')
const beforeUnload = ctx2.tools.schemas().filter((s) => s.name.startsWith('mem0_')).length
await ctx2Fiber.dispose()
const afterUnload = ctx2.tools.schemas().filter((s) => s.name.startsWith('mem0_')).length
console.log(`卸载前 ${beforeUnload} 个 mem0_* 工具 → 卸载后 ${afterUnload} 个`)
assert.equal(afterUnload, 0, 'disposing the plugin fiber must unregister every tool')

section('结果')
console.log('✅ 全部断言通过：8 个工具 + 写后即读 + 按 id 读取 + 时间窗扫描 + 分页 + 历史轨迹 + 作用域隔离 + 参数护栏 + 卸载撤销')

for (const fiber of fibers.reverse()) await fiber.dispose()
