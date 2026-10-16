/**
 * Verification for the model-facing surfaces: the guidance prompt section and
 * per-tool description overrides.
 *
 * The load-bearing assertions are the prompt ones — a plugin "contributing
 * guidance" is only real if it shows up in `systemPrompt.assemble()`, and a
 * section that survives plugin unload would silently stack up on every hot
 * reload (`section()` registers against the *service's* context, not the
 * caller's, so cleanup is this plugin's responsibility).
 *
 * Needs no Elasticsearch: backends are deliberately unreachable, and prompt
 * assembly does not depend on them. Run: node test/guidance.mjs
 */
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import * as plugin from '../lib/index.js'
import { DEFAULT_GUIDANCE, GUIDANCE_SECTION_NAME } from '../lib/guidance.js'

const baseConfig = {
  embedder: { provider: 'ollama', config: { url: 'http://127.0.0.1:9', model: 'none' } },
  preflight: { enabled: true, timeoutMs: 1500 },
  // Keep test history out of the user's DSH home (no workspace registry exists
  // in this harness, so the default would resolve to the <DSH_HOME> fallback).
  history: { dbPath: join(tmpdir(), 'dsh-mem0-guidance-history.db') },
}

let seq = 0

/** Load the plugin, run `fn(ctx, fiber)`, then unload and return what `fn` saw. */
async function withPlugin(config, fn) {
  const ctx = new Context()
  const fibers = [await ctx.plugin(SystemPrompt), await ctx.plugin(ToolRuntime)]
  const pluginFiber = await ctx.plugin(plugin, { ...baseConfig, ...config })
  try {
    return await fn(ctx, pluginFiber)
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose()
  }
}

/** The guidance section as the model would receive it. */
async function guidanceSection(ctx) {
  const assembly = await ctx.systemPrompt.assemble({})
  return assembly.sections.find((section) => section.name === GUIDANCE_SECTION_NAME)
}

const call = async (ctx, name, args = {}) =>
  (
    await ctx.tools.execute({
      callId: `g-${++seq}`,
      name,
      arguments: args,
      signal: new AbortController().signal,
    })
  ).value

console.log('='.repeat(72))
console.log('给模型的描述：系统提示词引导 + 工具描述覆盖')
console.log('='.repeat(72))

// 1 — the default guidance actually reaches the assembled prompt.
// `AssembledSection` is `{name, text, interpolate?}` — the order is a
// registration input, reported by `mem0_status` rather than the assembly.
{
  const { section, status } = await withPlugin({}, async (ctx) => ({
    section: await guidanceSection(ctx),
    status: await call(ctx, 'mem0_status'),
  }))
  console.log(`\n▸ 默认引导`)
  console.log(`  section=${section?.name}  chars=${section?.text.length}  order=${status.guidance.order}`)
  console.log(`  首行: ${section?.text.split('\n')[0]}`)
  assert.ok(section, 'the guidance section must appear in the assembled prompt')
  assert.equal(section.text, DEFAULT_GUIDANCE)
  assert.equal(section.interpolate, false, 'literal text must not be interpolated')
  assert.equal(status.guidance.registered, true)
  assert.equal(status.guidance.order, 3150)
  assert.equal(status.guidance.source, 'built-in')
}

// 2 — `guidance.text` replaces the built-in wording.
{
  const custom = '## Memory policy\n\nAlways check memory before answering about prior work.'
  const section = await withPlugin({ guidance: { text: custom } }, (ctx) => guidanceSection(ctx))
  console.log(`\n▸ guidance.text 替换`)
  console.log(`  ${section?.text.split('\n')[0]}`)
  assert.equal(section.text, custom, 'config text must replace the built-in entirely')
  assert.ok(!section.text.includes('mem0_search'), 'the built-in bullets must be gone')
}

// 3 — `guidance.append` adds to the built-in text.
{
  const section = await withPlugin(
    { guidance: { append: 'House rule: never store customer names.' } },
    (ctx) => guidanceSection(ctx),
  )
  console.log(`\n▸ guidance.append 追加`)
  assert.ok(section.text.startsWith(DEFAULT_GUIDANCE), 'the built-in text must be kept')
  assert.ok(section.text.endsWith('never store customer names.'), 'the appended text must be present')
  console.log(`  chars=${section.text.length}（默认 ${DEFAULT_GUIDANCE.length}）`)
}

// 4 — `guidance.enabled: false` removes it, and status says why.
{
  const section = await withPlugin({ guidance: { enabled: false } }, (ctx) => guidanceSection(ctx))
  console.log(`\n▸ guidance.enabled=false`)
  assert.equal(section, undefined, 'no section may be registered when disabled')
  console.log('  section=absent')

  const status = await withPlugin({ guidance: { enabled: false } }, (ctx) => call(ctx, 'mem0_status'))
  console.log(`  mem0_status: registered=${status.guidance.registered} reason=${status.guidance.reason}`)
  assert.equal(status.guidance.registered, false)
  assert.equal(status.guidance.source, 'disabled')
}

