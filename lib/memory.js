/**
 * Runtime ownership: lazy mem0 construction, health reporting, and the
 * identifier translation between the tool surface and the mem0 SDK.
 *
 * The plugin deliberately **always loads**. Constructing mem0 needs a live
 * embedder and vector store, and the moment that fails is exactly the moment an
 * operator needs `mem0_status` to explain why — so a failure is captured as
 * runtime state instead of failing the plugin load. `startup.strict` restores
 * load-time failure for deployments that prefer it.
 *
 * @module dsh-mem0-plugin/memory
 */
import { Memory } from 'mem0ai/oss';
import { Mem0ConfigError, appendSentence, collectionNameOf, createElasticsearchClient, describe, preflight, toSdkConfig, validateConfig, } from './config.js';
import { HistoryStore } from './history.js';
import { isMissingIndex } from './scan.js';
/** How long to wait before re-attempting a failed initialization. */
const RETRY_COOLDOWN_MS = 5_000;
/**
 * mem0's TypeScript SDK is asymmetric: write options take camelCase entity keys
 * (`userId`), while search/getAll filters take snake_case (`user_id`). Getting
 * this wrong does not throw — the filter simply matches nothing — so the
 * translation lives in exactly one place, here.
 */
export function toEntity(ids) {
    const entity = {};
    if (ids.user_id)
        entity.userId = ids.user_id;
    if (ids.agent_id)
        entity.agentId = ids.agent_id;
    if (ids.run_id)
        entity.runId = ids.run_id;
    return entity;
}
/** Build the snake_case filter object `search`/`getAll`/range scans expect. */
export function toFilters(ids, extra) {
    const filters = { ...(extra ?? {}) };
    if (ids.user_id)
        filters.user_id = ids.user_id;
    if (ids.agent_id)
        filters.agent_id = ids.agent_id;
    if (ids.run_id)
        filters.run_id = ids.run_id;
    return filters;
}
/**
 * Owns the mem0 runtime and the history store for one plugin instance.
 *
 * Initialization is lazy and retried: a `mem0_status` call (or any tool call)
 * after the cooldown re-attempts, so starting Elasticsearch *after* dsh is
 * enough to bring the plugin online without a restart.
 */
