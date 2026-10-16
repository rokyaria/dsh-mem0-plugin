/**
 * Performance baseline for dsh-mem0-plugin.
 *
 * Measures the numbers an operator needs before trusting a memory layer:
 *
 *   - write latency  : `mem0_add` end-to-end (embedding + ES index + refresh)
 *   - read latency   : `mem0_search` end-to-end (embedding + kNN + source fetch)
 *   - scan latency   : `mem0_get_all` (the eviction-job read path)
 *   - recall quality : can it find what was stored? recall@1 / recall@k / MRR
 *
 * It runs the write/read suite twice — once with `refreshAfterWrite: true`
 * (the default, which buys read-after-write consistency) and once with `false`
 * — so the cost of that default is measured rather than asserted.
 *
 * Recall uses unambiguous ground truth: every memory carries a unique random
 * project name, and each query asks for that name's access code, so exactly one
 * memory is correct.
 *
 * Requires Elasticsearch 8 on :9200 (elastic/elastic) and an embedding endpoint
 * — see install.md §1. Run:
 *
 *   node test/benchmark.mjs
 *   COUNT=300 QUERIES=50 node test/benchmark.mjs
 *   BENCH_EMBEDDER=lmstudio BENCH_MODEL=text-embedding-bge-m3 node test/benchmark.mjs
 */
import { randomBytes } from 'node:crypto'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as plugin from '../lib/index.js'
import {
  embedderConfig,
  vectorStoreConfig,
  describeBackends,
  liveBackendsOrSkip,
  EMBEDDER,
  EMBEDDER_MODEL as MODEL,
} from './backends.mjs'

// ---------------------------------------------------------------- parameters
const COUNT = Number(process.env.COUNT ?? 100)
const QUERIES = Number(process.env.QUERIES ?? 30)
const TOP_K = Number(process.env.TOP_K ?? 5)
const WARMUP = Number(process.env.WARMUP ?? 5)
const COLLECTION = process.env.BENCH_COLLECTION ?? 'mem0_dsh_benchmark'
const USER = 'mem0_benchmark_user'
const baseConfig = {
  embedder: embedderConfig(),
  vectorStore: vectorStoreConfig(COLLECTION),
  preflight: { enabled: true, timeoutMs: 20000 },
}

/** Mean, p50, p95, max in milliseconds. */
function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
  const mean = sorted.reduce((sum, value) => sum + value, 0) / (sorted.length || 1)
  return {
    n: sorted.length,
    mean: Number(mean.toFixed(1)),
    p50: Number(at(0.5).toFixed(1)),
    p95: Number(at(0.95).toFixed(1)),
    max: Number((sorted[sorted.length - 1] ?? 0).toFixed(1)),
  }
}

/** Run `fn` against a freshly loaded plugin instance, then unload it. */
async function withPlugin(overrides, fn) {
  const ctx = new Context()
  const fibers = [await ctx.plugin(SystemPrompt), await ctx.plugin(ToolRuntime)]
  fibers.push(await ctx.plugin(plugin, { ...baseConfig, ...overrides }))
  try {
    return await fn(ctx)
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose()
  }
}

function makeCaller(ctx) {
  let seq = 0
  return async function call(name, args = {}) {
    const started = performance.now()
    const result = await ctx.tools.execute({
      callId: `bench-${++seq}`,
      name,
      arguments: args,
      signal: new AbortController().signal,
    })
    const ms = performance.now() - started
    if (result.isError) {
      const text = result.content.map((b) => b.text ?? '').join('')
      throw new Error(`${name} failed: ${text.slice(0, 300)}`)
    }
    return { value: result.value, ms }
  }
}

// ------------------------------------------------------------------ fixtures
const token = () => randomBytes(4).toString('hex')
const dataset = Array.from({ length: COUNT }, () => {
  const project = `project-${token()}`
  const code = token().toUpperCase()
  return {
    project,
    code,
    text: `The access code for ${project} is ${code}. It rotates every 90 days.`,
    query: `What is the access code for ${project}?`,
  }
})