// 5 — `guidance.order` is honoured.
{
  const status = await withPlugin({ guidance: { order: 777 } }, (ctx) => call(ctx, 'mem0_status'))
  console.log(`\n▸ guidance.order=777 -> ${status.guidance.order}`)
  assert.equal(status.guidance.order, 777)
}

// 6 — per-tool description overrides reach the model-facing schema.
{
  const { schemas, status } = await withPlugin(
    { toolDescriptions: { mem0_add: 'Save a fact the user wants remembered.' } },
    async (ctx) => ({ schemas: ctx.tools.schemas(), status: await call(ctx, 'mem0_status') }),
  )
  const add = schemas.find((s) => s.name === 'mem0_add')
  const search = schemas.find((s) => s.name === 'mem0_search')
  console.log(`\n▸ toolDescriptions 覆盖`)
  console.log(`  mem0_add    -> ${add.description}`)
  console.log(`  mem0_search -> ${search.description.slice(0, 60)}…（未覆盖，保持内置）`)
  assert.equal(add.description, 'Save a fact the user wants remembered.')
  assert.ok(search.description.includes('natural-language'), 'unlisted tools keep the built-in text')
  assert.equal(status.guidance.registered, true)
}

// 7 — a typo in a tool name is rejected rather than silently ignored.
{
  let error
  try {
    await withPlugin({ toolDescriptions: { mem0_seach: 'typo' } }, async () => {})
  } catch (caught) {
    error = caught
  }
  // The plugin loads and reports through mem0_status rather than failing the
  // load, so the misconfiguration surfaces as a NOT READY status.
  const status = await withPlugin({ toolDescriptions: { mem0_seach: 'typo' } }, (ctx) =>
    call(ctx, 'mem0_status'),
  )
  console.log(`\n▸ toolDescriptions 里的拼写错误`)
  console.log(`  ok=${status.ok}  error=${status.error?.message?.slice(0, 90)}…`)
  assert.equal(status.ok, false, 'an unknown tool name must not be ignored')
  assert.match(status.error.message, /mem0_seach/, 'the error must name the offending key')
  assert.match(status.error.message, /mem0_search/, 'the error must list the valid tool names')
}

// 8 — the section must disappear when the plugin unloads.
{
  const ctx = new Context()
  const fibers = [await ctx.plugin(SystemPrompt), await ctx.plugin(ToolRuntime)]
  const pluginFiber = await ctx.plugin(plugin, baseConfig)

  const before = await guidanceSection(ctx)
  assert.ok(before, 'sanity: the section is present while the plugin is loaded')
  await pluginFiber.dispose()
  const after = await guidanceSection(ctx)
  console.log(`\n▸ 卸载插件`)
  console.log(`  卸载前 section=${before ? 'present' : 'absent'} → 卸载后 section=${after ? 'present' : 'absent'}`)
  assert.equal(after, undefined, 'the guidance section must be removed when the plugin unloads')

  for (const fiber of fibers.reverse()) await fiber.dispose()
}

// ---------------------------------------------------------------- scoped mode
/**
 * Drive one `agent/created` for a fake agent whose ctx carries a scope key.
 *
 * `systemPrompt.section()` is called through the service instance resolved from
 * `agent.ctx`, which is the scoped instance — that is what puts the section in
 * the agent's own prompt layer.
 */
async function withAgent(ctx, scopeKey, preset) {
  if (preset !== undefined) {
    ctx.provide('sessionProjections', {
      stateOf: (_session, key) => (key === 'agentPreset' ? preset : undefined),
    })
  }
  const scoped = createScope(ctx, scopeKey)
  const agent = { id: `agent-${String(scopeKey)}`, ctx: scoped.ctx, session: { header: {} } }
  await ctx.emit('agent/created', { agent })
  return scoped
}

// 9 — `scope: agent` puts the section in the agent's layer, not the global one.
{
  const ctx = new Context()
  const fibers = [await ctx.plugin(SystemPrompt), await ctx.plugin(ToolRuntime)]
  fibers.push(await ctx.plugin(plugin, { ...baseConfig, guidance: { scope: 'agent' } }))

  const key = {}
  const scoped = await withAgent(ctx, key, 'ptc')

  const globalAsm = await ctx.systemPrompt.assemble({})
  const scopedAsm = await ctx.systemPrompt.assemble({ scope: key })
  const inGlobal = globalAsm.sections.some((s) => s.name === GUIDANCE_SECTION_NAME)
  const inScoped = scopedAsm.sections.some((s) => s.name === GUIDANCE_SECTION_NAME)
  console.log(`\n▸ guidance.scope=agent`)
  console.log(`  global 装配: ${inGlobal ? 'contains' : 'absent'}  |  agent 装配: ${inScoped ? 'contains' : 'absent'}`)
  assert.equal(inGlobal, false, 'a scoped section must not leak into the global assembly')
  assert.equal(inScoped, true, 'the section must be present in the agent’s own assembly')

  const status = await call(ctx, 'mem0_status')
  console.log(`  mem0_status: scope=${status.guidance.scope} agents=${status.guidance.agents} skipped=${status.guidance.skipped}`)
  assert.equal(status.guidance.scope, 'agent')
  assert.equal(status.guidance.agents, 1)

  await scoped.dispose()
  for (const fiber of fibers.reverse()) await fiber.dispose()
}

