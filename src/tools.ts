/**
 * The model-facing tools, mirroring the operations of
 * `restful-server/app/main.py`:
 *
 *   POST   /memories                → mem0_add
 *   POST   /search                  → mem0_search
 *   PUT    /memories/{id}           → mem0_update
 *   DELETE /memories[/{id}]         → mem0_delete
 *   GET    /memories                → mem0_get_all   (time-range scan)
 *   GET    /memories/{id}/history   → mem0_history
 *   (installation check)            → mem0_status
 *
 * Parameter names keep the REST server's snake_case spelling so prompts and
 * habits carry over, and are translated to the SDK's spelling inside.
 *
 * @module dsh-mem0-plugin/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { describe } from './config.js'
import { GUIDANCE_SECTION_NAME } from './guidance.js'
import { toJsonValue } from './json.js'
import {
  toEntity,
  toFilters,
  type Identifiers,
  type Mem0RuntimeManager,
  type ReadyRuntime,
} from './memory.js'
import { scanMemories } from './scan.js'

/** Reported by `mem0_status`; keep in step with package.json. */
export const PLUGIN_VERSION = '0.3.0'

/**
 * Model-facing description for one tool: the deployment's override when
 * configured, otherwise the built-in text.
 */
function desc(manager: Mem0RuntimeManager, tool: string, fallback: string): string {
  return manager.config.toolDescriptions?.[tool] ?? fallback
}

/** Shared identifier properties across every tool. */
const identifierProperties = {
  user_id: { type: 'string', description: 'Scope memories to this end user.' },
  agent_id: { type: 'string', description: 'Scope memories to this agent.' },
  run_id: { type: 'string', description: 'Scope memories to this run/session.' },
} as const

const filterProperty = {
  type: 'object',
  additionalProperties: true,
  description:
    'Extra mem0 metadata filters (snake_case keys, e.g. {"category":"prefs"}). ' +
    'Values must be string, number or boolean.',
} as const

/** Format a memory hit for the model. */
function formatMemory(item: {
  id?: string
  memory?: string
  score?: number
  createdAt?: string
  metadata?: unknown
}): string {
  const score = typeof item.score === 'number' ? ` score=${item.score.toFixed(4)}` : ''
  const created = item.createdAt ? ` createdAt=${item.createdAt}` : ''
  const meta =
    item.metadata && Object.keys(item.metadata as object).length > 0
      ? ` metadata=${JSON.stringify(item.metadata)}`
      : ''
  return `- (${item.id ?? 'unknown'})${score}${created}${meta} ${item.memory ?? ''}`.trimEnd()
}

/** Turn a mem0 `SearchResult` into an operator-readable report. */
function renderResults(label: string, result: unknown): string {
  const results = (result as { results?: unknown[] } | undefined)?.results
  if (!Array.isArray(results) || results.length === 0) return `${label}: no memories.`
  const lines = results.map((item) => formatMemory(item as Parameters<typeof formatMemory>[0]))
  return `${label}: ${results.length} ${results.length === 1 ? 'memory' : 'memories'}\n${lines.join('\n')}`
}

/** Throw the same validation error the REST server raised for a missing scope. */
function requireIdentifier(ids: Identifiers): void {
  if (!ids.user_id && !ids.agent_id && !ids.run_id) {
    throw new Error(
      'At least one identifier (user_id, agent_id, run_id) is required. ' +
        'Either pass one on the call or set `identifiers` defaults in the plugin config.',
    )
  }
}

/**
 * Resolve the runtime, translating a failure into an actionable tool error.
 *
 * Every tool except `mem0_status` goes through here, so a broken installation
 * always points the caller at the one tool that can explain it.
 */
async function ready(manager: Mem0RuntimeManager): Promise<ReadyRuntime> {
  try {
    return await manager.ensure()
  } catch (error) {
    throw new Error(
      `${describe(error)} Run "mem0_status" for the full diagnosis and fix hints.`,
    )
  }
}

