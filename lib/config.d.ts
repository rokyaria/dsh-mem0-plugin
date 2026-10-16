/**
 * Plugin configuration: schema, validation, backend probing, and the shared
 * Elasticsearch client.
 *
 * @module dsh-mem0-plugin/config
 */
import Schema from '@deepseek-ai/schemastery';
/** One `provider` + free-form provider settings, as mem0's own factories expect. */
export interface ProviderSpec {
    /** Provider id understood by the matching mem0ai factory (e.g. `ollama`, `openai`, `elasticsearch`). */
    provider: string;
    /** Provider-specific settings; validated per provider by {@link validateConfig}. */
    config?: Record<string, unknown>;
}
/** How (and whether) the plugin verifies its backends. */
export interface PreflightSpec {
    /** Run the probe before declaring the runtime ready. Default `true`. */
    enabled?: boolean;
    /** Per-probe budget in milliseconds. Default `8000`. */
    timeoutMs?: number;
}
/** Persistent memory-history settings. */
export interface HistorySpec {
    /** Record and serve memory history. Default `true`. */
    enabled?: boolean;
    /**
     * SQLite file backing the history.
     *
     * Default `/mem0/history.db` (the container path from the reference
     * deployment). On a host where `/mem0` cannot be created — macOS keeps `/` on
     * a sealed read-only volume — the plugin falls back to
     * `<DSH_HOME>/mem0/history.db` and reports the resolved path through
     * `mem0_status`.
     */
    dbPath?: string;
}
/**
 * Model-facing guidance: a system-prompt section telling the agent *when* to
 * reach for memory, which is separate from each tool's own description.
 */
export interface GuidanceSpec {
    /** Contribute the section at all. Default `true`. */
    enabled?: boolean;
    /** Replace the built-in text entirely. */
    text?: string;
    /** Append to the built-in (or replaced) text. */
    append?: string;
    /** Sort order within the prompt. Default `3150` (after built-in tool sections). */
    order?: number;
    /**
     * Where the section is registered.
     *
     * - `global` (default): one section, every agent sees it.
     * - `agent`: one section **per agent**, registered through that agent's
     *   `agent.ctx` so it lands in that agent's own prompt layer. It is cleaned up
     *   with the agent, and it shadows a global section of the same name.
     *   `presets` narrows which agents get it.
     */
    scope?: 'global' | 'agent';
    /**
     * Preset ids to restrict to when `scope: agent` (e.g. `[ptc, standard]`).
     * Empty or omitted means every agent. Rejected when `scope` is `global`,
     * because a global section cannot be narrowed after the fact.
     */
    presets?: string[];
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
    strict?: boolean;
}
/** The plugin's user-facing configuration. */
export interface Config {
    /** Embedding model. Required to become ready (not to load — see {@link StartupSpec}). */
    embedder?: ProviderSpec;
    /** Vector store; ES8 deployments use `elasticsearch`. Required to become ready. */
    vectorStore?: ProviderSpec;
    /**
     * Fact-extraction / update LLM. Only `mem0_add` with `infer: true` needs it.
     *
     * mem0's TypeScript runtime requires an `llm` block to construct a `Memory`
     * at all, so the plugin always supplies one: either the user's, or an inert
     * placeholder that raises a precise error if a call actually needs it.
     */
    llm?: ProviderSpec;
    /** Persistent memory history. */
    history?: HistorySpec;
    /** Backend probe settings. */
    preflight?: PreflightSpec;
    /**
     * Force an Elasticsearch index refresh after every write, so a search issued
     * right after an add/update/delete sees it. Default `true`.
     */
    refreshAfterWrite?: boolean;
    /** Startup behaviour. */
    startup?: StartupSpec;
    /** Identifier defaults applied when a tool call omits them. */
    identifiers?: {
        user_id?: string;
        agent_id?: string;
        run_id?: string;
    };
    /**
     * Guidance section for the model: when to use memory. Contributed to the
     * system prompt; see {@link GuidanceSpec}.
     */
    guidance?: GuidanceSpec;
    /**
     * Override the model-facing description of individual tools, keyed by tool
     * name (`mem0_add`, `mem0_search`, …). Each value replaces that tool's whole
     * description, so state the full intent.
     */
    toolDescriptions?: Record<string, string>;
}
/**
 * Cordis config schema.
 *
 * `embedder` and `vectorStore` are deliberately **not** `required()` here: the
 * plugin must load even when they are missing, because `mem0_status` is the
 * only way to tell the operator what is wrong. Missing blocks surface as a
 * reported runtime error instead. Set `startup.strict` to fail the load instead.
 */
export declare const Config: Schema<Config>;
/** Raised for configs that parse but cannot work; message is written for the operator. */
export declare class Mem0ConfigError extends Error {
    constructor(message: string);
}
/** True when at least one mem0 entity identifier is present. */
export declare function hasIdentifier(value: {
    user_id?: string;
    agent_id?: string;
    run_id?: string;
}): boolean;
/** Every tool this plugin registers; the keys allowed in `toolDescriptions`. */
export declare const TOOL_NAMES: readonly ["mem0_status", "mem0_add", "mem0_search", "mem0_get", "mem0_update", "mem0_delete", "mem0_get_all", "mem0_history"];
/**
 * Reject configs the mem0 factories would only reject later, with a message
 * that names the field and the fix.
 *
 * @throws {Mem0ConfigError} for an unknown key or a provider setting that
 *   cannot work.
 */
export declare function validateConfig(config: Config): void;
/** Provider config with the Python-era snake_case aliases folded onto TS SDK names. */
export declare function normalizeVectorStoreConfig(config: Config): Record<string, unknown>;
/** Embedding provider config with snake_case aliases folded onto SDK names. */
export declare function normalizeEmbedderConfig(config: Config): Record<string, unknown>;
/**
 * Assemble the mem0 `MemoryConfig` the SDK expects.
 *
 * @param options.detectedDims - dimensionality measured by the probe; used as
 *   the Elasticsearch `embeddingModelDims` default so the index mapping can
 *   never disagree with the embedder.
 * @param options.allowInference - `false` installs an inert placeholder LLM.
 */
export declare function toSdkConfig(config: Config, options: {
    detectedDims?: number;
    allowInference: boolean;
}): Record<string, unknown>;
/** Outcome of the readiness probe. */
export interface PreflightReport {
    embedder: {
        provider: string;
        model?: string;
        dimensions: number;
    };
    vectorStore: {
        provider: string;
        detail: string;
    };
}
/**
 * Append a sentence to a message without producing a double period when the
 * original already ends in punctuation.
 */
export declare function appendSentence(message: string, sentence: string): string;
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
export declare function preflight(config: Config, timeoutMs: number): Promise<PreflightReport>;
/**
 * Build the same Elasticsearch client settings mem0 will use, for the plugin's
 * own probes, range scans and refreshes.
 */
export declare function createElasticsearchClient(config: Config): Promise<import("@elastic/elasticsearch").Client>;
/** The `collectionName` mem0 will use, or `undefined` when it is not configured. */
export declare function collectionNameOf(config: Config): string | undefined;
/**
 * One-line, credential-free description of an unknown thrown value.
 *
 * `@elastic/elasticsearch` reports a refused connection as a `ConnectionError`
 * with an **empty** `message`, so falling back to `error.message` alone would
 * produce "failed its probe: ." — useless to an operator.
 */
export declare function describe(error: unknown): string;
