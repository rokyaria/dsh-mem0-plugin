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
import { type Config, type PreflightReport } from './config.js';
import type { GuidanceState } from './guidance.js';
import { HistoryStore } from './history.js';
import type { ResolvedWorkspace } from './workspace.js';
/** Identifiers carried by every mem0 operation, in the REST server's snake_case spelling. */
export interface Identifiers {
    user_id?: string;
    agent_id?: string;
    run_id?: string;
}
/** Lifecycle of the underlying mem0 runtime. */
export type RuntimePhase = 'idle' | 'initializing' | 'ready' | 'failed';
/** A ready-to-use mem0 runtime. */
export interface ReadyRuntime {
    readonly memory: Memory;
    readonly report: PreflightReport | undefined;
    readonly inferenceAvailable: boolean;
    identifiers(explicit: Identifiers): Identifiers;
    /** Make just-written data visible to the next read. Always available on ES. */
    refresh(): Promise<void>;
    /** Refresh after a write, honouring `refreshAfterWrite`. */
    refreshAfterWrite(): Promise<void>;
}
/** Never-throwing diagnostic view, rendered by `mem0_status`. */
export interface StatusSnapshot {
    phase: RuntimePhase;
    attempts: number;
    readyAt?: string;
    lastAttemptAt?: string;
    lastAttemptMs?: number;
    error?: {
        name: string;
        message: string;
    };
    report?: PreflightReport;
    inferenceAvailable: boolean;
    embedder?: string;
    vectorStore?: string;
    collection?: string;
    identifiers: Identifiers;
    history: {
        enabled: boolean;
        path?: string;
        source: string;
        rows: number;
        note?: string;
        error?: string;
    };
    workspace?: {
        path: string;
        reason: string;
        total: number;
    };
    guidance: GuidanceState;
}
/**
 * mem0's TypeScript SDK is asymmetric: write options take camelCase entity keys
 * (`userId`), while search/getAll filters take snake_case (`user_id`). Getting
 * this wrong does not throw — the filter simply matches nothing — so the
 * translation lives in exactly one place, here.
 */
export declare function toEntity(ids: Identifiers): {
    userId?: string;
    agentId?: string;
    runId?: string;
};
/** Build the snake_case filter object `search`/`getAll`/range scans expect. */
export declare function toFilters(ids: Identifiers, extra?: Record<string, unknown>): Record<string, unknown>;
/**
 * Owns the mem0 runtime and the history store for one plugin instance.
 *
 * Initialization is lazy and retried: a `mem0_status` call (or any tool call)
 * after the cooldown re-attempts, so starting Elasticsearch *after* dsh is
 * enough to bring the plugin online without a restart.
 */
export declare class Mem0RuntimeManager {
    readonly config: Config;
    readonly history: HistoryStore;
    /** Prompt-guidance registration outcome, set by `apply` and reported by `mem0_status`. */
    guidance?: GuidanceState;
    private readonly startedAt;
    private phase;
    private attemptCount;
    private lastAttemptAt?;
    private readyAt?;
    private lastError?;
    private ready?;
    private inFlight?;
    private readonly resolveWorkspace;
    private workspace?;
    /**
     * @param config - plugin config.
     * @param options.resolveWorkspace - resolves the dsh workspace to place
     *   `<workspace>/mem0/` under. Omitted in tests and in profiles without a
     *   workspace registry, in which case history falls back to `<DSH_HOME>/mem0/`.
     */
    constructor(config: Config, options?: {
        resolveWorkspace?: () => Promise<ResolvedWorkspace | undefined>;
    });
    /** The configured inference LLM, if any. */
    get inferenceAvailable(): boolean;
    /**
     * Resolve a ready runtime, attempting initialization when needed.
     *
     * @throws {Mem0ConfigError} carrying the original cause, when the runtime
     *   cannot be brought up. The message is written for the operator.
     */
    ensure(): Promise<ReadyRuntime>;
    /** Run one initialization attempt, capturing every failure into state. */
    private attempt;
    /**
     * Resolve the workspace and (re)open the history store.
     *
     * Runs on every init attempt and on every `mem0_status`, because a host-level
     * plugin can load before any workspace is registered: the store first lands on
     * the `<DSH_HOME>` fallback and moves to `<workspace>/mem0/` on a later pass.
     * Never throws — a resolver problem must not take the memory runtime down.
     */
    private settleHistory;
    /** Wrap a message so the caller sees both the context and the real cause. */
    private failure;
    /**
     * Report the current state, attempting initialization first when it is idle
     * or past its cooldown. Never throws.
     */
    status(): Promise<StatusSnapshot>;
    /** Release the history handle. */
    dispose(): void;
}