/** Targeted "what to check next" hints for a known failure signature. */
function hintsFor(message: string): string[] {
  const hints: string[] = []
  if (/is not configured/i.test(message)) {
    hints.push('Add the missing block to the plugin config in the profile cordis.patch.yml, then reload.')
  }
  if (/Elasticsearch .*(failed its probe|did not respond|no response|refused)/i.test(message)) {
    hints.push('Check Elasticsearch is running: `docker ps`, then `curl -u elastic:elastic http://localhost:9200`.')
    hints.push('If it listens elsewhere, or you set useSsl, fix vectorStore.config (host, port, useSsl, username/password).')
  }
  if (/Embedding provider/i.test(message)) {
    hints.push('Check the embedding endpoint: `curl http://localhost:1234/v1/models` (LM Studio) or `curl http://localhost:11434/api/tags` (Ollama).')
    hints.push('Confirm the configured model name is actually served by that endpoint.')
  }
  if (/dimensional|dims/i.test(message)) {
    hints.push('Index and embedder disagree on vector size. Point collectionName at a new index, or switch the embedder back.')
  }
  if (/Unknown configuration/i.test(message)) {
    hints.push('A config key is misspelled; the error lists every valid top-level key.')
  }
  if (/useSsl/i.test(message)) {
    hints.push('Plain-http Elasticsearch (the usual ES8 single-node setup) needs `useSsl: false`.')
  }
  return hints
}

/** Render the human-readable `mem0_status` report. */
function renderStatus(snapshot: {
  phase: string
  error?: { name: string; message: string }
  embedder?: string
  vectorStore?: string
  collection?: string
  inferenceAvailable: boolean
  identifiers: Identifiers
  history: { enabled: boolean; path?: string; source: string; rows: number; note?: string; error?: string }
  workspace?: { path: string; reason: string; total: number }
  guidance: {
    registered: boolean
    source: string
    order: number
    chars: number
    reason?: string
    scope: string
    presets: string[]
    agents: number
    skipped: number
  }
  report?: { embedder: { provider: string; model?: string; dimensions: number }; vectorStore: { detail: string } }
  attempts: number
  readyAt?: string
}): string {
  const lines: string[] = []
  const ok = snapshot.phase === 'ready'
  lines.push(
    ok
      ? 'OK — dsh-mem0-plugin: 记忆运行时已就绪（mem0_status + 7 个记忆工具可用）'
      : `NOT READY — dsh-mem0-plugin (phase=${snapshot.phase})`,
  )
  lines.push(`version: ${PLUGIN_VERSION}`)

  if (snapshot.error) {
    lines.push('', `关键报错 (${snapshot.error.name}):`, `  ${snapshot.error.message}`)
    const hints = hintsFor(snapshot.error.message)
    if (hints.length > 0) {
      lines.push('', '排查建议:')
      for (const hint of hints) lines.push(`  * ${hint}`)
    }
  }

  lines.push('', '配置:')
  lines.push(`  embedder    : ${snapshot.embedder ?? '(未配置)'}`)
  lines.push(
    `  vectorStore : ${snapshot.vectorStore ?? '(未配置)'}${snapshot.collection ? ` (index: ${snapshot.collection})` : ''}`,
  )
  lines.push(
    `  llm         : ${
      snapshot.inferenceAvailable
        ? '已配置 (mem0_add 的 infer 默认 true)'
        : '未配置 (mem0_add 默认 infer:false，不做事实抽取)'
    }`,
  )
  const idText = Object.entries(snapshot.identifiers)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(', ')
  lines.push(`  identifiers : ${idText || '(无默认值)'}`)

  lines.push('', '给模型的引导（系统提示词）:')
  const g = snapshot.guidance
  if (g.registered) {
    const where =
      g.scope === 'agent'
        ? `按 agent 注册（当前 ${g.agents} 个${g.skipped ? `，跳过 ${g.skipped} 个` : ''}${
            g.presets.length ? `，限定 preset: ${g.presets.join(', ')}` : ''
          }）`
        : '全局注册（所有 agent 可见）'
    lines.push(`  已注入 「${GUIDANCE_SECTION_NAME}」  ${g.source} / order=${g.order} / ${g.chars} 字符`)
    lines.push(`  范围: ${where}`)
  } else {
    lines.push(`  未注入：${g.reason ?? 'unknown'}`)
  }

  lines.push('', '工作区:')
  lines.push(
    snapshot.workspace
      ? `  ${snapshot.workspace.path}  [${snapshot.workspace.reason}${
          snapshot.workspace.total > 1 ? `, 共 ${snapshot.workspace.total} 个` : ''
        }]`
      : '  (无法解析——history 将退回 <DSH_HOME>/mem0/)',
  )

  lines.push('', '历史库:')
  if (!snapshot.history.enabled) {
    lines.push('  已禁用')
  } else {
    lines.push(`  path  : ${snapshot.history.path ?? '(未解析)'}  [${snapshot.history.source}]`)
    lines.push(`  rows  : ${snapshot.history.rows}`)
  }
  if (snapshot.history.note) lines.push(`  注意  : ${snapshot.history.note}`)
  if (snapshot.history.error) lines.push(`  错误  : ${snapshot.history.error}`)

  if (snapshot.report) {
    lines.push('', '启动探测:')
    lines.push(
      `  embedder    : ${snapshot.report.embedder.provider}${
        snapshot.report.embedder.model ? ` / ${snapshot.report.embedder.model}` : ''
      } -> ${snapshot.report.embedder.dimensions} dims`,
    )
    lines.push(`  vectorStore : ${snapshot.report.vectorStore.detail}`)
  }

  lines.push(
    '',
    `运行时: attempts=${snapshot.attempts}` +
      (snapshot.readyAt ? ` readyAt=${snapshot.readyAt}` : ' (尚未就绪)') +
      (snapshot.phase === 'failed' ? ' — 失败后每 5 秒自动重试，无需重启 dsh' : ''),
  )
  if (!ok) {
    lines.push('', '提示: 修好依赖后再次调用 mem0_status 即可触发重试，不需要重启 dsh。')
  }
  return lines.join('\n')
}

