/**
 * Time-range scanning over stored memories — the query an eviction job needs
 * ("show me everything older than N days") and that mem0's own API cannot
 * express.
 *
 * mem0's `getAll` delegates to `vectorStore.list(filters, topK)`, and the
 * Elasticsearch implementation of that builds `term` filters only
 * (`validateFilter` accepts string/number/boolean, never a range), applies no
 * sort, and returns at most `topK` documents with no offset. So on Elasticsearch
 * the scan is issued directly against the index, where `metadata.createdAt` is
 * mapped as a `date` and can be range-filtered, sorted and paged natively.
 *
 * Any other vector store falls back to `getAll` plus in-memory filtering, and
 * the result says so through {@link ScanResult.caveat}.
 *
 * @module dsh-mem0-plugin/scan
 */
import { collectionNameOf, createElasticsearchClient, describe, type Config } from './config.js'
import { toFilters, type Identifiers, type ReadyRuntime } from './memory.js'

/** One memory as returned by a scan. */
export interface ScannedMemory {
  id: string
  memory: string
  createdAt?: string
  updatedAt?: string
  metadata?: Record<string, unknown>
  user_id?: string
  agent_id?: string
  run_id?: string
}

/** A window over the memories in one scope. */
export interface ScanQuery {
  ids: Identifiers
  createdAfter?: string
  createdBefore?: string
  updatedAfter?: string
  updatedBefore?: string
  limit: number
  offset: number
  order: 'asc' | 'desc'
}

/** Outcome of a scan, including how it was performed. */
export interface ScanResult {
  total: number
  returned: number
  offset: number
  limit: number
  hasMore: boolean
  scannedBy: 'elasticsearch' | 'mem0.getAll'
  /** Present when the scan could not be exhaustive; explains the limitation. */
  caveat?: string
  items: ScannedMemory[]
}

/**
 * Normalize an accepted time bound to an ISO-8601 string.
 *
 * @throws {Error} when the value is neither a parseable date string nor a
 *   finite epoch-millisecond number, so a typo cannot silently widen the window.
 */
export function normalizeTimeBound(value: string | number | undefined, field: string): string | undefined {
  if (value === undefined || value === '') return undefined
  const date = typeof value === 'number' ? new Date(value) : new Date(String(value))
  if (Number.isNaN(date.getTime())) {
    throw new Error(
      `${field} is not a valid time: ${JSON.stringify(value)}. ` +
        'Use an ISO-8601 timestamp (e.g. "2026-01-31T00:00:00Z") or epoch milliseconds.',
    )
  }
  return date.toISOString()
}

/** Build the `range` clause for one field from the given bounds. */
function rangeClause(
  field: string,
  after: string | undefined,
  before: string | undefined,
): Record<string, unknown> | undefined {
  if (!after && !before) return undefined
  const range: Record<string, string> = {}
  // Inclusive bounds: an eviction job asking for "before T" must still see a
  // memory written exactly at T.
  if (after) range.gte = after
  if (before) range.lte = before
  return { range: { [`metadata.${field}`]: range } }
}

/** Strip mem0's internal vector/payload wrappers down to what callers need. */
function toScannedMemory(id: string, metadata: Record<string, unknown>): ScannedMemory {
  const { data, createdAt, updatedAt, user_id, agent_id, run_id, ...rest } = metadata as Record<
    string,
    unknown
  >
  const item: ScannedMemory = { id, memory: typeof data === 'string' ? data : '' }
  if (typeof createdAt === 'string') item.createdAt = createdAt
  if (typeof updatedAt === 'string') item.updatedAt = updatedAt
  if (typeof user_id === 'string') item.user_id = user_id
  if (typeof agent_id === 'string') item.agent_id = agent_id
  if (typeof run_id === 'string') item.run_id = run_id
  const extra = Object.fromEntries(
    Object.entries(rest).filter(([key]) => key !== 'hash' && key !== 'textLemmatized'),
  )
  if (Object.keys(extra).length > 0) item.metadata = extra
  return item
}

/**
 * Scan memories in one scope within an optional time window.
 *
 * @param config - plugin config, to decide whether the native ES path applies.
 * @param runtime - a ready runtime, used for the generic fallback.
 */
export async function scanMemories(
  config: Config,
  runtime: ReadyRuntime,
  query: ScanQuery,
): Promise<ScanResult> {
  const createdAfter = normalizeTimeBound(query.createdAfter, 'created_after')
  const createdBefore = normalizeTimeBound(query.createdBefore, 'created_before')
  const updatedAfter = normalizeTimeBound(query.updatedAfter, 'updated_after')
  const updatedBefore = normalizeTimeBound(query.updatedBefore, 'updated_before')

  const collection = collectionNameOf(config)
  if (config.vectorStore?.provider === 'elasticsearch' && collection) {
    return scanElasticsearch(config, collection, query, {
      createdAfter,
      createdBefore,
      updatedAfter,
      updatedBefore,
    })
  }
  return scanGeneric(runtime, query, { createdAfter, createdBefore, updatedAfter, updatedBefore })
}

