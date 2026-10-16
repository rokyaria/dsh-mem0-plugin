/**
 * Shared backend selection for the *live* test suites.
 *
 * The suites that talk to a real embedder + Elasticsearch (e2e, scope-delete,
 * config-failfast, benchmark) must run on any machine an operator happens to
 * have, without the suites silently asserting on the wrong failure. So the
 * backend is chosen in one place, overridable by environment:
 *
 *   MEM0_TEST_EMBEDDER=lmstudio | ollama      (default: lmstudio)
 *   MEM0_TEST_EMBEDDER_URL=...                (default per provider, see below)
 *   MEM0_TEST_MODEL=...                       (default per provider)
 *   MEM0_TEST_ES_HOST / _PORT / _USER / _PASS
 *
 * `BENCH_*` names are still honoured so existing benchmark invocations keep
 * working (benchmark.mjs used them before this module existed).
 *
 * Suites that need a reachable embedder call `embedderReachable()` first and
 * print a SKIP line instead of failing when the machine has none — a missing
 * optional dependency is not a code defect, and a suite that reports a false
 * failure trains people to ignore it.
 */

export const EMBEDDER = process.env.MEM0_TEST_EMBEDDER ?? process.env.BENCH_EMBEDDER ?? 'lmstudio'

export const EMBEDDER_URL =
  process.env.MEM0_TEST_EMBEDDER_URL ??
  process.env.BENCH_EMBEDDER_URL ??
  (EMBEDDER === 'lmstudio' ? 'http://localhost:1234/v1' : 'http://localhost:11434')

export const EMBEDDER_MODEL =
  process.env.MEM0_TEST_MODEL ??
  process.env.BENCH_MODEL ??
  (EMBEDDER === 'lmstudio' ? 'text-embedding-bge-m3' : 'nomic-embed-text:latest')

export const ES = {
  host: process.env.MEM0_TEST_ES_HOST ?? 'localhost',
  port: Number(process.env.MEM0_TEST_ES_PORT ?? 9200),
  username: process.env.MEM0_TEST_ES_USER ?? 'elastic',
  password: process.env.MEM0_TEST_ES_PASS ?? 'elastic',
  useSsl: false,
}

/** Embedder block for the plugin config (both URL key spellings; providers differ). */
export function embedderConfig(overrides = {}) {
  return {
    provider: EMBEDDER,
    config: { url: EMBEDDER_URL, baseURL: EMBEDDER_URL, model: EMBEDDER_MODEL, ...overrides },
  }
}

/** Elasticsearch vector-store block for the plugin config. */
export function vectorStoreConfig(collectionName) {
  return { provider: 'elasticsearch', config: { collectionName, ...ES } }
}

/** One-line description for suite headers. */
export function describeBackends() {
  return `embedder=${EMBEDDER} @ ${EMBEDDER_URL} (${EMBEDDER_MODEL}) · ES=${ES.host}:${ES.port}`
}

/**
 * Is anything answering at this URL? Any HTTP status counts as reachable — the
 * question is "is a server there", not "is the request valid".
 */
export async function reachable(url, timeoutMs = 3000) {
  try {
    await fetch(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) })
    return true
  } catch {
    return false
  }
}

/** True when the configured embedding endpoint answers. */
export function embedderReachable(timeoutMs = 3000) {
  return reachable(EMBEDDER_URL, timeoutMs)
}

/** Is the configured Elasticsearch answering? */
export function vectorStoreReachable(timeoutMs = 3000) {
  return reachable(`http${ES.useSsl ? 's' : ''}://${ES.host}:${ES.port}`, timeoutMs)
}

/**
 * Guard for suites that need both live backends. Returns false (after printing
 * SKIP lines) when either is missing, so the caller can exit 0 instead of
 * reporting a failure that is really a missing optional dependency.
 */
export async function liveBackendsOrSkip(label) {
  const embedderOk = await embedderReachable()
  if (!embedderOk) {
    skip(label, `no embedding endpoint answered ${EMBEDDER_URL} — start Ollama, or set MEM0_TEST_EMBEDDER=lmstudio`)
  }
  const storeOk = await vectorStoreReachable()
  if (!storeOk) {
    skip(label, `no Elasticsearch answered ${ES.host}:${ES.port} — see install.md §2`)
  }
  return embedderOk && storeOk
}

/** Standard SKIP line, so skipped work is visible rather than silent. */
export function skip(label, why) {
  console.log(`\n⏭  SKIP ${label} — ${why}`)
}
