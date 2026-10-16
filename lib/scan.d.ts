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
import { type Config } from './config.js';
import { type Identifiers, type ReadyRuntime } from './memory.js';
/** One memory as returned by a scan. */
export interface ScannedMemory {
    id: string;
    memory: string;
    createdAt?: string;
    updatedAt?: string;
    metadata?: Record<string, unknown>;
    user_id?: string;
    agent_id?: string;
    run_id?: string;
}
/** A window over the memories in one scope. */
export interface ScanQuery {
    ids: Identifiers;
    createdAfter?: string;
    createdBefore?: string;
    updatedAfter?: string;
    updatedBefore?: string;
    limit: number;
    offset: number;
    order: 'asc' | 'desc';
}
/** Outcome of a scan, including how it was performed. */
export interface ScanResult {
    total: number;
    returned: number;
    offset: number;
    limit: number;
    hasMore: boolean;
    scannedBy: 'elasticsearch' | 'mem0.getAll';
    /** Present when the scan could not be exhaustive; explains the limitation. */
    caveat?: string;
    items: ScannedMemory[];
}
/**
 * Normalize an accepted time bound to an ISO-8601 string.
 *
 * @throws {Error} when the value is neither a parseable date string nor a
 *   finite epoch-millisecond number, so a typo cannot silently widen the window.
 */
export declare function normalizeTimeBound(value: string | number | undefined, field: string): string | undefined;
/**
 * Scan memories in one scope within an optional time window.
 *
 * @param config - plugin config, to decide whether the native ES path applies.
 * @param runtime - a ready runtime, used for the generic fallback.
 */
export declare function scanMemories(config: Config, runtime: ReadyRuntime, query: ScanQuery): Promise<ScanResult>;
/** True when Elasticsearch is telling us the index has not been created yet. */
export declare function isMissingIndex(error: unknown): boolean;
