/** Stable section name; a second registration under it would throw. */
export const GUIDANCE_SECTION_NAME = 'mem0:memory-guidance';
/**
 * Default placement.
 *
 * dsh's own tool sections run from `TOOL_BASH` (1000) to `TOOL_COMPUTER_USE`
 * (3000), then `MCP_SERVERS` (3100) and `TOOLS_SDK` (5000). 3150 sits after the
 * built-in tool guidance and before the SDK block.
 */
export const DEFAULT_GUIDANCE_ORDER = 3150;
/** Built-in guidance, used unless `guidance.text` replaces it. */
export const DEFAULT_GUIDANCE = `## Long-term memory

You have a persistent memory store that survives across sessions. Use it deliberately:

- Call \`mem0_search\` before answering questions about the user's earlier decisions, preferences, conventions or past work — do not assume the current conversation holds everything.
- Call \`mem0_add\` when the user asks you to remember something, or states a durable preference, decision or convention worth keeping.
- Keep the scope stable: reuse the same \`user_id\` throughout a task, and \`run_id\` for notes that belong to one session only.
- Do not store secrets, credentials, or facts you can re-derive from the workspace.
- Use \`mem0_get_all\` to audit a scope or find stale memories, and \`mem0_history\` to see how one memory changed.
- If any memory tool fails, call \`mem0_status\` before retrying — it reports whether the backend is reachable and why.`;
/** Preset projection key, as registered by `@deepseek-ai/dsh-agent-preset-registry`. */
const AGENT_PRESET_PROJECTION = 'agentPreset';
/**
 * Read the agent's preset.
 *
 * The header carries `agentPreset` too, but the owning package is explicit that
 * "reconstruction reads the `agentPreset` Session projection, never the header",
 * so the projection is the source of truth (a session can *change* preset, and
 * only the projection tracks the committed selection).
 *
 * @returns the preset id, or `undefined` when it cannot be determined.
 */
function presetOf(ctx, agent) {
    const projections = ctx.get('sessionProjections');
    if (!projections || typeof projections.stateOf !== 'function' || agent.session === undefined) {
        return undefined;
    }
    try {
        const state = projections.stateOf(agent.session, AGENT_PRESET_PROJECTION);
        return typeof state === 'string' ? state : undefined;
    }
    catch {
        return undefined;
    }
}
/** Resolve the guidance text and where it came from. */
export function resolveGuidance(config) {
    const base = config.guidance?.text ?? DEFAULT_GUIDANCE;
    const text = config.guidance?.append ? `${base}\n\n${config.guidance.append}` : base;
    return { text, source: config.guidance?.text ? 'config-text' : 'built-in' };
}
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
export function registerGuidance(ctx, config) {
    const order = config.guidance?.order ?? DEFAULT_GUIDANCE_ORDER;
    const { text, source } = resolveGuidance(config);
    const scope = config.guidance?.scope ?? 'global';
    const presets = config.guidance?.presets ?? [];
    if (config.guidance?.enabled === false) {
        return {
            registered: false,
            source: 'disabled',
            order: 0,
            chars: 0,
            reason: 'guidance.enabled is false',
            scope,
            presets,
            agents: 0,
            skipped: 0,
        };
    }
    const missing = {
        registered: false,
        source,
        order,
        chars: 0,
        reason: 'the `systemPrompt` service is not mounted in this profile, so no guidance was contributed',
        scope,
        presets,
        agents: 0,
        skipped: 0,
    };
    /** The section payload, shared by both registration modes. */
    const payload = {
        name: GUIDANCE_SECTION_NAME,
        order,
        text,
        // The text is literal: without this a `{...}` in user-supplied wording
        // would be run through the prompt-variable interpolator.
        interpolate: false,
    };
    if (scope === 'agent') {
        return registerPerAgent(ctx, config, payload, text, source, order, presets);
    }
    const service = ctx.get('systemPrompt');
    if (!service || typeof service.section !== 'function')
        return missing;
    try {
        ctx.effect(() => service.section(payload));
        return { registered: true, source, order, chars: text.length, scope, presets, agents: 0, skipped: 0 };
    }
    catch (error) {
        return {
            ...missing,
            reason: `failed to register the guidance section: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}
/**
 * Register one section per agent, through that agent's own context.
 *
 * Resolving `systemPrompt` from `agent.ctx` yields the *scoped* service
 * instance, whose `section()` registers into that agent's prompt layer — so the
 * section shadows the global one for that agent only and is torn down with it.
 *
 * The `agent/created` listener is `serial` and awaited before agent creation
 * resolves, and a throwing listener fails creation outright, so everything here
 * is contained: a guidance problem must never stop an agent from starting.
 */
function registerPerAgent(ctx, config, payload, text, source, order, presets) {
    const disposers = new Set();
    const state = {
        registered: false,
        source,
        order,
        chars: text.length,
        scope: 'agent',
        presets,
        agents: 0,
        skipped: 0,
    };
    const onCreated = (payloadIn) => {
        try {
            const agent = payloadIn?.agent;
            if (!agent || agent.ctx === undefined)
                return;
            if (presets.length > 0) {
                const preset = presetOf(ctx, agent);
                if (preset === undefined || !presets.includes(preset)) {
                    // Unknown preset counts as a skip: `presets` is an explicit allowlist.
                    state.skipped += 1;
                    return;
                }
            }
            const scoped = agent.ctx.get('systemPrompt');
            if (!scoped || typeof scoped.section !== 'function') {
                state.skipped += 1;
                return;
            }
            const dispose = scoped.section(payload);
            disposers.add(dispose);
            state.agents += 1;
            state.registered = true;
        }
        catch (error) {
            // Contained: `agent/created` is serial and a throw would fail creation.
            state.reason = `per-agent guidance failed: ${error instanceof Error ? error.message : String(error)}`;
        }
        return undefined;
    };
    ctx.on('agent/created', onCreated);
    // Sections registered for a *live* agent are owned by that agent's fiber, but
    // this plugin can unload while agents are still running. Disposing them here
    // is required — otherwise a reload would hit "prompt section is already
    // registered in this scope" and the next `agent/created` would fail.
    ctx.effect(() => () => {
        for (const dispose of disposers) {
            try {
                dispose();
            }
            catch {
                // Already gone with its agent; nothing to do.
            }
        }
        disposers.clear();
    });
    if (state.reason)
        return state;
    return state;
}
