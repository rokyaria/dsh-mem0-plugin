/**
 * Plugin configuration: schema, validation, backend probing, and the shared
 * Elasticsearch client.
 *
 * @module dsh-mem0-plugin/config
 */
import Schema from '@deepseek-ai/schemastery'

/** One `provider` + free-form provider settings, as mem0's own factories expect. */
export interface ProviderSpec {
  /** Provider id understood by the matching mem0ai factory (e.g. `ollama`, `openai`, `elasticsearch`). */
  provider: string
  /** Provider-specific settings; validated per provider by {@link validateConfig}. */
  config?: Record<string, unknown>
}

/** How (and whether) the plugin verifies its backends. */
export interface PreflightSpec {
  /** Run the probe before declaring the runtime ready. Default `true`. */
  enabled?: boolean
  /** Per-probe budget in milliseconds. Default `8000`. */
  timeoutMs?: number
}

/** Persistent memory-history settings. */
export interface HistorySpec {
  /** Record and serve memory history. Default `true`. */
  enabled?: boolean
  /**
   * SQLite file backing the history.
   *
   * Default `/mem0/history.db` (the container path from the reference
   * deployment). On a host where `/mem0` cannot be created — macOS keeps `/` on
   * a sealed read-only volume — the plugin falls back to
   * `<DSH_HOME>/mem0/history.db` and reports the resolved path through
   * `mem0_status`.
   */
  dbPath?: string
}

/**
 * Model-facing guidance: a system-prompt section telling the agent *when* to
 * reach for memory, which is separate from each tool's own description.
 */
export interface GuidanceSpec {
  /** Contribute the section at all. Default `true`. */
  enabled?: boolean
  /** Replace the built-in text entirely. */
  text?: string
  /** Append to the built-in (or replaced) text. */
  append?: string
  /** Sort order within the prompt. Default `3150` (after built-in tool sections). */
  order?: number
  /**
   * Where the section is registered.
   *
   * - `global` (default): one section, every agent sees it.
   * - `agent`: one section **per agent**, registered through that agent's
   *   `agent.ctx` so it lands in that agent's own prompt layer. It is cleaned up
   *   with the agent, and it shadows a global section of the same name.
   *   `presets` narrows which agents get it.
   */
  scope?: 'global' | 'agent'
  /**
   * Preset ids to restrict to when `scope: agent` (e.g. `[ptc, standard]`).
   * Empty or omitted means every agent. Rejected when `scope` is `global`,
   * because a global section cannot be narrowed after the fact.
   */
  presets?: string[]
}

/** Startup behaviour. */
export interface StartupSpec {
  /**
   * Fail the plugin load when the backends cannot be reached. Default `false`.
   *
   * `false` (default) keeps the plugin loaded so `mem0_status` can explain what
   * is wrong; every other tool reports the same error. `true` restores
   * load-time failure: the row lands in `FAILED` and no tool is registered,
   * which also means nothing is left to diagnose with.
   */
  strict?: boolean
}

/** The plugin's user-facing configuration. */
export interface Config {
  /** Embedding model. Required to become ready (not to load — see {@link StartupSpec}). */
  embedder?: ProviderSpec
  /** Vector store; ES8 deployments use `elasticsearch`. Required to become ready. */
  vectorStore?: ProviderSpec
  /**
   * Fact-extraction / update LLM. Only `mem0_add` with `infer: true` needs it.
   *
   * mem0's TypeScript runtime requires an `llm` block to construct a `Memory`
   * at all, so the plugin always supplies one: either the user's, or an inert
   * placeholder that raises a precise error if a call actually needs it.
   */
  llm?: ProviderSpec
  /** Persistent memory history. */
  history?: HistorySpec
  /** Backend probe settings. */
  preflight?: PreflightSpec
  /**
   * Force an Elasticsearch index refresh after every write, so a search issued
   * right after an add/update/delete sees it. Default `true`.
   */
  refreshAfterWrite?: boolean
  /** Startup behaviour. */
  startup?: StartupSpec
  /** Identifier defaults applied when a tool call omits them. */
  identifiers?: {
    user_id?: string
    agent_id?: string
    run_id?: string
  }
  /**
   * Guidance section for the model: when to use memory. Contributed to the
   * system prompt; see {@link GuidanceSpec}.
   */
  guidance?: GuidanceSpec
  /**
   * Override the model-facing description of individual tools, keyed by tool
   * name (`mem0_add`, `mem0_search`, …). Each value replaces that tool's whole
   * description, so state the full intent.
   */
  toolDescriptions?: Record<string, string>
}