/**
 * Deleting a scope cannot use mem0's `deleteAll`.
 *
 * That method loops `list` → `delete` → `list` with `DELETE_ALL_BATCH_SIZE = 1`
 * and stops as soon as it sees a repeated batch. Because the listing comes from
 * a refresh-dependent search, an index that has not been refreshed since the
 * last delete returns the document it just removed, so the guard fires on the
 * *second* pass: **one call deletes exactly one memory and reports success**,
 * silently leaving the rest of the scope behind. Timing-dependent variants
 * throw `Memory with ID ... not found` instead.
 *
 * Both were reproduced directly against ES8 (see docs/design-notes.md §2.10).
 * This implementation refreshes, pages through the scope itself, and deletes by
 * id — a path that does not depend on the listing being fresh — then reports
 * what is actually left instead of claiming success.
 */
const DELETE_SCAN_PAGE = 200
const MAX_DELETE_PASSES = 100

/** Result of a verified scope deletion. */
interface ScopeDeletion {
  deleted: number
  passes: number
  remaining: number
  stoppedEarly?: boolean
}

/** Count the memories still in scope, against a freshly refreshed view. */
async function scopeTotal(
  manager: Mem0RuntimeManager,
  runtime: ReadyRuntime,
  ids: Identifiers,
): Promise<number> {
  await runtime.refresh()
  const page = await scanMemories(manager.config, runtime, {
    ids,
    limit: 1,
    offset: 0,
    order: 'asc',
  })
  return page.total
}

/** Delete every memory in a scope, verifying that the scope actually empties. */
async function deleteScope(
  manager: Mem0RuntimeManager,
  runtime: ReadyRuntime,
  ids: Identifiers,
): Promise<ScopeDeletion> {
  let deleted = 0

  for (let pass = 1; pass <= MAX_DELETE_PASSES; pass += 1) {
    await runtime.refresh()
    const page = await scanMemories(manager.config, runtime, {
      ids,
      limit: DELETE_SCAN_PAGE,
      offset: 0,
      order: 'asc',
    })
    if (page.total === 0) return { deleted, passes: pass, remaining: 0 }

    let removedThisPass = 0
    for (const item of page.items) {
      try {
        await runtime.memory.delete(item.id)
      } catch (error) {
        // Already gone — a stale view or a concurrent delete is not a failure.
        if (/not found/i.test(describe(error))) continue
        throw error
      }
      manager.history.record({ memoryId: item.id, previousValue: item.memory, action: 'DELETE' })
      removedThisPass += 1
      deleted += 1
    }

    if (removedThisPass === 0) {
      // Nothing was removable: report rather than spin.
      return { deleted, passes: pass, remaining: page.total, stoppedEarly: true }
    }
  }

  return {
    deleted,
    passes: MAX_DELETE_PASSES,
    remaining: await scopeTotal(manager, runtime, ids),
    stoppedEarly: true,
  }
}

