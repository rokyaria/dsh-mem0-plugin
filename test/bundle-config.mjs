/**
 * Bundle-contract verification: the config shipped in `cordis.patch.yml` must
 * actually satisfy the plugin's Config schema and start the plugin.
 *
 * Without this, the patch file and the schema could drift apart silently and
 * every user installing the bundle would meet a load failure. (Workspace rule:
 * documentation and code must agree — a config key that does not exist is a
 * defect, not a typo.)
 *
 * Run: node test/bundle-config.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as plugin from '../lib/index.js'

const patchPath = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
const layers = parse(readFileSync(patchPath, 'utf8'))

console.log(`读取 ${patchPath}`)
assert.ok(Array.isArray(layers), 'a bundle patch must be a top-level YAML array of patch entries')

const inserted = layers.flatMap((entry) => entry?.insert ?? [])
assert.equal(inserted.length, 1, 'the bundle patch must insert exactly one row')
const row = inserted[0]
console.log(`patch 行: id=${row.id} name=${row.name}`)

// The row must name this package, or the loader resolves someone else's code.
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
assert.equal(row.name, pkg.name, `patch row must reference this package (${pkg.name})`)
assert.ok(row.config, 'the reference row must ship a config, otherwise the plugin always fails to load')

// 1. Schema level: the shipped config must validate against the exported Config.
const parsed = plugin.Config(row.config)
console.log(`schema 校验通过: embedder=${parsed.embedder.provider} vectorStore=${parsed.vectorStore.provider}`)
assert.equal(parsed.llm, undefined, 'the reference config intentionally ships without an llm block')

// 2. Load level: the plugin must actually start with the shipped config, which
//    also exercises the real preflight against ES8 + Ollama.
const ctx = new Context()
const fibers = [await ctx.plugin(SystemPrompt), await ctx.plugin(ToolRuntime)]
// Stub the workspace registry so the shipped default (`<workspace>/mem0/`) is
// exercised for real, and nothing lands in the user's DSH home.
const workspace = mkdtempSync(join(tmpdir(), 'dsh-mem0-bundle-ws-'))
ctx.provide('workspaceRegistry', {
  list: () => [{ path: workspace }],
  initializeDefault: async () => ({ path: workspace }),
})
fibers.push(await ctx.plugin(plugin, row.config))

const names = ctx.tools.schemas().map((s) => s.name).filter((n) => n.startsWith('mem0_')).sort()
console.log(`插件加载成功，注册工具: ${names.join(', ')}`)
assert.deepEqual(names, [
  'mem0_add',
  'mem0_delete',
  'mem0_get',
  'mem0_get_all',
  'mem0_history',
  'mem0_search',
  'mem0_status',
  'mem0_update',
])

const status = await ctx.tools.execute({
  callId: 'bundle-status',
  name: 'mem0_status',
  arguments: {},
  signal: new AbortController().signal,
})
// The version `mem0_status` reports must match the manifest — a drift here is
// invisible in normal use but makes every bug report ambiguous.
assert.equal(
  status.value.version,
  pkg.version,
  'PLUGIN_VERSION in src/tools.ts must match package.json',
)

console.log(`历史库 -> ${status.value.history.path}  [${status.value.history.source}]`)
console.log(`版本 -> ${status.value.version}`)
assert.equal(status.value.history.source, 'workspace', 'the shipped default must land in the workspace')
assert.equal(status.value.history.path, join(workspace, 'mem0', 'history.db'))

for (const fiber of fibers.reverse()) await fiber.dispose()

console.log('\n✅ cordis.patch.yml 的默认配置通过 schema 校验并成功启动插件，且历史库落在 <workspace>/mem0/')