// --------------------------------------------------------------- measurement
/**
 * Write `dataset`, then search it, under one `refreshAfterWrite` setting.
 *
 * @param settleMs - pause before searching, so a disabled refresh still has a
 *   chance to make writes visible (otherwise the reads measure staleness, not latency).
 */
async function measure(label, refreshAfterWrite, settleMs) {
  return withPlugin({ refreshAfterWrite }, async (ctx) => {
    const call = makeCaller(ctx)
    const status = await call('mem0_status', {})
    if (status.value.phase !== 'ready') {
      throw new Error(`plugin not ready: ${JSON.stringify(status.value.error)}`)
    }

    await call('mem0_delete', { user_id: USER })

    // Warm the embedding model and the index so cold start is not reported as
    // steady-state latency.
    for (let i = 0; i < WARMUP; i += 1) {
      await call('mem0_add', { messages: [{ role: 'user', content: `warmup ${i}` }], user_id: `${USER}_warmup` })
    }
    await call('mem0_delete', { user_id: `${USER}_warmup` })

    const writeLatencies = []
    const written = []
    for (const item of dataset) {
      const started = performance.now()
      const result = await call('mem0_add', {
        messages: [{ role: 'user', content: item.text }],
        user_id: USER,
        metadata: { project: item.project },
      })
      writeLatencies.push(performance.now() - started)
      const id = result.value?.results?.[0]?.id
      if (!id) throw new Error(`add returned no id for ${item.project}`)
      written.push({ ...item, id })
    }

    if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs))

    const searchLatencies = []
    const ranks = []
    for (const item of written.slice(0, QUERIES)) {
      const { value, ms } = await call('mem0_search', { query: item.query, user_id: USER, top_k: TOP_K })
      searchLatencies.push(ms)
      const rank = (value?.results ?? []).findIndex((hit) => hit.id === item.id)
      ranks.push(rank === -1 ? 0 : rank + 1)
    }

    const scan = await call('mem0_get_all', { user_id: USER, limit: 500 })

    const hits = (k) => ranks.filter((r) => r > 0 && r <= k).length / ranks.length
    return {
      label,
      refreshAfterWrite,
      status: status.value,
      write: stats(writeLatencies),
      search: stats(searchLatencies),
      scan: { ms: Number(scan.ms.toFixed(1)), total: scan.value.total },
      recall: {
        at1: hits(1),
        atK: hits(TOP_K),
        mrr: ranks.reduce((sum, r) => sum + (r > 0 ? 1 / r : 0), 0) / ranks.length,
        missed: ranks.filter((r) => r === 0).length,
        n: ranks.length,
        distribution: [1, 2, 3, 4, 5].map((k) => ranks.filter((r) => r === k).length),
      },
    }
  })
}

const pct = (value) => `${(value * 100).toFixed(1)}%`
const latencyTable = (s) =>
  `| mean | p50 | p95 | max | n |\n|---|---|---|---|---|\n| ${s.mean} | ${s.p50} | ${s.p95} | ${s.max} | ${s.n} |`

// ---------------------------------------------------------------------- main
console.log(`dsh-mem0-plugin benchmark — ${COUNT} memories, ${QUERIES} queries, top_k=${TOP_K}`)
console.log(`embedder: ${EMBEDDER} / ${MODEL}\n`)

console.log('phase A: refreshAfterWrite=true (default) …')
const withRefresh = await measure('refreshAfterWrite=true', true, 0)
console.log(`  write p50=${withRefresh.write.p50}ms  search p50=${withRefresh.search.p50}ms  recall@1=${pct(withRefresh.recall.at1)}`)

console.log('phase B: refreshAfterWrite=false …')
const withoutRefresh = await measure('refreshAfterWrite=false', false, 2000)
console.log(`  write p50=${withoutRefresh.write.p50}ms  search p50=${withoutRefresh.search.p50}ms  recall@1=${pct(withoutRefresh.recall.at1)}`)