const providerSpec = (description: string) =>
  Schema.object({
    provider: Schema.string().required().description(description),
    config: Schema.dict(Schema.any()).description('Provider-specific settings.'),
  })

/**
 * Cordis config schema.
 *
 * `embedder` and `vectorStore` are deliberately **not** `required()` here: the
 * plugin must load even when they are missing, because `mem0_status` is the
 * only way to tell the operator what is wrong. Missing blocks surface as a
 * reported runtime error instead. Set `startup.strict` to fail the load instead.
 */
export const Config: Schema<Config> = Schema.object({
  embedder: providerSpec('Embedding provider id, e.g. `ollama`, `openai` or `lmstudio`.')
    .default(undefined as never)
    .description('Embedding model. Required for the runtime to become ready.'),
  vectorStore: providerSpec('Vector store provider id; ES8 deployments use `elasticsearch`.')
    .default(undefined as never)
    .description('Vector store. Required for the runtime to become ready.'),
  llm: providerSpec('LLM provider id, e.g. `openai` (any OpenAI-compatible endpoint).')
    .default(undefined as never)
    .description('Optional. Only mem0 fact-extraction (`mem0_add` with `infer: true`) needs it.'),
  history: Schema.object({
    enabled: Schema.boolean().default(true),
    dbPath: Schema.string().description(
      'SQLite file for memory history. Default `/mem0/history.db`, falling back to `<DSH_HOME>/mem0/history.db`.',
    ),
  })
    .default({})
    .description('Persistent memory history for `mem0_history`.'),
  preflight: Schema.object({
    enabled: Schema.boolean().default(true),
    timeoutMs: Schema.natural().default(8000),
  })
    .default({})
    .description('Probe the vector store and embedding model before the runtime becomes ready.'),
  refreshAfterWrite: Schema.boolean()
    .default(true)
    .description(
      'Refresh the Elasticsearch index after each write so the next search sees it immediately.',
    ),
  startup: Schema.object({
    strict: Schema.boolean().default(false),
  })
    .default({})
    .description('`strict: true` fails the plugin load when a backend cannot be reached.'),
  identifiers: Schema.object({
    user_id: Schema.string(),
    agent_id: Schema.string(),
    run_id: Schema.string(),
  })
    .default({})
    .description('Default identifiers used when a tool call omits them.'),
  guidance: Schema.object({
    enabled: Schema.boolean().default(true),
    text: Schema.string().description('Replaces the built-in guidance section entirely.'),
    append: Schema.string().description('Appended after the built-in (or replacement) text.'),
    order: Schema.number().default(3150),
    scope: Schema.union(['global', 'agent']).default('global'),
    presets: Schema.array(Schema.string()).default([]),
  })
    .default({})
    .description('System-prompt section telling the agent when to use memory.'),
  toolDescriptions: Schema.dict(Schema.string())
    .default({})
    .description('Per-tool description overrides, keyed by tool name.'),
})

/** Raised for configs that parse but cannot work; message is written for the operator. */
export class Mem0ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Mem0ConfigError'
  }
}

/** True when at least one mem0 entity identifier is present. */
export function hasIdentifier(value: {
  user_id?: string
  agent_id?: string
  run_id?: string
}): boolean {
  return Boolean(value.user_id || value.agent_id || value.run_id)
}

/** Every tool this plugin registers; the keys allowed in `toolDescriptions`. */
export const TOOL_NAMES = [
  'mem0_status',
  'mem0_add',
  'mem0_search',
  'mem0_get',
  'mem0_update',
  'mem0_delete',
  'mem0_get_all',
  'mem0_history',
] as const

/** Top-level config keys this plugin understands. */
const KNOWN_TOP_LEVEL_KEYS = [
  'embedder',
  'vectorStore',
  'llm',
  'history',
  'preflight',
  'refreshAfterWrite',
  'startup',
  'identifiers',
  'guidance',
  'toolDescriptions',
] as const

/**
 * Reject configs the mem0 factories would only reject later, with a message
 * that names the field and the fix.
 *
 * @throws {Mem0ConfigError} for an unknown key or a provider setting that
 *   cannot work.
 */
