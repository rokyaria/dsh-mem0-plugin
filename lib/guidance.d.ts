/**
 * The "when should the agent use memory" guidance.
 *
 * Tool descriptions answer *what a tool does*; they do not tell the model when
 * reaching for memory is worth a turn. dsh assembles a system prompt from
 * ordered sections, so the plugin contributes one via `ctx.systemPrompt` — the
 * same mechanism first-party tools use for their own `TOOL_*` sections.
 *
 * Everything here is overridable from config (`guidance.text` / `.append` /
 * `.order` / `.enabled`), because prompt wording is deployment-specific.
 *
 * @module dsh-mem0-plugin/guidance
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Config } from './config.js';
/** Stable section name; a second registration under it would throw. */
export declare const GUIDANCE_SECTION_NAME = "mem0:memory-guidance";
/**
 * Default placement.
 *
 * dsh's own tool sections run from `TOOL_BASH` (1000) to `TOOL_COMPUTER_USE`
 * (3000), then `MCP_SERVERS` (3100) and `TOOLS_SDK` (5000). 3150 sits after the
 * built-in tool guidance and before the SDK block.
 */
export declare const DEFAULT_GUIDANCE_ORDER = 3150;
/** Built-in guidance, used unless `guidance.text` replaces it. */
export declare const DEFAULT_GUIDANCE = "## Long-term memory\n\nYou have a persistent memory store that survives across sessions. Use it deliberately:\n\n- Call `mem0_search` before answering questions about the user's earlier decisions, preferences, conventions or past work \u2014 do not assume the current conversation holds everything.\n- Call `mem0_add` when the user asks you to remember something, or states a durable preference, decision or convention worth keeping.\n- Keep the scope stable: reuse the same `user_id` throughout a task, and `run_id` for notes that belong to one session only.\n- Do not store secrets, credentials, or facts you can re-derive from the workspace.\n- Use `mem0_get_all` to audit a scope or find stale memories, and `mem0_history` to see how one memory changed.\n- If any memory tool fails, call `mem0_status` before retrying \u2014 it reports whether the backend is reachable and why.";
/** What actually happened, for `mem0_status` to report. */
export interface GuidanceState {
    registered: boolean;
    /** `built-in`, `config-text`, or `disabled`. */
    source: 'built-in' | 'config-text' | 'disabled';
    order: number;
    /** Characters contributed to the prompt (0 when not registered). */
    chars: number;
    /** Why it is not registered, when it is not. */
    reason?: string;
    /** `global` or `agent`; which registration mode is in force. */
    scope: 'global' | 'agent';
    /** Preset filter, empty when every agent is covered. */
    presets: string[];
    /** Agents that currently carry a scoped section (`scope: agent` only). */
    agents: number;
    /** Agents skipped because their preset did not match. */
    skipped: number;
}
/** Resolve the guidance text and where it came from. */
export declare function resolveGuidance(config: Config): {
    text: string;
    source: GuidanceState['source'];
};
/**
 * Contribute the guidance section to the system prompt.
 *
 * `section()` registers against the **service's own** context rather than the
 * caller's, so it is not torn down with this plugin automatically. The returned
 * disposer is therefore installed as a context effect here — without that, every
 * hot reload would leave another copy of the guidance in the prompt.
 *
 * @param ctx - plugin context.
 * @param config - plugin config.
 * @returns the registration outcome; never throws.
 */
export declare function registerGuidance(ctx: Context, config: Config): GuidanceState;
