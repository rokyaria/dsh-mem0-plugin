import { Config, describe } from './config.js';
import { registerGuidance } from './guidance.js';
import { Mem0RuntimeManager } from './memory.js';
import { registerMem0Tools } from './tools.js';
import { resolveWorkspace } from './workspace.js';
export const name = 'dsh-mem0-plugin';
/** Wait for the tool registry before `apply` runs. */
export const inject = ['tools'];
export { Config };
/**
 * Load the plugin: publish the tools, then bring the runtime up.
 *
 * @param ctx - plugin context, with `ctx.tools` guaranteed by `inject`.
 * @param config - plugin configuration (already schema-validated by Cordis).
 */
export async function apply(ctx, config) {
    const started = Date.now();
    // History lives in `<workspace>/mem0/` by default; the workspace is resolved
    // lazily on each init attempt so a registry that mounts after this row is
    // still picked up, and `<DSH_HOME>/mem0/` covers profiles without one.
    const manager = new Mem0RuntimeManager(config, {
        resolveWorkspace: () => resolveWorkspace(ctx),
    });
    // Release the history file handle when the plugin unloads or hot-reloads.
    ctx.effect(() => () => manager.dispose());
    // Tell the model *when* to reach for memory; tool descriptions only say what
    // each tool does. Overridable from config.
    const guidance = registerGuidance(ctx, config);
    manager.guidance = guidance;
    registerMem0Tools(ctx, manager);
    if (config.startup?.strict) {
        // Opt-in: a deployment that would rather not run a memory-less agent.
        // Throwing here lands the fiber in FAILED and leaves no tool to diagnose
        // with — which is exactly why this is not the default.
        await manager.ensure();
        ctx.logger.info('[dsh-mem0-plugin] runtime ready (strict startup)');
        return;
    }
    // Probe in the background so dsh startup is never blocked by a slow or
    // unreachable backend; the result is reported by `mem0_status` either way.
    void manager
        .status()
        .then((snapshot) => {
        if (snapshot.phase === 'ready') {
            ctx.logger.info('[dsh-mem0-plugin] ready in %dms — embedder=%s%s store=%s llm=%s', Date.now() - started, config.embedder?.provider, snapshot.report ? ` (${snapshot.report.embedder.dimensions} dims)` : '', snapshot.report?.vectorStore.detail ?? config.vectorStore?.provider, snapshot.inferenceAvailable ? config.llm?.provider : 'none (mem0_add defaults to infer:false)');
            if (snapshot.history.note)
                ctx.logger.warn('[dsh-mem0-plugin] %s', snapshot.history.note);
        }
        else {
            ctx.logger.warn('[dsh-mem0-plugin] NOT READY — call mem0_status for the diagnosis. Reason: %s', describe(snapshot.error?.message ?? 'unknown'));
        }
    })
        .catch((error) => {
        // `status()` is documented never to throw; this is belt-and-braces so a
        // background probe can never become an unhandled rejection.
        ctx.logger.error('[dsh-mem0-plugin] status probe crashed: %s', describe(error));
    });
    ctx.logger.info('[dsh-mem0-plugin] loaded in %dms (tools registered; probing backends)%s', Date.now() - started, guidance.registered
        ? ` — guidance section contributed (${guidance.source}, order ${guidance.order}, ${guidance.chars} chars)`
        : ` — no guidance section: ${guidance.reason}`);
}