export class Mem0RuntimeManager {
    config;
    history;
    /** Prompt-guidance registration outcome, set by `apply` and reported by `mem0_status`. */
    guidance;
    startedAt = Date.now();
    phase = 'idle';
    attemptCount = 0;
    lastAttemptAt;
    readyAt;
    lastError;
    ready;
    inFlight;
    resolveWorkspace;
    workspace;
    /**
     * @param config - plugin config.
     * @param options.resolveWorkspace - resolves the dsh workspace to place
     *   `<workspace>/mem0/` under. Omitted in tests and in profiles without a
     *   workspace registry, in which case history falls back to `<DSH_HOME>/mem0/`.
     */
    constructor(config, options = {}) {
        this.config = config;
        this.history = new HistoryStore();
        this.resolveWorkspace = options.resolveWorkspace ?? (async () => undefined);
    }
    /** The configured inference LLM, if any. */
    get inferenceAvailable() {
        return Boolean(this.config.llm?.provider);
    }
    /**
     * Resolve a ready runtime, attempting initialization when needed.
     *
     * @throws {Mem0ConfigError} carrying the original cause, when the runtime
     *   cannot be brought up. The message is written for the operator.
     */
    async ensure() {
        if (this.phase === 'ready' && this.ready)
            return this.ready;
        if (this.inFlight)
            return this.inFlight;
        if (this.phase === 'failed' && this.lastAttemptAt !== undefined) {
            const since = Date.now() - this.lastAttemptAt;
            if (since < RETRY_COOLDOWN_MS) {
                throw this.failure(`initialization failed ${Math.round(since / 1000)}s ago and is cooling down; ` +
                    `retrying automatically (last error: ${describe(this.lastError)}). ` +
                    'Call `mem0_status` for the full report.');
            }
        }
        this.inFlight = this.attempt().finally(() => {
            this.inFlight = undefined;
        });
        return this.inFlight;
    }
    /** Run one initialization attempt, capturing every failure into state. */
    async attempt() {
        this.phase = 'initializing';
        this.attemptCount += 1;
        this.lastAttemptAt = Date.now();
        const started = Date.now();
        try {
            validateConfig(this.config);
            await this.settleHistory();
            const timeoutMs = this.config.preflight?.timeoutMs ?? 8000;
            let report;
            let detectedDims;
            if (this.config.preflight?.enabled ?? true) {
                report = await preflight(this.config, timeoutMs);
                detectedDims = report.embedder.dimensions;
            }
            const inferenceAvailable = this.inferenceAvailable;
            const memory = Memory.fromConfig(toSdkConfig(this.config, { detectedDims, allowInference: inferenceAvailable }));
            // `refreshAfterWrite` only controls whether writes refresh *automatically*.
            // The refresh capability itself is always available for Elasticsearch,
            // because scope deletion depends on it for correctness (see `deleteScope`
            // in tools.ts) — not merely for read-after-write convenience.
            const collectionName = collectionNameOf(this.config);
            const refreshClient = this.config.vectorStore?.provider === 'elasticsearch' && collectionName
                ? await createElasticsearchClient(this.config)
                : undefined;
            const autoRefresh = this.config.refreshAfterWrite ?? true;
            const defaults = {
                user_id: this.config.identifiers?.user_id,
                agent_id: this.config.identifiers?.agent_id,
                run_id: this.config.identifiers?.run_id,
            };
            this.ready = {
                memory,
                report,
                inferenceAvailable,
                identifiers(explicit) {
                    return {
                        user_id: explicit.user_id ?? defaults.user_id,
                        agent_id: explicit.agent_id ?? defaults.agent_id,
                        run_id: explicit.run_id ?? defaults.run_id,
                    };
                },
                async refresh() {
                    if (!refreshClient || !collectionName)
                        return;
                    try {
                        await refreshClient.indices.refresh({ index: collectionName });
                    }
                    catch (error) {
                        // Before the first write mem0 has not created the index yet; there
                        // is nothing to refresh and nothing to report. Anything else is
                        // only ever a delay in visibility, so it must not fail the caller.
                        if (!isMissingIndex(error)) {
                            console.warn(`[dsh-mem0-plugin] index refresh failed: ${describe(error)}`);
                        }
                    }
                },
                /** Refresh only when the deployment asked for write-time auto-refresh. */
                async refreshAfterWrite() {
                    if (autoRefresh)
                        await this.refresh();
                },
            };
            this.phase = 'ready';
            this.readyAt = Date.now();
            this.lastError = undefined;
            console.log(`[dsh-mem0-plugin] runtime ready in ${Date.now() - started}ms`);
            return this.ready;
        }
        catch (error) {
            this.phase = 'failed';
            this.ready = undefined;
            this.lastError =
                error instanceof Mem0ConfigError
                    ? error
                    : new Mem0ConfigError(appendSentence(`mem0 rejected the resolved configuration: ${describe(error)}`, 'Check `embedder`, `vectorStore` and `llm` against the mem0ai OSS provider list.'));
            console.warn(`[dsh-mem0-plugin] runtime initialization failed: ${this.lastError.message}`);
            throw this.lastError;
        }
    }
    /**
     * Resolve the workspace and (re)open the history store.
     *
     * Runs on every init attempt and on every `mem0_status`, because a host-level
     * plugin can load before any workspace is registered: the store first lands on
     * the `<DSH_HOME>` fallback and moves to `<workspace>/mem0/` on a later pass.
     * Never throws — a resolver problem must not take the memory runtime down.
     */
    async settleHistory() {
        try {
            const resolved = await this.resolveWorkspace();
            if (resolved)
                this.workspace = resolved;
        }
        catch {
            // Keep whatever was resolved before; the store's own note explains it.
        }
        try {
            this.history.ensureOpen(this.config, this.workspace);
        }
        catch (error) {
            console.warn(`[dsh-mem0-plugin] history store unavailable: ${describe(error)}`);
        }
    }
    /** Wrap a message so the caller sees both the context and the real cause. */
    failure(context) {
        return new Mem0ConfigError(`mem0 is not ready: ${context}`);
    }
    /**
     * Report the current state, attempting initialization first when it is idle
     * or past its cooldown. Never throws.
     */
    async status() {
        if (this.phase === 'idle' || this.phase === 'failed') {
            try {
                await this.ensure();
            }
            catch {
                // Captured in state; the snapshot below is the report.
            }
        }
        else if (this.inFlight) {
            try {
                await this.inFlight;
            }
            catch {
                // Same.
            }
        }
        await this.settleHistory();
        const snapshot = {
            phase: this.phase,
            attempts: this.attemptCount,
            readyAt: this.readyAt ? new Date(this.readyAt).toISOString() : undefined,
            lastAttemptAt: this.lastAttemptAt ? new Date(this.lastAttemptAt).toISOString() : undefined,
            lastAttemptMs: this.lastAttemptAt ? this.lastAttemptAt - this.startedAt : undefined,
            error: this.lastError
                ? { name: this.lastError.name, message: this.lastError.message }
                : undefined,
            report: this.ready?.report,
            inferenceAvailable: this.inferenceAvailable,
            embedder: this.config.embedder?.provider,
            vectorStore: this.config.vectorStore?.provider,
            collection: collectionNameOf(this.config),
            identifiers: {
                user_id: this.config.identifiers?.user_id,
                agent_id: this.config.identifiers?.agent_id,
                run_id: this.config.identifiers?.run_id,
            },
            ...(this.workspace
                ? { workspace: { path: this.workspace.path, reason: this.workspace.reason, total: this.workspace.total } }
                : {}),
            guidance: this.guidance ?? {
                registered: false,
                source: 'disabled',
                order: 0,
                chars: 0,
                reason: 'not evaluated yet',
                scope: 'global',
                presets: [],
                agents: 0,
                skipped: 0,
            },
            history: {
                enabled: this.history.location.source !== 'disabled',
                path: this.history.location.path,
                source: this.history.location.source,
                rows: this.history.count(),
                note: this.history.location.note,
                error: this.history.error,
            },
        };
        return snapshot;
    }
    /** Release the history handle. */
    dispose() {
        this.history.close();
    }
}
