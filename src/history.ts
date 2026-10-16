/**
 * Persistent memory history, backed by Node's built-in `node:sqlite`.
 *
 * Why not mem0's own history store? mem0's `HistoryManagerFactory` only offers
 * `sqlite` (via the native `better-sqlite3` binding), `supabase`, and an
 * in-process `memory`. The dsh Desktop host runs Electron's Node
 * (`ELECTRON_RUN_AS_NODE`), whose module ABI differs from plain Node's
 * (Electron 44 → ABI 149, Node 24 → ABI 137), so a `better-sqlite3` built for
 * the local Node cannot be loaded by the host at all — and shipping an
 * ABI-matched native build would tie the plugin to one dsh/Electron release.
 *
 * `node:sqlite` ships with Node itself (verified working inside the Electron
 * host), so history works on any platform with no toolchain. The table mirrors
 * mem0's `memory_history` shape so the data reads the same way.
 *
 * @module dsh-mem0-plugin/history
 */
import { mkdirSync, accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Config } from './config.js'
import type { ResolvedWorkspace } from './workspace.js'

/** One recorded change to a memory. */
export interface HistoryEntry {
  id?: number
  memory_id: string
  previous_value: string | null
  new_value: string | null
  action: string
  created_at: string
  updated_at: string
  is_deleted: number
}

/** Where the history file ended up, and why. */
export interface HistoryLocation {
  /** Absolute path actually in use, or `undefined` when history is disabled/failed. */
  path?: string
  /**
   * `configured` = explicit `history.dbPath`
   * `workspace`  = `<workspace>/mem0/` (the default)
   * `dsh-home`   = `<DSH_HOME>/mem0/` (no workspace could be resolved)
   * `failed`     = the configured path is unusable
   */
  source: 'disabled' | 'configured' | 'workspace' | 'dsh-home' | 'failed'
  /** Operator-facing note, present whenever a fallback was taken. */
  note?: string
}

/** Directory name this plugin owns inside the chosen root. */
const SUBDIR = 'mem0'

/** The dsh home directory, matching the host's own resolution order. */
export function dshHome(): string {
  return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

/**
 * True when `file` can be created or written.
 *
 * Checks the deepest **existing** ancestor directory for writability, not just
 * the immediate parent: `<workspace>/mem0/` legitimately does not exist yet on
 * first run, and treating that as "unusable" would make the plugin fall back to
 * `<DSH_HOME>` on every fresh workspace.
 */
function isUsable(file: string): boolean {
  try {
    accessSync(file, constants.W_OK)
    return true
  } catch {
    // Not present yet — walk up to the nearest existing directory.
  }
  let dir = dirname(file)
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      accessSync(dir, constants.W_OK)
      return true
    } catch {
      const parent = dirname(dir)
      if (parent === dir) return false
      dir = parent
    }
  }
  return false
}

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
export function resolveHistoryLocation(
  config: Config,
  workspace?: ResolvedWorkspace,
): HistoryLocation {
  if (config.history?.enabled === false) return { source: 'disabled' }

  const configured = config.history?.dbPath?.trim()
  if (configured) {
    if (isUsable(configured)) return { path: configured, source: 'configured' }
    // An explicitly configured path that cannot be used is a configuration
    // problem: report it rather than silently writing somewhere else.
    return {
      source: 'failed',
      note:
        `history.dbPath \`${configured}\` is not writable (its directory cannot be created), ` +
        `so history is disabled. Point \`history.dbPath\` at a writable location, ` +
        `e.g. \`${join(dshHome(), SUBDIR, 'history.db')}\`.`,
    }
  }

  if (workspace?.path) {
    const candidate = join(workspace.path, SUBDIR, 'history.db')
    if (isUsable(candidate)) {
      return {
        path: candidate,
        source: 'workspace',
        note:
          workspace.reason === 'default-workspace'
            ? `history is stored in the default workspace (one of ${workspace.total} registered).`
            : undefined,
      }
    }
    return {
      path: join(dshHome(), SUBDIR, 'history.db'),
      source: 'dsh-home',
      note:
        `the workspace directory \`${workspace.path}\` is not writable, so history falls back to ` +
        `\`${join(dshHome(), SUBDIR, 'history.db')}\`. Set \`history.dbPath\` to choose explicitly.`,
    }
  }

  return {
    path: join(dshHome(), SUBDIR, 'history.db'),
    source: 'dsh-home',
    note:
      'no dsh workspace could be resolved (none registered, or the workspace registry is not ' +
      `mounted in this profile), so history uses \`${join(dshHome(), SUBDIR, 'history.db')}\`. ` +
      'Set `history.dbPath` to choose explicitly.',
  }
}