export function validateConfig(config: Config): void {
  // Schemastery ignores unknown keys, so a typo would silently keep the
  // default. Report it instead — an unrecognised key is almost always a typo.
  const unknown = Object.keys(config as unknown as Record<string, unknown>).filter(
    (key) => !(KNOWN_TOP_LEVEL_KEYS as readonly string[]).includes(key),
  )
  if (unknown.length > 0) {
    const migration = unknown.includes('historyStore')
      ? ' `historyStore` was replaced by `history.dbPath` in v0.2.0 — mem0\'s internal history store is no longer used.'
      : ''
    throw new Mem0ConfigError(
      `Unknown configuration ${unknown.length === 1 ? 'key' : 'keys'}: ${unknown.join(', ')}. ` +
        `Valid top-level keys are: ${KNOWN_TOP_LEVEL_KEYS.join(', ')}.${migration} ` +
        '(Keys inside `embedder.config` / `vectorStore.config` / `llm.config` are passed through to the provider.)',
    )
  }

  // A typo in a description override would silently leave the built-in text in
  // place, so name the valid tools instead.
  const unknownTools = Object.keys(config.toolDescriptions ?? {}).filter(
    (tool) => !(TOOL_NAMES as readonly string[]).includes(tool),
  )
  if (unknownTools.length > 0) {
    throw new Mem0ConfigError(
      `Unknown tool ${unknownTools.length === 1 ? 'name' : 'names'} in \`toolDescriptions\`: ` +
        `${unknownTools.join(', ')}. Valid tools are: ${TOOL_NAMES.join(', ')}.`,
    )
  }

  // A global section cannot be narrowed to presets, so accepting the pair would
  // silently deliver guidance to every agent.
  if ((config.guidance?.scope ?? 'global') === 'global' && (config.guidance?.presets?.length ?? 0) > 0) {
    throw new Mem0ConfigError(
      '`guidance.presets` only applies when `guidance.scope` is `agent` — a global section is ' +
        'visible to every agent and cannot be narrowed afterwards. Set `guidance.scope: agent`, ' +
        'or drop `presets` to keep one global section.',
    )
  }

  const storeConfig = (config.vectorStore?.config ?? {}) as Record<string, unknown>
  if (config.vectorStore?.provider === 'elasticsearch') {
    // ElasticsearchDB defaults `useSsl` to *true* (`undefined !== false`), so a
    // plain-http ES8 endpoint silently becomes an https client unless it is set.
    if (storeConfig.useSsl === undefined && (storeConfig.host || storeConfig.cloudId)) {
      throw new Mem0ConfigError(
        'vectorStore.config.useSsl is not set for an `elasticsearch` vector store. ' +
          'mem0ai then defaults to HTTPS; set `useSsl: false` for a plain-http Elasticsearch ' +
          '(the usual ES8 single-node setup), or `true` if you really serve TLS.',
      )
    }
    if (!storeConfig.collectionName && !storeConfig.collection_name) {
      throw new Mem0ConfigError(
        'vectorStore.config.collectionName is required for an `elasticsearch` vector store. ' +
          "Note the TypeScript SDK uses camelCase here — the Python REST server's " +
          '`collection_name` is also accepted.',
      )
    }
  }
}

/** Provider config with the Python-era snake_case aliases folded onto TS SDK names. */
export function normalizeVectorStoreConfig(config: Config): Record<string, unknown> {
  const raw = { ...(config.vectorStore?.config ?? {}) } as Record<string, unknown>
  const aliases: Record<string, string> = {
    collection_name: 'collectionName',
    embedding_model_dims: 'embeddingModelDims',
    user: 'username',
  }
  for (const [from, to] of Object.entries(aliases)) {
    if (raw[from] !== undefined && raw[to] === undefined) raw[to] = raw[from]
    delete raw[from]
  }
  return raw
}

/** Embedding provider config with snake_case aliases folded onto SDK names. */
export function normalizeEmbedderConfig(config: Config): Record<string, unknown> {
  const raw = { ...(config.embedder?.config ?? {}) } as Record<string, unknown>
  if (raw.embedding_dims !== undefined && raw.embeddingDims === undefined) {
    raw.embeddingDims = raw.embedding_dims
  }
  delete raw.embedding_dims
  return raw
}

/**
 * Assemble the mem0 `MemoryConfig` the SDK expects.
 *
 * @param options.detectedDims - dimensionality measured by the probe; used as
 *   the Elasticsearch `embeddingModelDims` default so the index mapping can
 *   never disagree with the embedder.
 * @param options.allowInference - `false` installs an inert placeholder LLM.
 */
