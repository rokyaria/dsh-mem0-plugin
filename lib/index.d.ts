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
import type { Context } from '@deepseek-ai/cordis';
import { Config, type Config as Mem0PluginConfig } from './config.js';
export declare const name = "dsh-mem0-plugin";
/** Wait for the tool registry before `apply` runs. */
export declare const inject: string[];
export { Config };
export type { Mem0PluginConfig };
/**
 * Load the plugin: publish the tools, then bring the runtime up.
 *
 * @param ctx - plugin context, with `ctx.tools` guaranteed by `inject`.
 * @param config - plugin configuration (already schema-validated by Cordis).
 */
export declare function apply(ctx: Context, config: Mem0PluginConfig): Promise<void>;