const dims = withRefresh.status.report?.embedder?.dimensions
const store = withRefresh.status.report?.vectorStore?.detail ?? 'unknown'
const writeDelta = withoutRefresh.write.p50 - withRefresh.write.p50
const writeP95Delta = withoutRefresh.write.p95 - withRefresh.write.p95
const searchDelta = withoutRefresh.search.p50 - withRefresh.search.p50
const searchP95Delta = withoutRefresh.search.p95 - withRefresh.search.p95
// A single run cannot resolve a difference smaller than its own spread, so say
// so instead of presenting noise as a finding.
const spread = withRefresh.write.p95 - withRefresh.write.p50
const resolvable = Math.abs(writeP95Delta) > spread / 4
// Only claim that unrefreshed bulk writes degrade later reads when the data
// actually shows it — an earlier draft hardcoded this and the next run
// contradicted it.
const readsDegradeWithoutRefresh = withoutRefresh.search.p95 > withRefresh.search.p95 * 1.25
const signed = (value) => `${value >= 0 ? '+' : ''}${value.toFixed(1)}`

const ratio = withRefresh.write.p95 / Math.max(withRefresh.write.p50, 1)
const report = `# dsh-mem0-plugin 性能基线

| 项 | 值 |
|---|---|
| Embedding | \`${EMBEDDER}\` / \`${MODEL}\` → ${dims} dims |
| Vector store | ${store} |
| Node | ${process.versions.node} |
| 规模 | 写入 ${COUNT} 条 · 检索 ${QUERIES} 次 (top_k=${TOP_K}) · 预热 ${WARMUP} 次 |

延迟均为**端到端**工具调用耗时（含 embedding 往返、ES 写入/检索、索引刷新），不含模型侧推理。
测试前做了 ${WARMUP} 次预热，所以下面的数字不含 embedding 模型冷启动。
单线程顺序调用，**未测并发**。

## 结论

- **写入** \`mem0_add\` p50 **${withRefresh.write.p50} ms**、p95 ${withRefresh.write.p95} ms（${COUNT} 条样本）。
- **检索** \`mem0_search\` p50 **${withRefresh.search.p50} ms**、p95 ${withRefresh.search.p95} ms（top_k=${TOP_K}）。
- **全量扫描** \`mem0_get_all\` 读 ${withRefresh.scan.total} 条 **${withRefresh.scan.ms} ms** —— 淘汰过期记忆该走这条路径。
- **召回** recall@1 = **${pct(withRefresh.recall.at1)}**，MRR = ${withRefresh.recall.mrr.toFixed(4)}（${withRefresh.recall.n} 个唯一可判定查询）。

${
  ratio > 3
    ? `p95 是 p50 的 ${ratio.toFixed(1)} 倍，说明**尾部**而非中位数决定了体验。\n` +
      `尾部大概率来自 embedding 服务的调度（${EMBEDDER}），而不是 ES —— 全量扫描 ${withRefresh.scan.total} 条只要 ${withRefresh.scan.ms} ms，可见 ES 侧很轻。`
    : `本次运行 p95/p50 = ${ratio.toFixed(1)}，延迟分布相对集中。`
}

## 读取 / 扫描延迟

| 路径 | mean | p50 | p95 | max |
|---|---|---|---|---|
| \`mem0_search\`（写后刷新开） | ${withRefresh.search.mean} | ${withRefresh.search.p50} | ${withRefresh.search.p95} | ${withRefresh.search.max} |
| \`mem0_search\`（写后刷新关） | ${withoutRefresh.search.mean} | ${withoutRefresh.search.p50} | ${withoutRefresh.search.p95} | ${withoutRefresh.search.max} |
| \`mem0_get_all\` 全量扫描 ${withRefresh.scan.total} 条 | ${withRefresh.scan.ms} | — | — | — |

## 写入延迟 — \`mem0_add\`

### \`refreshAfterWrite: true\`（默认）

${latencyTable(withRefresh.write)}

### \`refreshAfterWrite: false\`

${latencyTable(withoutRefresh.write)}

**这项默认值的代价**：
- p50 写入 ${withRefresh.write.p50} → ${withoutRefresh.write.p50} ms（**${signed(writeDelta)} ms**）
- p95 写入 ${withRefresh.write.p95} → ${withoutRefresh.write.p95} ms（**${signed(writeP95Delta)} ms**）
- 检索 p50 ${signed(searchDelta)} ms，p95 ${signed(searchP95Delta)} ms

${
  resolvable
    ? '关掉刷新省下的是**尾部延迟**，中位数几乎不变——刷新是 p95 的主要来源之一。'
    : `⚠️ 本次运行里两列写入延迟的差距（p50 ${signed(writeDelta)} / p95 ${signed(writeP95Delta)} ms）` +
      `**都落在自身波动范围内**，无法与噪声区分。也就是说：在这个规模（${COUNT} 条、单线程）下，` +
      '写后刷新的成本可以忽略。要断言它在更大规模下的影响，请多跑几轮或加大 COUNT，不要拿这一行当定论。'
}
默认开启换来的是「写完立刻能搜到」——对一个记忆工具来说，这个语义本身就值得。

${
  readsDegradeWithoutRefresh
    ? `> 注意 \`refreshAfterWrite: false\` 那一列的**检索**数字更差（p95 ${withoutRefresh.search.p95} vs ${withRefresh.search.p95} ms）。\n` +
      '> 一个可能的解释：批量写入期间不做 refresh 会让索引累积大量小 segment，之后的检索要为它们付出代价。\n' +
      '> **关刷新只适合一次性批量导入，导入完请打开。**'
    : `> 本次运行中，关掉刷新后的检索延迟并没有变差（p95 ${withoutRefresh.search.p95} vs ${withRefresh.search.p95} ms），\n` +
      '> 所以「不刷新会让后续检索变慢」这个说法**没有得到本次数据支持**，不写进结论。'
}