// 10 — `presets` narrows which agents get the section.
{
  const ctx = new Context()
  const fibers = [await ctx.plugin(SystemPrompt), await ctx.plugin(ToolRuntime)]
  ctx.provide('sessionProjections', {
    stateOf: (session, key) => (key === 'agentPreset' ? session.preset : undefined),
  })
  fibers.push(
    await ctx.plugin(plugin, { ...baseConfig, guidance: { scope: 'agent', presets: ['ptc'] } }),
  )

  const makeAgent = (preset) => {
    const key = {}
    const scoped = createScope(ctx, key)
    return { key, scoped, agent: { id: preset, ctx: scoped.ctx, session: { preset } } }
  }
  const matching = makeAgent('ptc')
  const other = makeAgent('standard')
  await ctx.emit('agent/created', { agent: matching.agent })
  await ctx.emit('agent/created', { agent: other.agent })

  const has = async (key) =>
    (await ctx.systemPrompt.assemble({ scope: key })).sections.some(
      (s) => s.name === GUIDANCE_SECTION_NAME,
    )
  const inMatching = await has(matching.key)
  const inOther = await has(other.key)
  const status = await call(ctx, 'mem0_status')
  console.log(`\n▸ guidance.presets=['ptc']`)
  console.log(`  preset=ptc      -> section ${inMatching ? 'present' : 'absent'}`)
  console.log(`  preset=standard -> section ${inOther ? 'present' : 'absent'}`)
  console.log(`  mem0_status: agents=${status.guidance.agents} skipped=${status.guidance.skipped}`)
  assert.equal(inMatching, true, 'the matching preset must get the section')
  assert.equal(inOther, false, 'a non-matching preset must not')
  assert.equal(status.guidance.agents, 1)
  assert.equal(status.guidance.skipped, 1)

  await matching.scoped.dispose()
  await other.scoped.dispose()
  for (const fiber of fibers.reverse()) await fiber.dispose()
}

// 11 — `presets` without `scope: agent` is rejected, not silently ignored.
{
  const status = await withPlugin({ guidance: { presets: ['ptc'] } }, (ctx) =>
    call(ctx, 'mem0_status'),
  )
  console.log(`\n▸ presets 与 scope: global 同时给出`)
  console.log(`  ok=${status.ok}  error=${status.error?.message?.slice(0, 80)}…`)
  assert.equal(status.ok, false, 'the combination must be rejected')
  assert.match(status.error.message, /guidance\.presets/)
  assert.match(status.error.message, /scope/)
}

// 12 — unloading the plugin removes live agents' sections too.
{
  const ctx = new Context()
  const fibers = [await ctx.plugin(SystemPrompt), await ctx.plugin(ToolRuntime)]
  const pluginFiber = await ctx.plugin(plugin, { ...baseConfig, guidance: { scope: 'agent' } })
  const key = {}
  const scoped = await withAgent(ctx, key, 'ptc')

  const before = (await ctx.systemPrompt.assemble({ scope: key })).sections.some(
    (s) => s.name === GUIDANCE_SECTION_NAME,
  )
  await pluginFiber.dispose()
  const after = (await ctx.systemPrompt.assemble({ scope: key })).sections.some(
    (s) => s.name === GUIDANCE_SECTION_NAME,
  )
  console.log(`\n▸ scope=agent 时卸载插件（agent 仍存活）`)
  console.log(`  卸载前 ${before ? 'present' : 'absent'} → 卸载后 ${after ? 'present' : 'absent'}`)
  assert.equal(before, true, 'sanity: the agent had the section')
  assert.equal(
    after,
    false,
    'a reload must not leave the section behind — the next agent/created would then fail as a duplicate',
  )

  await scoped.dispose()
  for (const fiber of fibers.reverse()) await fiber.dispose()
}

console.log(`\n${'='.repeat(72)}`)
console.log('✅ 12 个场景全部通过：注入 / 替换 / 追加 / 关闭 / 排序 / 工具描述覆盖 / 拼写校验 / 卸载清理 / per-agent / preset 过滤 / 组合校验 / 卸载清理(agent)')