/**
 * SQLite-backed history. Every method is safe to call on a failed store: writes
 * are dropped and reads return empty, while {@link HistoryStore.error} keeps the
 * reason for `mem0_status` to report.
 */
export class HistoryStore {
  location: HistoryLocation = { source: 'disabled' }
  /** Why the store is unusable, if it is. */
  error?: string
  private db?: DatabaseSync

  /** Whether history can actually be recorded and read. */
  get available(): boolean {
    return this.db !== undefined
  }

  /**
   * Resolve the location and open the file.
   *
   * Called on every runtime init attempt so the store can *self-heal*: a
   * host-level plugin may load before any workspace is registered, in which
   * case the first attempt lands on `<DSH_HOME>/mem0/`. Once a workspace
   * resolves, the store moves there — but only while it is on that fallback.
   * An explicit `history.dbPath` or an already-resolved workspace is final.
   */
  ensureOpen(config: Config, workspace?: ResolvedWorkspace): void {
    if (this.db && this.location.source !== 'dsh-home') return
    const next = resolveHistoryLocation(config, workspace)
    if (this.db && next.path === this.location.path) return

    this.close()
    this.location = next
    this.error = undefined
    if (next.source === 'disabled' || next.source === 'failed') {
      if (next.source === 'failed') this.error = next.note
      return
    }
    this.openFile(next.path as string)
  }

  /** Open one SQLite file and create the history table. */
  private openFile(path: string): void {
    try {
      mkdirSync(dirname(path), { recursive: true })
      this.db = new DatabaseSync(path)
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memory_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          memory_id TEXT NOT NULL,
          previous_value TEXT,
          new_value TEXT,
          action TEXT NOT NULL,
          created_at TEXT,
          updated_at TEXT,
          is_deleted INTEGER DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_memory_history_memory_id
          ON memory_history (memory_id);
      `)
    } catch (error) {
      this.error = `history store at \`${path}\` could not be opened: ${
        error instanceof Error ? error.message : String(error)
      }`
      this.db = undefined
    }
  }

  /**
   * Append one change. Failures are swallowed into {@link error} — history must
   * never fail the memory operation it describes.
   */
  record(entry: {
    memoryId: string
    previousValue?: string | null
    newValue?: string | null
    action: 'ADD' | 'UPDATE' | 'DELETE'
  }): void {
    if (!this.db) return
    const now = new Date().toISOString()
    try {
      this.db
        .prepare(
          `INSERT INTO memory_history
             (memory_id, previous_value, new_value, action, created_at, updated_at, is_deleted)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          entry.memoryId,
          entry.previousValue ?? null,
          entry.newValue ?? null,
          entry.action,
          now,
          now,
          entry.action === 'DELETE' ? 1 : 0,
        )
    } catch (error) {
      this.error = `failed to record history for ${entry.memoryId}: ${
        error instanceof Error ? error.message : String(error)
      }`
    }
  }

  /** Full change history for one memory, oldest first. */
  list(memoryId: string): HistoryEntry[] {
    if (!this.db) return []
    try {
      return this.db
        .prepare(`SELECT * FROM memory_history WHERE memory_id = ? ORDER BY id ASC`)
        .all(memoryId) as unknown as HistoryEntry[]
    } catch (error) {
      this.error = `failed to read history: ${error instanceof Error ? error.message : String(error)}`
      return []
    }
  }

  /** Number of recorded rows, for `mem0_status`. */
  count(): number {
    if (!this.db) return 0
    try {
      const row = this.db.prepare(`SELECT COUNT(*) AS n FROM memory_history`).get() as
        | { n?: number }
        | undefined
      return Number(row?.n ?? 0)
    } catch {
      return 0
    }
  }

  /** Release the file handle so the plugin can be unloaded cleanly. */
  close(): void {
    try {
      this.db?.close()
    } catch {
      // Closing an already-closed or broken handle must not fail unload.
    }
    this.db = undefined
  }
}