## 召回正确率

| 指标 | refreshAfterWrite=true | refreshAfterWrite=false |
|---|---|---|
| recall@1 | ${pct(withRefresh.recall.at1)} | ${pct(withoutRefresh.recall.at1)} |
| recall@${TOP_K} | ${pct(withRefresh.recall.atK)} | ${pct(withoutRefresh.recall.atK)} |
| MRR | ${withRefresh.recall.mrr.toFixed(4)} | ${withoutRefresh.recall.mrr.toFixed(4)} |
| 未命中 | ${withRefresh.recall.missed} / ${withRefresh.recall.n} | ${withoutRefresh.recall.missed} / ${withoutRefresh.recall.n} |

排名分布（true / false）:
${[1, 2, 3, 4, 5]
  .map(
    (k) =>
      `- rank${k}: ${withRefresh.recall.distribution[k - 1]} / ${withoutRefresh.recall.distribution[k - 1]}`,
  )
  .join('\n')}
- miss: ${withRefresh.recall.missed} / ${withoutRefresh.recall.missed}

查询用的都是**唯一可判定**的问题（每个项目名在全库只出现一次），所以 recall@1 就是
「embedding + kNN 排序是否把正确答案排在第一」的直接度量，不含歧义样本。
换 embedding 模型、维度或 top_k 后，这组数字必须重测。

## 复现

\`\`\`sh
node test/benchmark.mjs
COUNT=300 QUERIES=50 node test/benchmark.mjs
BENCH_EMBEDDER=lmstudio BENCH_MODEL=text-embedding-bge-m3 node test/benchmark.mjs
\`\`\`
`

console.log(`\n${'='.repeat(72)}\n${report}`)

const outDir = fileURLToPath(new URL('../docs/evidence/', import.meta.url))
mkdirSync(outDir, { recursive: true })
const stamp = new Date().toISOString().slice(0, 10)
// One file per backend per day: a same-day rerun against a different
// embedder must not silently overwrite the first measurement.
const outFile = `${outDir}benchmark-${stamp}-${EMBEDDER}.md`
writeFileSync(outFile, report)
console.log(`report written to ${outFile}`)
