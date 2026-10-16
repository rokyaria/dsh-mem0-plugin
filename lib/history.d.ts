import type { Config } from './config.js';
import type { ResolvedWorkspace } from './workspace.js';
/** One recorded change to a memory. */
export interface HistoryEntry {
    id?: number;
    memory_id: string;
    previous_value: string | null;
    new_value: string | null;
    action: string;
    created_at: string;
    updated_at: string;
    is_deleted: number;
}
/** Where the history file ended up, and why. */
export interface HistoryLocation {
    /** Absolute path actually in use, or `undefined` when history is disabled/failed. */
    path?: string;
    /**
     * `configured` = explicit `history.dbPath`
     * `workspace`  = `<workspace>/mem0/` (the default)
     * `dsh-home`   = `<DSH_HOME>/mem0/` (no workspace could be resolved)
     * `failed`     = the configured path is unusable
     */
    source: 'disabled' | 'configured' | 'workspace' | 'dsh-home' | 'failed';
    /** Operator-facing note, present whenever a fallback was taken. */
    note?: string;
}
/** The dsh home directory, matching the host's own resolution order. */
export declare function dshHome(): string;
/**
 * Decide where history lives.
 *
 * Order: explicit `history.dbPath` → `<workspace>/mem0/history.db` →
 * `<DSH_HOME>/mem0/history.db`.
 *
 * The workspace root is supplied by {@link resolveWorkspace}: the only
 * registered workspace, or dsh's default one when several exist. The dsh-home
 * fallback exists because a host-level plugin can load before any workspace is
 * registered (or in profiles with no workspace registry at all).
 */
export declare function resolveHistoryLocation(config: Config, workspace?: ResolvedWorkspace): HistoryLocation;
/**
 * SQLite-backed history. Every method is safe to call on a failed store: writes
 * are dropped and reads return empty, while {@link HistoryStore.error} keeps the
 * reason for `mem0_status` to report.
 */
export declare class HistoryStore {
    location: HistoryLocation;
    /** Why the store is unusable, if it is. */
    error?: string;
    private db?;
    /** Whether history can actually be recorded and read. */
    get available(): boolean;
    /**
     * Resolve the location and open the file.
     *
     * Called on every runtime init attempt so the store can *self-heal*: a
     * host-level plugin may load before any workspace is registered, in which
     * case the first attempt lands on `<DSH_HOME>/mem0/`. Once a workspace
     * resolves, the store moves there — but only while it is on that fallback.
     * An explicit `history.dbPath` or an already-resolved workspace is final.
     */
    ensureOpen(config: Config, workspace?: ResolvedWorkspace): void;
    /** Open one SQLite file and create the history table. */
    private openFile;
    /**
     * Append one change. Failures are swallowed into {@link error} — history must
     * never fail the memory operation it describes.
     */
    record(entry: {
        memoryId: string;
        previousValue?: string | null;
        newValue?: string | null;
        action: 'ADD' | 'UPDATE' | 'DELETE';
    }): void;
    /** Full change history for one memory, oldest first. */
    list(memoryId: string): HistoryEntry[];
    /** Number of recorded rows, for `mem0_status`. */
    count(): number;
    /** Release the file handle so the plugin can be unloaded cleanly. */
    close(): void;
}
