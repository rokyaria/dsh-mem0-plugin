/**
 * dsh-mem0-plugin — mem0 long-term memory for DeepSeek Harness.
 *
 * Unlike the reference `restful-server` (a Python FastAPI process wrapping
 * `mem0.Memory`), this plugin runs mem0's **TypeScript OSS SDK in the dsh host
 * process**: no sidecar, no HTTP hop, no `/configure` round-trip.
 *
 * Startup contract: **the plugin always loads and always registers its tools**,
 * including `mem0_status`. Constructing mem0 needs a live embedder and vector
 * store, and the moment that fails is exactly the moment an operator needs
 * `mem0_status` to explain why — so a failure becomes reported runtime state,
 * not a dead plugin. The first probe runs in the background; the memory tools
 * await it and, if it failed, return the underlying error plus a pointer to
 * `mem0_status`. Set `startup.strict: true` to fail the load instead.
 *
 * @module dsh-mem0-plugin
 */
import type { Context } from '@deepseek-ai/cordis'
import { Config, describe, type Config as Mem0PluginConfig } from './config.js'
import { registerGuidance } from './guidance.js'
import { Mem0RuntimeManager } from './memory.js'
import { registerMem0Tools } from './tools.js'
import { resolveWorkspace } from './workspace.js'

export const name = 'dsh-mem0-plugin'

/** Wait for the tool registry before `apply` runs. */
export const inject = ['tools']

export { Config }
export type { Mem0PluginConfig }

/**
 * Load the plugin: publish the tools, then bring the runtime up.
 *
 * @param ctx - plugin context, with `ctx.tools` guaranteed by `inject`.
 * @param config - plugin configuration (already schema-validated by Cordis).
 */
export async function apply(ctx: Context, config: Mem0PluginConfig): Promise<void> {
  const started = Date.now()
  // History lives in `<workspace>/mem0/` by default; the workspace is resolved
  // lazily on each init attempt so a registry that mounts after this row is
  // still picked up, and `<DSH_HOME>/mem0/` covers profiles without one.
  const manager = new Mem0RuntimeManager(config, {
    resolveWorkspace: () => resolveWorkspace(ctx),
  })

  // Release the history file handle when the plugin unloads or hot-reloads.
  ctx.effect(() => () => manager.dispose())

  // Tell the model *when* to reach for memory; tool descriptions only say what
  // each tool does. Overridable from config.
  const guidance = registerGuidance(ctx, config)
  manager.guidance = guidance

  registerMem0Tools(ctx, manager)

  if (config.startup?.strict) {
    // Opt-in: a deployment that would rather not run a memory-less agent.
    // Throwing here lands the fiber in FAILED and leaves no tool to diagnose
    // with — which is exactly why this is not the default.
    await manager.ensure()
    ctx.logger.info('[dsh-mem0-plugin] runtime ready (strict startup)')
    return
  }

  // Probe in the background so dsh startup is never blocked by a slow or
  // unreachable backend; the result is reported by `mem0_status` either way.
  void manager
    .status()
    .then((snapshot) => {
      if (snapshot.phase === 'ready') {
        ctx.logger.info(
          '[dsh-mem0-plugin] ready in %dms — embedder=%s%s store=%s llm=%s',
          Date.now() - started,
          config.embedder?.provider,
          snapshot.report ? ` (${snapshot.report.embedder.dimensions} dims)` : '',
          snapshot.report?.vectorStore.detail ?? config.vectorStore?.provider,
          snapshot.inferenceAvailable ? config.llm?.provider : 'none (mem0_add defaults to infer:false)',
        )
        if (snapshot.history.note) ctx.logger.warn('[dsh-mem0-plugin] %s', snapshot.history.note)
      } else {
        ctx.logger.warn(
          '[dsh-mem0-plugin] NOT READY — call mem0_status for the diagnosis. Reason: %s',
          describe(snapshot.error?.message ?? 'unknown'),
        )
      }
    })
    .catch((error: unknown) => {
      // `status()` is documented never to throw; this is belt-and-braces so a
      // background probe can never become an unhandled rejection.
      ctx.logger.error('[dsh-mem0-plugin] status probe crashed: %s', describe(error))
    })

  ctx.logger.info(
    '[dsh-mem0-plugin] loaded in %dms (tools registered; probing backends)%s',
    Date.now() - started,
    guidance.registered
      ? ` — guidance section contributed (${guidance.source}, order ${guidance.order}, ${guidance.chars} chars)`
      : ` — no guidance section: ${guidance.reason}`,
  )
}
