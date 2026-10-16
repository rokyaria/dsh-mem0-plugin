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
import type { Context } from '@deepseek-ai/cordis';
/** A resolved workspace directory and why it was chosen. */
export interface ResolvedWorkspace {
    /** Absolute directory path of the workspace. */
    path: string;
    /** Which rule selected it; surfaced by `mem0_status`. */
    reason: 'only-workspace' | 'default-workspace' | 'first-registered';
    /** Total number of registered workspaces, for diagnostics. */
    total: number;
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
export declare function resolveWorkspace(ctx: Context): Promise<ResolvedWorkspace | undefined>;
