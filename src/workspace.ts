/**
 * Resolving the dsh *workspace* a plugin should treat as "the" workspace.
 *
 * dsh models workspaces as a registry of directories (`workspaceRegistry`,
 * provided by the web-app bundle), not as one ambient value:
 *
 *   - there may be several (`registry.list()`),
 *   - the desktop host's `process.cwd()` is the **profile directory**
 *     (`~/.dsh/profiles/<name>`), never the user's workspace,
 *   - `defaultWorkspaceId` — dsh's own notion of "the" workspace — has no public
 *     accessor.
 *
 * So the resolution order is: the only workspace if there is exactly one,
 * otherwise dsh's default workspace, otherwise nothing (the caller falls back).
 *
 * @module dsh-mem0-plugin/workspace
 */
import type { Context } from '@deepseek-ai/cordis'

/** A resolved workspace directory and why it was chosen. */
export interface ResolvedWorkspace {
  /** Absolute directory path of the workspace. */
  path: string
  /** Which rule selected it; surfaced by `mem0_status`. */
  reason: 'only-workspace' | 'default-workspace' | 'first-registered'
  /** Total number of registered workspaces, for diagnostics. */
  total: number
}

/** The slice of `workspaceRegistry` this module uses. */
interface WorkspaceRegistryLike {
  list(): Array<{ path?: string }>
  initializeDefault(resolveDirectory: () => Promise<string> | string): Promise<{ path?: string } | undefined>
}

/**
 * Look up the workspace registry without declaring a dependency on it.
 *
 * It is provided by the web-app bundle, so profiles without a browser surface
 * (headless, sdk) never have it. `inject` would leave this plugin stuck in
 * PENDING there, which would defeat its always-load contract — hence an
 * optional lookup.
 */
function registryOf(ctx: Context): WorkspaceRegistryLike | undefined {
  const registry = (ctx as unknown as { get(name: string): unknown }).get('workspaceRegistry')
  if (!registry || typeof registry !== 'object') return undefined
  const candidate = registry as Partial<WorkspaceRegistryLike>
  if (typeof candidate.list !== 'function') return undefined
  return candidate as WorkspaceRegistryLike
}

/**
 * Resolve the workspace directory to place `<workspace>/mem0/` under, or
 * `undefined` when no workspace can be determined.
 *
 * Never creates anything: the resolver handed to `initializeDefault` throws, so
 * if that call were ever to reach the *initialization* branch it fails instead
 * of registering a workspace at a path this plugin invented. Reaching it would
 * require zero workspaces, zero sessions and zero stored session headers, which
 * the `list()` length check above already excludes.
 *
 * @param ctx - plugin context, used for an optional service lookup.
 */
export async function resolveWorkspace(ctx: Context): Promise<ResolvedWorkspace | undefined> {
  let registry: WorkspaceRegistryLike | undefined
  try {
    registry = registryOf(ctx)
  } catch {
    return undefined
  }
  if (!registry) return undefined

  let workspaces: Array<{ path?: string }>
  try {
    // `list()` requires the registry's persisted state to be loaded; during a
    // very early boot it can throw. That is a "not ready", not a failure.
    workspaces = registry.list() ?? []
  } catch {
    return undefined
  }
  const paths = workspaces.map((entry) => entry.path).filter((path): path is string => Boolean(path))
  if (paths.length === 0) return undefined
  if (paths.length === 1) {
    return { path: paths[0] as string, reason: 'only-workspace', total: 1 }
  }

  // Several workspaces: ask dsh which one is the default. With workspaces
  // present this returns the registered default without initializing anything.
  try {
    const preferred = await registry.initializeDefault(() => {
      throw new Error('dsh-mem0-plugin must never create a workspace')
    })
    if (preferred?.path) {
      return { path: preferred.path, reason: 'default-workspace', total: paths.length }
    }
  } catch {
    // No default recorded, or the call was refused — fall through.
  }

  return { path: paths[0] as string, reason: 'first-registered', total: paths.length }
}