/**
 * Register every mem0 tool on `ctx.tools`.
 *
 * @param ctx - plugin context whose `tools` service is already available.
 * @param manager - runtime manager owned by this plugin instance.
 * @returns the disposer that unregisters every tool.
 */
export function registerMem0Tools(ctx: Context, manager: Mem0RuntimeManager): () => void {
  // -------------------------------------------------------------- mem0_status
  const status = defineTool({
    name: 'mem0_status',
    description: desc(
      manager,
      'mem0_status',
      'Check whether the mem0 plugin is installed and working. Always available, even when the plugin ' +
      'failed to initialize — call this first whenever the memory tools error, or to confirm an ' +
      'installation right after setup.',
    ),
    parameters: {},
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        return [{ type: 'text', text: (value as { summary?: string })?.summary ?? 'no report' }]
      },
    },
    async execute() {
      const snapshot = await manager.status()
      return toJsonValue({
        ok: snapshot.phase === 'ready',
        version: PLUGIN_VERSION,
        ...snapshot,
        // `report` stays the structured preflight result; `summary` is the
        // rendered text. Overwriting one with the other silently dropped the
        // embedder dimensions and store detail for programmatic callers.
        summary: renderStatus(snapshot),
      }) as never
    },
  })

  // ----------------------------------------------------------------- mem0_add
  const add = defineTool({
    name: 'mem0_add',
    description: desc(
      manager,
      'mem0_add',
      'Store memories for a user/agent/run in long-term memory. Accepts a conversation fragment; ' +
      'mem0 extracts the facts worth keeping when `infer` is true, or stores the text verbatim when false.',
    ),
    parameters: {
      messages: {
        type: 'array',
        required: true,
        description: 'Conversation messages to remember, in chronological order.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            role: { type: 'string', required: true, description: 'Message role, e.g. user or assistant.' },
            content: { type: 'string', required: true, description: 'Message content.' },
          },
        },
      },
      ...identifierProperties,
      metadata: { type: 'object', additionalProperties: true, description: 'Arbitrary metadata to attach.' },
      infer: {
        type: 'boolean',
        description:
          'Extract facts with the configured LLM instead of storing text verbatim. Requires an `llm` ' +
          'in the plugin config; defaults to true when one is configured, false otherwise.',
      },
      expiration_date: {
        type: 'string',
        description: 'Optional YYYY-MM-DD after which the memory stops being returned.',
      },
    },
    output: {
      schema: { type: 'json' },
      render(args, value) {
        const result = value as { results?: Array<{ id?: string; memory?: string; event?: string }> }
        const count = result?.results?.length ?? 0
        const events = (result?.results ?? [])
          .map((r) => r.event)
          .filter((event): event is string => Boolean(event))
        const head =
          `Stored via mem0_add (${args.messages.length} message${
            args.messages.length === 1 ? '' : 's'
          }, infer=${args.infer ?? manager.inferenceAvailable}): ${count} ${
            count === 1 ? 'memory' : 'memories'
          }${events.length ? ` [${events.join(', ')}]` : ''}.`
        const lines = (result?.results ?? []).map((r) => `- (${r.id ?? 'unknown'}) ${r.memory ?? ''}`)
        return [{ type: 'text', text: [head, ...lines].join('\n') }]
      },
    },
    async execute(args) {
      const runtime = await ready(manager)
      const ids = runtime.identifiers({
        user_id: args.user_id,
        agent_id: args.agent_id,
        run_id: args.run_id,
      })
      requireIdentifier(ids)
      const infer = args.infer ?? runtime.inferenceAvailable
      if (infer && !runtime.inferenceAvailable) {
        throw new Error(
          'mem0_add was called with `infer: true`, but the plugin has no `llm` configured. ' +
            'Add an `llm` block to the plugin config, or pass `infer: false` to store the text verbatim.',
        )
      }
      try {
        const stored = (await runtime.memory.add(
          args.messages.map((m) => ({ role: m.role, content: m.content })),
          {
            ...toEntity(ids),
            infer,
            ...(args.metadata ? { metadata: args.metadata } : {}),
            ...(args.expiration_date ? { expirationDate: args.expiration_date } : {}),
          },
        )) as { results?: Array<{ id?: string; memory?: string }> }
        for (const item of stored.results ?? []) {
          if (item.id) {
            manager.history.record({ memoryId: item.id, newValue: item.memory ?? null, action: 'ADD' })
          }
        }
        await runtime.refreshAfterWrite()
        return toJsonValue(stored) as never
      } catch (error) {
        throw new Error(`mem0_add failed: ${describe(error)}`)
      }
    },
  })

  // -------------------------------------------------------------- mem0_search
  const search = defineTool({
    name: 'mem0_search',
    description: desc(
      manager,
      'mem0_search',
      'Search long-term memory with a natural-language query and return the most relevant memories. ' +
      'Scope the search with user_id / agent_id / run_id.',
    ),
    parameters: {
      query: { type: 'string', required: true, description: 'Natural-language search query.' },
      ...identifierProperties,
      filters: filterProperty,
      top_k: { type: 'integer', description: 'Maximum number of memories to return. Defaults to 5.' },
      threshold: { type: 'number', description: 'Minimum similarity score for a result to be returned.' },
      rerank: { type: 'boolean', description: 'Re-rank results with the configured reranker, if any.' },
    },
    output: {
      schema: { type: 'json' },
      render(args, value) {
        return [{ type: 'text', text: renderResults(`mem0_search "${args.query}"`, value) }]
      },
    },
    async execute(args) {
      const runtime = await ready(manager)
      const ids = runtime.identifiers({
        user_id: args.user_id,
        agent_id: args.agent_id,
        run_id: args.run_id,
      })
      requireIdentifier(ids)
      try {
        const found = await runtime.memory.search(args.query, {
          filters: toFilters(ids, args.filters),
          topK: args.top_k ?? 5,
          ...(args.threshold !== undefined ? { threshold: args.threshold } : {}),
          ...(args.rerank !== undefined ? { rerank: args.rerank } : {}),
        })
        return toJsonValue(found) as never
      } catch (error) {
        throw new Error(`mem0_search failed: ${describe(error)}`)
      }
    },
  })

  // ----------------------------------------------------------------- mem0_get
  const get = defineTool({
    name: 'mem0_get',
    description: desc(
      manager,
      'mem0_get',
      'Fetch one memory by its exact id and return its current text and metadata. ' +
        'Use this when you already have an id (from mem0_search or mem0_get_all) and need the ' +
        'verbatim content; use mem0_search when you only have a question. Returns found:false ' +
        'rather than failing when the id does not exist.',
    ),
    parameters: {
      memory_id: { type: 'string', required: true, description: 'Id of the memory to fetch.' },
    },
    output: {
      schema: { type: 'json' },
      render(args, value) {
        const result = value as {
          found?: boolean
          memory?: { memory?: string; createdAt?: string; updatedAt?: string; metadata?: unknown }
        }
        if (!result.found) {
          return [{ type: 'text', text: `mem0_get ${args.memory_id}: no memory with that id.` }]
        }
        const item = result.memory ?? {}
        return [
          {
            type: 'text',
            text: `mem0_get ${args.memory_id}: ${item.memory ?? ''}`.trimEnd(),
          },
        ]
      },
    },
    async execute(args) {
      const runtime = await ready(manager)
      try {
        // `get` resolves to `null` for an unknown or malformed id; it does not
        // throw, so "not found" is a normal answer rather than a tool failure.
        const found = (await runtime.memory.get(args.memory_id)) as Record<string, unknown> | null
        if (!found) {
          return toJsonValue({ found: false, memory_id: args.memory_id }) as never
        }
        return toJsonValue({ found: true, memory_id: args.memory_id, memory: found }) as never
      } catch (error) {
        throw new Error(`mem0_get failed: ${describe(error)}`)
      }
    },
  })

  // -------------------------------------------------------------- mem0_update
  const update = defineTool({
    name: 'mem0_update',
    description: desc(
      manager,
      'mem0_update',
      'Replace the text of an existing memory (or merge metadata into it). Use mem0_search or ' +
      'mem0_get_all first to find the memory id.',
    ),
    parameters: {
      memory_id: { type: 'string', required: true, description: 'Id of the memory to update.' },
      text: { type: 'string', required: true, description: 'New content for the memory.' },
      metadata: {
        type: 'object',
        additionalProperties: true,
        description: "Metadata merged into the memory's existing metadata.",
      },
    },
    output: {
      schema: { type: 'json' },
      render(args, value) {
        const message = (value as { message?: string })?.message ?? 'updated'
        return [{ type: 'text', text: `mem0_update ${args.memory_id}: ${message}` }]
      },
    },
    async execute(args) {
      const runtime = await ready(manager)
      try {
        // Read first so history can record what the value used to be.
        const before = (await runtime.memory.get(args.memory_id)) as { memory?: string } | null
        const updated = await runtime.memory.update(args.memory_id, {
          text: args.text,
          ...(args.metadata ? { metadata: args.metadata } : {}),
        })
        manager.history.record({
          memoryId: args.memory_id,
          previousValue: before?.memory ?? null,
          newValue: args.text,
          action: 'UPDATE',
        })
        await runtime.refreshAfterWrite()
        return toJsonValue(updated) as never
      } catch (error) {
        throw new Error(`mem0_update failed: ${describe(error)}`)
      }
    },
  })

  // -------------------------------------------------------------- mem0_delete
  const remove = defineTool({
    name: 'mem0_delete',
    description: desc(
      manager,
      'mem0_delete',
      'Delete memory: one memory by `memory_id`, or every memory matching the given ' +
      'user_id / agent_id / run_id. Exactly one of those two forms is required.',
    ),
    parameters: {
      memory_id: { type: 'string', description: 'Delete this single memory.' },
      ...identifierProperties,
    },
    output: {
      schema: { type: 'json' },
      render(args, value) {
        const message = (value as { message?: string })?.message ?? 'deleted'
        const what = args.memory_id
          ? `memory ${args.memory_id}`
          : `all memories for ${JSON.stringify({
              user_id: args.user_id,
              agent_id: args.agent_id,
              run_id: args.run_id,
            })}`
        return [{ type: 'text', text: `mem0_delete ${what}: ${message}` }]
      },
    },
    async execute(args) {
      const runtime = await ready(manager)
      if (args.memory_id) {
        if (args.user_id || args.agent_id || args.run_id) {
          throw new Error(
            'mem0_delete takes either `memory_id` or identifiers, not both. ' +
              'Call it once per form to avoid deleting more than you meant to.',
          )
        }
        try {
          const before = (await runtime.memory.get(args.memory_id)) as { memory?: string } | null
          const removed = await runtime.memory.delete(args.memory_id)
          manager.history.record({
            memoryId: args.memory_id,
            previousValue: before?.memory ?? null,
            action: 'DELETE',
          })
          await runtime.refreshAfterWrite()
          return toJsonValue(removed) as never
        } catch (error) {
          throw new Error(`mem0_delete failed: ${describe(error)}`)
        }
      }
      const ids = runtime.identifiers({
        user_id: args.user_id,
        agent_id: args.agent_id,
        run_id: args.run_id,
      })
      requireIdentifier(ids)
      try {
        const outcome = await deleteScope(manager, runtime, ids)
        return toJsonValue({
          message:
            outcome.remaining === 0
              ? `All relevant memories deleted (${outcome.deleted}).`
              : `Deleted ${outcome.deleted}, but ${outcome.remaining} memories remain in scope.`,
          ...outcome,
        }) as never
      } catch (error) {
        throw new Error(`mem0_delete failed: ${describe(error)}`)
      }
    },
  })

  // ------------------------------------------------------------- mem0_get_all
  const getAll = defineTool({
    name: 'mem0_get_all',
    description: desc(
      manager,
      'mem0_get_all',
      'List stored memories in one scope, optionally within a time window. Use this to audit what is ' +
      'remembered, or to find stale memories before evicting them (for example `created_before` an ' +
      'ISO date). Results are sorted by time and page with `offset`.',
    ),
    parameters: {
      ...identifierProperties,
      created_after: { type: 'string', description: 'Only memories created at/after this time (ISO-8601 or epoch ms).' },
      created_before: { type: 'string', description: 'Only memories created at/before this time — the eviction-scan bound.' },
      updated_after: { type: 'string', description: 'Only memories last updated at/after this time.' },
      updated_before: { type: 'string', description: 'Only memories last updated at/before this time.' },
      limit: { type: 'integer', description: 'Page size. Defaults to 50, capped at 500.' },
      offset: { type: 'integer', description: 'Skip this many matches. Defaults to 0.' },
      order: {
        type: 'string',
        enum: ['asc', 'desc'],
        description: 'Sort direction by time. Defaults to desc (newest first).',
      },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        const result = value as {
          total?: number
          returned?: number
          hasMore?: boolean
          scannedBy?: string
          caveat?: string
          items?: Array<{ id: string; memory: string; createdAt?: string }>
          window?: string
        }
        const head =
          `mem0_get_all${result.window ? ` (${result.window})` : ''}: ` +
          `${result.returned ?? 0} of ${result.total ?? 0} memories` +
          `${result.hasMore ? ' (more available — increase offset)' : ''} ` +
          `[scanned by ${result.scannedBy}]`
        const lines = (result.items ?? []).map((item) =>
          formatMemory({ id: item.id, memory: item.memory, createdAt: item.createdAt }),
        )
        const caveat = result.caveat ? ['', `WARNING: ${result.caveat}`] : []
        return [{ type: 'text', text: [head, ...lines, ...caveat].join('\n') }]
      },
    },
    async execute(args) {
      const runtime = await ready(manager)
      const ids = runtime.identifiers({
        user_id: args.user_id,
        agent_id: args.agent_id,
        run_id: args.run_id,
      })
      requireIdentifier(ids)

      const limit = Math.min(Math.max(args.limit ?? 50, 1), 500)
      const offset = Math.max(args.offset ?? 0, 0)

      const result = await scanMemories(manager.config, runtime, {
        ids,
        createdAfter: args.created_after,
        createdBefore: args.created_before,
        updatedAfter: args.updated_after,
        updatedBefore: args.updated_before,
        limit,
        offset,
        order: args.order ?? 'desc',
      })

      const window = [
        args.created_after ? `created>=${args.created_after}` : '',
        args.created_before ? `created<=${args.created_before}` : '',
        args.updated_after ? `updated>=${args.updated_after}` : '',
        args.updated_before ? `updated<=${args.updated_before}` : '',
      ]
        .filter(Boolean)
        .join(' ')

      return toJsonValue({ ...result, window: window || undefined }) as never
    },
  })

  // ------------------------------------------------------------- mem0_history
  const history = defineTool({
    name: 'mem0_history',
    description: desc(
      manager,
      'mem0_history',
      'Show the recorded change history of one memory (add / update / delete, with the previous and ' +
      'new text). Entries are appended by these tools to a local SQLite file; mem0_status reports ' +
      'where that file lives.',
    ),
    parameters: {
      memory_id: { type: 'string', required: true, description: 'Id of the memory to inspect.' },
    },
    output: {
      schema: { type: 'json' },
      render(args, value) {
        const result = value as {
          entries?: Array<{
            action: string
            updated_at: string
            previous_value: string | null
            new_value: string | null
          }>
          available?: boolean
          message?: string
          path?: string
        }
        if (result.available === false) {
          return [
            {
              type: 'text',
              text: `mem0_history unavailable: ${result.message ?? 'history store is not open'}`,
            },
          ]
        }
        const entries = result.entries ?? []
        if (entries.length === 0) {
          return [
            {
              type: 'text',
              text:
                `mem0_history ${args.memory_id}: no recorded changes.\n` +
                `(history file: ${result.path ?? 'unknown'})`,
            },
          ]
        }
        const lines = entries.map(
          (entry) =>
            `- ${entry.updated_at} ${entry.action}: ${entry.previous_value ?? '(empty)'} -> ${
              entry.new_value ?? '(empty)'
            }`,
        )
        return [
          {
            type: 'text',
            text: [`mem0_history ${args.memory_id}: ${entries.length} change(s)`, ...lines].join('\n'),
          },
        ]
      },
    },
    async execute(args) {
      const store = manager.history
      if (!store.available) {
        return toJsonValue({
          available: false,
          message: store.error ?? store.location.note ?? 'history store is not open',
          path: store.location.path,
          entries: [],
        }) as never
      }
      return toJsonValue({
        available: true,
        memory_id: args.memory_id,
        path: store.location.path,
        entries: store.list(args.memory_id),
      }) as never
    },
  })

  const disposers = [
    ctx.tools.register(status),
    ctx.tools.register(add),
    ctx.tools.register(search),
    ctx.tools.register(get),
    ctx.tools.register(update),
    ctx.tools.register(remove),
    ctx.tools.register(getAll),
    ctx.tools.register(history),
  ]
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
