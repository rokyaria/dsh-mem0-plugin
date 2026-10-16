import type { Context } from '@deepseek-ai/cordis';
import { type Mem0RuntimeManager } from './memory.js';
/** Reported by `mem0_status`; keep in step with package.json. */
export declare const PLUGIN_VERSION = "0.3.0";
/**
 * Register every mem0 tool on `ctx.tools`.
 *
 * @param ctx - plugin context whose `tools` service is already available.
 * @param manager - runtime manager owned by this plugin instance.
 * @returns the disposer that unregisters every tool.
 */
export declare function registerMem0Tools(ctx: Context, manager: Mem0RuntimeManager): () => void;