/** True when Elasticsearch is telling us the index has not been created yet. */
export function isMissingIndex(error: unknown): boolean {
  const status = (error as { meta?: { statusCode?: number } })?.meta?.statusCode
  if (status === 404) return true
  const message = error instanceof Error ? error.message : String(error)
  return /index_not_found_exception|no such index/i.test(message)
}

/** Native ES scan: `bool.filter` + date ranges + sort + `from`/`size`. */
async function scanElasticsearch(
  config: Config,
  collection: string,
  query: ScanQuery,
  bounds: {
    createdAfter?: string
    createdBefore?: string
    updatedAfter?: string
    updatedBefore?: string
  },
): Promise<ScanResult> {
  const client = await createElasticsearchClient(config)

  const filters: Record<string, unknown>[] = []
  for (const [key, value] of Object.entries(toFilters(query.ids))) {
    filters.push({ term: { [`metadata.${key}`]: value } })
  }
  const ranges = [
    rangeClause('createdAt', bounds.createdAfter, bounds.createdBefore),
    rangeClause('updatedAt', bounds.updatedAfter, bounds.updatedBefore),
  ].filter((clause): clause is Record<string, unknown> => clause !== undefined)
  filters.push(...ranges)

  const sortField = bounds.updatedAfter || bounds.updatedBefore ? 'metadata.updatedAt' : 'metadata.createdAt'

  try {
    const response = (await client.search({
      index: collection,
      query: filters.length > 0 ? { bool: { filter: filters } } : { match_all: {} },
      sort: [{ [sortField]: { order: query.order, unmapped_type: 'date' } }],
      from: query.offset,
      size: query.limit,
      track_total_hits: true,
      _source: ['metadata'],
    })) as unknown as {
      hits: {
        total?: number | { value?: number }
        hits: Array<{ _id: string; _source?: { metadata?: Record<string, unknown> } }>
      }
    }

    const totalRaw = response.hits.total
    const total = typeof totalRaw === 'number' ? totalRaw : Number(totalRaw?.value ?? 0)
    const items = response.hits.hits.map((hit) => toScannedMemory(hit._id, hit._source?.metadata ?? {}))

    return {
      total,
      returned: items.length,
      offset: query.offset,
      limit: query.limit,
      hasMore: query.offset + items.length < total,
      scannedBy: 'elasticsearch',
      items,
    }
  } catch (error) {
    // mem0 creates the index lazily on the first write, so a scan that runs
    // before any memory exists legitimately finds no index. That is an empty
    // scope, not a failure.
    if (isMissingIndex(error)) {
      return {
        total: 0,
        returned: 0,
        offset: query.offset,
        limit: query.limit,
        hasMore: false,
        scannedBy: 'elasticsearch',
        items: [],
      }
    }
    throw new Error(`time-range scan against \`${collection}\` failed: ${describe(error)}`)
  }
}

/** Fallback for non-ES stores: `getAll`, then filter/sort/page in memory. */
async function scanGeneric(
  runtime: ReadyRuntime,
  query: ScanQuery,
  bounds: {
    createdAfter?: string
    createdBefore?: string
    updatedAfter?: string
    updatedBefore?: string
  },
): Promise<ScanResult> {
  // `getAll` has no offset and caps at `topK`, so over-fetch and page locally.
  const topK = Math.max(200, query.offset + query.limit)
  const result = (await runtime.memory.getAll({
    filters: toFilters(query.ids),
    topK,
  })) as unknown as { results?: Array<Record<string, unknown>> }

  const all = (result.results ?? []).map((row) =>
    toScannedMemory(String(row.id), {
      data: row.memory,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      user_id: row.user_id,
      agent_id: row.agent_id,
      run_id: row.run_id,
      ...(typeof row.metadata === 'object' && row.metadata ? (row.metadata as object) : {}),
    }),
  )

  const inWindow = (value: string | undefined, after?: string, before?: string): boolean => {
    if (!after && !before) return true
    if (!value) return false
    const at = new Date(value).getTime()
    if (after && at < new Date(after).getTime()) return false
    if (before && at > new Date(before).getTime()) return false
    return true
  }

  const matching = all.filter(
    (item) =>
      inWindow(item.createdAt, bounds.createdAfter, bounds.createdBefore) &&
      inWindow(item.updatedAt, bounds.updatedAfter, bounds.updatedBefore),
  )
  const sortKey = bounds.updatedAfter || bounds.updatedBefore ? 'updatedAt' : 'createdAt'
  matching.sort((left, right) => {
    const a = left[sortKey] ?? left.createdAt ?? ''
    const b = right[sortKey] ?? right.createdAt ?? ''
    return query.order === 'asc' ? a.localeCompare(b) : b.localeCompare(a)
  })

  const page = matching.slice(query.offset, query.offset + query.limit)
  return {
    total: matching.length,
    returned: page.length,
    offset: query.offset,
    limit: query.limit,
    hasMore: query.offset + page.length < matching.length,
    scannedBy: 'mem0.getAll',
    caveat:
      `This vector store is not Elasticsearch, so the scan reads at most ${topK} memories ` +
      'through mem0.getAll and filters them in memory. `total` therefore counts only what was ' +
      'fetched, and results are complete only for scopes smaller than that. ' +
      'Elasticsearch uses a native range query and is exact.',
    items: page,
  }
}
