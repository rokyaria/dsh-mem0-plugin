/**
 * Regression test for scope deletion (`mem0_delete` with identifiers).
 *
 * mem0's own `deleteAll` cannot be used: it pages with `DELETE_ALL_BATCH_SIZE = 1`
 * and stops when a listing repeats, which an unrefreshed index does immediately.
 * The failure is *silent* — it reports success after removing one document — so
 * it needs a test that counts what is actually left, not one that checks the
 * return message.
 *
 * Both modes are covered, because `refreshAfterWrite: false` is exactly the
 * configuration in which mem0's loop guard trips first.
 *
 * Requires Elasticsearch 8 on :9200 and an embedding endpoint (install.md §1).
 * Run: node test/scope-delete.mjs
 */
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as plugin from '../lib/index.js'
import { embedderConfig, vectorStoreConfig, describeBackends, liveBackendsOrSkip } from './backends.mjs'

const SCOPE_SIZE = 25

console.log(`后端：${describeBackends()}`)
if (!(await liveBackendsOrSkip('scope-delete'))) process.exit(0)
const baseConfig = {
  embedder: embedderConfig(),
  vectorStore: vectorStoreConfig('mem0_dsh_scope_delete'),
  preflight: { enabled: true, timeoutMs: 15000 },
  // Keep test history out of the user's DSH home.
  history: { dbPath: join(tmpdir(), 'dsh-mem0-test-history.db') },
}

let seq = 0
async function call(ctx, name, args = {}) {
  const result = await ctx.tools.execute({
    callId: `sd-${++seq}`,
    name,
    arguments: args,
    signal: new AbortController().signal,
  })
  const text = result.content.map((b) => b.text ?? '').join('')
  if (result.isError) throw new Error(`${name} failed: ${text.slice(0, 200)}`)
  return result.value
}

/** Fill a scope, delete it, and count what survives. */
async function roundTrip(refreshAfterWrite) {
  // A unique scope per run: mem0 deduplicates by content hash, so a fixed
  // user_id would make this test depend on what a previous run left behind.
  const user = `scope_delete_${refreshAfterWrite ? 'refresh' : 'norefresh'}_${Date.now()}`

  const ctx = new Context()
  const fibers = [await ctx.plugin(SystemPrompt), await ctx.plugin(ToolRuntime)]
  fibers.push(await ctx.plugin(plugin, { ...baseConfig, refreshAfterWrite }))
  try {
    for (let i = 0; i < SCOPE_SIZE; i += 1) {
      await call(ctx, 'mem0_add', { messages: [{ role: 'user', content: `scope doc ${i}` }], user_id: user })
    }

    // With `refreshAfterWrite: false` the writes are not immediately visible —
    // mem0 creates the index with `refresh_interval: "1s"`. Wait past one cycle
    // so this measures deletion, not indexing lag.
    if (!refreshAfterWrite) await new Promise((resolve) => setTimeout(resolve, 2500))

    const before = await call(ctx, 'mem0_get_all', { user_id: user, limit: 500 })
    assert.equal(before.total, SCOPE_SIZE, `expected ${SCOPE_SIZE} memories before deleting`)

    const result = await call(ctx, 'mem0_delete', { user_id: user })
    const after = await call(ctx, 'mem0_get_all', { user_id: user, limit: 500 })
    return { before: before.total, result, after: after.total }
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose()
  }
}

console.log('='.repeat(72))
console.log(`范围删除回归：一次 delete 必须真的清空 ${SCOPE_SIZE} 条（mem0 自带的 deleteAll 做不到）`)
console.log('='.repeat(72))

for (const refreshAfterWrite of [true, false]) {
  const outcome = await roundTrip(refreshAfterWrite)
  console.log(`\n▸ refreshAfterWrite=${refreshAfterWrite}`)
  console.log(`  删除前 ${outcome.before} 条 → 返回 ${JSON.stringify(outcome.result)}`)
  console.log(`  删除后剩余 ${outcome.after} 条`)
  assert.equal(outcome.after, 0, 'a scope delete must leave nothing behind')
  assert.equal(outcome.result.remaining, 0, 'the tool must report remaining=0')
  assert.equal(outcome.result.deleted, outcome.before, 'the tool must report every deletion')
  assert.equal(outcome.result.stoppedEarly, undefined, 'the loop must not stop early')
}

console.log(`\n${'='.repeat(72)}`)
console.log('✅ 两种模式下都真正清空，且 deleted/remaining 与实际一致')