export function toSdkConfig(
  config: Config,
  options: { detectedDims?: number; allowInference: boolean },
): Record<string, unknown> {
  const storeConfig: Record<string, unknown> = { ...normalizeVectorStoreConfig(config) }
  const embedderConfig: Record<string, unknown> = { ...normalizeEmbedderConfig(config) }

  if (options.detectedDims && storeConfig.embeddingModelDims === undefined) {
    storeConfig.embeddingModelDims = options.detectedDims
  }
  if (options.detectedDims && embedderConfig.embeddingDims === undefined) {
    embedderConfig.embeddingDims = options.detectedDims
  }

  const llm =
    config.llm && options.allowInference
      ? { provider: config.llm.provider, config: { ...(config.llm.config ?? {}) } }
      : // mem0's schema makes `llm` mandatory even for call paths that never use it.
        // This placeholder points at a closed port so misuse fails fast and visibly.
        {
          provider: 'openai',
          config: { apiKey: 'unused', model: 'unused', baseURL: 'http://127.0.0.1:1/v1' },
        }

  return {
    embedder: { provider: config.embedder?.provider, config: embedderConfig },
    vectorStore: { provider: config.vectorStore?.provider, config: storeConfig },
    llm,
    // The plugin owns history (see src/history.ts); mem0's own store stays
    // in-process so the ABI-bound better-sqlite3 binding is never instantiated.
    historyStore: { provider: 'memory', config: {} },
  }
}

/** Outcome of the readiness probe. */
export interface PreflightReport {
  embedder: { provider: string; model?: string; dimensions: number }
  vectorStore: { provider: string; detail: string }
}

/** Reject if `promise` does not settle within `ms`, so startup cannot hang forever. */
async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Mem0ConfigError(`${what} did not respond within ${ms}ms`)),
          ms,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Append a sentence to a message without producing a double period when the
 * original already ends in punctuation.
 */
export function appendSentence(message: string, sentence: string): string {
  return /[.!?]$/.test(message) ? `${message} ${sentence}` : `${message}. ${sentence}`
}

/**
 * Probe the embedding model and the vector store.
 *
 * The embedding probe doubles as dimensionality detection; the store probe
 * pings Elasticsearch and, when the target index exists, checks its
 * `dense_vector` dimension against the embedder — the most common way a
 * mem0 + ES8 deployment breaks, and otherwise only reported by a failing insert.
 *
 * @throws {Mem0ConfigError} naming the backend that failed and what to check.
 */
export async function preflight(config: Config, timeoutMs: number): Promise<PreflightReport> {
  if (!config.embedder?.provider) {
    throw new Mem0ConfigError('`embedder` is not configured, so nothing can be embedded. Add an `embedder` block.')
  }
  if (!config.vectorStore?.provider) {
    throw new Mem0ConfigError('`vectorStore` is not configured, so memories have nowhere to live. Add a `vectorStore` block.')
  }

  const { EmbedderFactory } = await import('mem0ai/oss')
  const embedderConfig = normalizeEmbedderConfig(config)
  const embedder = EmbedderFactory.create(config.embedder.provider, embedderConfig)

  let dimensions: number
  try {
    const vector = await withTimeout(
      embedder.embed('mem0 preflight probe'),
      timeoutMs,
      `Embedding provider \`${config.embedder.provider}\``,
    )
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new Mem0ConfigError(
        `Embedding provider \`${config.embedder.provider}\` returned an empty vector; ` +
          'check that the model name is correct and the endpoint serves embeddings.',
      )
    }
    dimensions = vector.length
  } catch (error) {
    if (error instanceof Mem0ConfigError) throw error
    throw new Mem0ConfigError(
      appendSentence(
        `Embedding provider \`${config.embedder.provider}\` failed its probe: ${describe(error)}`,
        'Check `embedder.config` (endpoint URL, model name, API key).',
      ),
    )
  }

  const report: PreflightReport = {
    embedder: {
      provider: config.embedder.provider,
      model: typeof embedderConfig.model === 'string' ? embedderConfig.model : undefined,
      dimensions,
    },
    vectorStore: { provider: config.vectorStore.provider, detail: 'not probed' },
  }

  if (config.vectorStore.provider === 'elasticsearch') {
    report.vectorStore.detail = await preflightElasticsearch(config, dimensions, timeoutMs)
  }
  return report
}

/**
 * Build the same Elasticsearch client settings mem0 will use, for the plugin's
 * own probes, range scans and refreshes.
 */
export async function createElasticsearchClient(config: Config) {
  const storeConfig = normalizeVectorStoreConfig(config)
  const { Client } = await import('@elastic/elasticsearch')
  const host = typeof storeConfig.host === 'string' ? storeConfig.host : 'localhost'
  const port = typeof storeConfig.port === 'number' ? storeConfig.port : 9200
  const scheme = storeConfig.useSsl === true ? 'https' : 'http'
  const auth =
    typeof storeConfig.username === 'string' && typeof storeConfig.password === 'string'
      ? { username: storeConfig.username, password: storeConfig.password }
      : storeConfig.apiKey
        ? { apiKey: storeConfig.apiKey as string }
        : undefined

  return new Client({
    node: `${scheme}://${host}:${port}`,
    ...(auth ? { auth } : {}),
    ...(storeConfig.verifyCerts === false ? { tls: { rejectUnauthorized: false } } : {}),
  })
}

