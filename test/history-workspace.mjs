/**
 * Workspace-resolution verification for the history store.
 *
 * `<workspace>/mem0/history.db` is the default location, but a host-level
 * plugin cannot read "the workspace" from `process.cwd()` (the desktop host's
 * cwd is the *profile* directory) — it has to ask dsh's `workspaceRegistry`,
 * which may register zero, one, or many workspaces.
 *
 * These cases pin down the whole decision table, including the self-healing
 * path where the registry only becomes readable after the first attempt.
 *
 * Needs no Elasticsearch: `mem0_status` reports the history location even when
 * the runtime is NOT READY. Run: node test/history-workspace.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as plugin from '../lib/index.js'

const tmp = mkdtempSync(join(tmpdir(), 'dsh-mem0-ws-'))
// The `<DSH_HOME>/mem0/` fallback is one of the cases below, so point DSH_HOME
// at a temp directory: the suite must not write into the user's real dsh home.
const fakeHome = join(tmp, 'dsh-home')
process.env.DSH_HOME = fakeHome
const wsA = join(tmp, 'workspace-a')
const wsB = join(tmp, 'workspace-b')
mkdirSync(wsA, { recursive: true })
mkdirSync(wsB, { recursive: true })

// Backends deliberately unreachable: this suite is about *where history lives*,
// and that must be reported even when the runtime is NOT READY.
const config = {
  embedder: { provider: 'ollama', config: { url: 'http://127.0.0.1:9', model: 'none' } },
  preflight: { enabled: true, timeoutMs: 1500 },
}

let seq = 0

/** Load the plugin with an optional stubbed `workspaceRegistry`, then read status. */
async function statusWith(registry, configOverride = {}) {
  const ctx = new Context()
  const fibers = [await ctx.plugin(SystemPrompt), await ctx.plugin(ToolRuntime)]
  if (registry) ctx.provide('workspaceRegistry', registry)
  fibers.push(await ctx.plugin(plugin, { ...config, ...configOverride }))
  try {
    const result = await ctx.tools.execute({
      callId: `ws-${++seq}`,
      name: 'mem0_status',
      arguments: {},
      signal: new AbortController().signal,
    })
    return result.value
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose()
  }
}

const registryOf = (entries, initializeDefault) => ({
  list: () => entries.map((path) => ({ path })),
  initializeDefault:
    initializeDefault ??
    (async () => {
      throw new Error('no default recorded')
    }),
})

console.log('='.repeat(72))
console.log('历史库位置解析：<workspace>/mem0/ 的决策表')
console.log('='.repeat(72))

// 1 — no registry at all (headless / sdk profiles).
{
  const status = await statusWith(undefined)
  console.log(`\n▸ 没有 workspaceRegistry`)
  console.log(`  source=${status.history.source}  path=${status.history.path}`)
  assert.equal(status.history.source, 'dsh-home', 'no registry must fall back to DSH_HOME')
  assert.equal(status.history.path, join(fakeHome, 'mem0', 'history.db'))
}

// 2 — exactly one workspace.
{
  const status = await statusWith(registryOf([wsA]))
  console.log(`\n▸ 只有一个工作区`)
  console.log(`  workspace=${status.workspace?.path} [${status.workspace?.reason}]`)
  console.log(`  source=${status.history.source}  path=${status.history.path}`)
  assert.equal(status.history.source, 'workspace')
  assert.equal(status.workspace.reason, 'only-workspace')
  assert.equal(status.history.path, join(wsA, 'mem0', 'history.db'))
  assert.ok(existsSync(join(wsA, 'mem0')), 'the mem0 directory must actually be created')
}

// 3 — several workspaces, dsh nominates a default.
{
  const status = await statusWith(
    registryOf([wsA, wsB], async () => ({ path: wsB })),
  )
  console.log(`\n▸ 多个工作区，dsh 给出 default`)
  console.log(`  workspace=${status.workspace?.path} [${status.workspace?.reason}, 共 ${status.workspace?.total} 个]`)
  assert.equal(status.workspace.reason, 'default-workspace')
  assert.equal(status.history.path, join(wsB, 'mem0', 'history.db'))
}

// 4 — several workspaces, no default recorded.
{
  const status = await statusWith(registryOf([wsA, wsB]))
  console.log(`\n▸ 多个工作区，但没有 default`)
  console.log(`  workspace=${status.workspace?.path} [${status.workspace?.reason}]`)
  assert.equal(status.workspace.reason, 'first-registered')
  assert.equal(status.history.path, join(wsA, 'mem0', 'history.db'))
}

// 5 — the plugin must never create a workspace as a side effect.
{
  let asked = false
  const registry = {
    // The registry projects entities, not bare paths — `list()` must yield
    // objects carrying `.path`.
    list: () => [{ path: wsA }, { path: wsB }],
    initializeDefault: async (resolveDirectory) => {
      asked = true
      // Simulate the "no default recorded" shape instead of the init branch.
      assert.equal(typeof resolveDirectory, 'function')
      return undefined
    },
  }
  const status = await statusWith(registry)
  console.log(`\n▸ initializeDefault 返回 undefined（不是初始化分支）`)
  console.log(`  asked=${asked}  workspace=${status.workspace?.path} [${status.workspace?.reason}]`)
  assert.equal(asked, true, 'the default lookup must actually be attempted')
  assert.equal(status.history.source, 'workspace', 'must still land in a workspace')
}

// 6 — explicit config beats everything.
{
  const explicit = join(tmp, 'explicit', 'history.db')
  const status = await statusWith(registryOf([wsA]), { history: { dbPath: explicit } })
  console.log(`\n▸ 显式 history.dbPath`)
  console.log(`  source=${status.history.source}  path=${status.history.path}`)
  assert.equal(status.history.source, 'configured')
  assert.equal(status.history.path, explicit)
}

// 7 — self-healing: registry unreadable on the first pass, available later.
{
  let ready = false
  const flaky = {
    list: () => {
      if (!ready) throw new Error('workspace state not loaded yet')
      return [{ path: wsB }]
    },
    initializeDefault: async () => undefined,
  }
  const ctx = new Context()
  const fibers = [await ctx.plugin(SystemPrompt), await ctx.plugin(ToolRuntime)]
  ctx.provide('workspaceRegistry', flaky)
  fibers.push(await ctx.plugin(plugin, config))

  const call = async (id) =>
    (
      await ctx.tools.execute({
        callId: id,
        name: 'mem0_status',
        arguments: {},
        signal: new AbortController().signal,
      })
    ).value

  const first = await call('ws-first')
  console.log(`\n▸ 自愈：第一次解析不到工作区`)
  console.log(`  attempt#1 source=${first.history.source}`)
  assert.equal(first.history.source, 'dsh-home', 'must fall back while the registry is unreadable')

  ready = true
  const second = await call('ws-second')
  console.log(`  attempt#2 source=${second.history.source}  path=${second.history.path}`)
  assert.equal(second.history.source, 'workspace', 'a later pass must move into the workspace')
  assert.equal(second.history.path, join(wsB, 'mem0', 'history.db'))

  const third = await call('ws-third')
  assert.equal(third.history.path, second.history.path, 'once settled it must not move again')
  console.log(`  attempt#3 稳定在 ${third.history.source}`)

  for (const fiber of fibers.reverse()) await fiber.dispose()
}

console.log(`\n${'='.repeat(72)}`)
console.log('✅ 7 个场景全部符合预期：唯一工作区 / 默认工作区 / 首个注册 / 显式配置 / 无注册表 / 自愈')