/** The `collectionName` mem0 will use, or `undefined` when it is not configured. */
export function collectionNameOf(config: Config): string | undefined {
  const storeConfig = normalizeVectorStoreConfig(config)
  return typeof storeConfig.collectionName === 'string' ? storeConfig.collectionName : undefined
}

/** Ping ES8 and verify the target index dimension, returning an operator-facing summary. */
async function preflightElasticsearch(
  config: Config,
  dimensions: number,
  timeoutMs: number,
): Promise<string> {
  const storeConfig = normalizeVectorStoreConfig(config)
  const host = typeof storeConfig.host === 'string' ? storeConfig.host : 'localhost'
  const port = typeof storeConfig.port === 'number' ? storeConfig.port : 9200
  const scheme = storeConfig.useSsl === true ? 'https' : 'http'
  const client = await createElasticsearchClient(config)

  let version: string
  try {
    const info = await withTimeout(client.info(), timeoutMs, `Elasticsearch at ${scheme}://${host}:${port}`)
    version = String((info as { version?: { number?: string } }).version?.number ?? 'unknown')
  } catch (error) {
    throw new Mem0ConfigError(
      appendSentence(
        `Elasticsearch at ${scheme}://${host}:${port} failed its probe: ${describe(error)}`,
        'Check `vectorStore.config` (host, port, useSsl, username/password).',
      ),
    )
  }

  const major = Number.parseInt(version.split('.')[0] ?? '', 10)
  if (Number.isFinite(major) && major >= 9) {
    throw new Mem0ConfigError(
      `Elasticsearch reported version ${version}, but this plugin pins the \`@elastic/elasticsearch\` v8 ` +
        'client for ES8 compatibility. The v9 client sends `compatible-with=9` media types that an ES8 ' +
        'server rejects, and an ES9 server with a v8 client is likewise unsupported here.',
    )
  }

  const collectionName = collectionNameOf(config)
  if (!collectionName) return `Elasticsearch ${version} reachable; index not checked`

  try {
    const exists = await withTimeout(
      client.indices.exists({ index: collectionName }),
      timeoutMs,
      `Elasticsearch index ${collectionName}`,
    )
    if (!exists) {
      return `Elasticsearch ${version} reachable; index \`${collectionName}\` will be created with ${dimensions} dims`
    }
    const mapping = (await client.indices.getMapping({ index: collectionName })) as Record<
      string,
      { mappings?: { properties?: { vector?: { dims?: number } } } }
    >
    const dims = mapping[collectionName]?.mappings?.properties?.vector?.dims
    if (typeof dims === 'number' && dims !== dimensions) {
      throw new Mem0ConfigError(
        `Index \`${collectionName}\` stores ${dims}-dimensional vectors but the configured embedding ` +
          `model produces ${dimensions}. mem0 cannot mix dimensions in one index: point ` +
          '`vectorStore.config.collectionName` at a new index, or switch the embedder back.',
      )
    }
    return `Elasticsearch ${version} reachable; index \`${collectionName}\` present (${dims ?? dimensions} dims)`
  } catch (error) {
    if (error instanceof Mem0ConfigError) throw error
    throw new Mem0ConfigError(
      `Elasticsearch ${version} responded but index \`${collectionName}\` could not be inspected: ${describe(error)}.`,
    )
  }
}

/**
 * One-line, credential-free description of an unknown thrown value.
 *
 * `@elastic/elasticsearch` reports a refused connection as a `ConnectionError`
 * with an **empty** `message`, so falling back to `error.message` alone would
 * produce "failed its probe: ." — useless to an operator.
 */
export function describe(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message?.trim()
    if (message) return message

    const meta = (error as { meta?: { statusCode?: number; meta?: { attempts?: number } } }).meta
    const parts = [error.name || 'Error']
    parts.push(meta?.statusCode ? `HTTP ${meta.statusCode}` : 'no response')
    const attempts = meta?.meta?.attempts
    if (attempts) parts.push(`after ${attempts} attempts`)
    return `${parts.join(', ')} — the endpoint refused the connection or is not reachable`
  }
  if (error === undefined) return 'undefined'
  return String(error)
}
